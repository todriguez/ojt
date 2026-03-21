/**
 * POST /api/v2/auth/admin/logout
 *
 * Revokes the admin session and clears the session cookie.
 */

import { NextResponse } from "next/server";
import { getAdminSessionToken } from "@/lib/auth/cookies";
import { clearAdminSessionCookie } from "@/lib/auth/cookies";
import { verifyJwt, AdminJwtPayload } from "@/lib/auth/jwt";
import { revokeSession } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth.admin");

export async function POST() {
  const response = NextResponse.json({ success: true });

  try {
    const token = await getAdminSessionToken();
    if (token) {
      const payload = await verifyJwt(token);
      if (payload.type === "admin") {
        await revokeSession((payload as AdminJwtPayload).sessionId);
        log.info({ email: (payload as AdminJwtPayload).email }, "admin.logout.success");
      }
    }
  } catch {
    // Token may already be expired/invalid — that's fine, just clear cookie
  }

  clearAdminSessionCookie(response);
  return response;
}
