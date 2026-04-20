/**
 * @noble/secp256k1 v3 requires the caller to wire sync hash functions
 * before calling sync `sign` / `hash`. This module is the single place
 * that wiring lives; every identity-module file that needs signing
 * must import it (side-effect) so the setup runs exactly once.
 */

import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(secp as any).hashes.sha256 = sha256;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(secp as any).hashes.hmacSha256 = (key: Uint8Array, msg: Uint8Array) =>
  hmac(sha256, key, msg);

export {};
