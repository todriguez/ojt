/**
 * GET /api/v2/auth/session
 *
 * Returns the current session info (admin or customer).
 */

import { NextResponse } from "next/server";
import { getAdminSessionToken, getCustomerSessionToken } from "@/lib/auth/cookies";
import { verifyJwt } from "@/lib/auth/jwt";
import { validateSession } from "@/lib/auth/session";

export async function GET() {
  // Try admin session first
  const adminToken = await getAdminSessionToken();
  if (adminToken) {
    try {
      const payload = await verifyJwt(adminToken);
      if (payload.type === "admin") {
        const session = await validateSession(payload.sessionId);
        if (session) {
          return NextResponse.json({
            authenticated: true,
            type: "admin",
            email: payload.email,
          });
        }
      }
    } catch {
      // Invalid token — fall through
    }
  }

  // Try customer session
  const customerToken = await getCustomerSessionToken();
  if (customerToken) {
    try {
      const payload = await verifyJwt(customerToken);
      if (payload.type === "customer") {
        const session = await validateSession(payload.sessionId);
        if (session) {
          return NextResponse.json({
            authenticated: true,
            type: "customer",
            customerId: payload.customerId,
          });
        }
      }
    } catch {
      // Invalid token — fall through
    }
  }

  return NextResponse.json({ authenticated: false }, { status: 401 });
}
