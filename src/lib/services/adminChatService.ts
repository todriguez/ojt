/**
 * Admin Chat Service — Claude with tool use for Todd's admin copilot.
 *
 * Sends messages to Claude with a set of DB operation tools.
 * Implements the tool execution loop: Claude may call tools,
 * we execute them and send results back, until Claude responds with text.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@/lib/logger";
import {
  searchJobs,
  getJobDetail,
  addJobNote,
  addJobPhotos,
  updateJobEstimate,
  updateJobStatus,
  getScheduleSummary,
  generateFormalQuote,
} from "./adminChatTools";

const log = createLogger("admin-chat");

const MODEL = "claude-sonnet-4-5-20250514";

// ─────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Todd's business assistant for Odd Job Todd, a handyman business on the Sunshine Coast (Noosa area).

Todd is usually on his phone at job sites. Keep responses SHORT and practical — no waffle.

WHAT YOU CAN DO:
- Search and view jobs in the database
- Add notes, photos, measurements to jobs
- Update job estimates (effort, cost, materials)
- Change job status (schedule, mark complete, etc.)
- Generate formal quotes
- Show a summary of active/upcoming work

RULES:
- Currency: AUD ($)
- Dates: Australian format (DD/MM/YYYY)
- When Todd mentions a job by suburb, customer name, or description, search for it — don't ask for an ID
- When Todd uploads photos, link them to the most recently discussed job
- Keep job lists compact: one line per job (type, suburb, status, cost)
- If Todd says "quote" or "quote it", generate a formal quote
- Todd often shortens words: "reckon" = estimate, "arvo" = afternoon, "sparky" = electrician

EFFORT BANDS:
- quick: 30min-1hr ($80-150)
- short: 1-2hrs ($150-280)
- quarter_day: 2-3hrs ($250-400)
- half_day: 3-5hrs ($350-600)
- full_day: 5-8hrs ($550-900)
- multi_day: 8-24hrs ($900-2500)`;

// ─────────────────────────────────────────────
// Tool Definitions (Anthropic format)
// ─────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_jobs",
    description: "Search jobs by status, suburb, customer name, job type, or lead source. Returns a compact list.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "array", items: { type: "string" }, description: "Filter by status(es): new_lead, partial_intake, awaiting_customer, needs_site_visit, ready_for_review, estimate_presented, bookable, scheduled, in_progress, complete, etc." },
        suburb: { type: "string", description: "Filter by suburb name (partial match)" },
        customerName: { type: "string", description: "Filter by customer name (partial match)" },
        jobType: { type: "string", description: "Filter by job type: carpentry, plumbing, electrical, painting, general, fencing, tiling, roofing, doors_windows, gardening, cleaning, other" },
        leadSource: { type: "string", description: "Filter by lead source: website_chat, agent_pdf, phone, referral, etc." },
        limit: { type: "number", description: "Max results (default 10, max 20)" },
      },
    },
  },
  {
    name: "get_job_detail",
    description: "Get full details of a specific job including conversation history, estimates, photos, and operator notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string", description: "The job UUID" },
      },
      required: ["jobId"],
    },
  },
  {
    name: "add_job_note",
    description: "Add an operator note to a job. Use for measurements, materials lists, access notes, or general observations.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string", description: "The job UUID" },
        note: { type: "string", description: "The note text" },
        noteType: { type: "string", enum: ["general", "measurement", "materials", "access"], description: "Type of note (default: general)" },
      },
      required: ["jobId", "note"],
    },
  },
  {
    name: "add_job_photos",
    description: "Link uploaded photo URLs to a job. Photos should already be uploaded via the upload endpoint.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string", description: "The job UUID" },
        photoUrls: { type: "array", items: { type: "string" }, description: "Array of photo URLs" },
        captions: { type: "array", items: { type: "string" }, description: "Optional captions for each photo" },
      },
      required: ["jobId", "photoUrls"],
    },
  },
  {
    name: "update_job_estimate",
    description: "Set or update Todd's estimate for a job. Effort band, hours, cost range, materials, and assumptions.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string", description: "The job UUID" },
        effortBand: { type: "string", enum: ["quick", "short", "quarter_day", "half_day", "full_day", "multi_day"], description: "Effort band" },
        hoursMin: { type: "number", description: "Minimum hours estimate" },
        hoursMax: { type: "number", description: "Maximum hours estimate" },
        costMin: { type: "number", description: "Minimum cost in AUD" },
        costMax: { type: "number", description: "Maximum cost in AUD" },
        materials: { type: "string", description: "Materials needed (shopping list)" },
        assumptions: { type: "string", description: "Assumptions made for this estimate" },
      },
      required: ["jobId"],
    },
  },
  {
    name: "update_job_status",
    description: "Change a job's status. Use for scheduling, marking complete, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string", description: "The job UUID" },
        newStatus: { type: "string", description: "New status: needs_site_visit, scheduled, in_progress, complete, bookable, ready_for_review, etc." },
        reason: { type: "string", description: "Reason for the status change" },
      },
      required: ["jobId", "newStatus"],
    },
  },
  {
    name: "get_schedule_summary",
    description: "Get a summary of active and upcoming jobs grouped by status.",
    input_schema: {
      type: "object" as const,
      properties: {
        period: { type: "string", enum: ["today", "this_week", "next_week", "all_active"], description: "Time period (default: all_active)" },
      },
    },
  },
  {
    name: "generate_formal_quote",
    description: "Generate a formal quote for a job to send to the customer or agent.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string", description: "The job UUID" },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              amount: { type: "number" },
            },
            required: ["description", "amount"],
          },
          description: "Line items for the quote. If not provided, uses the existing estimate.",
        },
        notes: { type: "string", description: "Additional notes for the quote" },
        validDays: { type: "number", description: "Quote validity in days (default: 14)" },
      },
      required: ["jobId"],
    },
  },
];

// ─────────────────────────────────────────────
// Tool Executor
// ─────────────────────────────────────────────

async function executeTool(name: string, input: any): Promise<any> {
  switch (name) {
    case "search_jobs":
      return searchJobs(input);
    case "get_job_detail":
      return getJobDetail(input);
    case "add_job_note":
      return addJobNote(input);
    case "add_job_photos":
      return addJobPhotos(input);
    case "update_job_estimate":
      return updateJobEstimate(input);
    case "update_job_status":
      return updateJobStatus(input);
    case "get_schedule_summary":
      return getScheduleSummary(input);
    case "generate_formal_quote":
      return generateFormalQuote(input);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─────────────────────────────────────────────
// Main Chat Function
// ─────────────────────────────────────────────

export interface AdminChatInput {
  message: string;
  photos?: string[];
  jobContext?: string;
  history?: Anthropic.MessageParam[];
}

export interface AdminChatResult {
  reply: string;
  toolResults: Array<{ tool: string; result: any }>;
}

export async function processAdminMessage(input: AdminChatInput): Promise<AdminChatResult> {
  const anthropic = new Anthropic();
  const toolResults: Array<{ tool: string; result: any }> = [];

  // Build the user message
  let userContent = input.message;
  if (input.photos?.length) {
    userContent += `\n\n[Uploaded ${input.photos.length} photo(s): ${input.photos.join(", ")}]`;
  }
  if (input.jobContext) {
    userContent += `\n\n[Currently focused on job: ${input.jobContext}]`;
  }

  // Build messages array with history
  const messages: Anthropic.MessageParam[] = [
    ...(input.history || []),
    { role: "user", content: userContent },
  ];

  // Tool execution loop
  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  // Loop while Claude wants to use tools
  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
    );

    const toolResultMessages: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      log.info({ tool: toolUse.name }, "admin-chat.tool.executing");
      try {
        const result = await executeTool(toolUse.name, toolUse.input);
        toolResults.push({ tool: toolUse.name, result });
        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error({ tool: toolUse.name, error: errorMsg }, "admin-chat.tool.error");
        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: errorMsg }),
          is_error: true,
        });
      }
    }

    // Send tool results back to Claude
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResultMessages });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
  }

  // Extract the text reply
  const reply = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");

  return { reply, toolResults };
}
