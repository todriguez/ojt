/**
 * OJT-PHASE-2 gate tests (G1..G8).
 *
 * Run: npx tsx --test tests/identity/identity.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  bytesToHex,
  hexToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPublicKey, sign, verify } from "@noble/secp256k1";

// ---- Fixture env ------------------------------------------------------
// A fixed 32-byte hex seed so G3 / phoneToIdentity reproduce across runs.
const FIXTURE_SEED_HEX =
  "d8c69a0b4a0e7c2f3e1b9d5a6c7e8f1213141516171819202122232425262728";

// A fixture admin keypair — privkey is a deterministic 32-byte value.
// Not a production key. Kept here so G4/G5/G8 can exercise
// loadAdminIdentity without network or external state.
const FIXTURE_ADMIN_PRIVKEY_HEX =
  "1111111111111111111111111111111111111111111111111111111111111111";
const FIXTURE_ADMIN_PUBKEY_HEX = bytesToHex(
  getPublicKey(hexToBytes(FIXTURE_ADMIN_PRIVKEY_HEX), true),
);
const FIXTURE_ADMIN_CERT_ID = bytesToHex(
  sha256(new TextEncoder().encode("ojt:admin:fixture")),
);

describe("OJT-PHASE-2 identity adapter", () => {
  before(() => {
    process.env.OJT_DERIVATION_SEED = FIXTURE_SEED_HEX;
    process.env.OJT_ADMIN_CERT_ID = FIXTURE_ADMIN_CERT_ID;
    process.env.OJT_ADMIN_PUBKEY_HEX = FIXTURE_ADMIN_PUBKEY_HEX;
    process.env.OJT_ADMIN_PRIVKEY_HEX = FIXTURE_ADMIN_PRIVKEY_HEX;
  });

  // G1 — normalization is stable across local / international forms.
  it("G1: normalizePhone collapses variants to a single E.164", async () => {
    const { normalizePhone } = await import("../../src/lib/identity");
    const local = normalizePhone("0412345678", "AU");
    const intl = normalizePhone("+61412345678");
    const spaced = normalizePhone("+61 412 345 678");
    assert.equal(local, "+61412345678");
    assert.equal(intl, "+61412345678");
    assert.equal(spaced, "+61412345678");
  });

  // G2 — certId is deterministic across invocations.
  it("G2: certIdFromPhone is deterministic", async () => {
    const { certIdFromPhone } = await import("../../src/lib/identity");
    const a = certIdFromPhone("+61412345678", "tenant");
    const b = certIdFromPhone("0412345678", "tenant");
    const c = certIdFromPhone("+61 412 345 678", "tenant");
    assert.equal(a, b);
    assert.equal(a, c);
    assert.equal(a.length, 64);
    assert.match(a, /^[0-9a-f]{64}$/);

    // Different role → different certId.
    const rea = certIdFromPhone("+61412345678", "rea");
    assert.notEqual(a, rea);
  });

  // G3 — pubkey derivation is deterministic + correct length.
  it("G3: derivePubkeyHexFromPhone is deterministic and 66 chars hex", async () => {
    const { derivePubkeyHexFromPhone } = await import(
      "../../src/lib/identity"
    );
    const seed = hexToBytes(FIXTURE_SEED_HEX);
    const p1 = derivePubkeyHexFromPhone("+61412345678", "tenant", seed);
    const p2 = derivePubkeyHexFromPhone("+61412345678", "tenant", seed);
    assert.equal(p1, p2);
    assert.equal(p1.length, 66);
    assert.match(p1, /^[0-9a-f]{66}$/);

    // Different role → different pubkey under same seed+phone.
    const rea = derivePubkeyHexFromPhone("+61412345678", "rea", seed);
    assert.notEqual(p1, rea);

    // Different seed → different pubkey.
    const otherSeed = new Uint8Array(32).fill(7);
    const p3 = derivePubkeyHexFromPhone("+61412345678", "tenant", otherSeed);
    assert.notEqual(p1, p3);
  });

  // G4 — loadAdminIdentity is strict on env.
  it("G4: loadAdminIdentity throws when any required env var is missing", async () => {
    const { loadAdminIdentity } = await import("../../src/lib/identity");

    // Happy path first — confirms the fixtures are wired up.
    const ok = loadAdminIdentity();
    assert.equal(ok.certId, FIXTURE_ADMIN_CERT_ID);
    assert.equal(ok.pubkeyHex, FIXTURE_ADMIN_PUBKEY_HEX);
    assert.equal(ok.privkeyHex, FIXTURE_ADMIN_PRIVKEY_HEX);
    assert.equal(ok.facetId, "admin");
    assert.ok(ok.bca.length > 0);

    for (const envVar of [
      "OJT_ADMIN_CERT_ID",
      "OJT_ADMIN_PUBKEY_HEX",
      "OJT_ADMIN_PRIVKEY_HEX",
    ]) {
      const saved = process.env[envVar];
      delete process.env[envVar];
      try {
        assert.throws(
          () => loadAdminIdentity(),
          new RegExp(envVar),
          `loadAdminIdentity should throw when ${envVar} is missing`,
        );
      } finally {
        process.env[envVar] = saved;
      }
    }
  });

  // G5 — phone-derived identities never carry a privkey.
  it("G5: phoneToIdentity returns privkeyHex === ''", async () => {
    const { phoneToIdentity } = await import("../../src/lib/identity");
    const tenant = phoneToIdentity("+61412345678", "tenant");
    const rea = phoneToIdentity("+61412345678", "rea");

    assert.equal(tenant.privkeyHex, "");
    assert.equal(rea.privkeyHex, "");
    assert.equal(tenant.facetId, "tenant:+61412345678");
    assert.equal(rea.facetId, "rea:+61412345678");
    assert.ok(tenant.certId !== rea.certId);
    assert.ok(tenant.pubkeyHex !== rea.pubkeyHex);
  });

  // G6 — identityToCertRecord satisfies CertRecord structurally.
  it("G6: identityToCertRecord is assignable to CertRecord", async () => {
    const { identityToCertRecord, loadAdminIdentity } = await import(
      "../../src/lib/identity"
    );
    const { type } = await import("@semantos/session-protocol").then(() => ({
      type: null as never,
    })).catch(() => ({ type: null as never }));
    void type;

    const admin = loadAdminIdentity();
    const rec = identityToCertRecord(admin);
    // Compile-time check via import of CertRecord:
    type AssertAssignable = import("@semantos/session-protocol").CertRecord;
    const _check: AssertAssignable = rec;
    assert.equal(_check.certId, admin.certId);
    assert.equal(_check.publicKeyHex, admin.pubkeyHex);
    assert.equal(_check.revoked, false);
  });

  // G7 — bootKnownCertStore seeds admin + REA peers.
  it("G7: bootKnownCertStore has admin and peers", async () => {
    const { bootKnownCertStore, loadAdminIdentity, phoneToIdentity } =
      await import("../../src/lib/identity");
    const admin = loadAdminIdentity();
    const peer1 = phoneToIdentity("+61411111111", "rea");
    const peer2 = phoneToIdentity("+61422222222", "rea");
    const store = bootKnownCertStore({
      adminId: admin,
      reaPeers: [peer1, peer2],
    });
    assert.equal(await store.has(admin.certId), true);
    assert.equal(await store.has(peer1.certId), true);
    assert.equal(await store.has(peer2.certId), true);

    const got = await store.get(admin.certId);
    assert.ok(got);
    assert.equal(got!.publicKeyHex, admin.pubkeyHex);
  });

  // G8 — a signed bundle from createOjtSigner(admin) verifies against
  //      the bootstrapped store via verifyBundleWithTrust.
  it("G8: createOjtSigner produces a bundle that verifies against the store", async () => {
    const {
      bootKnownCertStore,
      loadAdminIdentity,
      createOjtSigner,
    } = await import("../../src/lib/identity");
    const sp = await import("@semantos/session-protocol");

    const admin = loadAdminIdentity();
    const store = bootKnownCertStore({ adminId: admin });
    const signer = createOjtSigner(admin);

    const payload = { kind: "ojt-p2-test", nonce: "g8-smoke" };
    const bundle = await sp.signBundle(payload, signer);
    assert.equal(bundle.signer.certId, admin.certId);
    assert.equal(bundle.signer.pubkeyHex, admin.pubkeyHex);

    const verifier = new sp.BsvSdkVerifier();
    const result = await sp.verifyBundleWithTrust(bundle, verifier, store);
    assert.equal(result.ok, true, `verifyBundleWithTrust failed: ${
      result.ok ? "" : `${(result as { code: string }).code} — ${(result as { message: string }).message}`
    }`);
    if (result.ok) {
      assert.deepEqual(result.payload, payload);
      assert.equal(result.cert.certId, admin.certId);
    }

    // Secondary independent check via raw secp256k1: a fresh signature over
    // a known message verifies with the pubkey we stored. Documented
    // alongside G8 since it exercises the same bridge without depending on
    // the envelope implementation.
    const msg = randomBytes(32);
    const sig = await sign(msg, hexToBytes(admin.privkeyHex));
    assert.equal(await verify(sig, msg, hexToBytes(admin.pubkeyHex)), true);
  });
});
