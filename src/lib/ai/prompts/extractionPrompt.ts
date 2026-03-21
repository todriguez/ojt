/**
 * Prompt for extracting structured data from a customer message.
 *
 * Sprint 3: Much more aggressive about inferring likely meaning,
 * while clearly distinguishing facts from weak signals.
 */

import type { AccumulatedJobState } from "../extractors/extractionSchema";

export function buildExtractionPrompt(
  currentState: AccumulatedJobState,
  latestMessage: string,
  conversationSummary: string
): string {
  return `You are a data extraction agent for a Sunshine Coast handyman business. Extract structured JSON from a customer's message in context.

CRITICAL RULES:
- Be aggressive about extraction. Extract LIKELY meanings, not just explicit statements.
- A customer saying "3 doors need doing" means jobType is "doors_windows", quantity is "3 doors", repairReplaceSignal is "replace".
- Output ONLY raw JSON. No markdown fences, no backticks, no explanation. Just the { } object.
- Use ONLY the exact enum values listed below. Do NOT invent new values.

CURRENT KNOWN STATE:
${JSON.stringify(currentState, null, 2)}

CONVERSATION SO FAR:
${conversationSummary}

LATEST CUSTOMER MESSAGE:
"${latestMessage}"

Return this JSON structure. Use null for genuinely unknown fields:

{
  "customerName": string | null,
  "customerPhone": string | null,
  "customerEmail": string | null,
  "suburb": string | null,
  "locationClue": string | null,
  "address": string | null,
  "postcode": string | null,
  "accessNotes": string | null,
  "jobType": "carpentry" | "plumbing" | "electrical" | "painting" | "general" | "fencing" | "tiling" | "roofing" | "doors_windows" | "gardening" | "cleaning" | "other" | null,
  "jobTypeConfidence": "certain" | "likely" | "guess" | null,
  "jobSubcategory": string | null,
  "repairReplaceSignal": "repair" | "replace" | "install" | "inspect" | "unclear" | null,
  "scopeDescription": string | null,
  "quantity": string | null,
  "materials": string | null,
  "materialCondition": string | null,
  "accessDifficulty": "ground_level" | "ladder_required" | "scaffolding_required" | "difficult_access" | null,
  "photosReferenced": boolean | null,
  "urgency": "emergency" | "urgent" | "next_week" | "next_2_weeks" | "flexible" | "when_convenient" | "unspecified" | null,
  "estimateReaction": "accepted" | "tentative" | "uncertain" | "pushback" | "rejected" | "wants_exact_price" | "rate_shopping" | "unclear" | null,
  "budgetReaction": "accepted" | "ok" | "unsure" | "expensive" | "cheap" | "wants_hourly" | "wants_guarantee" | null,
  "customerToneSignal": "friendly" | "practical" | "demanding" | "suspicious" | "price_focused" | "vague" | "impatient" | null,
  "micromanagerSignals": boolean | null,
  "cheapestMindset": boolean | null,
  "clarityScore": "very_clear" | "clear" | "vague" | "confused" | null,
  "contactReadiness": "offered" | "willing" | "reluctant" | "refused" | null,
  "isComplete": boolean,
  "missingInfo": string[],
  "conversationPhase": "greeting" | "describing_job" | "providing_details" | "providing_location" | "providing_contact" | "reviewing_estimate" | "confirmed" | "disengaged"
}

EXTRACTION RULES:

1. JOB TYPE — use the EXACT values above:
   "doors" / "door" → "doors_windows"
   "fence" / "fencing" / "paling" → "fencing"
   "tap" / "pipe" / "drain" / "leak" → "plumbing"
   "deck" / "timber framing" / "shelf" / "cabinet" / "pergola" → "carpentry"
   "paint" / "repaint" → "painting"
   "tile" / "grout" → "tiling"
   "roof" / "gutter" → "roofing"
   "light" / "power point" / "switch" → "electrical"
   "curtain rod" / "blind" / "hook" / "hang picture" / "towel rail" / "misc fix" → "general"
   "garden" / "lawn" / "hedge" / "tree" → "gardening"
   If ambiguous, use "general" and set jobTypeConfidence to "guess"

2. URGENCY — use the EXACT values above:
   "ASAP" / "today" / "emergency" / "flooding" → "emergency"
   "urgent" / "this week" / "broken" (safety risk) → "urgent"
   "next week" / "soon" → "next_week"
   "couple of weeks" / "fortnight" → "next_2_weeks"
   "no rush" / "whenever" / "flexible" → "flexible"
   "when you can" / "when convenient" → "when_convenient"

3. ESTIMATE REACTION — only if estimate was previously presented:
   "yeah that's fine" / "sounds good" / "about what I expected" → "accepted"
   "ok" / "I guess" / "maybe" → "tentative"
   "hmm" / "that much?" / "I was thinking less" → "pushback"
   "no way" / "too expensive" / "forget it" → "rejected"
   "what's your hourly rate?" / "can you do it cheaper?" → "wants_exact_price"
   "I'm getting a few quotes" / "what do others charge?" → "rate_shopping"

4. CUSTOMER TONE — read between the lines:
   Helpful, detail naturally → "friendly" or "practical"
   Short reluctant answers → "vague"
   Demanding exact times/methods/prices → "demanding"
   Questioning everything / comparing → "suspicious"
   Every message mentions cost → "price_focused"
   Wants it done NOW, annoyance at timeline → "impatient"

5. CHEAPEST MINDSET — set true if ANY of these:
   - Asks for cheapest option, cheapest fix, cheapest way
   - Only wants a patch/bandaid, not proper repair
   - Pushes back on materials cost, wants to supply own cheap materials
   - Asks "can you just..." to minimise scope
   - Compares to DIY cost or YouTube estimates
   - Multiple mentions of budget/cost being the top priority
   - Tone suggests they see the job as trivial and overpriced

6. CONVERSATION PHASE:
   First message or just said hi → "greeting"
   Describing what they need → "describing_job"
   Answering follow-up questions → "providing_details"
   Talking about location → "providing_location"
   Giving name/phone/email → "providing_contact"
   Responding to an estimate → "reviewing_estimate"
   Agreed to proceed → "confirmed"
   Gone quiet / said no thanks → "disengaged"

7. MISSING INFO — list what would help most right now.

8. SUBURB — extract any Sunshine Coast suburb mentioned. Common ones: Noosa Heads, Noosaville, Sunshine Beach, Tewantin, Cooroy, Peregian Beach, Maroochydore, Mooloolaba, Buderim, Caloundra, Nambour, Coolum Beach, Eumundi, Doonan. Also extract from context like "I'm in Noosa" → "Noosa Heads".

Output ONLY the raw JSON object. No \`\`\`json fences. No markdown. No explanation.`;
}
