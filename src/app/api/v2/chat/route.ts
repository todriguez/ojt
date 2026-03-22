/**
 * POST /api/v2/chat
 *
 * Processes a customer message through the full intake pipeline:
 * save → extract → merge → evaluate → reply → persist.
 *
 * Request body:
 * {
 *   jobId: string (UUID) — existing job to continue, OR
 *   organisationId: string (UUID) — to create a new job
 *   customerId?: string (UUID)
 *   message: string
 *   messageType?: "text" | "voice" | "image"
 * }
 *
 * Response:
 * {
 *   reply: string
 *   jobId: string
 *   conversationPhase: string
 *   completenessScore: number
 *   estimatePresented: boolean
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { processCustomerMessage } from "@/lib/services/chatService";
import { checkRateLimit } from "@/lib/rateLimit";
import { checkJobOwnership } from "@/lib/middleware/withOwnershipCheck";
import { createLogger } from "@/lib/logger";

const log = createLogger("chat");

const chatRequestSchema = z.object({
  jobId: z.string().uuid().optional(),
  organisationId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  message: z.string().min(1, "Message cannot be empty"),
  messageType: z.enum(["text", "voice", "image"]).default("text"),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const sessionCustomerId = request.headers.get("x-session-customer-id");

  try {
    // Rate limit: per session or per IP
    const rateLimitKey = sessionCustomerId || ip;
    const rlSession = await checkRateLimit("chatPerSession", rateLimitKey);
    if (!rlSession.allowed) {
      return NextResponse.json(
        { error: "You're sending messages too quickly. Please slow down." },
        { status: 429, headers: { "Retry-After": String(rlSession.retryAfter) } }
      );
    }

    const rlIp = await checkRateLimit("chatPerIp", ip);
    if (!rlIp.allowed) {
      return NextResponse.json(
        { error: "Too many messages from this location." },
        { status: 429, headers: { "Retry-After": String(rlIp.retryAfter) } }
      );
    }

    const body = await request.json();
    const parsed = chatRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { message, messageType, customerId } = parsed.data;
    let { jobId, organisationId } = parsed.data;

    const db = await getDb();

    // If continuing an existing job, verify ownership
    if (jobId) {
      const ownershipError = await checkJobOwnership(request, jobId);
      if (ownershipError) return ownershipError;
    }

    // If no jobId, create a new job
    if (!jobId) {
      // Rate limit new conversations per IP (bot protection)
      const rlNew = await checkRateLimit("newConversationPerIp", ip);
      if (!rlNew.allowed) {
        return NextResponse.json(
          { error: "Too many new conversations. Please try again later." },
          { status: 429, headers: { "Retry-After": String(rlNew.retryAfter) } }
        );
      }

      if (!organisationId) {
        return NextResponse.json(
          { error: "Either jobId or organisationId is required" },
          { status: 400 }
        );
      }

      const [newJob] = await db
        .insert(schema.jobs)
        .values({
          organisationId,
          customerId: customerId || sessionCustomerId || undefined,
          leadSource: "website_chat",
          status: "new_lead",
        })
        .returning();

      jobId = newJob.id;

      // Log the initial state event
      await db.insert(schema.jobStateEvents).values({
        jobId,
        fromState: "new_lead",
        toState: "new_lead",
        actorType: "system",
        reason: "Conversation started via chat",
      });

      log.info({ jobId, ip }, "chat.conversation.started");
    }

    // Process through the chat pipeline
    const result = await processCustomerMessage({
      jobId: jobId!,
      customerId: customerId || sessionCustomerId || "",
      message,
      messageType,
    });

    log.info({ jobId, phase: result.conversationPhase }, "chat.message.processed");

    return NextResponse.json({
      reply: result.reply,
      jobId,
      conversationPhase: result.conversationPhase,
      completenessScore: result.completenessScore,
      estimatePresented: result.estimatePresented,
      // Sprint 3 scoring
      scoring: {
        customerFitScore: result.customerFitScore,
        customerFitLabel: result.customerFitLabel,
        quoteWorthinessScore: result.quoteWorthinessScore,
        quoteWorthinessLabel: result.quoteWorthinessLabel,
        recommendation: result.recommendation,
        recommendationReason: result.recommendationReason,
        estimateAckStatus: result.estimateAckStatus,
      },
    });
  } catch (error) {
    log.error(
      { ip, error: error instanceof Error ? error.message : String(error) },
      "chat.message.error"
    );

    const message =
      error instanceof Error ? error.message : "Internal server error";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/v2/chat?jobId=xxx
 *
 * Returns the conversation history for a job.
 * Requires ownership check — customer can only see their own messages.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");

    if (!jobId) {
      return NextResponse.json(
        { error: "jobId query parameter is required" },
        { status: 400 }
      );
    }

    // Ownership check
    const ownershipError = await checkJobOwnership(request, jobId);
    if (ownershipError) return ownershipError;

    const db = await getDb();

    const messages = await db
      .select()
      .from(schema.messages)
      .where(
        eq(schema.messages.jobId, jobId)
      )
      .orderBy(schema.messages.createdAt);

    return NextResponse.json({
      jobId,
      messages: messages.map((m: any) => ({
        id: m.id,
        senderType: m.senderType,
        messageType: m.messageType,
        content: m.rawContent,
        createdAt: m.createdAt,
      })),
      count: messages.length,
    });
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "chat.history.error"
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
