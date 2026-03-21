import { createLogger } from "@/lib/logger";
import { getConfig } from "@/lib/config";

// ─────────────────────────────────────────────
// Firebase Admin SDK (singleton)
//
// Used server-side to verify Firebase ID tokens
// during admin login flow.
// ─────────────────────────────────────────────

const log = createLogger("firebaseAdmin");

let _app: import("firebase-admin").app.App | null = null;

async function getApp() {
  if (_app) return _app;

  const admin = await import("firebase-admin");
  const config = getConfig();

  // Handle escaped newlines in private key (common in env vars)
  const privateKey = config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

  if (admin.apps.length > 0) {
    _app = admin.apps[0]!;
  } else {
    _app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.FIREBASE_PROJECT_ID,
        clientEmail: config.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
  }

  log.info("Firebase Admin SDK initialized");
  return _app;
}

export async function verifyIdToken(idToken: string) {
  const app = await getApp();
  const admin = await import("firebase-admin");
  return admin.auth(app).verifyIdToken(idToken);
}
