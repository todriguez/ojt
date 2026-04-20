/**
 * OjtIdentity — the concrete shape OJT carries instead of a Plexus cert.
 *
 * Two constructors:
 *   - loadAdminIdentity()   — reads env (OJT_ADMIN_*). The only identity
 *                             in the system that holds a real privkey.
 *   - phoneToIdentity(phone, role) — derives a deterministic identity
 *                                    from a phone number + the master
 *                                    seed. No privkey (privkeyHex: '').
 *
 * Both satisfy the same interface so the rest of OJT doesn't care where
 * an identity came from. When the real Plexus SDK adapter lands, these
 * constructors get swapped out but the interface (and all downstream
 * callers: bridge, store, facetId) stay identical.
 */

import { deriveBCABytes, bcaBytesToIPv6 } from "@semantos/session-protocol";
import { hexToBytes } from "@noble/hashes/utils.js";

import { certIdFromPhone, normalizePhone, type OjtRole } from "./phone";
import { derivePubkeyHexFromPhone } from "./derive";

export interface OjtIdentity {
  certId: string;
  pubkeyHex: string;
  /** '' for phone-derived — we never hold user privkeys. Only admin has one. */
  privkeyHex: string;
  bca: string;
  /** 'admin' | `tenant:${normalizedPhone}` | `rea:${normalizedPhone}` */
  facetId: string;
}

/**
 * Deterministic OJT BCA parameters. These are fixed at the protocol
 * level so two different OJT boxes with the same pubkey produce the
 * same BCA — critical for cross-instance cert-trust store bootstrap.
 *
 * subnetPrefix: 8-byte IPv6 prefix (fd00::/8 = ULA range).
 * modifier: 16 zero bytes — we don't use the modifier field yet.
 * sec: 0 — no security level encoded.
 */
const OJT_SUBNET_PREFIX = new Uint8Array([0xfd, 0x00, 0x4f, 0x4a, 0x54, 0x00, 0x00, 0x00]);
const OJT_BCA_MODIFIER = new Uint8Array(16);
const OJT_BCA_SEC = 0;

function bcaFromPubkeyHex(pubkeyHex: string): string {
  const pub = hexToBytes(pubkeyHex);
  const bytes = deriveBCABytes(pub, OJT_SUBNET_PREFIX, OJT_BCA_MODIFIER, OJT_BCA_SEC);
  return bcaBytesToIPv6(bytes);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`loadAdminIdentity: missing env var ${name}`);
  }
  return v;
}

/**
 * Load the admin identity from env. Throws if any of the three core
 * vars are missing — the admin cert is the root of trust so a silent
 * fallback would be a security bug.
 *
 * Env:
 *   OJT_ADMIN_CERT_ID    — required, 64 hex chars
 *   OJT_ADMIN_PUBKEY_HEX — required, 66 hex chars (compressed secp256k1)
 *   OJT_ADMIN_PRIVKEY_HEX — required, 64 hex chars (the secret)
 *   OJT_ADMIN_BCA        — optional IPv6; derived from pubkey when absent
 */
export function loadAdminIdentity(): OjtIdentity {
  const certId = requireEnv("OJT_ADMIN_CERT_ID");
  const pubkeyHex = requireEnv("OJT_ADMIN_PUBKEY_HEX");
  const privkeyHex = requireEnv("OJT_ADMIN_PRIVKEY_HEX");
  const bca = process.env.OJT_ADMIN_BCA?.trim() || bcaFromPubkeyHex(pubkeyHex);

  return {
    certId,
    pubkeyHex,
    privkeyHex,
    bca,
    facetId: "admin",
  };
}

function loadDerivationSeed(): Uint8Array {
  const raw = process.env.OJT_DERIVATION_SEED;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("phoneToIdentity: missing env var OJT_DERIVATION_SEED");
  }
  return hexToBytes(raw);
}

/**
 * Derive a deterministic OjtIdentity from a phone number + role. Pure
 * function of (phone, role, OJT_DERIVATION_SEED) — same inputs always
 * produce the same certId / pubkey / bca / facetId.
 *
 * No privkey is returned. If you need to sign on behalf of a user
 * you'll do it through the Plexus SDK's user wallet later; OJT never
 * holds the user secret.
 */
export function phoneToIdentity(phone: string, role: OjtRole): OjtIdentity {
  const normalized = normalizePhone(phone);
  const certId = certIdFromPhone(normalized, role);
  const seed = loadDerivationSeed();
  const pubkeyHex = derivePubkeyHexFromPhone(normalized, role, seed);
  const bca = bcaFromPubkeyHex(pubkeyHex);

  return {
    certId,
    pubkeyHex,
    privkeyHex: "",
    bca,
    facetId: `${role}:${normalized}`,
  };
}
