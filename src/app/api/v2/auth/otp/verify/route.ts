/**
 * POST /api/v2/auth/otp/verify
 *
 * Verifies an OTP code, creates or finds the customer,
 * creates a session, and sets an httpOnly cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getOtpService, normalizePhone } from "@/lib/services/otpService";
import { checkRateLimit } from "@/lib/rateLimit";
import { signJwt } from "@/lib/auth/jwt";
import { createSession } from "@/lib/auth/session";
import { setCustomerSessionCookie } from "@/lib/auth/cookies";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth.otp");

const verifySchema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().length(6),
  jobId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  try {
    const body = await request.json();
    const parsed = verifySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const phone = normalizePhone(parsed.data.phone);
    const { code, jobId } = parsed.data;

    // Rate limit
    const rl = await checkRateLimit("otpVerify", phone);
    if (!rl.allowed) {
      log.warn({ ip, retryAfter: rl.retryAfter }, "otp.verify.rate_limited");
      return NextResponse.json(
        { error: "Too many verification attempts. Please request a new code." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
      );
    }

    // Verify OTP
    const otpService = getOtpService();
    const result = await otpService.verifyCode(phone, code);

    if (!result.valid) {
      return NextResponse.json(
        { error: "Invalid verification code" },
        { status: 401 }
      );
    }

    // Find or create customer
    const db = await getDb();
    let [customer] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.mobile, phone))
      .limit(1);

    if (!customer) {
      // Need an organisationId — get from the job if provided, or use default
      let orgId: string | undefined;
      if (jobId) {
        const [job] = await db
          .select({ organisationId: schema.jobs.organisationId })
          .from(schema.jobs)
          .where(eq(schema.jobs.id, jobId))
          .limit(1);
        orgId = job?.organisationId;
      }

      if (!orgId) {
        // Get the first (default) organisation
        const [org] = await db
          .select({ id: schema.organisations.id })
          .from(schema.organisations)
          .limit(1);
        orgId = org?.id;
      }

      if (!orgId) {
        log.error({ phone }, "otp.verify.no_organisation");
        return NextResponse.json(
          { error: "System not configured" },
          { status: 500 }
        );
      }

      [customer] = await db
        .insert(schema.customers)
        .values({
          name: "",
          organisationId: orgId,
          mobile: phone,
          mobileVerifiedAt: new Date(),
        })
        .returning();

      log.info({ customerId: customer.id }, "customer.created");
    } else {
      // Update verified timestamp
      await db
        .update(schema.customers)
        .set({ mobileVerifiedAt: new Date() })
        .where(eq(schema.customers.id, customer.id));
    }

    // Link customer to job if provided and not already linked
    if (jobId) {
      const [job] = await db
        .select({ customerId: schema.jobs.customerId })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, jobId))
        .limit(1);

      if (job && !job.customerId) {
        await db
          .update(schema.jobs)
          .set({ customerId: customer.id })
          .where(eq(schema.jobs.id, jobId));
      }
    }

    // Sign JWT
    const jwt = await signJwt(
      { type: "customer", customerId: customer.id, phone, sessionId: "" },
      "7d"
    );

    // Create session
    const session = await createSession({
      type: "customer",
      actorId: customer.id,
      token: jwt,
      ip,
      userAgent: request.headers.get("user-agent") || undefined,
    });

    // Re-sign with sessionId
    const finalJwt = await signJwt(
      { type: "customer", customerId: customer.id, phone, sessionId: session.id },
      "7d"
    );

    const response = NextResponse.json({
      success: true,
      customerId: customer.id,
    });
    setCustomerSessionCookie(response, finalJwt);

    log.info({ customerId: customer.id, sessionId: session.id }, "otp.verify.session_created");
    return response;
  } catch (err) {
    log.error(
      { ip, error: err instanceof Error ? err.message : String(err) },
      "otp.verify.error"
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
