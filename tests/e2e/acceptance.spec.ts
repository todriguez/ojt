/**
 * Sprint 5A End-to-End Acceptance Test Checklist
 *
 * These tests verify the complete hardening implementation.
 * Run with: npx playwright test tests/e2e/acceptance.spec.ts
 *
 * Prerequisites:
 * - App running locally (npm run dev)
 * - Mock OTP service (no Twilio credentials needed)
 * - PGlite database (no Postgres needed)
 * - JWT_SECRET set in .env.local
 *
 * Note: Some tests use direct API calls rather than browser
 * interaction for faster, more reliable execution.
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// ── Security boundary tests (API-level) ────

test.describe("Admin API protection", () => {
  test("GET /api/v2/admin/leads without session returns 401", async ({
    request,
  }) => {
    const res = await request.get(`${BASE_URL}/api/v2/admin/leads`);
    expect(res.status()).toBe(401);
  });

  test("GET /api/v2/admin/leads/fake-id without session returns 401", async ({
    request,
  }) => {
    const res = await request.get(
      `${BASE_URL}/api/v2/admin/leads/00000000-0000-0000-0000-000000000000`
    );
    expect(res.status()).toBe(401);
  });

  test("POST /api/v2/admin/leads/fake-id/action without session returns 401", async ({
    request,
  }) => {
    const res = await request.post(
      `${BASE_URL}/api/v2/admin/leads/00000000-0000-0000-0000-000000000000/action`,
      { data: { action: "declined" } }
    );
    expect(res.status()).toBe(401);
  });
});

test.describe("Upload endpoint disabled", () => {
  test("POST /api/upload returns 403 when uploads disabled", async ({
    request,
  }) => {
    const res = await request.post(`${BASE_URL}/api/upload`, {
      multipart: {
        photos: {
          name: "test.jpg",
          mimeType: "image/jpeg",
          buffer: Buffer.from("fake image"),
        },
      },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("disabled");
  });
});

test.describe("Rate limiting", () => {
  test("OTP send rate limits after 3 requests", async ({ request }) => {
    const phone = `+6140000${Date.now().toString().slice(-4)}`;

    for (let i = 0; i < 3; i++) {
      const res = await request.post(`${BASE_URL}/api/v2/auth/otp/send`, {
        data: { phone },
      });
      expect(res.status()).toBe(200);
    }

    // 4th request should be rate limited
    const res = await request.post(`${BASE_URL}/api/v2/auth/otp/send`, {
      data: { phone },
    });
    expect(res.status()).toBe(429);
  });
});

test.describe("OTP verify flow", () => {
  test("OTP verify with mock code 123456 succeeds", async ({ request }) => {
    const phone = `+6140001${Date.now().toString().slice(-4)}`;

    // Send OTP
    const sendRes = await request.post(`${BASE_URL}/api/v2/auth/otp/send`, {
      data: { phone },
    });
    expect(sendRes.status()).toBe(200);

    // Verify with mock code
    const verifyRes = await request.post(
      `${BASE_URL}/api/v2/auth/otp/verify`,
      { data: { phone, code: "123456" } }
    );
    expect(verifyRes.status()).toBe(200);
    const body = await verifyRes.json();
    expect(body.success).toBe(true);
    expect(body.customerId).toBeTruthy();

    // Should have set a session cookie
    const cookies = verifyRes.headers()["set-cookie"];
    expect(cookies).toContain("ojt_customer_session");
  });

  test("OTP verify with wrong code returns 401", async ({ request }) => {
    const phone = `+6140002${Date.now().toString().slice(-4)}`;

    await request.post(`${BASE_URL}/api/v2/auth/otp/send`, {
      data: { phone },
    });

    const res = await request.post(`${BASE_URL}/api/v2/auth/otp/verify`, {
      data: { phone, code: "999999" },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("Session endpoint", () => {
  test("GET /api/v2/auth/session without cookie returns 401", async ({
    request,
  }) => {
    const res = await request.get(`${BASE_URL}/api/v2/auth/session`);
    expect(res.status()).toBe(401);
  });
});

test.describe("Admin page redirect", () => {
  test("/admin redirects to /admin/login without session", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForURL("**/admin/login");
    expect(page.url()).toContain("/admin/login");
  });
});

test.describe("Security headers", () => {
  test("Response includes security headers", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/`);
    const headers = res.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe(
      "strict-origin-when-cross-origin"
    );
  });
});
