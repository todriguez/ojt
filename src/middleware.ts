/**
 * Next.js Edge Middleware
 *
 * Runs on Vercel Edge Runtime. Handles:
 * - Admin route protection (pages + API)
 * - Customer route protection
 * - JWT verification at the edge (lightweight, no DB call)
 * - Identity forwarding via headers
 */

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const ADMIN_COOKIE = "ojt_admin_session";
const CUSTOMER_COOKIE = "ojt_customer_session";

function getSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET || "");
}

function getPreviousSecret(): Uint8Array | null {
  const prev = process.env.JWT_SECRET_PREVIOUS;
  if (!prev) return null;
  return new TextEncoder().encode(prev);
}

interface TokenPayload {
  type: "admin" | "customer";
  email?: string;
  customerId?: string;
  sessionId: string;
}

async function verifyToken(token: string): Promise<TokenPayload | null> {
  // Try current key
  try {
    const { payload } = await jwtVerify(token, getSecret(), { issuer: "oddjobtodd" });
    return payload as unknown as TokenPayload;
  } catch {
    // Try previous key
    const prev = getPreviousSecret();
    if (prev) {
      try {
        const { payload } = await jwtVerify(token, prev, { issuer: "oddjobtodd" });
        return payload as unknown as TokenPayload;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function getCookie(request: NextRequest, name: string): string | undefined {
  return request.cookies.get(name)?.value;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Admin pages (except login) ───────────
  if (pathname.startsWith("/admin") && !pathname.startsWith("/admin/login")) {
    const token = getCookie(request, ADMIN_COOKIE);
    if (!token) {
      return NextResponse.redirect(new URL("/admin/login", request.url));
    }
    const payload = await verifyToken(token);
    if (!payload || payload.type !== "admin") {
      return NextResponse.redirect(new URL("/admin/login", request.url));
    }
    // Forward identity
    const headers = new Headers(request.headers);
    headers.set("x-session-type", "admin");
    headers.set("x-session-admin-email", payload.email || "");
    headers.set("x-session-id", payload.sessionId);
    return NextResponse.next({ request: { headers } });
  }

  // ── Admin API routes ─────────────────────
  if (pathname.startsWith("/api/v2/admin")) {
    const token = getCookie(request, ADMIN_COOKIE);
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload || payload.type !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const headers = new Headers(request.headers);
    headers.set("x-session-type", "admin");
    headers.set("x-session-admin-email", payload.email || "");
    headers.set("x-session-id", payload.sessionId);
    return NextResponse.next({ request: { headers } });
  }

  // ── Auth endpoints — public ──────────────
  if (pathname.startsWith("/api/v2/auth")) {
    return NextResponse.next();
  }

  // ── Customer-protected routes ────────────
  if (
    pathname.startsWith("/api/v2/customers") ||
    pathname.startsWith("/api/v2/jobs")
  ) {
    // Allow admin OR customer
    const adminToken = getCookie(request, ADMIN_COOKIE);
    if (adminToken) {
      const payload = await verifyToken(adminToken);
      if (payload?.type === "admin") {
        const headers = new Headers(request.headers);
        headers.set("x-session-type", "admin");
        headers.set("x-session-admin-email", payload.email || "");
        headers.set("x-session-id", payload.sessionId);
        return NextResponse.next({ request: { headers } });
      }
    }

    const customerToken = getCookie(request, CUSTOMER_COOKIE);
    if (!customerToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const payload = await verifyToken(customerToken);
    if (!payload || payload.type !== "customer") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const headers = new Headers(request.headers);
    headers.set("x-session-type", "customer");
    headers.set("x-session-customer-id", payload.customerId || "");
    headers.set("x-session-id", payload.sessionId);
    return NextResponse.next({ request: { headers } });
  }

  // ── Chat route — optional customer session ─
  if (pathname.startsWith("/api/v2/chat")) {
    const customerToken = getCookie(request, CUSTOMER_COOKIE);
    if (customerToken) {
      const payload = await verifyToken(customerToken);
      if (payload?.type === "customer") {
        const headers = new Headers(request.headers);
        headers.set("x-session-type", "customer");
        headers.set("x-session-customer-id", payload.customerId || "");
        headers.set("x-session-id", payload.sessionId);
        return NextResponse.next({ request: { headers } });
      }
    }
    // Also allow admin to view chat
    const adminToken = getCookie(request, ADMIN_COOKIE);
    if (adminToken) {
      const payload = await verifyToken(adminToken);
      if (payload?.type === "admin") {
        const headers = new Headers(request.headers);
        headers.set("x-session-type", "admin");
        headers.set("x-session-admin-email", payload.email || "");
        headers.set("x-session-id", payload.sessionId);
        return NextResponse.next({ request: { headers } });
      }
    }
    // Anonymous access allowed for chat (new conversations)
    return NextResponse.next();
  }

  // ── Everything else — pass through ───────
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/api/v2/:path*",
  ],
};
