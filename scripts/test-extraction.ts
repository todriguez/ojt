/**
 * Quick test: what does Haiku actually return for extraction?
 */
import fs from "fs";
const envContent = fs.readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import Anthropic from "@anthropic-ai/sdk";
import { buildExtractionPrompt } from "../src/lib/ai/prompts/extractionPrompt";
import { accumulatedJobStateSchema, messageExtractionSchema } from "../src/lib/ai/extractors/extractionSchema";

async function main() {
  const anthropic = new Anthropic();
  const emptyState = accumulatedJobStateSchema.parse({});

  const prompt = buildExtractionPrompt(
    emptyState,
    "Hey, I've got 3 internal doors that need replacing. They're all standard hollow core, nothing fancy. House is in Noosa Heads.",
    ""
  );

  console.log("Prompt length:", prompt.length, "chars\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  console.log("Raw response:\n", text, "\n");

  // Try to parse
  try {
    let clean = text.trim();
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(clean);
    const validated = messageExtractionSchema.parse(parsed);
    console.log("Parsed extraction:");
    console.log("  jobType:", validated.jobType);
    console.log("  suburb:", validated.suburb);
    console.log("  scopeDescription:", validated.scopeDescription);
    console.log("  quantity:", validated.quantity);
    console.log("  materials:", validated.materials);
    console.log("  urgency:", validated.urgency);
    console.log("  phase:", validated.conversationPhase);
    console.log("  missingInfo:", validated.missingInfo);
  } catch (err: any) {
    console.error("Parse failed:", err.message);
  }
}

main();
