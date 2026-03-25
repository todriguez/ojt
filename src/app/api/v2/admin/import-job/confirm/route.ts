/**
 * POST /api/v2/admin/import-job/confirm
 *
 * Create a job from reviewed PDF extraction data.
 * Finds/creates customer, creates job with metadata, inserts opening AI message.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { jobs, customers, messages, jobStateEvents } from "@/lib/db/schema";
import { withAdminAuth } from "@/lib/middleware/withAdminAuth";
import { accumulatedJobStateSchema } from "@/lib/ai/extractors/extractionSchema";
import { createLogger } from "@/lib/logger";

const log = createLogger("import-job");

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

const confirmSchema = z.object({
  pdfUrl: z.string().url(),
  jobState: accumulatedJobStateSchema,
  gaps: z.array(z.object({
    field: z.string(),
    label: z.string(),
    importance: z.enum(["blocking_rom", "nice_to_have"]),
    question: z.string(),
  })).default([]),
});

export const POST = withAdminAuth(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const parsed = confirmSchema.parse(body);
    const { jobState, gaps, pdfUrl } = parsed;
    const db = await getDb();

    // Find or create customer by phone
    let customerId: string | undefined;
    if (jobState.customerPhone) {
      const existing = await db
        .select()
        .from(customers)
        .where(eq(customers.mobile, jobState.customerPhone))
        .limit(1);

      if (existing.length > 0) {
        customerId = existing[0].id;
        // Update name/email if we have new info
        if (jobState.customerName || jobState.customerEmail) {
          await db
            .update(customers)
            .set({
              ...(jobState.customerName && !existing[0].name ? { name: jobState.customerName } : {}),
              ...(jobState.customerEmail && !existing[0].email ? { email: jobState.customerEmail } : {}),
            })
            .where(eq(customers.id, customerId));
        }
      } else {
        const [newCustomer] = await db
          .insert(customers)
          .values({
            organisationId: DEFAULT_ORG_ID,
            name: jobState.customerName || "Unknown",
            mobile: jobState.customerPhone,
            email: jobState.customerEmail || undefined,
            preferredContactChannel: "sms",
          })
          .returning();
        customerId = newCustomer.id;
      }
    }

    // Create the job
    const [newJob] = await db
      .insert(jobs)
      .values({
        organisationId: DEFAULT_ORG_ID,
        customerId: customerId || undefined,
        leadSource: "agent_pdf",
        status: "partial_intake",
        jobType: (jobState.jobType as any) || "general",
        urgency: (jobState.urgency as any) || "unspecified",
        descriptionRaw: jobState.scopeDescription || undefined,
        metadata: jobState as any,
      })
      .returning();

    const jobId = newJob.id;

    // Log state event
    await db.insert(jobStateEvents).values({
      jobId,
      fromState: "new_lead",
      toState: "partial_intake",
      actorType: "system",
      reason: "Created from PDF import",
    });

    // ── Semantic layer: create object + participant channels ──
    let channelId: string | undefined;
    try {
      const { ensureSemanticObject } = await import("@/lib/domain/bridge/semanticRuntimeAdapter");
      const { addParticipantWithChannel } = await import("@/lib/semantos-kernel/channelService");
      const { seedTradesPolicyTemplates, getPolicyTemplateForScenario } = await import("@/lib/semantos-kernel/verticals/trades/policies.trades");
      const { assignChannelPolicy, getActivePolicyTemplate } = await import("@/lib/semantos-kernel/channelService");

      // Seed policy templates (idempotent — hard dependency, not lazy)
      await seedTradesPolicyTemplates();

      const semCtx = await ensureSemanticObject(db, jobId, (jobState.jobType as string) || "general");
      const objectId = semCtx.semanticObjectId;

      // Create tenant/customer participant + channel
      if (customerId) {
        const { channel, participant } = await addParticipantWithChannel({
          objectId,
          identityRef: `customer:${customerId}`,
          identityKind: "customer",
          participantRole: "contributor",
          displayName: jobState.customerName || undefined,
        });
        channelId = channel.id;

        // Assign policy based on scenario
        const templateName = getPolicyTemplateForScenario("agent_pdf");
        const template = await getActivePolicyTemplate("trades", templateName);
        if (template) {
          await assignChannelPolicy({ channelId: channel.id, policyId: template.id, participantId: participant.id });
        }
      }

      // Create REA/agent participant + channel if agent info exists
      if (jobState.referringAgentEmail || jobState.referringAgentPhone) {
        const agentRef = jobState.referringAgentEmail
          ? `email:${jobState.referringAgentEmail}`
          : `phone:${jobState.referringAgentPhone}`;
        await addParticipantWithChannel({
          objectId,
          identityRef: agentRef,
          identityKind: "external",
          participantRole: "creator",
          displayName: jobState.referringAgentName || "Property Agent",
        });
      }

      log.info({ jobId, channelId, objectId }, "import-job.channels.created");
    } catch (err) {
      log.warn({ err, jobId }, "import-job.channels.failed");
      // Non-fatal: job exists, channels can be created later
    }

    // Build the opening AI message that summarises the extraction
    const taskSummary = jobState.importedTasks
      .map((t) => t.description)
      .join(", ");
    const address = jobState.address || jobState.suburb || "the property";

    let openingMessage = `G'day! Todd's been asked to look at some work at ${address}.`;
    if (taskSummary) {
      openingMessage += ` From what I've got so far: ${taskSummary}.`;
    }
    if (gaps.length > 0) {
      openingMessage += " Just need to check a few things before Todd can give you a rough idea on pricing.";
      const firstBlockingGap = gaps.find((g) => g.importance === "blocking_rom");
      if (firstBlockingGap) {
        openingMessage += `\n\n${firstBlockingGap.question}`;
      }
    }

    // Insert the opening message (in the tenant's channel if available)
    await db.insert(messages).values({
      jobId,
      customerId: customerId || undefined,
      senderType: "ai",
      messageType: "text",
      rawContent: openingMessage,
      channelId: channelId || undefined,
    });

    log.info(
      { jobId, customerId, taskCount: jobState.importedTasks.length, gapCount: gaps.length },
      "import-job.created"
    );

    return NextResponse.json({
      success: true,
      jobId,
      customerId,
      channelId,
      openingMessage,
    });
  } catch (error) {
    console.error("Job confirm error:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid data", details: error.issues }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Failed to create job: ${error instanceof Error ? error.message : "Unknown error"}` },
      { status: 500 }
    );
  }
});
