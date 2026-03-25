/**
 * POST /api/v2/chat
 *
 * Processes a customer message through the full intake pipeline:
 * save → extract → merge → evaluate → reply → persist.
 *
 * TWO MODES:
 * 1. Full pipeline (DATABASE_URL set): save → extract → score → reply → persist
 * 2. Stateless fallback (no DB): call Claude with system prompt, return reply
 *
 * Request body:
 * {
 *   jobId?: string — existing job to continue (full mode only)
 *   message: string
 *   messages?: Array<{role, content}> — conversation history (stateless mode)
 *   messageType?: "text" | "voice" | "image"
 * }
 *
 * Response:
 * {
 *   reply: string
 *   jobId: string | null
 *   conversationPhase: string
 *   completenessScore: number
 *   estimatePresented: boolean
 *   mode: "full" | "stateless"
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "@/lib/ai/prompts/systemPrompt";
import { checkRateLimit } from "@/lib/rateLimit";
import { createLogger } from "@/lib/logger";

const log = createLogger("chat");

const chatRequestSchema = z.object({
  jobId: z.string().uuid().optional(),
  organisationId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  channelId: z.string().optional(),  // conversation channel (multi-participant)
  message: z.string().min(1, "Message cannot be empty"),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).optional(),
  messageType: z.enum(["text", "voice", "image"]).default("text"),
  photos: z.array(z.string().url()).optional(),
});

/**
 * Stateless fallback — no DB, just Claude with the system prompt.
 * Keeps conversations working on Vercel without DATABASE_URL.
 */
async function handleStateless(
  message: string,
  conversationHistory: Array<{ role: string; content: string }>,
) {
  const anthropic = new Anthropic();
  const systemPrompt = buildSystemPrompt();

  // Build messages from conversation history
  const messages: Anthropic.MessageParam[] = conversationHistory.length > 0
    ? [
        ...conversationHistory.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ]
    : [{ role: "user" as const, content: message }];

  // Ensure last message is the current one
  if (messages.length === 0 || messages[messages.length - 1].content !== message) {
    messages.push({ role: "user", content: message });
  }

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: systemPrompt,
    messages,
  });

  const reply =
    response.content[0].type === "text"
      ? response.content[0].text
      : "Sorry, something went wrong. Can you say that again?";

  return {
    reply,
    jobId: null,
    conversationPhase: "intake",
    completenessScore: 0,
    estimatePresented: false,
    mode: "stateless" as const,
    scoring: null,
  };
}

/**
 * Full pipeline — DB available, run extraction + scoring + persistence.
 */
async function handleFullPipeline(
  request: NextRequest,
  parsed: z.infer<typeof chatRequestSchema>,
  ip: string,
) {
  const { getDb } = await import("@/lib/db/client");
  const schema = await import("@/lib/db/schema");
  const { processCustomerMessage } = await import("@/lib/services/chatService");
  const { checkJobOwnership } = await import("@/lib/middleware/withOwnershipCheck");

  const sessionCustomerId = request.headers.get("x-session-customer-id");
  const { message, messageType, customerId } = parsed;
  let { jobId, organisationId } = parsed;

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

    // Auto-create organisation ID if not provided (website chat doesn't need one)
    if (!organisationId) {
      organisationId = "00000000-0000-0000-0000-000000000001"; // default org
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
    photos: parsed.photos,
    channelId: parsed.channelId,
  });

  // Use the result's jobId — may differ if a job pivot created a new job
  const finalJobId = result.jobId || jobId;
  log.info({ jobId: finalJobId, phase: result.conversationPhase }, "chat.message.processed");

  return NextResponse.json({
    reply: result.reply,
    jobId: finalJobId,
    channelId: result.channelId,
    conversationPhase: result.conversationPhase,
    completenessScore: result.completenessScore,
    estimatePresented: result.estimatePresented,
    mode: "full",
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
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  try {
    // Rate limit
    const rlSession = await checkRateLimit("chatPerSession", ip);
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

    const { message, messages: conversationHistory } = parsed.data;

    // Choose mode based on DB availability
    const hasDb = !!process.env.DATABASE_URL;

    if (!hasDb) {
      log.info({ ip }, "chat.stateless_mode");
      const result = await handleStateless(message, conversationHistory || []);
      return NextResponse.json(result);
    }

    // Full pipeline with DB
    return await handleFullPipeline(request, parsed.data, ip);
  } catch (error) {
    log.error(
      { ip, error: error instanceof Error ? error.message : String(error) },
      "chat.message.error"
    );

    const msg =
      error instanceof Error ? error.message : "Internal server error";

    return NextResponse.json({ error: msg }, { status: 500 });
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
    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { error: "Chat history requires database connection" },
        { status: 503 }
      );
    }

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");
    const channelId = searchParams.get("channelId");

    if (!jobId) {
      return NextResponse.json(
        { error: "jobId query parameter is required" },
        { status: 400 }
      );
    }

    const { eq, and } = await import("drizzle-orm");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { checkJobOwnership } = await import("@/lib/middleware/withOwnershipCheck");

    // Ownership check
    const ownershipError = await checkJobOwnership(request, jobId);
    if (ownershipError) return ownershipError;

    const db = await getDb();

    // Privacy guard: if job has channels, channelId is required for non-admin sessions
    const isAdmin = request.headers.get("x-session-type") === "admin";
    if (!channelId && !isAdmin) {
      try {
        const { ensureSemanticObject } = await import("@/lib/domain/bridge/semanticRuntimeAdapter");
        const { getChannelsForObject } = await import("@/lib/semantos-kernel/channelService");
        const jobRows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
        if (jobRows.length > 0) {
          const semCtx = await ensureSemanticObject(db, jobId, jobRows[0].jobType);
          const jobChannels = await getChannelsForObject(semCtx.semanticObjectId);
          if (jobChannels.length > 0) {
            return NextResponse.json(
              { error: "channelId is required for this job" },
              { status: 400 }
            );
          }
        }
      } catch {
        // If semantic object doesn't exist, fall through to unscoped query
      }
    }

    // Build query: scope by channelId if provided
    const whereClause = channelId
      ? and(eq(schema.messages.jobId, jobId), eq(schema.messages.channelId, channelId))
      : eq(schema.messages.jobId, jobId);

    const messages = await db
      .select()
      .from(schema.messages)
      .where(whereClause)
      .orderBy(schema.messages.createdAt);

    return NextResponse.json({
      jobId,
      channelId,
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
