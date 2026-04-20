/**
 * OJT phone-number identity adapter.
 *
 * Drop-in replaceable by the real Plexus SDK adapter later. All
 * downstream OJT code imports from this barrel; no direct imports of
 * phone.ts / derive.ts / identity.ts / bridge.ts / store.ts elsewhere.
 */

// NB: imports are extensionless — Next.js webpack resolves through
// tsconfig `moduleResolution: bundler` but rejects `.js` suffixes on
// `.ts` files when building the app/api bundles. The tsx-based test
// runner is happy with both.

import "./secp256k1-setup";

export type { OjtIdentity } from "./identity";
export type { OjtRole } from "./phone";

export { normalizePhone, certIdFromPhone } from "./phone";
export { derivePubkeyHexFromPhone } from "./derive";
export { loadAdminIdentity, phoneToIdentity } from "./identity";
export { identityToCertRecord, createOjtSigner } from "./bridge";
export { bootKnownCertStore, loadReaPeersFromEnv } from "./store";
