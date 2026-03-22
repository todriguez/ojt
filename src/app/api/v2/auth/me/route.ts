/**
 * GET /api/v2/auth/me
 *
 * Returns the current authenticated user info from the JWT cookie.
 * Used by the admin UI to check auth state without Firebase.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyJwt } from "@/lib/auth/jwt";

export async function GET(request: NextRequest) {
  const token =
    request.cookies.get("admin_session")?.value ||
    request.cookies.get("customer_session")?.value;

  if (!token) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  try {
    const payload = await verifyJwt(token);
    return NextResponse.json({
      authenticated: true,
      type: payload.type,
      email: payload.type === "admin" ? payload.email : undefined,
    });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}
