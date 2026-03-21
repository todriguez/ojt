/**
 * Admin auth route handler wrapper (defense in depth).
 *
 * Re-verifies the admin session from the cookie and checks
 * the session is not revoked in the database. The edge middleware
 * provides the first gate; this provides the definitive check.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminSessionToken } from "@/lib/auth/cookies";
import { verifyJwt, AdminJwtPayload } from "@/lib/auth/jwt";
import { validateSession } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth.admin");

export interface AdminAuthContext {
  email: string;
  sessionId: string;
}

type HandlerWithAuth = (
  request: NextRequest,
  context: AdminAuthContext,
  params?: Record<string, string>
) => Promise<NextResponse>;

export function withAdminAuth(handler: HandlerWithAuth) {
  return async (request: NextRequest, routeContext?: { params?: Promise<Record<string, string>> }) => {
    try {
      const token = await getAdminSessionToken();
      if (!token) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const payload = await verifyJwt(token);
      if (payload.type !== "admin") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const adminPayload = payload as AdminJwtPayload;

      // Validate session in DB (not just JWT)
      const session = await validateSession(adminPayload.sessionId);
      if (!session) {
        log.warn({ sessionId: adminPayload.sessionId }, "admin.auth.session_invalid");
        return NextResponse.json({ error: "Session expired or revoked" }, { status: 401 });
      }

      const resolvedParams = routeContext?.params ? await routeContext.params : undefined;
      return handler(request, {
        email: adminPayload.email,
        sessionId: adminPayload.sessionId,
      }, resolvedParams);
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "admin.auth.error"
      );
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  };
}
