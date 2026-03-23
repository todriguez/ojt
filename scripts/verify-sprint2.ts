/**
 * Sprint 2 Verification Script
 *
 * Tests the domain logic without needing an Anthropic API key:
 * 1. Effort band inference
 * 2. ROM estimate generation
 * 3. Estimate wording generation
 * 4. Extraction schema + merge logic
 * 5. Conversation state evaluation
 *
 * Usage: npx tsx scripts/verify-sprint2.ts
 */

import { inferEffortBand } from "../src/lib/domain/estimates/effortBandService";
import { generateRomEstimate } from "../src/lib/domain/estimates/estimateService";
import { generateEstimateWording } from "../src/lib/domain/estimates/estimateWordingService";
import {
  messageExtractionSchema,
  accumulatedJobStateSchema,
  mergeExtraction,
} from "../src/lib/ai/extractors/extractionSchema";
import {
  evaluateConversationState,
  generateSystemInjection,
} from "../src/lib/domain/workflow/conversationStateManager";

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

function main() {
  // ── 1. Effort Band Inference ──────────────
  console.log("\n1. Effort Band Inference");

  const doorResult = inferEffortBand({
    jobType: "doors_windows",
    scopeDescription: "3 internal hollow core doors need replacing",
    quantity: "3 doors",
    materials: "hollow core",
    accessDifficulty: null,
  });
  assert("3 doors → full_day", doorResult.band === "full_day", `got ${doorResult.band}`);

  const fenceResult = inferEffortBand({
    jobType: "fencing",
    scopeDescription: "6m fence section blown down, snapped post",
    quantity: "6m",
    materials: null,
    accessDifficulty: null,
  });
  assert("6m fence section → full_day or multi_day", ["full_day", "multi_day"].includes(fenceResult.band), `got ${fenceResult.band}`);

  const quickResult = inferEffortBand({
    jobType: "general",
    scopeDescription: "hang a picture frame on the wall",
    quantity: null,
    materials: null,
    accessDifficulty: null,
  });
  assert("Hang picture → quick", quickResult.band === "quick", `got ${quickResult.band}`);

  const unknownResult = inferEffortBand({
    jobType: "general",
    scopeDescription: null,
    quantity: null,
    materials: null,
    accessDifficulty: null,
  });
  assert("No description → unknown", unknownResult.band === "unknown", `got ${unknownResult.band}`);

  const scaffoldResult = inferEffortBand({
    jobType: "roofing",
    scopeDescription: "few tiles need replacing, leak near valley",
    quantity: "few tiles",
    materials: null,
    accessDifficulty: "scaffolding_required",
  });
  assert(
    "Roof tiles + scaffolding → bumped up",
    ["full_day", "multi_day"].includes(scaffoldResult.band),
    `got ${scaffoldResult.band}`
  );

  const deckResult = inferEffortBand({
    jobType: "carpentry",
    scopeDescription: "deck boards soft and cracking, raised deck 4x5m",
    quantity: null,
    materials: null,
    accessDifficulty: null,
  });
  assert("Deck repair → half_day+", ["half_day", "full_day"].includes(deckResult.band), `got ${deckResult.band}`);

  // ── 2. ROM Estimate Generation ────────────
  console.log("\n2. ROM Estimate Generation");

  const doorEstimate = generateRomEstimate({
    effortBand: "full_day",
    jobType: "doors_windows",
    materials: null,
    quantity: "3",
  });
  assert("3 doors per-unit cost range", doorEstimate.costMin === 900 && doorEstimate.costMax === 1200, `got ${doorEstimate.costMin}-${doorEstimate.costMax}`);
  assert("All-in pricing (not labour-only)", doorEstimate.labourOnly === false);
  assert("Materials note present", !!doorEstimate.materialsNote);

  const unknownEstimate = generateRomEstimate({
    effortBand: "unknown",
    jobType: "general",
  });
  assert("Unknown band → zero costs", unknownEstimate.costMin === 0 && unknownEstimate.costMax === 0);

  const fullDayEstimate = generateRomEstimate({
    effortBand: "full_day",
    jobType: "carpentry",
  });
  assert("Full-day cost range", fullDayEstimate.costMin === 550 && fullDayEstimate.costMax === 900);

  // ── 3. Estimate Wording ───────────────────
  console.log("\n3. Estimate Wording");

  const doorWording = generateEstimateWording({
    estimate: doorEstimate,
    jobType: "doors_windows",
    scopeDescription: "3 internal doors need replacing",
    quantity: "3",
    materials: "hollow core",
  });
  assert("Customer-facing wording present", doorWording.customerFacing.length > 20);
  assert("Expectation check present", doorWording.expectationCheck.length > 10);
  assert("Internal note present", doorWording.internalNote.includes("$"));
  assert("Contains price range", doorWording.customerFacing.includes("$"));
  assert("No hourly rate shown", !doorWording.customerFacing.includes("/hr") && !doorWording.customerFacing.includes("per hour"));

  const unknownWording = generateEstimateWording({
    estimate: unknownEstimate,
    jobType: "general",
    scopeDescription: null,
  });
  assert("Unknown → asks for more detail", unknownWording.customerFacing.includes("more detail"));

  // ── 4. Extraction Schema + Merge ──────────
  console.log("\n4. Extraction Schema + Merge");

  const extraction1 = messageExtractionSchema.parse({
    jobType: "doors_windows",
    scopeDescription: "3 internal doors need replacing",
    suburb: "Noosa Heads",
    conversationPhase: "describing_job",
    missingInfo: ["contact_details", "urgency"],
  });
  assert("Extraction 1 parsed", extraction1.jobType === "doors_windows");
  assert("Null fields default", extraction1.customerName === null);

  const emptyState = accumulatedJobStateSchema.parse({});
  assert("Empty state defaults", emptyState.conversationPhase === "greeting");
  assert("Empty completeness", emptyState.completenessScore === 0);

  const merged1 = mergeExtraction(emptyState, extraction1).state;
  assert("Merge: jobType set", merged1.jobType === "doors_windows");
  assert("Merge: suburb set", merged1.suburb === "Noosa Heads");
  assert("Merge: completeness > 0", merged1.completenessScore > 0);
  assert("Merge: missing info carried", merged1.missingInfo.length === 2);

  const extraction2 = messageExtractionSchema.parse({
    customerName: "Sarah Mitchell",
    customerPhone: "0423456789",
    urgency: "flexible",
    conversationPhase: "providing_contact",
    missingInfo: [],
  });

  const merged2 = mergeExtraction(merged1, extraction2).state;
  assert("Merge 2: name set", merged2.customerName === "Sarah Mitchell");
  assert("Merge 2: phone set", merged2.customerPhone === "0423456789");
  assert("Merge 2: suburb preserved", merged2.suburb === "Noosa Heads");
  assert("Merge 2: completeness higher", merged2.completenessScore > merged1.completenessScore);

  // Test scope description appending
  const extraction3 = messageExtractionSchema.parse({
    scopeDescription: "Standard sizes, ground floor, hollow core doors",
    conversationPhase: "providing_details",
    missingInfo: [],
  });
  const merged3 = mergeExtraction(merged1, extraction3).state;
  assert("Merge 3: scope appended", !!(merged3.scopeDescription?.includes("3 internal") && merged3.scopeDescription?.includes("Standard sizes")));

  // ── 5. Conversation State Evaluation ──────
  console.log("\n5. Conversation State Evaluation");

  // Early state — just continue
  const earlyAction = evaluateConversationState(emptyState);
  assert("Empty state → continue", earlyAction.type === "continue");

  // State with enough for estimate
  const readyForEstimate = accumulatedJobStateSchema.parse({
    jobType: "doors_windows",
    scopeDescription: "3 internal doors need replacing, hollow core, standard sizes",
    suburb: "Noosa Heads",
    quantity: "3 doors",
    materials: "hollow core",
    completenessScore: 55,
    scopeClarity: 70,
    locationClarity: 60,
    estimateReadiness: 65,
    conversationPhase: "providing_details",
    estimatePresented: false,
    estimateAcknowledged: false,
  });
  const estimateAction = evaluateConversationState(readyForEstimate);
  assert("Ready for estimate → present_estimate", estimateAction.type === "present_estimate", `got ${estimateAction.type}`);

  if (estimateAction.type === "present_estimate") {
    assert("Estimate wording has price", estimateAction.wording.includes("$"));
    assert("Has expectation check", estimateAction.expectationCheck.length > 0);
  }

  // State after estimate acknowledged, no contact
  const needsContact = accumulatedJobStateSchema.parse({
    jobType: "doors_windows",
    scopeDescription: "3 internal doors need replacing",
    suburb: "Noosa Heads",
    completenessScore: 75,
    scopeClarity: 60,
    locationClarity: 60,
    estimateReadiness: 70,
    estimateAckStatus: "accepted",
    conversationPhase: "reviewing_estimate",
    estimatePresented: true,
    estimateAcknowledged: true,
  });
  const contactAction = evaluateConversationState(needsContact);
  assert("Estimate acknowledged, no contact → ask_contact", contactAction.type === "ask_contact", `got ${contactAction.type}`);

  // State ready to close
  const readyToClose = accumulatedJobStateSchema.parse({
    jobType: "doors_windows",
    scopeDescription: "3 internal doors need replacing",
    suburb: "Noosa Heads",
    customerName: "Sarah",
    customerPhone: "0423456789",
    completenessScore: 90,
    scopeClarity: 70,
    locationClarity: 60,
    contactReadinessScore: 70,
    decisionReadiness: 75,
    estimateAckStatus: "accepted",
    conversationPhase: "providing_contact",
    estimatePresented: true,
    estimateAcknowledged: true,
  });
  const closeAction = evaluateConversationState(readyToClose);
  assert("Full info → summarise_and_close", closeAction.type === "summarise_and_close", `got ${closeAction.type}`);

  if (closeAction.type === "summarise_and_close") {
    assert("Summary has job description", closeAction.summary.includes("doors"));
    assert("Summary has location", closeAction.summary.includes("Noosa"));
    assert("Summary has name", closeAction.summary.includes("Sarah"));
  }

  // System injection generation
  console.log("\n6. System Injection Generation");

  const continueInjection = generateSystemInjection({ type: "continue" });
  assert("Continue → null injection", continueInjection === null);

  if (estimateAction.type === "present_estimate") {
    const estInjection = generateSystemInjection(estimateAction);
    assert("Estimate → has SYSTEM tag", estInjection?.includes("[SYSTEM") === true);
    assert("Estimate → has price", estInjection?.includes("$") === true);
  }

  const contactInjection = generateSystemInjection({ type: "ask_contact" });
  assert("Ask contact → has SYSTEM tag", contactInjection?.includes("[SYSTEM") === true);

  // ── Summary ───────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nSprint 2 domain logic verified. All systems operational.");
    console.log("Next: wire up with real Anthropic API key for live testing.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
