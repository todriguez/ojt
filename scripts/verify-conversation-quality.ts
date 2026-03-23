/**
 * Conversation Quality Verification
 *
 * Deterministic tests for the conversation pipeline:
 * - Multi-turn state accumulation
 * - Effort band + cure time coverage
 * - Per-unit pricing
 * - Estimate wording quality
 * - Stop conditions
 * - Scope deduplication
 * - Pushback classification
 */

import { accumulatedJobStateSchema, mergeExtraction, messageExtractionSchema } from "../src/lib/ai/extractors/extractionSchema";
import type { AccumulatedJobState } from "../src/lib/ai/extractors/extractionSchema";

function createEmptyState(): AccumulatedJobState {
  return accumulatedJobStateSchema.parse({});
}
import { evaluateConversationState } from "../src/lib/domain/workflow/conversationStateManager";
import { inferEffortBand } from "../src/lib/domain/estimates/effortBandService";
import { generateRomEstimate } from "../src/lib/domain/estimates/estimateService";
import { generateEstimateWording } from "../src/lib/domain/estimates/estimateWordingService";
import { classifyFromText, classifyEstimateAcknowledgement } from "../src/lib/ai/classifiers/estimateAcknowledgementClassifier";

// ── Test harness ──────────────────────────────

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ── 1. Multi-turn State Accumulation ──────────

section("1. Multi-turn State Accumulation");

const state0 = createEmptyState();

const ext1 = messageExtractionSchema.parse({
  jobType: "doors_windows",
  jobTypeConfidence: "certain",
  scopeDescription: "3 new interior doors to be hung and painted",
  quantity: "3 doors",
  conversationPhase: "describing_job",
  missingInfo: ["location", "urgency"],
});
const state1 = mergeExtraction(state0, ext1).state;
assert("Turn 1: jobType set", state1.jobType === "doors_windows");
assert("Turn 1: scopeClarity > 0", state1.scopeClarity > 0, `got ${state1.scopeClarity}`);
assert("Turn 1: locationClarity = 0", state1.locationClarity === 0);

const ext2 = messageExtractionSchema.parse({
  suburb: "Noosa Heads",
  conversationPhase: "providing_location",
  missingInfo: ["urgency"],
});
const state2 = mergeExtraction(state1, ext2).state;
assert("Turn 2: suburb set", state2.suburb === "Noosa Heads");
assert("Turn 2: locationClarity > 0", state2.locationClarity > 0, `got ${state2.locationClarity}`);
assert("Turn 2: scopeClarity preserved", state2.scopeClarity >= state1.scopeClarity);

const ext3 = messageExtractionSchema.parse({
  urgency: "next_week",
  accessDifficulty: "ground_level",
  conversationPhase: "providing_details",
  missingInfo: [],
});
const state3 = mergeExtraction(state2, ext3).state;
assert("Turn 3: urgency set", state3.urgency === "next_week");
assert("Turn 3: estimateReadiness higher", state3.estimateReadiness >= state2.estimateReadiness, `${state3.estimateReadiness} vs ${state2.estimateReadiness}`);

const ext4 = messageExtractionSchema.parse({
  customerName: "Dave",
  customerPhone: "0412345678",
  conversationPhase: "providing_contact",
  missingInfo: [],
});
const state4 = mergeExtraction(state3, ext4).state;
assert("Turn 4: contactReadiness jumps", state4.contactReadinessScore > state3.contactReadinessScore);
assert("Turn 4: completeness highest", state4.completenessScore > state3.completenessScore, `${state4.completenessScore} vs ${state3.completenessScore}`);
assert("Turn 4: phase progression", state4.conversationPhase === "providing_contact");

// ── 2. Effort Band + Cure Time Coverage ──────

section("2. Effort Band + Cure Time Coverage");

// Painting with 2 coats should bump
const paintResult = inferEffortBand({ jobType: "painting", scopeDescription: "paint 1 room, 2 coats", quantity: null });
assert("1 room paint 2 coats → full_day", paintResult.band === "full_day", `got ${paintResult.band}`);
assert("Cure time bump in reason", paintResult.reason.includes("cure/dry"), paintResult.reason);

// Painting without explicit coats still bumps (painting always dries)
const paintResult2 = inferEffortBand({ jobType: "painting", scopeDescription: "paint one room" });
assert("1 room paint (no coats) → half_day", paintResult2.band === "half_day", `got ${paintResult2.band}`);

// Concrete footings + post replacement → multi_day
const fenceConcreteResult = inferEffortBand({ jobType: "fencing", scopeDescription: "6m fence section, replace posts, concrete footings" });
assert("Fence + new posts → multi_day", fenceConcreteResult.band === "multi_day", `got ${fenceConcreteResult.band}`);

// Fence without post replacement (posts ok, just re-paling)
const fenceResult = inferEffortBand({ jobType: "fencing", scopeDescription: "6m fence section blown down, existing posts ok" });
assert("Fence no posts → full_day", fenceResult.band === "full_day", `got ${fenceResult.band}`);

// Tiling with grout
const tileResult = inferEffortBand({ jobType: "tiling", scopeDescription: "tile bathroom floor and grout" });
assert("Bathroom floor + grout → multi_day", tileResult.band === "multi_day", `got ${tileResult.band}`);

// General plaster
const plasterResult = inferEffortBand({ jobType: "general", scopeDescription: "patch and plaster a hole in the wall" });
assert("Plaster → full_day (cure bump)", plasterResult.band === "full_day", `got ${plasterResult.band}`);

// 3 doors hung and painted
const doorResult = inferEffortBand({ jobType: "doors_windows", scopeDescription: "3 new interior doors hung and painted 2 coats", quantity: "3 doors" });
assert("3 doors hung + painted → multi_day", doorResult.band === "multi_day", `got ${doorResult.band}`);

// Simple handle fix (no cure)
const handleResult = inferEffortBand({ jobType: "doors_windows", scopeDescription: "fix a loose door handle" });
assert("Door handle → short", handleResult.band === "short", `got ${handleResult.band}`);

// Quick job
const quickResult = inferEffortBand({ jobType: "general", scopeDescription: "hang a picture frame" });
assert("Hang picture → quick", quickResult.band === "quick", `got ${quickResult.band}`);

// ── 3. Per-Unit Pricing ──────────────────────

section("3. Per-Unit Pricing");

// 1 door — per-unit pricing
const rom1door = generateRomEstimate({ effortBand: "half_day", jobType: "doors_windows", quantity: "1 door" });
assert("1 door per-unit: $300–400", rom1door.costMin === 300 && rom1door.costMax === 400, `got ${rom1door.costMin}-${rom1door.costMax}`);
assert("1 door: not labour-only", rom1door.labourOnly === false);

// 3 doors — per-unit pricing
const rom3doors = generateRomEstimate({ effortBand: "full_day", jobType: "doors_windows", quantity: "3 doors" });
assert("3 doors per-unit: $900–1200", rom3doors.costMin === 900 && rom3doors.costMax === 1200, `got ${rom3doors.costMin}-${rom3doors.costMax}`);

// 5 doors
const rom5doors = generateRomEstimate({ effortBand: "multi_day", jobType: "doors_windows", quantity: "5 doors" });
assert("5 doors per-unit: $1500–2000", rom5doors.costMin === 1500 && rom5doors.costMax === 2000, `got ${rom5doors.costMin}-${rom5doors.costMax}`);

// Handle fix — no quantity, falls back to band pricing
const romHandle = generateRomEstimate({ effortBand: "short", jobType: "doors_windows" });
assert("Handle fix: labour-only", romHandle.labourOnly === true);
assert("Handle fix: short band pricing", romHandle.costMin === 150 && romHandle.costMax === 280, `got ${romHandle.costMin}-${romHandle.costMax}`);

// Painting — no per-unit, standard band
const romPaint = generateRomEstimate({ effortBand: "full_day", jobType: "painting" });
assert("Painting: labour-only", romPaint.labourOnly === true);
assert("Painting: full_day band", romPaint.costMin === 550 && romPaint.costMax === 900, `got ${romPaint.costMin}-${romPaint.costMax}`);

// ── 4. Estimate Wording Quality ──────────────

section("4. Estimate Wording Quality");

const bands = ["quick", "short", "quarter_day", "half_day", "full_day", "multi_day"] as const;
for (const band of bands) {
  const rom = generateRomEstimate({ effortBand: band, jobType: "general" });
  const wording = generateEstimateWording({ estimate: rom, jobType: "general", scopeDescription: "fix something" });
  assert(`${band}: contains $`, wording.customerFacing.includes("$"), wording.customerFacing.substring(0, 60));
  assert(`${band}: no hourly rate`, !/\$\d+\s*\/\s*h(ou)?r/i.test(wording.customerFacing), wording.customerFacing.substring(0, 60));
  assert(`${band}: has expectation check`, wording.expectationCheck.length > 0);
}

// All-in wording for doors
const romDoorsWording = generateEstimateWording({
  estimate: rom3doors,
  jobType: "doors_windows",
  scopeDescription: "3 new interior doors hung and painted",
  quantity: "3 doors",
});
assert("Doors wording: says 'all up'", romDoorsWording.customerFacing.includes("all up"), romDoorsWording.customerFacing.substring(0, 80));

// ── 5. Stop Conditions ──────────────────────

section("5. Stop Conditions");

// Vague hourly seeker should NOT present estimate
const vagueState: AccumulatedJobState = {
  ...createEmptyState(),
  customerToneSignal: "price_focused",
  estimateReaction: "rate_shopping",
  scopeDescription: null,
  clarityScore: "vague",
  estimateReadiness: 40,
  scopeClarity: 10,
};
const vagueAction = evaluateConversationState(vagueState);
assert("Vague hourly seeker → continue", vagueAction.type === "continue", `got ${vagueAction.type}`);

// Clear scope + location → present estimate
const clearState: AccumulatedJobState = {
  ...createEmptyState(),
  jobType: "fencing",
  scopeDescription: "5m fence section needs replacing, hardwood palings",
  suburb: "Noosa Heads",
  estimateReadiness: 70,
  scopeClarity: 65,
  locationClarity: 100,
};
const clearAction = evaluateConversationState(clearState);
assert("Clear scope + location → present_estimate", clearAction.type === "present_estimate", `got ${clearAction.type}`);

// Pushback stays in continue
const pushbackState: AccumulatedJobState = {
  ...createEmptyState(),
  estimatePresented: true,
  estimateAckStatus: "pushback",
  scopeDescription: "3 doors hung",
  jobType: "doors_windows",
  scopeClarity: 60,
};
const pushbackAction = evaluateConversationState(pushbackState);
assert("Pushback → continue (not ask_contact)", pushbackAction.type === "continue", `got ${pushbackAction.type}`);

// Accepted + no contact → ask_contact
const acceptedNoContact: AccumulatedJobState = {
  ...createEmptyState(),
  estimatePresented: true,
  estimateAcknowledged: true,
  estimateAckStatus: "accepted",
  scopeDescription: "paint a room",
  jobType: "painting",
  suburb: "Noosa Heads",
  scopeClarity: 60,
};
const contactAction = evaluateConversationState(acceptedNoContact);
assert("Accepted + no phone → ask_contact", contactAction.type === "ask_contact", `got ${contactAction.type}`);

// Complete → summarise_and_close
const completeState: AccumulatedJobState = {
  ...createEmptyState(),
  estimatePresented: true,
  estimateAcknowledged: true,
  estimateAckStatus: "accepted",
  customerName: "Dave",
  customerPhone: "0412345678",
  scopeDescription: "paint a room",
  jobType: "painting",
  suburb: "Noosa Heads",
  decisionReadiness: 80,
  scopeClarity: 60,
};
const closeAction = evaluateConversationState(completeState);
assert("Complete → summarise_and_close", closeAction.type === "summarise_and_close", `got ${closeAction.type}`);

// Hazardous → needs_site_visit
const hazardousState: AccumulatedJobState = {
  ...createEmptyState(),
  scopeDescription: "deck has structural damage and termite activity",
  jobType: "carpentry",
  suburb: "Cooroy",
};
const hazardAction = evaluateConversationState(hazardousState);
assert("Hazardous → needs_site_visit", hazardAction.type === "needs_site_visit", `got ${hazardAction.type}`);

// ── 6. Scope Deduplication ──────────────────

section("6. Scope Deduplication");

const scopeState = createEmptyState();
const scopeExt1 = messageExtractionSchema.parse({
  scopeDescription: "3 new interior doors to be hung and painted",
  conversationPhase: "describing_job",
  missingInfo: [],
});
const scopeState1 = mergeExtraction(scopeState, scopeExt1).state;

// Same scope re-extracted (should not duplicate)
const scopeExt2 = messageExtractionSchema.parse({
  scopeDescription: "3 new interior doors to be hung and painted",
  conversationPhase: "providing_details",
  missingInfo: [],
});
const scopeState2 = mergeExtraction(scopeState1, scopeExt2).state;
assert("Same scope: no duplication", !scopeState2.scopeDescription!.includes(". 3 new"), `got: ${scopeState2.scopeDescription}`);

// Overlapping scope (slightly different wording)
const scopeExt3 = messageExtractionSchema.parse({
  scopeDescription: "3 interior doors need to be hung, painted two coats",
  conversationPhase: "providing_details",
  missingInfo: [],
});
const scopeState3 = mergeExtraction(scopeState2, scopeExt3).state;
assert("Overlapping scope: takes longer version", scopeState3.scopeDescription!.includes("two coats") || scopeState3.scopeDescription!.length >= scopeState2.scopeDescription!.length);

// Genuinely new scope (low overlap)
const scopeState4base = mergeExtraction(createEmptyState(), messageExtractionSchema.parse({
  scopeDescription: "3 internal doors need replacing",
  conversationPhase: "describing_job",
  missingInfo: [],
})).state;
const scopeExt5 = messageExtractionSchema.parse({
  scopeDescription: "Standard sizes, ground floor, hollow core doors",
  conversationPhase: "providing_details",
  missingInfo: [],
});
const scopeState5 = mergeExtraction(scopeState4base, scopeExt5).state;
assert("New details: merged with period", scopeState5.scopeDescription!.includes("doors") && scopeState5.scopeDescription!.includes("hollow core"), `got: ${scopeState5.scopeDescription}`);

// ── 7. Pushback Classification ──────────────

section("7. Pushback Classification");

assert("'sounds good' → accepted", classifyFromText("sounds good").status === "accepted");
assert("'that's fine' → accepted", classifyFromText("that's fine").status === "accepted");
assert("'ok' → tentative", classifyFromText("ok").status === "tentative");
assert("'I'll think about it' → tentative", classifyFromText("I'll think about it").status === "tentative");
assert("'that's expensive' → pushback", classifyFromText("that's expensive").status === "pushback");
assert("'bit steep' → pushback", classifyFromText("bit steep").status === "pushback");
assert("'that seems cheap' → pushback", classifyFromText("that seems cheap").status === "pushback");
assert("'exceedingly cheap' → pushback", classifyFromText("exceedingly cheap").status === "pushback");
assert("'how can you get 2 coats done in that time' → pushback", classifyFromText("how can you get 2 coats done in that time").status === "pushback");
assert("'not enough time' → pushback", classifyFromText("not enough time").status === "pushback");
assert("'no thanks' → rejected", classifyFromText("no thanks").status === "rejected");
assert("'too expensive' → rejected", classifyFromText("too expensive").status === "rejected");
assert("'what's your hourly rate' → wants_exact_price", classifyFromText("what's your hourly rate").status === "wants_exact_price");
assert("'getting a few quotes' → rate_shopping", classifyFromText("getting a few quotes").status === "rate_shopping");

// Combined classifier: extraction takes priority
const combined = classifyEstimateAcknowledgement("accepted", null, "that's expensive");
assert("Combined: extraction wins over text", combined.status === "accepted");
assert("Combined: high confidence from extraction", combined.confidence === "high");

// Combined: falls back to text
const combinedFallback = classifyEstimateAcknowledgement(null, null, "that seems cheap");
assert("Combined fallback: text pattern fires", combinedFallback.status === "pushback");

// ── Results ──────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("");
if (failed > 0) {
  console.log("Conversation quality verification FAILED.");
  process.exit(1);
} else {
  console.log("Conversation quality verified. Pipeline operational.");
}
