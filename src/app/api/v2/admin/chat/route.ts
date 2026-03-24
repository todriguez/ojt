/**
 * POST /api/v2/admin/chat
 *
 * Admin chat copilot — Claude with tool use for managing jobs.
 * Todd sends natural language, Claude uses DB tools to execute.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { processAdminMessage } from "@/lib/services/adminChatService";
import { createLogger } from "@/lib/logger";

const log = createLogger("admin.chat");

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  photos: z.array(z.string().url()).optional(),
  jobContext: z.string().uuid().optional(),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.any(),
  })).optional(),
});

export const POST = withAdminAuth(async (request: NextRequest, authCtx) => {
  try {
    const body = await request.json();
    const parsed = chatSchema.parse(body);

    log.info(
      { email: authCtx.email, messageLength: parsed.message.length },
      "admin.chat.message"
    );

    const result = await processAdminMessage({
      message: parsed.message,
      photos: parsed.photos,
      jobContext: parsed.jobContext,
      history: parsed.history as any,
    });

    return NextResponse.json({
      reply: result.reply,
      toolResults: result.toolResults,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid input", details: error.issues }, { status: 400 });
    }
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "admin.chat.error"
    );
    return NextResponse.json(
      { error: `Chat failed: ${error instanceof Error ? error.message : "Unknown error"}` },
      { status: 500 }
    );
  }
});
