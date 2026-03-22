/**
 * POST /api/v2/auth/admin/login
 *
 * Direct email + password admin login.
 * Verifies against ADMIN_EMAIL + ADMIN_PASSWORD_HASH env vars,
 * signs a JWT, and sets an httpOnly session cookie.
 *
 * DB session + audit log are best-effort (skipped if no DATABASE_URL).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyPassword } from "@/lib/auth/password";
import { signJwt } from "@/lib/auth/jwt";
import { setAdminSessionCookie } from "@/lib/auth/cookies";
import { checkRateLimit } from "@/lib/rateLimit";
import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth.admin");

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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

    const { email, password } = parsed.data;
    const config = getConfig();

    // Check admin email
    if (email !== config.ADMIN_EMAIL) {
      log.warn({ email, ip }, "admin.login.unauthorized");
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Verify password
    const passwordValid = await verifyPassword(password, config.ADMIN_PASSWORD_HASH);
    if (!passwordValid) {
      log.warn({ email, ip }, "admin.login.bad_password");
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Sign JWT — sessionId is optional (DB may not be available)
    let sessionId = "no-db";

    // Best-effort: create DB session + audit log if DATABASE_URL is set
    if (process.env.DATABASE_URL) {
      try {
        const { createSession } = await import("@/lib/auth/session");
        const { getDb } = await import("@/lib/db/client");
        const { auditLog } = await import("@/lib/db/schema");

        const jwt = await signJwt(
          { type: "admin", email, sessionId: "" },
          "8h"
        );

        const session = await createSession({
          type: "admin",
          actorId: email,
          token: jwt,
          ip,
          userAgent: request.headers.get("user-agent") || undefined,
        });
        sessionId = session.id;

        const db = await getDb();
        await db.insert(auditLog).values({
          actorType: "admin",
          actorId: email,
          action: "admin.login",
          ipAddress: ip,
        });
      } catch (dbErr) {
        log.warn(
          { error: dbErr instanceof Error ? dbErr.message : String(dbErr) },
          "admin.login.db_skipped"
        );
      }
    }

    // Sign final JWT with sessionId
    const finalJwt = await signJwt(
      { type: "admin", email, sessionId },
      "8h"
    );

    // Set cookie and respond
    const response = NextResponse.json({ success: true, email });
    setAdminSessionCookie(response, finalJwt);

    log.info({ email, sessionId, ip }, "admin.login.success");
    return response;
  } catch (err) {
    log.error(
      { ip, error: err instanceof Error ? err.message : String(err) },
      "admin.login.failure"
    );
    return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
  }
}
