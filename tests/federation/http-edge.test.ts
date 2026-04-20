/**
 * OJT-P4 gate tests for the /api/v3 HTTP edge.
 *
 * Runner: node:test (via `npx tsx --test`).
 *
 * 8 gates:
 *   G1 /api/v3/chat accepts {phone, message} and returns reply
 *   G2 /api/v3/chat rejects missing phone (400 bad_request)
 *   G3 /api/v3/federation/bundle rejects invalid signature (400)
 *   G4 /api/v3/federation/bundle rejects unknown signer (400 unknown_signer)
 *   G5 /api/v3/federation/bundle rejects policy denial (403)
 *   G6 /api/v3/federation/bundle atomic persistence on success
 *   G7 /api/v3/jobs/:id/export returns bundle verifiable by verifyBundleWithTrust
 *   G8 /api/v3/jobs/:id/export 404 when jobId has no patches
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  bytesToHex,
  hexToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPublicKey } from "@noble/secp256k1";

// ── Deterministic fixture keys — set BEFORE any app import ──────

const FIXTURE_SEED_HEX =
  "d8c69a0b4a0e7c2f3e1b9d5a6c7e8f1213141516171819202122232425262728";
const ADMIN_PRIVKEY_HEX =
  "2222222222222222222222222222222222222222222222222222222222222222";
const ADMIN_PUBKEY_HEX = bytesToHex(
  getPublicKey(hexToBytes(ADMIN_PRIVKEY_HEX), true),
);
const ADMIN_CERT_ID = bytesToHex(
  sha256(new TextEncoder().encode("ojt:admin:p4-http-edge")),
);

const PEER_PRIVKEY_HEX =
  "3333333333333333333333333333333333333333333333333333333333333333";
const PEER_PUBKEY_HEX = bytesToHex(
  getPublicKey(hexToBytes(PEER_PRIVKEY_HEX), true),
);
const PEER_CERT_ID = bytesToHex(
  sha256(new TextEncoder().encode("ojt:rea:p4-http-edge")),
);

// Distinct unknown peer whose cert is NOT added to the trust store.
const UNKNOWN_PRIVKEY_HEX =
  "4444444444444444444444444444444444444444444444444444444444444444";
const UNKNOWN_PUBKEY_HEX = bytesToHex(
  getPublicKey(hexToBytes(UNKNOWN_PRIVKEY_HEX), true),
);
const UNKNOWN_CERT_ID = bytesToHex(
  sha256(new TextEncoder().encode("ojt:rea:unknown")),
);

// ── Test workspace ──────────────────────────────────────────────

let DATA_DIR: string;
let POLICY_PATH: string;

before(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ojt-p4-http-"));
  POLICY_PATH = path.join(DATA_DIR, "handoff-policy.json");

  // Env: pglite, admin identity, handoff policy.
  process.env.PGLITE_DATA_DIR = path.join(DATA_DIR, "pglite");
  process.env.OJT_DERIVATION_SEED = FIXTURE_SEED_HEX;
  process.env.OJT_ADMIN_CERT_ID = ADMIN_CERT_ID;
  process.env.OJT_ADMIN_PUBKEY_HEX = ADMIN_PUBKEY_HEX;
  process.env.OJT_ADMIN_PRIVKEY_HEX = ADMIN_PRIVKEY_HEX;
  process.env.OJT_HANDOFF_POLICY_PATH = POLICY_PATH;
  // No REA peers in env — we'll add peer manually to the store.
  process.env.OJT_REA_PEERS_JSON = "[]";
  // Ensure we stay on pglite.
  delete process.env.DATABASE_URL;

  // Minimum stubs for chatService / logger modules imported elsewhere.
  process.env.JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
  process.env.ADMIN_EMAIL = "todd@oddjobtodd.info";
  process.env.ADMIN_PASSWORD_HASH = "fakesalt:fakehash";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

  // Seed an empty handoff policy — tests rewrite it then reset
  // singletons.
  fs.writeFileSync(
    POLICY_PATH,
    JSON.stringify({ canSend: {}, canReceive: {} }),
  );
});

after(() => {
  if (DATA_DIR && fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  // PGlite keeps an open file handle through the module-scope getDb
  // singleton; node:test's file-level watchdog would otherwise time
  // out waiting for the process to idle. Force exit once assertions
  // have all settled.
  setImmediate(() => process.exit(0));
});

// ── Helper: boot a PGlite DB, run migrations, expose to app code ─

async function bootPgliteAndMigrate(): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(process.env.PGLITE_DATA_DIR!);
  await client.waitReady;
  const db = drizzle(client);
  await migrate(db as any, {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
  await client.close();
}

async function resetSingletons(): Promise<void> {
  const { __resetFederationSingletonsForTests } = await import(
    "../../src/lib/federation/singletons"
  );
  __resetFederationSingletonsForTests();
}

async function rewritePolicy(
  policy: {
    canReceive?: Record<string, string[]>;
    canSend?: Record<string, string[]>;
    fallback?: "deny" | "allow";
  },
): Promise<void> {
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policy));
  await resetSingletons();
}

// ── DB boot runs once before all tests ──────────────────────────

before(async () => {
  await bootPgliteAndMigrate();
});

// ── G1 + G2: /api/v3/chat contract ─────────────────────────────

describe("G1/G2 /api/v3/chat", () => {
  beforeEach(async () => {
    await resetSingletons();
    const chat = await import("../../src/lib/services/chatService");
    // Stub handleTenantMessage so the edge test doesn't pull in
    // Anthropic + the full extraction pipeline.
    chat.__setHandleTenantMessageForTests(async (input) => ({
      reply: `echo:${input.message} [facet=${input.identity.facetId}]`,
      jobId: input.jobId ?? "job-stub-1",
    }));
  });

  it("G1: accepts {phone, message} and returns reply", async () => {
    const { POST } = await import("../../src/app/api/v3/chat/route");
    const req = new Request("http://local/api/v3/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: "+61412345678",
        message: "hello from chat",
      }),
    });
    const res = await POST(req as any);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.reply, "string");
    assert.match(body.reply, /hello from chat/);
    assert.equal(typeof body.jobId, "string");
  });

  it("G2: rejects missing phone (400 bad_request)", async () => {
    const { POST } = await import("../../src/app/api/v3/chat/route");
    const req = new Request("http://local/api/v3/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "no phone here" }),
    });
    const res = await POST(req as any);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "bad_request");
  });
});

// ── Federation tests: signer helpers ────────────────────────────

async function signBundleAs(
  privkeyHex: string,
  certId: string,
  payload: unknown,
  recipient: { certId: string; pubkeyHex: string },
) {
  const {
    StubSigner,
    signBundle,
  } = await import("@semantos/session-protocol");
  const signer = new StubSigner(privkeyHex, certId);
  return signBundle(payload, signer, { recipient });
}

// Add a trusted peer cert to the in-process known-cert store.
async function addPeerToTrust(): Promise<void> {
  const {
    trustStore,
  } = await import("../../src/lib/federation/singletons");
  const store = trustStore();
  await store.add({
    certId: PEER_CERT_ID,
    publicKeyHex: PEER_PUBKEY_HEX,
    revoked: false,
  });
}

// ── G3: invalid signature ──────────────────────────────────────

describe("G3/G4/G5/G6 /api/v3/federation/bundle", () => {
  const OBJECT_ID_G5 = "550e8400-e29b-41d4-a716-446655440005"; // not in allowlist
  const OBJECT_ID_G6 = "550e8400-e29b-41d4-a716-446655440006"; // in allowlist

  beforeEach(async () => {
    // Default policy: permit OBJECT_ID_G6 from PEER_CERT_ID, deny others.
    await rewritePolicy({
      canReceive: {
        [OBJECT_ID_G6]: [PEER_CERT_ID],
      },
      canSend: {},
      fallback: "deny",
    });
    await addPeerToTrust();
  });

  function samplePayload(objectId: string) {
    return {
      objectId,
      patches: [
        {
          objectId,
          fromVersion: 1,
          toVersion: 2,
          prevStateHash: "b".repeat(64),
          newStateHash: "c".repeat(64),
          patchKind: "extraction" as const,
          delta: { foo: { from: null, to: 1 } },
          deltaCount: 1,
          source: "user:p4-test",
          timestamp: Date.now(),
          facetId: "rea:+61499000001",
          lexicon: "jural",
        },
      ],
    };
  }

  it("G3: rejects invalid signature (400)", async () => {
    const { POST } = await import(
      "../../src/app/api/v3/federation/bundle/route"
    );
    const bundle = await signBundleAs(
      PEER_PRIVKEY_HEX,
      PEER_CERT_ID,
      samplePayload(OBJECT_ID_G6),
      { certId: ADMIN_CERT_ID, pubkeyHex: ADMIN_PUBKEY_HEX },
    );
    // Tamper the signature hex.
    bundle.signature = "ff".repeat(70);
    const req = new Request("http://local/api/v3/federation/bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    const res = await POST(req as any);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(
      /invalid_signature|bad_signature_encoding/.test(body.code),
      `expected invalid_signature/bad_signature_encoding, got ${body.code}`,
    );
  });

  it("G4: rejects unknown signer (400 unknown_signer)", async () => {
    const { POST } = await import(
      "../../src/app/api/v3/federation/bundle/route"
    );
    // Signed by UNKNOWN_PRIVKEY_HEX — cert NOT in trust store.
    const bundle = await signBundleAs(
      UNKNOWN_PRIVKEY_HEX,
      UNKNOWN_CERT_ID,
      samplePayload(OBJECT_ID_G6),
      { certId: ADMIN_CERT_ID, pubkeyHex: ADMIN_PUBKEY_HEX },
    );
    const req = new Request("http://local/api/v3/federation/bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    const res = await POST(req as any);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "unknown_signer");
  });

  it("G5: rejects policy denial (403)", async () => {
    const { POST } = await import(
      "../../src/app/api/v3/federation/bundle/route"
    );
    // Use OBJECT_ID_G5 — NOT in the canReceive allowlist → fallback=deny.
    const bundle = await signBundleAs(
      PEER_PRIVKEY_HEX,
      PEER_CERT_ID,
      samplePayload(OBJECT_ID_G5),
      { certId: ADMIN_CERT_ID, pubkeyHex: ADMIN_PUBKEY_HEX },
    );
    const req = new Request("http://local/api/v3/federation/bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    const res = await POST(req as any);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(
      typeof body.code === "string" && body.code.length > 0,
      `expected a policy-reason code, got ${body.code}`,
    );
  });

  it("G6: atomic persistence on success (200, rows in both tables)", async () => {
    const { POST } = await import(
      "../../src/app/api/v3/federation/bundle/route"
    );
    const bundle = await signBundleAs(
      PEER_PRIVKEY_HEX,
      PEER_CERT_ID,
      samplePayload(OBJECT_ID_G6),
      { certId: ADMIN_CERT_ID, pubkeyHex: ADMIN_PUBKEY_HEX },
    );
    const req = new Request("http://local/api/v3/federation/bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    const res = await POST(req as any);
    assert.equal(res.status, 200, `body: ${await res.clone().text()}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.patchIds.length, 1);
    assert.equal(body.bundleIds.length, 1);

    // Verify both rows landed.
    const { getDb } = await import("../../src/lib/db/client");
    const kernel = await import("../../src/lib/semantos-kernel/schema.core");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();

    const patchRows = await db
      .select()
      .from(kernel.objectPatches)
      .where(eq(kernel.objectPatches.id, body.patchIds[0]));
    assert.equal(patchRows.length, 1);

    const bundleRows = await db
      .select()
      .from(kernel.semSignedBundles)
      .where(eq(kernel.semSignedBundles.id, body.bundleIds[0]));
    assert.equal(bundleRows.length, 1);
    assert.equal(bundleRows[0].direction, "inbound");
    assert.equal(bundleRows[0].signerCertId, PEER_CERT_ID);
  });
});

// ── G7/G8 export ───────────────────────────────────────────────

describe("G7/G8 /api/v3/jobs/:id/export", () => {
  const OBJECT_ID_G7 = "550e8400-e29b-41d4-a716-446655440007";
  const OBJECT_ID_G8 = "550e8400-e29b-41d4-a716-446655440008";

  before(async () => {
    // Seed one object + one patch for G7 (export should find it).
    const { getDb } = await import("../../src/lib/db/client");
    const kernel = await import("../../src/lib/semantos-kernel/schema.core");
    const db = await getDb();

    await db.insert(kernel.semanticObjects).values({
      id: OBJECT_ID_G7,
      vertical: "trades",
      objectKind: "job",
      typeHash: "0".repeat(64),
      currentStateHash: "",
    });

    await db.insert(kernel.objectPatches).values({
      objectId: OBJECT_ID_G7,
      fromVersion: 1,
      toVersion: 2,
      prevStateHash: "b".repeat(64),
      newStateHash: "c".repeat(64),
      patchKind: "extraction",
      delta: { foo: { from: null, to: 1 } },
      source: "user:p4-export-seed",
    });
  });

  beforeEach(async () => {
    await resetSingletons();
  });

  it("G7: returns a bundle that verifyBundleWithTrust accepts", async () => {
    const { GET } = await import(
      "../../src/app/api/v3/jobs/[id]/export/route"
    );
    const req = new Request(
      `http://local/api/v3/jobs/${OBJECT_ID_G7}/export?recipient_cert_id=${PEER_CERT_ID}&recipient_pubkey_hex=${PEER_PUBKEY_HEX}`,
    );
    const res = await GET(req as any, { params: { id: OBJECT_ID_G7 } });
    assert.equal(res.status, 200, `body: ${await res.clone().text()}`);
    const bundle = await res.json();

    // Recipient has its own trust store with ADMIN as a known signer.
    const {
      createInMemoryKnownCertStore,
      verifyBundleWithTrust,
      BsvSdkVerifier,
    } = await import("@semantos/session-protocol");

    const peerStore = createInMemoryKnownCertStore([
      {
        certId: ADMIN_CERT_ID,
        publicKeyHex: ADMIN_PUBKEY_HEX,
        revoked: false,
      },
    ]);

    const verify = await verifyBundleWithTrust(
      bundle,
      new BsvSdkVerifier(),
      peerStore,
      { expectedRecipientCertId: PEER_CERT_ID },
    );
    assert.equal(
      verify.ok,
      true,
      `verify failed: ${!verify.ok ? verify.code : ""}`,
    );
    if (verify.ok) {
      assert.equal(verify.payload.objectId, OBJECT_ID_G7);
      assert.ok(verify.payload.patches.length >= 1);
    }
  });

  it("G8: 404 when jobId has no patches", async () => {
    const { GET } = await import(
      "../../src/app/api/v3/jobs/[id]/export/route"
    );
    const req = new Request(
      `http://local/api/v3/jobs/${OBJECT_ID_G8}/export?recipient_cert_id=${PEER_CERT_ID}&recipient_pubkey_hex=${PEER_PUBKEY_HEX}`,
    );
    const res = await GET(req as any, { params: { id: OBJECT_ID_G8 } });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "not_found");
  });
});
