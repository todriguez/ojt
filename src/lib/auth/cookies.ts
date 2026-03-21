import { NextResponse } from "next/server";
import { cookies } from "next/headers";

// ─────────────────────────────────────────────
// Cookie helpers for admin and customer sessions
//
// Admin: ojt_admin_session (8h TTL)
// Customer: ojt_customer_session (7d TTL)
//
// Both: HttpOnly, SameSite=Lax, Secure in production
// ─────────────────────────────────────────────

const ADMIN_COOKIE = "ojt_admin_session";
const CUSTOMER_COOKIE = "ojt_customer_session";

const isProduction = process.env.NODE_ENV === "production";

interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge: number;
}

function baseCookieOptions(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

// ── Set cookies on a NextResponse ──────────

export function setAdminSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(ADMIN_COOKIE, token, baseCookieOptions(28800)); // 8 hours
}

export function setCustomerSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(CUSTOMER_COOKIE, token, baseCookieOptions(604800)); // 7 days
}

export function clearAdminSessionCookie(response: NextResponse) {
  response.cookies.set(ADMIN_COOKIE, "", { ...baseCookieOptions(0), maxAge: 0 });
}

export function clearCustomerSessionCookie(response: NextResponse) {
  response.cookies.set(CUSTOMER_COOKIE, "", { ...baseCookieOptions(0), maxAge: 0 });
}

// ── Read cookies in server components / route handlers ──

export async function getAdminSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(ADMIN_COOKIE)?.value;
}

export async function getCustomerSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(CUSTOMER_COOKIE)?.value;
}

// ── Read from Request (for middleware/edge) ─

export function getAdminTokenFromRequest(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${ADMIN_COOKIE}=([^;]+)`));
  return match?.[1];
}

export function getCustomerTokenFromRequest(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${CUSTOMER_COOKIE}=([^;]+)`));
  return match?.[1];
}

export { ADMIN_COOKIE, CUSTOMER_COOKIE };
