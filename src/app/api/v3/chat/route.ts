/**
 * POST /api/v3/chat
 *
 * Phone-identity aware chat endpoint for the OJT HTTP edge (P4).
 *
 * Request body:
 *   { phone: string, message: string, jobId?: string }
 *
 * 200: { reply, jobId }
 * 400: { code: "bad_request", detail }
 * 500: { code: "internal", detail }
 *
 * Additive — does not touch /api/v2/*. The body contract is stable;
 * P5 will rewire the internals of handleTenantMessage through the
 * semantic-object bridge.
 */

import { NextRequest, NextResponse } from "next/server";

import { handleTenantMessage } from "@/lib/services/chatService";
import { phoneToIdentity } from "@/lib/identity";
import { createLogger } from "@/lib/logger";

const log = createLogger("v3.chat");

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: "bad_request", detail: "invalid JSON body" },
      { status: 400 },
    );
  }

  const b = body as {
    phone?: unknown;
    message?: unknown;
    jobId?: unknown;
    proposedSlot?: unknown;
    confirmBooking?: unknown;
  };
  if (typeof b.phone !== "string" || b.phone.length === 0) {
    return NextResponse.json(
      { code: "bad_request", detail: "missing phone" },
      { status: 400 },
    );
  }
  if (typeof b.message !== "string" || b.message.length === 0) {
    return NextResponse.json(
      { code: "bad_request", detail: "missing message" },
      { status: 400 },
    );
  }
  if (b.jobId !== undefined && typeof b.jobId !== "string") {
    return NextResponse.json(
      { code: "bad_request", detail: "jobId must be a string" },
      { status: 400 },
    );
  }

  // A5: optional proposedSlot — when present, the calendar guard runs
  // before the LLM. The body shape is identical to ProposedSlot from
  // @semantos/intent. We do minimal normalisation here (dates → Date)
  // and leave full validation to extractProposedSlot downstream.
  let proposedSlot: import("@semantos/intent").ProposedSlot | undefined;
  if (b.proposedSlot !== undefined) {
    if (typeof b.proposedSlot !== "object" || b.proposedSlot === null) {
      return NextResponse.json(
        { code: "bad_request", detail: "proposedSlot must be an object" },
        { status: 400 },
      );
    }
    const ps = b.proposedSlot as Record<string, unknown>;
    if (
      typeof ps.startAt !== "string" ||
      typeof ps.endAt !== "string" ||
      typeof ps.hatId !== "string" ||
      typeof ps.subjectKind !== "string" ||
      typeof ps.subjectId !== "string"
    ) {
      return NextResponse.json(
        {
          code: "bad_request",
          detail:
            "proposedSlot requires {startAt, endAt, hatId, subjectKind, subjectId}",
        },
        { status: 400 },
      );
    }
    proposedSlot = {
      startAt: new Date(ps.startAt),
      endAt: new Date(ps.endAt),
      hatId: ps.hatId,
      subjectKind: ps.subjectKind,
      subjectId: ps.subjectId,
      proposedByCertId:
        typeof ps.proposedByCertId === "string"
          ? ps.proposedByCertId
          : undefined,
    };
  }

  const confirmBooking =
    typeof b.confirmBooking === "boolean" ? b.confirmBooking : undefined;

  try {
    const identity = phoneToIdentity(b.phone, "tenant");
    const result = await handleTenantMessage({
      identity,
      message: b.message,
      jobId: b.jobId,
      proposedSlot,
      confirmBooking,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ detail }, "v3.chat.error");
    return NextResponse.json(
      { code: "internal", detail },
      { status: 500 },
    );
  }
}
