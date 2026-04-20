/**
 * Deterministic pubkey derivation from phone + master seed.
 *
 * The master seed (`OJT_DERIVATION_SEED`, 32-byte hex) never leaves the
 * server. For any phone+role, `privkeyScalar = HMAC-SHA256(masterSeed,
 * "ojt:${role}:${normalizedPhone}")` — a stable 32-byte scalar. The
 * compressed secp256k1 public key is then exported as 66-char hex and
 * is what we record in the known-cert store and advertise on the wire.
 *
 * The privkey itself is never stored, logged, or returned — `phoneToIdentity`
 * stamps `privkeyHex: ''` for every phone-derived identity. Only admin has
 * a privkey (read from env). This keeps the adapter drop-in compatible with
 * a future Plexus SDK where user privkeys live client-side.
 */

import "./secp256k1-setup";

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "@noble/secp256k1";

import type { OjtRole } from "./phone";

const DERIVATION_LABEL = "ojt";

/**
 * Derive the 33-byte compressed secp256k1 public key for the given
 * phone+role. Returns 66 lowercase hex chars.
 *
 * Precondition: `normalizedPhone` is already in E.164 form (caller
 * should route raw inputs through `normalizePhone` first). We do NOT
 * re-normalize here — this function is pure and deterministic given
 * its inputs.
 */
export function derivePubkeyHexFromPhone(
  normalizedPhone: string,
  role: OjtRole,
  masterSeed: Uint8Array,
): string {
  if (!(masterSeed instanceof Uint8Array) || masterSeed.length < 16) {
    throw new Error(
      `derivePubkeyHexFromPhone: masterSeed must be at least 16 bytes (got ${masterSeed?.length ?? 0})`,
    );
  }
  const info = new TextEncoder().encode(
    `${DERIVATION_LABEL}:${role}:${normalizedPhone}`,
  );
  const scalar = hmac(sha256, masterSeed, info); // 32 bytes
  // secp256k1 scalars have an astronomically small chance of being 0 or
  // >= n; @noble/secp256k1 throws in that case. Practically unreachable
  // for HMAC output — we let the throw propagate rather than mask it.
  const pub = getPublicKey(scalar, true); // 33-byte compressed
  return bytesToHex(pub);
}
