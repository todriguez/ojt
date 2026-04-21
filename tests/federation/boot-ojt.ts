/**
 * OJT test harness (D7.2) — bring the OJT Next.js route handlers up
 * on a real HTTP listener without needing a full `next start` boot.
 *
 * Why not `next start`:
 *   Next 16 wants a build first, pulls in middleware, the edge
 *   runtime, et cetera. For a gate test that just hits three
 *   endpoints, the overhead isn't worth it. Instead we import the
 *   `POST`/`GET` handler functions directly and serve them via
 *   `Bun.serve` (real HTTP — tests fetch() against it unchanged).
 *
 * Routes mounted:
 *   POST /api/v3/chat                      → src/app/api/v3/chat/route
 *                                            (dynamically imported only
 *                                            when G1/G2 actually need it)
 *   POST /api/v3/federation/bundle         → .../federation/bundle/route
 *   GET  /api/v3/jobs/:id/export           → .../jobs/[id]/export/route
 *   GET  /health                           → 200 OK (liveness)
 *
 * Returns `{ baseUrl, ojtCertRecord, close() }` — the test asks for
 * those three and never touches the server implementation directly.
 *
 * Env isolation: ALL OJT_ vars + ANTHROPIC_API_KEY + PGLITE_DATA_DIR
 * are set before any OJT module import (so `loadAdminIdentity` sees
 * the test fixture values) and restored on `close()`. DATABASE_URL is
 * explicitly deleted so the in-process DB picks PGlite against the
 * per-test temp directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPublicKey } from "@noble/secp256k1";

import type { CertRecord } from "@semantos/session-protocol";

// ── Fixture constants ───────────────────────────────────────────

/**
 * A stable 32-byte derivation seed. Re-used across e2e gate runs so
 * phone-derived identities collide across tests (they shouldn't —
 * every test uses a fresh jobId — but determinism is a nice
 * property when debugging).
 */
const FIXTURE_DERIVATION_SEED_HEX =
  "de1ab0dab0dab0dab0dab0dab0dab0dab0dab0dab0dab0dab0dab0dab0dab0da";

/**
 * Admin privkey for OJT. Different from http-edge.test.ts's fixture so
 * the two suites can run back-to-back without file-handle clashes if
 * they happen to share PGLITE_DATA_DIR (they don't, but belt +
 * braces).
 */
const OJT_ADMIN_PRIVKEY_HEX =
  "7777777777777777777777777777777777777777777777777777777777777777";

// ── Public contract ─────────────────────────────────────────────

export interface OjtTestHarness {
  /** `http://127.0.0.1:PORT` — fetch against this from the test. */
  baseUrl: string;
  /** The admin identity in CertRecord form (feeds the REA stub trust). */
  ojtCertRecord: CertRecord;
  /** The admin identity details — tests may need pubkey for recipient addressing. */
  ojtAdmin: {
    certId: string;
    pubkeyHex: string;
    privkeyHex: string;
    bca: string;
  };
  /** Path to the test-generated handoff policy JSON; tests rewrite it + reset singletons. */
  policyPath: string;
  /** Tear down listener + remove temp dir + restore env vars. */
  close(): Promise<void>;
}

export interface BootOjtOpts {
  /** Listener port (default 19080 — out of range of P3 + P4 tests). */
  port?: number;
  /** REA peer phone for OJT_REA_PEERS_JSON. Default matches spec fixture. */
  reaPeerPhone?: string;
}

// ── Impl ─────────────────────────────────────────────────────────

const DEFAULT_OJT_PORT = 19080;

export async function bootOjt(opts: BootOjtOpts = {}): Promise<OjtTestHarness> {
  const port = opts.port ?? DEFAULT_OJT_PORT;
  const reaPeerPhone = opts.reaPeerPhone ?? "+61400000099";

  // ── 1. Temp workspace + admin identity bytes ──────────────────
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ojt-p7-e2e-"));
  const policyPath = path.join(dataDir, "handoff-policy.json");
  const pgliteDir = path.join(dataDir, "pglite");

  const adminPubkeyHex = bytesToHex(
    getPublicKey(hexToBytes(OJT_ADMIN_PRIVKEY_HEX), true),
  );
  const adminCertId = bytesToHex(
    sha256(new TextEncoder().encode("ojt:admin:p7-e2e-gate")),
  );

  // Seed a starter policy — tests will rewrite this per-case.
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ canSend: {}, canReceive: {}, fallback: "deny" }),
  );

  // ── 2. Env isolation (snapshot → set → restore-on-close) ─────
  const envKeys = [
    "OJT_ADMIN_CERT_ID",
    "OJT_ADMIN_PUBKEY_HEX",
    "OJT_ADMIN_PRIVKEY_HEX",
    "OJT_ADMIN_BCA",
    "OJT_DERIVATION_SEED",
    "OJT_REA_PEERS_JSON",
    "OJT_HANDOFF_POLICY_PATH",
    "PGLITE_DATA_DIR",
    "DATABASE_URL",
    // Chat-service touchstones (set so module load doesn't throw even
    // when the chat route isn't exercised).
    "JWT_SECRET",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD_HASH",
    // ANTHROPIC_API_KEY is intentionally NOT overridden — if the real
    // env has it set, G1/G2 use it; if not, those gates skip.
  ];
  const envSnapshot: Record<string, string | undefined> = {};
  for (const k of envKeys) envSnapshot[k] = process.env[k];

  process.env.OJT_ADMIN_CERT_ID = adminCertId;
  process.env.OJT_ADMIN_PUBKEY_HEX = adminPubkeyHex;
  process.env.OJT_ADMIN_PRIVKEY_HEX = OJT_ADMIN_PRIVKEY_HEX;
  // Let loadAdminIdentity derive bca from pubkey — exercise that path.
  delete process.env.OJT_ADMIN_BCA;
  process.env.OJT_DERIVATION_SEED = FIXTURE_DERIVATION_SEED_HEX;
  process.env.OJT_REA_PEERS_JSON = JSON.stringify([{ phone: reaPeerPhone }]);
  process.env.OJT_HANDOFF_POLICY_PATH = policyPath;
  process.env.PGLITE_DATA_DIR = pgliteDir;
  delete process.env.DATABASE_URL;
  process.env.JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
  process.env.ADMIN_EMAIL = "todd@oddjobtodd.info";
  process.env.ADMIN_PASSWORD_HASH = "fakesalt:fakehash";

  // ── 3. Boot PGlite + migrate ─────────────────────────────────
  //
  // We open a throwaway PGlite connection against the temp dir so
  // drizzle-kit's embedded migrations run once. The client is then
  // closed — `getDb()` reopens the same dir when the route handler
  // first uses it.
  {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const pg = new PGlite(pgliteDir);
    await pg.waitReady;
    const db = drizzle(pg);
    await migrate(db as any, {
      migrationsFolder: path.join(process.cwd(), "drizzle"),
    });
    await pg.close();
  }

  // ── 4. Import federation route handlers + reset singletons ───
  //
  // Import order matters — singletons memoize on first call. We do a
  // reset immediately to guarantee the first request reads our env
  // (not whatever a prior test left lying around).
  const { __resetFederationSingletonsForTests, adminIdentity } = await import(
    "../../src/lib/federation/singletons"
  );
  __resetFederationSingletonsForTests();
  // Touch once to force env read + seed admin into the trust store.
  const admin = adminIdentity();

  const bundleRoute = await import(
    "../../src/app/api/v3/federation/bundle/route"
  );
  const exportRoute = await import(
    "../../src/app/api/v3/jobs/[id]/export/route"
  );

  // ── 5. Spin up the HTTP server ───────────────────────────────
  //
  // We use Bun.serve because createHttpTransport inside the REA stub
  // already relies on Bun. Keeping both halves on the same runtime
  // avoids surprise interop issues. The server delegates to the
  // Next route handlers with a lightweight Request/Response bridge.
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req: Request) {
      const url = new URL(req.url);

      // Liveness probe.
      if (url.pathname === "/health" && req.method === "GET") {
        return new Response("ok", { status: 200 });
      }

      // POST /api/v3/federation/bundle
      if (
        url.pathname === "/api/v3/federation/bundle" &&
        req.method === "POST"
      ) {
        // The route handler takes a NextRequest-ish; a plain
        // Request() satisfies the .json()/.headers/.url it uses.
        return bundleRoute.POST(req as any);
      }

      // GET /api/v3/jobs/:id/export
      const exportMatch = url.pathname.match(
        /^\/api\/v3\/jobs\/([^/]+)\/export$/,
      );
      if (exportMatch && req.method === "GET") {
        const id = decodeURIComponent(exportMatch[1]);
        return exportRoute.GET(req as any, { params: { id } });
      }

      // POST /api/v3/chat (only used when G1/G2 run with a live API key)
      if (url.pathname === "/api/v3/chat" && req.method === "POST") {
        // Lazy import — keeps the LLM code path out of the module
        // graph for test runs that don't touch it.
        const chatRoute = await import("../../src/app/api/v3/chat/route");
        return chatRoute.POST(req as any);
      }

      return new Response("not found", { status: 404 });
    },
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  // ── 6. Build the return value ────────────────────────────────
  const ojtCertRecord: CertRecord = {
    certId: admin.certId,
    publicKeyHex: admin.pubkeyHex,
    revoked: false,
  };

  async function close(): Promise<void> {
    server.stop(true);
    // Remove temp workspace.
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    // Restore env vars.
    for (const k of envKeys) {
      const prev = envSnapshot[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
    // Clear federation singletons so a subsequent boot in the same
    // process doesn't reuse a stale admin/trust store.
    __resetFederationSingletonsForTests();
  }

  return {
    baseUrl,
    ojtCertRecord,
    ojtAdmin: {
      certId: adminCertId,
      pubkeyHex: adminPubkeyHex,
      privkeyHex: OJT_ADMIN_PRIVKEY_HEX,
      bca: admin.bca,
    },
    policyPath,
    close,
  };
}

// ── Helper: rewrite handoff policy + reset singletons ──────────

export async function rewriteOjtHandoffPolicy(
  harness: OjtTestHarness,
  policy: {
    canSend?: Record<string, string[]>;
    canReceive?: Record<string, string[]>;
    fallback?: "deny" | "allow";
  },
): Promise<void> {
  fs.writeFileSync(harness.policyPath, JSON.stringify(policy));
  const { __resetFederationSingletonsForTests } = await import(
    "../../src/lib/federation/singletons"
  );
  __resetFederationSingletonsForTests();
}

// ── Helper: add a trusted peer cert to OJT's in-process store ──

export async function addPeerCertToOjtTrust(
  cert: CertRecord,
): Promise<void> {
  const { trustStore } = await import("../../src/lib/federation/singletons");
  await trustStore().add(cert);
}
