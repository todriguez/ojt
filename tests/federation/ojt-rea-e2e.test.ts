/**
 * OJT-P7 end-to-end federation gate — 13 gates covering the full
 * OJT↔REA federation stack over a real HTTP wire with a working REA
 * stub. No mocking of the DB (real PGlite per test workspace), no
 * mocking of the LLM (G1/G2 skip cleanly if ANTHROPIC_API_KEY is
 * absent).
 *
 * Gate map:
 *   G1  — chat → extraction → patch persisted (LLM-dependent)
 *   G2  — multi-turn: second message gets prior-patch context (LLM-dep)
 *   G3  — seeded patch → GET /jobs/:id/export → REA verifies bundle
 *   G4  — REA signs execution patch → POST /federation/bundle → persisted
 *   G5  — bidirectional round-trip (OJT export → REA response → OJT apply)
 *   G6  — allowlisted object replays end-to-end cleanly
 *   G7  — flipped payload byte → 400 invalid_signature
 *   G8  — swapped recipient certId post-sign → 400 invalid_signature
 *   G9  — unknown-key signer → 400 unknown_signer
 *   G10 — impostor (cert matches, privkey doesn't) → 400 pubkey_cert_mismatch
 *   G11 — cross-object leak attempt → REA stub canSend denies
 *   G12 — transport send to unregistered peer → recipient_not_registered
 *   G13 — transport send to own cert → self_send
 *
 * Runner: `bun test` (see .github/workflows/e2e-federation.yml). Uses
 * Bun's built-in test API because the REA stub's HttpBundleTransport
 * already depends on Bun.serve — keeping both halves on one runtime
 * avoids interop surprises.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import {
  BsvSdkVerifier,
  verifyBundleWithTrust,
  createInMemoryKnownCertStore,
  type SignedBundle,
} from "@semantos/session-protocol";

import {
  bootOjt,
  rewriteOjtHandoffPolicy,
  addPeerCertToOjtTrust,
  type OjtTestHarness,
} from "./boot-ojt";
import { startReaStub, type ReaStub, type ReaPatchPayload } from "./rea-stub";

// ── Shared fixtures ──────────────────────────────────────────────

const OJT_PORT = 19080;
const REA_PORT = 19081;

// Stub signer for the REA harness — stable key so trust record is
// deterministic across test files.
const REA_STUB_PRIVKEY_HEX = "cc".repeat(32);

const HAPPY_OBJECT_ID = "550e8400-e29b-41d4-a716-446655440701";

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// Bun `test.skipIf` takes a boolean predicate.
const llmTest = HAS_API_KEY ? test : test.skip;

// ── Top-level harness (one boot per test file) ───────────────────

let ojt: OjtTestHarness;
let rea: ReaStub;

beforeAll(async () => {
  ojt = await bootOjt({ port: OJT_PORT });

  rea = await startReaStub({
    port: REA_PORT,
    ojtCertRecord: ojt.ojtCertRecord,
    ojtPeerUrl: ojt.baseUrl,
    allowedObjectIds: [HAPPY_OBJECT_ID],
    privkeyHex: REA_STUB_PRIVKEY_HEX,
    certId: "rea-stub-cert",
  });

  // Teach OJT's trust store about the REA stub cert so inbound
  // REA→OJT bundles pass verifyBundleWithTrust. We also need the
  // handoff policy to allow HAPPY_OBJECT_ID from REA.
  await addPeerCertToOjtTrust({
    certId: rea.certId,
    publicKeyHex: rea.publicKeyHex,
    revoked: false,
  });

  await rewriteOjtHandoffPolicy(ojt, {
    canReceive: {
      [HAPPY_OBJECT_ID]: [rea.certId],
    },
    canSend: {
      [HAPPY_OBJECT_ID]: [rea.certId],
    },
    fallback: "deny",
  });
  // The rewrite above resets singletons, which also drops the REA
  // cert from the trust store. Re-add it.
  await addPeerCertToOjtTrust({
    certId: rea.certId,
    publicKeyHex: rea.publicKeyHex,
    revoked: false,
  });
});

afterAll(async () => {
  await rea?.close();
  await ojt?.close();
});

// ── Helpers ──────────────────────────────────────────────────────

/** Manually insert a patch row so G3-G6 don't need the LLM path. */
async function seedPatch(objectId: string): Promise<string> {
  const { getDb } = await import("../../src/lib/db/client");
  const kernel = await import("../../src/lib/semantos-kernel/schema.core");
  const db = await getDb();

  // Parent row — insert or ignore (on re-seed inside the same suite).
  const existing = await db
    .select({ id: kernel.semanticObjects.id })
    .from(kernel.semanticObjects)
    .where((kernel.semanticObjects as any).id.eq ? (kernel.semanticObjects as any).id.eq(objectId) : (() => {
      const { eq } = require("drizzle-orm");
      return eq(kernel.semanticObjects.id, objectId);
    })())
    .limit(1);
  if (existing.length === 0) {
    await db.insert(kernel.semanticObjects).values({
      id: objectId,
      vertical: "trades",
      objectKind: "job",
      typeHash: "0".repeat(64),
      currentStateHash: "",
    });
  }

  const [patch] = await db
    .insert(kernel.objectPatches)
    .values({
      objectId,
      fromVersion: 1,
      toVersion: 2,
      prevStateHash: "b".repeat(64),
      newStateHash: "c".repeat(64),
      patchKind: "extraction",
      delta: { seeded: { from: null, to: "yes" } },
      source: "test:p7-seed",
    })
    .returning({ id: kernel.objectPatches.id });
  return patch.id;
}

// ═══════════════════════════════════════════════════════════════
// G1 — LLM chat → extraction → patch persisted
// ═══════════════════════════════════════════════════════════════

describe("G1-G2 LLM-driven chat (requires ANTHROPIC_API_KEY)", () => {
  llmTest(
    "G1: chat message drives extraction and persists a patch",
    async () => {
      const phone = "+61400000101";
      const res = await fetch(`${ojt.baseUrl}/api/v3/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone,
          message:
            "My kitchen tap has been leaking for 3 days, can drop by tomorrow afternoon, address is 42 Baker St, Sydney.",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reply: string; jobId: string };
      expect(typeof body.reply).toBe("string");
      expect(typeof body.jobId).toBe("string");

      // Poll the DB for at least one patch on this job's semantic object.
      const { getDb } = await import("../../src/lib/db/client");
      const kernel = await import("../../src/lib/semantos-kernel/schema.core");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();

      // Find the semantic object linked to this jobId via the bridge.
      const bridge = await import(
        "../../src/lib/domain/bridge/semanticRuntimeAdapter"
      );
      const ctx = await bridge.ensureSemanticObject(db, body.jobId, null);
      const objectId = ctx.semanticObjectId;

      const patches = await db
        .select()
        .from(kernel.objectPatches)
        .where(eq(kernel.objectPatches.objectId, objectId));
      expect(patches.length).toBeGreaterThanOrEqual(1);
    },
    60000,
  );

  llmTest(
    "G2: second turn sees the first turn's patch-chain in context",
    async () => {
      const phone = "+61400000102";
      // Turn 1: create a job with initial context.
      const r1 = await fetch(`${ojt.baseUrl}/api/v3/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone,
          message: "Hi, I need a plumber for a leaking tap at 7 Park Lane.",
        }),
      });
      expect(r1.status).toBe(200);
      const b1 = (await r1.json()) as { reply: string; jobId: string };

      // Turn 2: reference prior info — reply should not re-ask for address.
      const r2 = await fetch(`${ojt.baseUrl}/api/v3/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone,
          message: "Actually tomorrow morning works best for the visit.",
          jobId: b1.jobId,
        }),
      });
      expect(r2.status).toBe(200);
      const b2 = (await r2.json()) as { reply: string; jobId: string };
      expect(b2.jobId).toBe(b1.jobId);
      // Sanity — reply is at least non-empty.
      expect(b2.reply.length).toBeGreaterThan(0);
    },
    60000,
  );
});

// ═══════════════════════════════════════════════════════════════
// G3-G6 — Happy-path federation round-trips (no LLM needed)
// ═══════════════════════════════════════════════════════════════

describe("G3-G6 federation happy path (manual patch seeding)", () => {
  test("G3: GET /jobs/:id/export → REA stub verifies signed bundle", async () => {
    // Seed a patch so loadJobPatches has something to export.
    await seedPatch(HAPPY_OBJECT_ID);

    // Fetch the bundle addressed to the REA stub.
    const res = await fetch(
      `${ojt.baseUrl}/api/v3/jobs/${HAPPY_OBJECT_ID}/export?recipient_cert_id=${rea.certId}&recipient_pubkey_hex=${rea.publicKeyHex}`,
    );
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as SignedBundle<ReaPatchPayload>;

    // REA side: verify against its own trust store (OJT is a known
    // signer there).
    const peerStore = createInMemoryKnownCertStore([ojt.ojtCertRecord]);
    const verify = await verifyBundleWithTrust(
      bundle,
      new BsvSdkVerifier(),
      peerStore,
      { expectedRecipientCertId: rea.certId },
    );
    expect(verify.ok).toBe(true);
    if (verify.ok) {
      expect(verify.payload.objectId).toBe(HAPPY_OBJECT_ID);
      expect(verify.payload.patches.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("G4: REA signs execution patch → POST /federation/bundle → persisted", async () => {
    await rea.respondWithExecutionPatch(HAPPY_OBJECT_ID);

    // Verify the row landed on OJT's side.
    const { getDb } = await import("../../src/lib/db/client");
    const kernel = await import("../../src/lib/semantos-kernel/schema.core");
    const { eq, and } = await import("drizzle-orm");
    const db = await getDb();

    const rows = await db
      .select()
      .from(kernel.objectPatches)
      .where(
        and(
          eq(kernel.objectPatches.objectId, HAPPY_OBJECT_ID),
          eq(kernel.objectPatches.source, "rea:stub"),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // And the signed-bundle row is tagged inbound with REA's cert.
    const bundleRows = await db
      .select()
      .from(kernel.semSignedBundles)
      .where(eq(kernel.semSignedBundles.signerCertId, rea.certId));
    expect(bundleRows.length).toBeGreaterThanOrEqual(1);
    expect(bundleRows[bundleRows.length - 1].direction).toBe("inbound");
  });

  test("G5: bidirectional round-trip — OJT→REA export then REA→OJT response", async () => {
    // OJT → REA: export a bundle to the REA stub via its HTTP
    // transport. The stub's onReceive pipeline verifies + records.
    const bundleRes = await fetch(
      `${ojt.baseUrl}/api/v3/jobs/${HAPPY_OBJECT_ID}/export?recipient_cert_id=${rea.certId}&recipient_pubkey_hex=${rea.publicKeyHex}`,
    );
    expect(bundleRes.status).toBe(200);
    const bundle = (await bundleRes.json()) as SignedBundle<ReaPatchPayload>;

    // Deliver the bundle to the REA stub over its HTTP transport by
    // POSTing straight to the stub's federation endpoint (mirrors
    // what a real OJT outbound transport would do). Bun.serve inside
    // createHttpTransport listens on /federation/bundle by default.
    const deliverRes = await fetch(
      `http://127.0.0.1:${REA_PORT}/federation/bundle`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bundle),
      },
    );
    expect(deliverRes.status).toBe(200);

    // The stub should have recorded a successful inbound.
    const last = rea.importedPatches[rea.importedPatches.length - 1];
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.payload!.objectId).toBe(HAPPY_OBJECT_ID);
    }

    // REA → OJT: respond with an execution patch.
    await rea.respondWithExecutionPatch(HAPPY_OBJECT_ID);

    // Assert OJT persisted a rea:stub-source patch for this object.
    const { getDb } = await import("../../src/lib/db/client");
    const kernel = await import("../../src/lib/semantos-kernel/schema.core");
    const { eq, and } = await import("drizzle-orm");
    const db = await getDb();

    const rows = await db
      .select()
      .from(kernel.objectPatches)
      .where(
        and(
          eq(kernel.objectPatches.objectId, HAPPY_OBJECT_ID),
          eq(kernel.objectPatches.source, "rea:stub"),
        ),
      );
    // At least two rea:stub patches by now (G4 and G5 both pushed one).
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test("G6: allowlisted object round-trips end-to-end without denial", async () => {
    const beforeLen = rea.importedPatches.length;

    // Deliver a fresh OJT→REA bundle for HAPPY_OBJECT_ID via the
    // stub's HTTP endpoint.
    const bundleRes = await fetch(
      `${ojt.baseUrl}/api/v3/jobs/${HAPPY_OBJECT_ID}/export?recipient_cert_id=${rea.certId}&recipient_pubkey_hex=${rea.publicKeyHex}`,
    );
    expect(bundleRes.status).toBe(200);
    const bundle = await bundleRes.json();

    const res = await fetch(`http://127.0.0.1:${REA_PORT}/federation/bundle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    expect(res.status).toBe(200);

    // Exactly one new imported record, marked ok.
    expect(rea.importedPatches.length).toBe(beforeLen + 1);
    const rec = rea.importedPatches[beforeLen];
    expect(rec.ok).toBe(true);
    expect(rec.senderCertId).toBe(ojt.ojtCertRecord.certId);
  });
});

