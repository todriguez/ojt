import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { messages, jobs } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";

// ── Validation ──────────────────────────────

const createMessageSchema = z.object({
  jobId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  senderType: z.enum(["customer", "operator", "system", "ai"]),
  channel: z.enum(["sms", "email", "phone", "whatsapp", "messenger", "webchat"]).default("webchat"),
  messageType: z.enum(["text", "voice", "image", "file", "system"]).default("text"),
  rawContent: z.string().min(1),
  transcript: z.string().optional(),
  extractedJson: z.any().optional(),
});

// ── GET /api/v2/messages?jobId=... ──────────

export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    const { searchParams } = new URL(request.url);

    const jobId = searchParams.get("jobId");
    if (!jobId) {
      return NextResponse.json(
        { error: "jobId query parameter required" },
        { status: 400 }
      );
    }

    const results = await db
      .select()
      .from(messages)
      .where(eq(messages.jobId, jobId))
      .orderBy(messages.createdAt);

    return NextResponse.json({ messages: results });
  } catch (error) {
    console.error("GET /api/v2/messages error:", error);
    return NextResponse.json({ error: "Failed to fetch messages" }, { status: 500 });
  }
}

// ── POST /api/v2/messages ───────────────────

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    const body = await request.json();
    const validated = createMessageSchema.parse(body);

    // Persist message
    const [newMessage] = await db
      .insert(messages)
      .values(validated)
      .returning();

    // Update job's lastCustomerMessageAt if customer message
    if (validated.senderType === "customer" && validated.jobId) {
      await db
        .update(jobs)
        .set({
          lastCustomerMessageAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, validated.jobId));
    }

    return NextResponse.json(newMessage, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("POST /api/v2/messages error:", error);
    return NextResponse.json({ error: "Failed to create message" }, { status: 500 });
  }
}
