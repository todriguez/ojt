/**
 * POST /api/v2/auth/otp/send
 *
 * Sends an OTP code to the provided phone number.
 * Rate limited per phone and per IP.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getOtpService, normalizePhone } from "@/lib/services/otpService";
import { checkRateLimit } from "@/lib/rateLimit";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth.otp");

const sendSchema = z.object({
  phone: z.string().min(8).max(20),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  try {
    const body = await request.json();
    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid phone number" },
        { status: 400 }
      );
    }

    const phone = normalizePhone(parsed.data.phone);

    // Rate limit: per phone
    const rlPhone = await checkRateLimit("otpSendPerPhone", phone);
    if (!rlPhone.allowed) {
      log.warn({ ip, retryAfter: rlPhone.retryAfter }, "otp.send.rate_limited.phone");
      return NextResponse.json(
        { error: "Too many OTP requests. Please wait before trying again." },
        { status: 429, headers: { "Retry-After": String(rlPhone.retryAfter) } }
      );
    }

    // Rate limit: per IP
    const rlIp = await checkRateLimit("otpSendPerIp", ip);
    if (!rlIp.allowed) {
      log.warn({ ip, retryAfter: rlIp.retryAfter }, "otp.send.rate_limited.ip");
      return NextResponse.json(
        { error: "Too many OTP requests from this location." },
        { status: 429, headers: { "Retry-After": String(rlIp.retryAfter) } }
      );
    }

    // Send OTP
    const otpService = getOtpService();
    const result = await otpService.sendCode(phone);

    if (!result.success) {
      return NextResponse.json(
        { error: "Failed to send verification code. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    log.error(
      { ip, error: err instanceof Error ? err.message : String(err) },
      "otp.send.error"
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
