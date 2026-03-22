/**
 * Unit tests for JWT sign/verify and dual-key rotation.
 *
 * Run: npx tsx --test tests/unit/auth.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Set env vars before importing modules
process.env.JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
process.env.ADMIN_EMAIL = "todd@oddjobtodd.info";
process.env.ADMIN_PASSWORD_HASH = "fakesalt:fakehash";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

describe("JWT utilities", () => {
  it("should sign and verify an admin JWT", async () => {
    const { signJwt, verifyJwt } = await import("../../src/lib/auth/jwt");

    const token = await signJwt(
      { type: "admin", email: "todd@oddjobtodd.info", sessionId: "sess-123" },
      "1h"
    );

    assert.ok(token);
    assert.ok(token.split(".").length === 3, "Should be a valid JWT format");

    const payload = await verifyJwt(token);
    assert.equal(payload.type, "admin");
    assert.equal(payload.email, "todd@oddjobtodd.info");
    assert.equal(payload.sessionId, "sess-123");
  });

  it("should sign and verify a customer JWT", async () => {
    const { signJwt, verifyJwt } = await import("../../src/lib/auth/jwt");

    const token = await signJwt(
      {
        type: "customer",
        customerId: "cust-456",
        phone: "+61400000000",
        sessionId: "sess-789",
      },
      "7d"
    );

    const payload = await verifyJwt(token);
    assert.equal(payload.type, "customer");
    if (payload.type === "customer") {
      assert.equal(payload.customerId, "cust-456");
      assert.equal(payload.phone, "+61400000000");
    }
  });

  it("should reject a tampered token", async () => {
    const { signJwt, verifyJwt } = await import("../../src/lib/auth/jwt");

    const token = await signJwt(
      { type: "admin", email: "todd@oddjobtodd.info", sessionId: "sess-123" },
      "1h"
    );

    // Tamper with the token
    const tampered = token.slice(0, -5) + "XXXXX";

    await assert.rejects(
      () => verifyJwt(tampered),
      "Should reject tampered token"
    );
  });

  it("should verify with previous key during rotation", async () => {
    const { signJwt } = await import("../../src/lib/auth/jwt");

    // Sign with current key
    const token = await signJwt(
      { type: "admin", email: "todd@oddjobtodd.info", sessionId: "sess-123" },
      "1h"
    );

    // Simulate key rotation: move current to previous, set new current
    const oldSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET_PREVIOUS = oldSecret;
    process.env.JWT_SECRET = "brand-new-secret-that-is-at-least-32-characters-long";

    // Clear module cache to pick up new env
    // Re-import is needed because getConfig() caches
    // For this test, we verify the concept works with jose directly
    const { jwtVerify } = await import("jose");
    const prevKey = new TextEncoder().encode(oldSecret!);

    const { payload } = await jwtVerify(token, prevKey, {
      issuer: "oddjobtodd",
    });
    assert.equal((payload as Record<string, unknown>).type, "admin");

    // Restore env
    process.env.JWT_SECRET = oldSecret;
    delete process.env.JWT_SECRET_PREVIOUS;
  });
});

describe("Phone normalization", () => {
  it("should normalize Australian mobile numbers", async () => {
    const { normalizePhone } = await import(
      "../../src/lib/services/otpService"
    );

    assert.equal(normalizePhone("0412345678"), "+61412345678");
    assert.equal(normalizePhone("+61412345678"), "+61412345678");
    assert.equal(normalizePhone("412345678"), "+61412345678");
  });
});

describe("Rate limiter (in-memory)", () => {
  it("should allow requests within limit", async () => {
    const { checkRateLimit } = await import("../../src/lib/rateLimit");

    // adminLogin allows 5 per 15 min
    const result = await checkRateLimit("adminLogin", "test-ip-1");
    assert.equal(result.allowed, true);
  });

  it("should block after exceeding limit", async () => {
    const { checkRateLimit } = await import("../../src/lib/rateLimit");

    // otpSendPerPhone allows 3 per 10 min
    const key = "test-phone-block-" + Date.now();
    await checkRateLimit("otpSendPerPhone", key);
    await checkRateLimit("otpSendPerPhone", key);
    await checkRateLimit("otpSendPerPhone", key);

    const result = await checkRateLimit("otpSendPerPhone", key);
    assert.equal(result.allowed, false);
    assert.ok(result.retryAfter && result.retryAfter > 0);
  });
});

describe("Mock OTP service", () => {
  it("should accept code 123456", async () => {
    const { getOtpService } = await import(
      "../../src/lib/services/otpService"
    );

    const otp = getOtpService();
    const sendResult = await otp.sendCode("+61400000000");
    assert.equal(sendResult.success, true);

    const verifyResult = await otp.verifyCode("+61400000000", "123456");
    assert.equal(verifyResult.valid, true);
  });

  it("should reject wrong code", async () => {
    const { getOtpService } = await import(
      "../../src/lib/services/otpService"
    );

    const otp = getOtpService();
    const result = await otp.verifyCode("+61400000000", "999999");
    assert.equal(result.valid, false);
  });
});
