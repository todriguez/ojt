import { eq, and, gt } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import crypto from "crypto";

// ─────────────────────────────────────────────
// Session CRUD
//
// Sessions are stored in the database and referenced
// by their ID in the JWT payload. The tokenHash allows
// revocation by matching against the hash of the JWT.
// ─────────────────────────────────────────────

const log = createLogger("session");

// TTLs
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;    // 8 hours
const CUSTOMER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(params: {
  type: "admin" | "customer";
  actorId: string;        // customerId or adminEmail
  token: string;          // JWT to hash
  ip?: string;
  userAgent?: string;
}): Promise<typeof sessions.$inferSelect> {
  const db = await getDb();
  const ttl = params.type === "admin" ? ADMIN_SESSION_TTL_MS : CUSTOMER_SESSION_TTL_MS;

  const [session] = await db
    .insert(sessions)
    .values({
      customerId: params.type === "customer" ? params.actorId : undefined,
      adminEmail: params.type === "admin" ? params.actorId : undefined,
      sessionType: params.type,
      tokenHash: hashToken(params.token),
      expiresAt: new Date(Date.now() + ttl),
      ipAddress: params.ip,
      userAgent: params.userAgent,
    })
    .returning();

  log.info({ sessionId: session.id, type: params.type }, "session.created");
  return session;
}

export async function validateSession(
  sessionId: string
): Promise<typeof sessions.$inferSelect | null> {
  const db = await getDb();

  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.revoked, false),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) {
    log.info({ sessionId }, "session.invalid");
    return null;
  }

  // Update lastActiveAt (fire-and-forget)
  db.update(sessions)
    .set({ lastActiveAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .then(() => {})
    .catch(() => {});

  return session;
}

export async function revokeSession(sessionId: string): Promise<void> {
  const db = await getDb();

  await db
    .update(sessions)
    .set({ revoked: true })
    .where(eq(sessions.id, sessionId));

  log.info({ sessionId }, "session.revoked");
}
