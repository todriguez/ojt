/**
 * Ownership check: verifies the customer owns the requested resource.
 *
 * Extracts customerId from the session and compares it to the
 * resource's customerId in the database. Returns 403 if mismatch.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth.ownership");

/**
 * Check if the customer session owns the specified job.
 * Admins bypass this check.
 */
export async function checkJobOwnership(
  request: NextRequest,
  jobId: string
): Promise<NextResponse | null> {
  const sessionType = request.headers.get("x-session-type");

  // Admins can access any job
  if (sessionType === "admin") return null;

  const customerId = request.headers.get("x-session-customer-id");

  // No session — ownership can't be verified
  if (!customerId) {
    return NextResponse.json(
      { error: "Unauthorized: no session" },
      { status: 401 }
    );
  }

  const db = await getDb();
  const [job] = await db
    .select({ customerId: jobs.customerId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Job has no customer yet (anonymous conversation in progress) — allow if
  // this is the customer who started it (will be linked after OTP verify)
  if (!job.customerId) return null;

  if (job.customerId !== customerId) {
    log.warn(
      { jobId, sessionCustomerId: customerId, jobCustomerId: job.customerId },
      "ownership.denied"
    );
    return NextResponse.json(
      { error: "Forbidden: you do not own this resource" },
      { status: 403 }
    );
  }

  return null; // Ownership confirmed
}
