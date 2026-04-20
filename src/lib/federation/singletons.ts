/**
 * Federation singletons.
 *
 * Lazy module-scope holders for:
 *  - the OJT admin identity (signer of outbound bundles; root of trust
 *    on the local known-cert store)
 *  - the admin Signer (derived from admin identity's privkey)
 *  - the known-cert store (admin + any REA peers from env)
 *  - the handoff policy (file-backed allowlist from
 *    OJT_HANDOFF_POLICY_PATH, default ./config/handoff-policy.json)
 *
 * Lazy on purpose — Next.js routes import these at module load, so
 * reading env / the filesystem eagerly would break tests that set
 * env vars after import. Each helper memoizes its result in a
 * module-scope `let` so per-request cost is zero.
 *
 * Reset hook (`__resetFederationSingletonsForTests`) exists for the
 * test suite; do not call it from production code.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  createAllowlistHandoffPolicy,
  type HandoffPolicy,
  type KnownCertStore,
  type Signer,
} from "@semantos/session-protocol";

import {
  bootKnownCertStore,
  createOjtSigner,
  loadAdminIdentity,
  loadReaPeersFromEnv,
  type OjtIdentity,
} from "@/lib/identity";

// ── Admin identity ───────────────────────────────────────────────

let _adminIdentity: OjtIdentity | null = null;

export function adminIdentity(): OjtIdentity {
  if (!_adminIdentity) {
    _adminIdentity = loadAdminIdentity();
  }
  return _adminIdentity;
}

// ── Admin signer ─────────────────────────────────────────────────

let _adminSigner: Signer | null = null;

export function adminSigner(): Signer {
  if (!_adminSigner) {
    _adminSigner = createOjtSigner(adminIdentity());
  }
  return _adminSigner;
}

// ── Known-cert trust store ───────────────────────────────────────

let _trustStore: KnownCertStore | null = null;

export function trustStore(): KnownCertStore {
  if (!_trustStore) {
    _trustStore = bootKnownCertStore({
      adminId: adminIdentity(),
      reaPeers: loadReaPeersFromEnv(),
    });
  }
  return _trustStore;
}

// ── Handoff policy (file-backed allowlist) ───────────────────────

type HandoffPolicyFile = {
  canSend?: Record<string, string[]>;
  canReceive?: Record<string, string[]>;
  fallback?: "deny" | "allow";
};

let _handoffPolicy: HandoffPolicy | null = null;

function loadHandoffPolicyFromFile(): HandoffPolicy {
  const configPath =
    process.env.OJT_HANDOFF_POLICY_PATH ||
    path.join(process.cwd(), "config", "handoff-policy.json");

  let parsed: HandoffPolicyFile;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    parsed = JSON.parse(raw) as HandoffPolicyFile;
  } catch (err) {
    throw new Error(
      `handoffPolicy: failed to load ${configPath}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const canSend = new Map<string, Set<string>>();
  const canReceive = new Map<string, Set<string>>();

  for (const [objectId, certIds] of Object.entries(parsed.canSend ?? {})) {
    canSend.set(objectId, new Set(certIds));
  }
  for (const [objectId, certIds] of Object.entries(parsed.canReceive ?? {})) {
    canReceive.set(objectId, new Set(certIds));
  }

  return createAllowlistHandoffPolicy({
    canSend,
    canReceive,
    fallback: parsed.fallback ?? "deny",
  });
}

export function handoffPolicy(): HandoffPolicy {
  if (!_handoffPolicy) {
    _handoffPolicy = loadHandoffPolicyFromFile();
  }
  return _handoffPolicy;
}

// ── Test hook ────────────────────────────────────────────────────

/**
 * Clear all memoized singletons. For tests only — production code
 * must not call this.
 */
export function __resetFederationSingletonsForTests(): void {
  _adminIdentity = null;
  _adminSigner = null;
  _trustStore = null;
  _handoffPolicy = null;
}
