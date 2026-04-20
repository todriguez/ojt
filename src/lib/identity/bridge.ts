/**
 * Bridge from OjtIdentity → @semantos/session-protocol shapes.
 *
 * CertRecord + Signer come from session-protocol. The prompt spec'd a
 * `CertRecord` with fields {certId, pubkeyHex, bca, issuedAt, revokedAt?,
 * metadata?} and a `Signer.sign(): Promise<string>`; the actual
 * @semantos/session-protocol@0.1.0 shapes are:
 *
 *   CertRecord — { certId, publicKeyHex, revoked?, parentCertId?,
 *                  resourceId?, domainFlag? }
 *   Signer.sign(bytes) — returns Promise<Uint8Array>
 *   Signer.identity()  — returns Promise<Identity>  (not SignerIdentity)
 *
 * We follow the ACTUAL SDK shapes (structural compat is the point — the
 * whole module will be swapped for the real Plexus SDK later, and the
 * real SDK exports the same session-protocol types). `bca` and
 * `facetId` we carry only on OjtIdentity itself; the trust store
 * doesn't need them.
 */

import { StubSigner, type Signer, type CertRecord } from "@semantos/session-protocol";

import type { OjtIdentity } from "./identity";

/**
 * Convert an OjtIdentity into a CertRecord suitable for the known-cert
 * store. `revoked` defaults to false (un-revoked); the store's `revoke`
 * method is what flips it.
 *
 * Note: we drop bca / facetId / privkeyHex here — CertRecord is the
 * **receiver's** view of a peer, and none of those belong in a public
 * registry. bca is recoverable from publicKeyHex if needed.
 */
export function identityToCertRecord(id: OjtIdentity): CertRecord {
  return {
    certId: id.certId,
    publicKeyHex: id.pubkeyHex,
    revoked: false,
  };
}

/**
 * Create a Signer bound to an OjtIdentity. Requires privkeyHex — i.e.
 * only the admin identity can produce a signer. Phone-derived
 * identities (privkeyHex === '') throw here; that's a feature, since
 * OJT is not permitted to sign on behalf of users.
 *
 * The underlying implementation is `StubSigner` from session-protocol,
 * which is real ECDSA over secp256k1 seeded with the supplied 32-byte
 * hex. When the Plexus SDK adapter lands this becomes PlexusSigner
 * without changing callers.
 */
export function createOjtSigner(id: OjtIdentity): Signer {
  if (!id.privkeyHex) {
    throw new Error(
      `createOjtSigner: identity has no privkey (facetId=${id.facetId}); ` +
        `only the admin identity can sign. OJT never holds user privkeys.`,
    );
  }
  // StubSigner: (seedHex, certId?) — seedHex is the 32-byte privkey hex.
  return new StubSigner(id.privkeyHex, id.certId);
}
