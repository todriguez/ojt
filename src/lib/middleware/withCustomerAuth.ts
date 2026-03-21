/**
 * Customer auth route handler wrapper (defense in depth).
 *
 * Verifies customer session from cookie and validates in DB.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCustomerSessionToken } from "@/lib/auth/cookies";
import { verifyJwt, CustomerJwtPayload } from "@/lib/auth/jwt";
import { validateSession } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth.customer");

export interface CustomerAuthContext {
  customerId: string;
  phone: string;
  sessionId: string;
}

type HandlerWithAuth = (
  request: NextRequest,
  context: CustomerAuthContext,
  params?: Record<string, string>
) => Promise<NextResponse>;

export function withCustomerAuth(handler: HandlerWithAuth) {
  return async (request: NextRequest, routeContext?: { params?: Promise<Record<string, string>> }) => {
    try {
      const token = await getCustomerSessionToken();
      if (!token) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const payload = await verifyJwt(token);
      if (payload.type !== "customer") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const customerPayload = payload as CustomerJwtPayload;

      const session = await validateSession(customerPayload.sessionId);
      if (!session) {
        log.warn({ sessionId: customerPayload.sessionId }, "customer.auth.session_invalid");
        return NextResponse.json({ error: "Session expired or revoked" }, { status: 401 });
      }

      const resolvedParams = routeContext?.params ? await routeContext.params : undefined;
      return handler(request, {
        customerId: customerPayload.customerId,
        phone: customerPayload.phone,
        sessionId: customerPayload.sessionId,
      }, resolvedParams);
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "customer.auth.error"
      );
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  };
}
