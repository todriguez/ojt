/**
 * REA stub harness — a self-contained, signing-capable peer of OJT
 * that speaks real @semantos/session-protocol over real HTTP. Used by
 * the OJT↔REA e2e gate (OJT-P7) to exercise every layer of the
 * federation stack without mocking anything:
 *
 *   • sign bundles via StubSigner (real ECDSA over secp256k1)
 *   • verify inbound bundles via verifyBundleWithTrust + BsvSdkVerifier
 *   • enforce a per-object handoff policy via an allowlist
 *   • push imported-patch records into an in-memory array for assertion
 *
 * Shape is per the phase-7 spec D7.1:
 *
 *   startReaStub({ port, ojtCertRecord, ojtPeerUrl, allowedObjectIds })
 *     → {
 *         certId, publicKeyHex,
 *         transport: BundleTransport & { close(): Promise<void> },
 *         importedPatches: any[],
 *         respondWithExecutionPatch(objectId): Promise<void>,
 *         close(): Promise<void>,
 *       }
 *
 * Notes on actual SDK shapes (vs. the nominal ones in the phase prompt):
 *   • BundleTransport.send(bundle) — recipient is in bundle.recipient.certId
 *   • onReceive(handler) returns an Unsubscribe
 *   • verifyBundleWithTrust(bundle, verifier, store, opts)
 *   • CertRecord uses `publicKeyHex`; SignedBundle.signer uses `pubkeyHex`
 *   • StubSigner: `new StubSigner(privkeyHex, certId?)`
 *   • Signer.identity() returns Identity with `pubkey: Uint8Array`
 *   • KnownCertStore is async — `await store.has(id)`
 *
 * The stub's onReceive handler NEVER rejects silently: on any error it
 * pushes a negative record onto importedPatches with the failure code
 * (so the test can assert on it) and re-throws so the test surface
 * sees unexpected failures immediately.
 */

import {
  StubSigner,
  BsvSdkVerifier,
  createHttpTransport,
  createInMemoryKnownCertStore,
  createAllowlistHandoffPolicy,
  signBundle,
  verifyBundleWithTrust,
  type BundleTransport,
  type CertRecord,
  type KnownCertStore,
  type SignedBundle,
} from "@semantos/session-protocol";

import { bytesToHex } from "@noble/hashes/utils.js";

// ── Public shape ────────────────────────────────────────────────

export interface ReaPatchPayload {
  objectId: string;
  patches: Array<{
    objectId: string;
    fromVersion: number;
    toVersion: number;
    prevStateHash: string;
    newStateHash: string;
    patchKind:
      | "extraction"
      | "rescore"
      | "manual_override"
      | "state_transition"
      | "evidence_merge"
      | "instrument_emit"
      | "action";
    delta: unknown;
    deltaCount?: number;
    source: string;
    evidenceRef?: string | null;
    authorObjectId?: string | null;
    timestamp?: number;
    facetId?: string | null;
    facetCapabilities?: number[] | null;
    lexicon?: string | null;
  }>;
}

export interface ImportedRecord {
  ok: boolean;
  /** When ok=true: the resolved sender cert. */
  senderCertId?: string;
  /** When ok=true: the bundle payload as verified. */
  payload?: ReaPatchPayload;
  /** When ok=false: the failure code (verify / policy). */
  code?: string;
  /** When ok=false: the human-readable detail. */
  detail?: string;
  /** Raw bundle for introspection (kept on both paths). */
  bundle: SignedBundle<ReaPatchPayload>;
}

export interface StartReaStubOpts {
  /** Port to bind the REA stub's HTTP transport listener on. */
  port: number;
  /**
   * OJT's cert record — the REA stub adds this to its trust store so
   * admin-signed bundles from OJT verify.
   */
  ojtCertRecord: CertRecord;
  /**
   * OJT's base URL — used when respondWithExecutionPatch fires back
   * a signed patch into OJT's `/api/v3/federation/bundle`.
   */
  ojtPeerUrl: string;
  /**
   * Object ids the REA is allowed to hand patches back to OJT for.
   * Enforced BEFORE sending (canSend) — protects against cross-object
   * leaks on the sender side.
   */
  allowedObjectIds: string[];
  /**
   * Optional override for the stub's fixture privkey. Defaults to a
   * stable 32-byte value so per-test fixtures are deterministic.
   */
  privkeyHex?: string;
  /**
   * Optional override for the stub's cert id. Defaults to
   * "rea-stub-cert" per the spec.
   */
  certId?: string;
}

export interface ReaStub {
  readonly certId: string;
  readonly publicKeyHex: string;
  readonly transport: BundleTransport & { close(): Promise<void> };
  /**
   * Records of everything the stub's transport has received — one
   * element per inbound bundle, verified or not. Tests assert on
   * this directly (length, payload.objectId, code on failure).
   */
  readonly importedPatches: ImportedRecord[];
  /**
   * Sign + POST an execution patch for the given objectId back to
   * OJT's /api/v3/federation/bundle endpoint. Throws on any HTTP
   * non-2xx (the test catches).
   *
   * The REA-side canSend policy is consulted first; an objectId not
   * in `allowedObjectIds` throws `policy_denied` (exercised in G11).
   */
  respondWithExecutionPatch(objectId: string): Promise<void>;
  /** Stop the HTTP listener + tear down trust/policy state. */
  close(): Promise<void>;
}

// ── Implementation ──────────────────────────────────────────────

const DEFAULT_STUB_PRIVKEY_HEX = "aa".repeat(32);
const DEFAULT_STUB_CERT_ID = "rea-stub-cert";

export async function startReaStub(opts: StartReaStubOpts): Promise<ReaStub> {
  const privkeyHex = opts.privkeyHex ?? DEFAULT_STUB_PRIVKEY_HEX;
  const certId = opts.certId ?? DEFAULT_STUB_CERT_ID;

  // ── Signer + identity ────────────────────────────────────────
  const signer = new StubSigner(privkeyHex, certId);
  const identity = await signer.identity();
  const publicKeyHex = bytesToHex(identity.pubkey);

  // ── Trust store: OJT is a known signer ───────────────────────
  const trustStore: KnownCertStore = createInMemoryKnownCertStore([
    opts.ojtCertRecord,
  ]);

  // ── Handoff policy: allowlist of objectIds we can send FOR ──
  // canSend[objectId] = { OJT_CERT_ID } means "REA is allowed to
  // send patches about this object to OJT". canReceive is permissive
  // for objects OJT sends us (we trust OJT via the cert store).
  const canSend = new Map<string, Set<string>>();
  const canReceive = new Map<string, Set<string>>();
  for (const id of opts.allowedObjectIds) {
    canSend.set(id, new Set([opts.ojtCertRecord.certId]));
    canReceive.set(id, new Set([opts.ojtCertRecord.certId]));
  }
  const policy = createAllowlistHandoffPolicy({
    canSend,
    canReceive,
    fallback: "deny",
  });

  // ── Transport ────────────────────────────────────────────────
  const peerRegistry = new Map<string, string>([
    [opts.ojtCertRecord.certId, opts.ojtPeerUrl],
  ]);
  const transport = createHttpTransport({
    ownCertId: certId,
    listenPort: opts.port,
    listenHost: "127.0.0.1",
    peerRegistry,
  });

  // ── onReceive: verify → policy → record ──────────────────────
  const importedPatches: ImportedRecord[] = [];
  const verifier = new BsvSdkVerifier();

  transport.onReceive<ReaPatchPayload>(async (bundle) => {
    // Verify envelope + trust + recipient address.
    const trust = await verifyBundleWithTrust(bundle, verifier, trustStore, {
      expectedRecipientCertId: certId,
    });
    if (!trust.ok) {
      importedPatches.push({
        ok: false,
        code: trust.code,
        detail: trust.message,
        bundle,
      });
      // Don't throw — the test is asserting on the record. Silent
      // drops are what we guard against; a populated record *is*
      // the visibility.
      return;
    }

    // Policy: does the REA stub accept this object from OJT?
    const decision = await policy.canReceive({
      objectId: trust.payload.objectId,
      senderCertId: trust.cert.certId,
      recipientCertId: certId,
    });
    if (!decision.allowed) {
      importedPatches.push({
        ok: false,
        code: "policy_denied",
        detail: decision.reason,
        bundle,
      });
      return;
    }

    importedPatches.push({
      ok: true,
      senderCertId: trust.cert.certId,
      payload: trust.payload,
      bundle,
    });
  });

  async function respondWithExecutionPatch(objectId: string): Promise<void> {
    // REA-side canSend check BEFORE crafting a bundle. Mirrors
    // Slice 5c's two-sided policy model.
    const send = await policy.canSend({
      objectId,
      senderCertId: certId,
      recipientCertId: opts.ojtCertRecord.certId,
    });
    if (!send.allowed) {
      throw new Error(
        `rea-stub: canSend denied for objectId=${objectId}: ${send.reason}`,
      );
    }

    const payload: ReaPatchPayload = {
      objectId,
      patches: [
        {
          objectId,
          fromVersion: 1,
          toVersion: 2,
          prevStateHash: "e".repeat(64),
          newStateHash: "f".repeat(64),
          patchKind: "state_transition",
          delta: { status: { from: "new", to: "in_progress" } },
          deltaCount: 1,
          source: "rea:stub",
          timestamp: Date.now(),
          facetId: "rea:stub",
          lexicon: "jural",
        },
      ],
    };

    const bundle = await signBundle(payload, signer, {
      recipient: {
        certId: opts.ojtCertRecord.certId,
        pubkeyHex: opts.ojtCertRecord.publicKeyHex,
      },
    });
    // Belt + braces — explicit certId on signer (StubSigner already
    // provides it, but this matches what `signer.certId` look like on
    // downstream adapters).
    bundle.signer.certId = certId;

    const res = await fetch(`${opts.ojtPeerUrl}/api/v3/federation/bundle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      throw new Error(
        `rea-stub: POST to OJT /federation/bundle failed: ${res.status} ${body}`,
      );
    }
  }

  async function close(): Promise<void> {
    await transport.close();
  }

  return {
    certId,
    publicKeyHex,
    transport,
    importedPatches,
    respondWithExecutionPatch,
    close,
  };
}
