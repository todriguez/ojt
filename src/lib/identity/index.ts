/**
 * OJT phone-number identity adapter.
 *
 * Drop-in replaceable by the real Plexus SDK adapter later. All
 * downstream OJT code imports from this barrel; no direct imports of
 * phone.ts / derive.ts / identity.ts / bridge.ts / store.ts elsewhere.
 */

export type { OjtIdentity } from "./identity.js";
export type { OjtRole } from "./phone.js";

export { normalizePhone, certIdFromPhone } from "./phone.js";
export { derivePubkeyHexFromPhone } from "./derive.js";
export { loadAdminIdentity, phoneToIdentity } from "./identity.js";
export { identityToCertRecord, createOjtSigner } from "./bridge.js";
export { bootKnownCertStore, loadReaPeersFromEnv } from "./store.js";
