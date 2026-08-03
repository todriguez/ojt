/**
 * Prompt for extracting structured data from a customer message.
 *
 * Sprint 3: Much more aggressive about inferring likely meaning,
 * while clearly distinguishing facts from weak signals.
 */

import type { AccumulatedJobState } from "../extractors/extractionSchema";
import { buildCategoryAwareExtractionHints } from "../../domain/categories/categoryResolver";
import {
  JURAL_CATEGORIES,
  PM_CATEGORIES,
  TRADES_CATEGORIES,
  BUILDING_JOB_DIMENSIONS_CATEGORIES,
} from "../../lexicons";

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
  "jobPivot": "same_job" | "additional_scope" | "different_job" | null,
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
   "that seems cheap" / "how can you do it for that?" / "seems low" / "that's not enough time" → "pushback"
   Questions about method/feasibility ("how do you mortise in that time?", "two coats?") → "pushback"
   "no way" / "too expensive" / "forget it" → "rejected"
   "what's your hourly rate?" / "can you do it cheaper?" → "wants_exact_price"
   "I'm getting a few quotes" / "what do others charge?" → "rate_shopping"
   IMPORTANT: "cheap" is pushback (skepticism), not acceptance!

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

9. JOB PIVOT — detect when the customer changes topic mid-conversation:
   - Same work, more details about the current job → "same_job"
   - Adding related scope ("also need...", "while you're here...", "and the kitchen too") that's the SAME TRADE → "additional_scope"
   - Completely DIFFERENT trade or unrelated work (fencing → painting, plumbing → carpentry) → "different_job"
   - First message or no prior job context → null
   - If unsure, use "same_job" — only use "different_job" when it's clearly a separate job

   HARD RULES — these override anything else:
   - If CURRENT KNOWN STATE shows estimatePresented=true OR conversationPhase="reviewing_estimate", jobPivot MUST be "same_job" UNLESS the customer literally names a different property/trade ("also at my mum's house", "different job — paint the bedrooms"). Pushback on the estimate ("seems cheap", "5 hrs?", "how do you do two coats in that time", "bit steep", "what's your rate") is ALWAYS "same_job".
   - Questions about method, materials, time, or price are NEVER different_job — they're the customer probing the current scope. Use "same_job".
   - Single-sentence challenges (under 15 words) referencing time/cost/method are "same_job", not pivots.

${buildCategoryAwareExtractionHints(currentState)}
${buildTaggedFactsSection()}
Output ONLY the raw JSON object. No \`\`\`json fences. No markdown. No explanation.`;
}

/**
 * TAGGED FACTS section (OJT-P6). Appended to the extraction prompt so
 * the LLM also emits `taggedFacts: TaggedFact[]` alongside the existing
 * extraction fields. Categories are rendered from the imported
 * JURAL_CATEGORIES / PM_CATEGORIES so the prompt stays in sync with
 * semantos without manual duplication.
 *
 * The shape matches `src/lib/lexicons/index.ts::TaggedFact`. The post-
 * extraction validator (`validateAgainstLexicon`) enforces the registry
 * — this prompt is only guidance. NEVER trust the LLM's tags without
 * running the validator.
 */
function buildTaggedFactsSection(): string {
  // Rendering from the registry arrays ensures the prompt can't drift
  // from the source of truth. If semantos adds a category, it shows up
  // here without any OJT-side edit.
  const juralList = JURAL_CATEGORIES.map((c) => `  - ${c}: ${JURAL_DEFINITIONS[c] ?? "(see semantos-core Jural.lean)"}`).join("\n");
  const pmList = PM_CATEGORIES.map((c) => `  - ${c}: ${PM_DEFINITIONS[c] ?? "(see semantos-core PropertyManagement.lean)"}`).join("\n");
  const tradesList = TRADES_CATEGORIES.map((c) => `  - ${c}: ${TRADES_DEFINITIONS[c] ?? "(handyman trade)"}`).join("\n");
  const dimensionsList = BUILDING_JOB_DIMENSIONS_CATEGORIES.map(
    (c) => `  - ${c}: ${DIMENSIONS_DEFINITIONS[c] ?? "(see buildingJobDimensions)"}`
  ).join("\n");

  return `
TAGGED FACTS (OJT-P6):

Alongside the extraction fields above, emit a \`taggedFacts\` array. Each element tags a single fact against ONE (lexicon, category) pair or leaves both null.

Shape:
  "taggedFacts": [
    {
      "lexicon": "jural" | "property-management" | "trades" | "building-job-dimensions" | null,
      "category": <one of the categories for that lexicon> | null,
      "confidence": <number 0..1>,
      "fact": <one-sentence canonicalised statement OR a controlled-vocab token for building-job-dimensions>,
      "source": <verbatim slice of the customer's utterance>
    }
  ]

IMPORTANT for "building-job-dimensions": the \`fact\` field must be one of
the controlled-vocabulary tokens below, not free text. The downstream parser
rejects anything that isn't an exact match.

Jural lexicon (legal / Hohfeldian relations):
${juralList}

Property-management lexicon (rental-operations lifecycle):
${pmList}

Trades lexicon (handyman building-trade classification — emit ONE per message naming the trade the job belongs to, matching the \`jobType\` field):
${tradesList}

Building-job-dimensions lexicon (attributes of the job that drive the estimator — emit facts for every signal present in the message, with \`fact\` set to the matching controlled-vocab token):
${dimensionsList}

Controlled vocab per dimension (\`fact\` MUST be one of these, lowercase):
  - surface:          interior | exterior | mixed
  - prep_level:       clean | scuff_sand | fill_patch | plaster_repair | strip_back
  - room_count:       <integer as string — e.g. "1", "8">  (count rooms/areas listed)
  - dwelling_type:    apartment | townhouse | house | commercial
  - access:           ground | ladder | scaffold | difficult
  - material_tier:    standard | mid | premium
  - quantity_signal:  single | small_batch | large_batch
  - work_type:        repair | replace | install | inspect

Rules:
- If a fact does not clearly fit either lexicon, set lexicon=null AND category=null. NEVER guess.
- Confidence below 0.6 will be discarded by the validator. Only report high-confidence tags.
- NEVER set one field null and the other non-null — that's a partial tag and will be rejected.
- A single utterance may produce multiple tagged facts (e.g. a complaint is maintenance + obligation).

FEW-SHOT EXAMPLES:

# Jural — declaration
"I'm letting you know I'll be moving out on the 30th."
  → { "lexicon": "jural", "category": "declaration", "confidence": 0.9, "fact": "Tenant declares intent to vacate on the 30th", "source": "I'm letting you know I'll be moving out on the 30th" }

# Jural — obligation
"the lease says I have to give 28 days notice before leaving"
  → { "lexicon": "jural", "category": "obligation", "confidence": 0.9, "fact": "Tenant obligated to give 28 days notice before vacating", "source": "the lease says I have to give 28 days notice before leaving" }

# Jural — permission
"yeah I asked the landlord and they said go ahead"
  → { "lexicon": "jural", "category": "permission", "confidence": 0.85, "fact": "Landlord granted permission for the tenant to proceed", "source": "I asked the landlord and they said go ahead" }

# Jural — prohibition
"the agreement says no pets under any circumstances"
  → { "lexicon": "jural", "category": "prohibition", "confidence": 0.95, "fact": "Tenancy prohibits pets on the premises", "source": "the agreement says no pets under any circumstances" }

# Jural — power
"as the head tenant I can add a flatmate to the lease"
  → { "lexicon": "jural", "category": "power", "confidence": 0.8, "fact": "Head tenant has power to add a flatmate to the lease", "source": "as the head tenant I can add a flatmate to the lease" }

# Jural — condition
"if the rent clears by Friday we'll waive the late fee"
  → { "lexicon": "jural", "category": "condition", "confidence": 0.85, "fact": "Late fee waived conditional on rent clearing by Friday", "source": "if the rent clears by Friday we'll waive the late fee" }

# Jural — transfer
"I've transferred the bond over to the new place"
  → { "lexicon": "jural", "category": "transfer", "confidence": 0.85, "fact": "Bond transferred to a different tenancy", "source": "I've transferred the bond over to the new place" }

# Property-management — lease
"we signed a 12-month lease starting in March"
  → { "lexicon": "property-management", "category": "lease", "confidence": 0.95, "fact": "12-month lease commenced in March", "source": "we signed a 12-month lease starting in March" }

# Property-management — maintenance
"the kitchen tap has been leaking for three weeks"
  → { "lexicon": "property-management", "category": "maintenance", "confidence": 0.9, "fact": "Kitchen tap leaking for 3 weeks", "source": "the kitchen tap has been leaking for three weeks" }

# Property-management — inspection
"the agent is doing the routine inspection next Tuesday"
  → { "lexicon": "property-management", "category": "inspection", "confidence": 0.9, "fact": "Routine inspection scheduled for next Tuesday", "source": "the agent is doing the routine inspection next Tuesday" }

# Property-management — rent
"rent's going up by $40 a week from next month"
  → { "lexicon": "property-management", "category": "rent", "confidence": 0.9, "fact": "Rent increase of $40/week effective next month", "source": "rent's going up by $40 a week from next month" }

# Property-management — violation
"the neighbour complained I had four people living here when the lease says two"
  → { "lexicon": "property-management", "category": "violation", "confidence": 0.85, "fact": "Alleged occupancy breach — four residents vs lease limit of two", "source": "neighbour complained I had four people living here when the lease says two" }

# Property-management — renewal
"the agent offered to renew the lease for another 12 months"
  → { "lexicon": "property-management", "category": "renewal", "confidence": 0.9, "fact": "Agent offered 12-month lease renewal", "source": "the agent offered to renew the lease for another 12 months" }

# Property-management — termination
"I got a notice to vacate because they're selling the place"
  → { "lexicon": "property-management", "category": "termination", "confidence": 0.95, "fact": "Notice to vacate issued due to property sale", "source": "I got a notice to vacate because they're selling the place" }

# Trades — doors_windows
"I need three doors hung and one frame replaced"
  → { "lexicon": "trades", "category": "doors_windows", "confidence": 0.95, "fact": "Three doors to hang and one frame to replace", "source": "three doors hung and one frame replaced" }

# Trades — general (assembly)
"can you put together a wardrobe and a couple of flatpack desks"
  → { "lexicon": "trades", "category": "general", "confidence": 0.9, "fact": "Wardrobe assembly plus two flatpack desks", "source": "put together a wardrobe and a couple of flatpack desks" }

# Trades — fencing
"storm knocked down about 6m of side fence — paling fence with concreted posts"
  → { "lexicon": "trades", "category": "fencing", "confidence": 0.95, "fact": "6m of paling side fence with concreted posts down after storm", "source": "6m of side fence — paling fence with concreted posts" }

# Building-job-dimensions — surface + dwelling
"whole apartment interior"
  → { "lexicon": "building-job-dimensions", "category": "surface", "confidence": 0.95, "fact": "interior", "source": "whole apartment interior" }
  → { "lexicon": "building-job-dimensions", "category": "dwelling_type", "confidence": 0.9, "fact": "apartment", "source": "whole apartment interior" }

# Building-job-dimensions — room_count + quantity_signal
"2 bedroom, two bath, wc, laundry, hallway, living area, kitchen"
  → { "lexicon": "building-job-dimensions", "category": "room_count", "confidence": 0.95, "fact": "8", "source": "2 bedroom, two bath, wc, laundry, hallway, living area, kitchen" }
  → { "lexicon": "building-job-dimensions", "category": "quantity_signal", "confidence": 0.9, "fact": "large_batch", "source": "2 bedroom, two bath, wc, laundry, hallway, living area, kitchen" }

# Building-job-dimensions — prep_level (fill_patch)
"lots of screw holes and holes where the door handles went through the wall"
  → { "lexicon": "building-job-dimensions", "category": "prep_level", "confidence": 0.9, "fact": "fill_patch", "source": "lots of screw holes and holes where the door handles went through the wall" }

# Building-job-dimensions — prep_level (plaster_repair, escalating)
"yeah we need plaster repairs on everything"
  → { "lexicon": "building-job-dimensions", "category": "prep_level", "confidence": 0.95, "fact": "plaster_repair", "source": "we need plaster repairs on everything" }

# Building-job-dimensions — access
"it's a two-storey job so you'll need scaffolding up there"
  → { "lexicon": "building-job-dimensions", "category": "access", "confidence": 0.9, "fact": "scaffold", "source": "two-storey job so you'll need scaffolding up there" }

# Building-job-dimensions — work_type (repair vs replace)
"one of the palings has snapped, needs replacing"
  → { "lexicon": "building-job-dimensions", "category": "work_type", "confidence": 0.9, "fact": "replace", "source": "needs replacing" }

# Untagged (no fit — set both null)
"yeah cheers thanks for sorting that"
  → { "lexicon": null, "category": null, "confidence": 0.9, "fact": "Tenant acknowledgement of assistance", "source": "cheers thanks for sorting that" }
`;
}

/**
 * One-line human-readable definitions for the Jural categories. Keys
 * are kept loose (string index) so if semantos ever adds a category we
 * don't break at compile time — missing entries fall through to a
 * generic note in buildTaggedFactsSection.
 */
const JURAL_DEFINITIONS: Record<string, string> = {
  declaration: "an explicit announcement or statement of status/intent (\"I hereby...\", \"I'm letting you know...\")",
  obligation: "a duty owed — someone MUST do something (\"I have to\", \"the lease requires\")",
  permission: "authorisation granted — someone MAY do something (\"I said it's fine\", \"go ahead\")",
  prohibition: "a ban — someone MUST NOT do something (\"no pets\", \"not allowed\")",
  power: "legal capacity to change another's position (\"I can terminate\", \"the agent may evict\")",
  condition: "an if/then that gates some effect (\"if X then Y\", \"provided that\", \"as long as\")",
  transfer: "movement of a right, obligation, or thing between parties (\"I've handed it over\", \"bond transferred\")",
};

/** One-line definitions for the PropertyManagement categories. */
const PM_DEFINITIONS: Record<string, string> = {
  lease: "creation, structure, or terms of the tenancy agreement itself",
  maintenance: "fix/repair/replace requests or reports (leaks, broken fittings, wear)",
  inspection: "scheduled or completed property inspections (routine, entry, exit)",
  rent: "rent amount, changes, payment timing, arrears, or late fees",
  violation: "alleged or actual breach of the lease by any party",
  renewal: "extending or renewing the tenancy past the current term",
  termination: "ending the tenancy — notices to vacate, break-lease, sale, eviction",
};

/** Definitions for building-job-dimensions. Keys line up with
 *  BuildingJobDimensionsLexicon.categories — each is a dimension whose
 *  value goes in the TaggedFact.fact field as a controlled-vocab token. */
const DIMENSIONS_DEFINITIONS: Record<string, string> = {
  surface:         "interior vs exterior vs mixed — drives painting/cleaning bumps",
  prep_level:      "how much surface prep — clean | scuff_sand | fill_patch | plaster_repair | strip_back",
  room_count:      "integer count of rooms/areas the customer listed (emit as a string)",
  dwelling_type:   "apartment | townhouse | house | commercial — affects access + logistics",
  access:          "ground | ladder | scaffold | difficult — physical access to the work area",
  material_tier:   "standard | mid | premium — quality tier of materials",
  quantity_signal: "single | small_batch | large_batch — coarse count bucket",
  work_type:       "repair | replace | install | inspect — what's actually being done",
};

/** One-line definitions for the Trades categories. Keys line up with
 *  TradesLexicon.categories. */
const TRADES_DEFINITIONS: Record<string, string> = {
  carpentry:     "framing, cabinetry, decks, shelves, built-ins, timber work",
  plumbing:      "taps, drains, hot water, basin, pipes, toilets",
  electrical:    "power points, switches, light fittings, circuits, rewires",
  painting:      "interior/exterior coats, patching, feature walls, stain",
  general:       "assembly, flatpack, wardrobes, bracket work, hang picture / TV mount (catch-all for non-trade-specific handy jobs)",
  fencing:       "panels, posts, gates, palings, boundary fences",
  tiling:        "floor/wall tile repair, grout, splashbacks, bathroom tiling",
  roofing:       "leaks, gutters, ridge caps, tile replacement, whirlybirds",
  doors_windows: "door hanging, adjusting, frames, locks, window sashes, sliding units",
  gardening:     "mow, hedge, mulch, retaining walls, landscaping",
  cleaning:      "pressure wash, house wash, gutter clean, end-of-lease",
  other:         "doesn't fit any of the above — use rarely",
};
