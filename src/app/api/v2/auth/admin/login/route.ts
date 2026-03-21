/**
 * POST /api/v2/auth/admin/login
 *
 * Receives a Firebase ID token from the client, verifies it server-side
 * via Firebase Admin SDK, checks admin email, creates a session, and
 * sets an httpOnly session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyIdToken } from "@/lib/auth/firebaseAdmin";
import { signJwt } from "@/lib/auth/jwt";
import { createSession } from "@/lib/auth/session";
import { setAdminSessionCookie } from "@/lib/auth/cookies";
import { checkRateLimit } from "@/lib/rateLimit";
import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

const log = createLogger("auth.admin");

const loginSchema = z.object({
  idToken: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  try {
    // Rate limit
    const rl = await checkRateLimit("adminLogin", ip);
    if (!rl.allowed) {
      log.warn({ ip, retryAfter: rl.retryAfter }, "admin.login.rate_limited");
      return NextResponse.json(
        { error: "Too many login attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
      );
    }

    const body = await request.json();
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    // Verify Firebase ID token server-side
    const decoded = await verifyIdToken(parsed.data.idToken);

    // Check admin email
    const config = getConfig();
    if (decoded.email !== config.ADMIN_EMAIL) {
      log.warn({ email: decoded.email, ip }, "admin.login.unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Sign our own JWT
    const jwt = await signJwt(
      { type: "admin", email: decoded.email!, sessionId: "" }, // sessionId filled below
      "8h"
    );

    // Create session
    const session = await createSession({
      type: "admin",
      actorId: decoded.email!,
      token: jwt,
      ip,
      userAgent: request.headers.get("user-agent") || undefined,
    });

    // Re-sign with actual sessionId
    const finalJwt = await signJwt(
      { type: "admin", email: decoded.email!, sessionId: session.id },
      "8h"
    );

    // Audit log
    const db = await getDb();
    await db.insert(auditLog).values({
      actorType: "admin",
      actorId: decoded.email!,
      action: "admin.login",
      ipAddress: ip,
    });

    // Set cookie and respond
    const response = NextResponse.json({ success: true });
    setAdminSessionCookie(response, finalJwt);

    log.info({ email: decoded.email, sessionId: session.id, ip }, "admin.login.success");
    return response;
  } catch (err) {
    log.error(
      { ip, error: err instanceof Error ? err.message : String(err) },
      "admin.login.failure"
    );
    return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
  }
}
