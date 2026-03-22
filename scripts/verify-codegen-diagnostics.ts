/**
 * Verification tests for:
 *   1. Codegen (Instrument Service) — rendering quotes, contracts, invoices from lowered IR
 *   2. Diagnostics (Disagreement Analysis) — classifying misses and suggesting policy adjustments
 */

import type { AccumulatedJobState } from "../src/lib/ai/extractors/extractionSchema";
import { runScoringPipeline } from "../src/lib/domain/scoring/scoringPipelineService";
import {
  renderInstrument,
  renderInstrumentAs,
  type RenderedInstrument,
  type RomQuoteInstrument,
  type FixedPriceQuoteInstrument,
  type ServiceAgreementInstrument,
  type InvoiceInstrument,
  type LineItem,
} from "../src/lib/domain/instruments";
import {
  analyzeDisagreement,
  analyzeBatch,
  type OutcomeRecord,
  type DisagreementResult,
  type DiagnosticsSummary,
  type SystemRecommendation,
  type HumanDecision,
  type ActualOutcome,
} from "../src/lib/domain/diagnostics";
import type { SystemScoresSnapshot } from "../src/lib/domain/policy/policyTypes";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// ── Mock Data ───────────────────────────────────────

function mockState(overrides: Partial<AccumulatedJobState> = {}): AccumulatedJobState {
  return {
    customerName: "Jane Smith",
    customerPhone: "0412345678",
    customerEmail: "jane@example.com",
    suburb: "Paddington",
    locationClue: "near the shops",
    address: "42 Latrobe Tce",
    postcode: "4064",
    jobType: "carpentry",
    scopeDescription: "Need a new deck built, about 20sqm hardwood timber",
    quantity: "20sqm",
    materials: "hardwood timber",
    estimatePresented: true,
    estimateAckStatus: "accepted",
    ...overrides,
  } as AccumulatedJobState;
}

function mockSnapshot(overrides: Partial<SystemScoresSnapshot> = {}): SystemScoresSnapshot {
  return {
    fit: {
      score: 72,
      label: "good",
      reasoning: ["+10: Clear communication", "+8: Practical tone"],
      positiveSignals: ["Clear communication", "Practical tone", "Photos provided"],
      negativeSignals: [],
    },
    worthiness: {
      score: 65,
      label: "worth_quoting",
      reasoning: ["+12: Core suburb", "+8: Half day effort", "+6: Above-average value category"],
    },
    recommendation: {
      value: "worth_quoting",
      reason: "Good customer in core area",
      actionHint: "Send formal quote",
    },
    confidence: {
      score: 68,
      label: "moderate",
      factors: ["Scope clarity moderate", "Location confirmed"],
    },
    completeness: {
      total: 71,
      scopeClarity: 72,
      locationClarity: 85,
      contactReadiness: 90,
      estimateReadiness: 61,
      decisionReadiness: 40,
    },
    estimateAck: {
      status: "accepted",
      presented: true,
      acknowledged: true,
    },
    category: {
      path: "services.trades.carpentry",
      name: "Carpentry",
      confidence: "high",
      valueMultiplier: 1.4,
      siteVisitLikely: true,
      licensedTrade: false,
    },
    ...overrides,
  };
}

function mockOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    jobId: "test-job-1",
    policyVersion: 3,
    systemRecommendation: "worth_quoting" as SystemRecommendation,
    systemScores: mockSnapshot(),
    systemConfidence: 68,
    systemPolicySnapshot: null,
    humanDecision: null,
    actualOutcome: null,
    outcomeValue: null,
    missType: null,
    wasSystemCorrect: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════
// PART 1: CODEGEN (INSTRUMENT SERVICE)
// ═══════════════════════════════════════════════════

console.log("\n── Codegen: ROM Quote Rendering ──");

const carpentryState = mockState();
const pipeline = runScoringPipeline(carpentryState);

const romInstrument = renderInstrument(carpentryState, pipeline);
assert(romInstrument !== null, "ROM instrument rendered");
assert(romInstrument!.instrumentPath.startsWith("inst."), "Instrument path starts with inst.");
assert(romInstrument!.categoryPath === "services.trades.carpentry", "Category path correct");
assert(romInstrument!.txType === "hire", "Transaction type is hire");
assert(romInstrument!.generatedAt.length > 0, "Has generation timestamp");
assert(romInstrument!.version === 1, "Default version is 1");

if (romInstrument!.instrumentPath === "inst.quote.rom") {
  const rom = romInstrument as RomQuoteInstrument;
  assert(rom.rom.costMin > 0, "ROM has non-zero cost min");
  assert(rom.rom.costMax > rom.rom.costMin, "ROM cost max > cost min");
  assert(rom.rom.hoursMin > 0, "ROM has hours");
  assert(rom.wording.customerFacing.length > 0, "ROM has customer-facing wording");
  assert(rom.wording.internalNote.length > 0, "ROM has internal note");
} else {
  // If estimate was accepted, it'll render as service agreement
  assert(
    romInstrument!.instrumentPath === "inst.contract.service-agreement",
    "Accepted estimate renders as service agreement"
  );
}

console.log("\n── Codegen: Fixed-Price Quote ──");

const quoteInstrument = renderInstrumentAs(
  "inst.quote.fixed-price",
  carpentryState,
  pipeline,
  { operatorName: "Todd Price", operatorAbn: "12 345 678 901" }
);
assert(quoteInstrument !== null, "Fixed-price quote rendered");
assert(quoteInstrument!.instrumentPath === "inst.quote.fixed-price", "Correct instrument path");

const fpq = quoteInstrument as FixedPriceQuoteInstrument;
assert(fpq.lineItems.length > 0, "Has line items");
assert(fpq.totalExGst >= 0, "Has total ex GST");
assert(fpq.gst >= 0, "Has GST calculated");
assert(fpq.totalIncGst === fpq.totalExGst + fpq.gst, "Inc GST = Ex GST + GST");
assert(fpq.validDays === 14, "14 day validity");
assert(fpq.scopeSummary.length > 0, "Has scope summary");
assert(fpq.inclusions.length > 0, "Has inclusions");
assert(fpq.exclusions.length > 0, "Has exclusions");
assert(fpq.conditions.length > 0, "Has conditions");
assert(fpq.paymentTerms.length > 0, "Has payment terms");

console.log("\n── Codegen: Service Agreement ──");

const agreementInstrument = renderInstrumentAs(
  "inst.contract.service-agreement",
  carpentryState,
  pipeline,
  { operatorName: "Todd Price", operatorAbn: "12 345 678 901" }
);
assert(agreementInstrument !== null, "Service agreement rendered");
assert(agreementInstrument!.instrumentPath === "inst.contract.service-agreement", "Correct path");

const sa = agreementInstrument as ServiceAgreementInstrument;
assert(sa.parties.provider.name === "Todd Price", "Provider name from options");
assert(sa.parties.provider.abn === "12 345 678 901", "Provider ABN from options");
assert(sa.parties.client.name === "Jane Smith", "Client name from state");
assert(sa.parties.client.phone === "0412345678", "Client phone from state");
assert(sa.scope.includes("deck"), "Scope mentions deck");
assert(sa.siteAddress.includes("Paddington"), "Site address includes suburb");
assert(sa.estimatedCost.min > 0, "Has estimated cost min");
assert(sa.estimatedCost.max > sa.estimatedCost.min, "Cost max > min");
assert(sa.paymentTerms.length > 0, "Has payment terms");
assert(sa.warranty.length > 0, "Has warranty clause");
assert(sa.cancellation.length > 0, "Has cancellation terms");
assert(sa.variations.length > 0, "Has variations clause");

console.log("\n── Codegen: Invoice ──");

const invoiceInstrument = renderInstrumentAs(
  "inst.invoice.standard",
  carpentryState,
  pipeline,
  { invoiceNumber: "INV-001", dueDate: "2026-04-05" }
);
assert(invoiceInstrument !== null, "Invoice rendered");

const inv = invoiceInstrument as InvoiceInstrument;
assert(inv.invoiceNumber === "INV-001", "Custom invoice number");
assert(inv.dueDate === "2026-04-05", "Custom due date");
assert(inv.lineItems.length > 0, "Has line items");
assert(inv.gst >= 0, "Has GST");
assert(inv.total > inv.subtotal, "Total > subtotal (GST added)");
assert(inv.paymentMethods.length > 0, "Has payment methods");

console.log("\n── Codegen: Category-Driven Instrument Derivation ──");

// Unaccepted estimate → should be ROM quote
const preAcceptState = mockState({ estimateAckStatus: null, estimatePresented: false });
const preAcceptPipeline = runScoringPipeline(preAcceptState);
const preAcceptInst = renderInstrument(preAcceptState, preAcceptPipeline);
assert(preAcceptInst !== null, "Pre-accept instrument rendered");
assert(preAcceptInst!.instrumentPath === "inst.quote.rom", "Pre-accept → ROM quote");

// No category → null instrument
const emptySt = { jobType: null, scopeDescription: null } as unknown as AccumulatedJobState;
const emptyPipeline = runScoringPipeline(emptySt);
const emptyInst = renderInstrument(emptySt, emptyPipeline);
assert(emptyInst === null, "No category → null instrument");

console.log("\n── Codegen: GST Calculation ──");

// Verify GST is 10%
const items: LineItem[] = [
  { description: "Labour", quantity: 5, unit: "hours", unitPrice: 8000, total: 40000, category: "labour" },
  { description: "Materials", quantity: 1, unit: "lot", unitPrice: 15000, total: 15000, category: "materials" },
];
const customQuote = renderInstrumentAs(
  "inst.quote.fixed-price",
  carpentryState,
  pipeline,
  { lineItems: items }
);
const cq = customQuote as FixedPriceQuoteInstrument;
assert(cq.totalExGst === 55000, "Custom items: total ex GST = 55000");
assert(cq.gst === 5500, "GST = 10% of ex GST");
assert(cq.totalIncGst === 60500, "Total inc GST = ex + GST");
assert(cq.labourTotal === 40000, "Labour subtotal correct");
assert(cq.materialsTotal === 15000, "Materials subtotal correct");

// ═══════════════════════════════════════════════════
// PART 2: DIAGNOSTICS (DISAGREEMENT ANALYSIS)
// ═══════════════════════════════════════════════════

console.log("\n── Diagnostics: Insufficient Data ──");

const noData = analyzeDisagreement(mockOutcome());
assert(noData.direction === "insufficient_data", "No decision/outcome → insufficient data");
assert(noData.severity === "none", "Insufficient data → no severity");
assert(noData.signalAttribution.length === 0, "No attribution for insufficient data");

console.log("\n── Diagnostics: Aligned (System Correct) ──");

const aligned = analyzeDisagreement(mockOutcome({
  humanDecision: "quoted" as HumanDecision,
  actualOutcome: "completed_paid" as ActualOutcome,
  wasSystemCorrect: true,
}));
assert(aligned.direction === "aligned", "Quoted + completed_paid → aligned");
assert(aligned.severity === "none", "Aligned → no severity");

console.log("\n── Diagnostics: System Too Optimistic ──");

// No human decision — pure system vs outcome comparison
const tooOptimistic = analyzeDisagreement(mockOutcome({
  systemRecommendation: "probably_bookable" as SystemRecommendation,
  humanDecision: null,
  actualOutcome: "customer_ghosted" as ActualOutcome,
  wasSystemCorrect: false,
  systemConfidence: 72,
}));
assert(
  tooOptimistic.direction === "system_too_optimistic",
  "Probably bookable + ghosted (no human) → too optimistic"
);
assert(tooOptimistic.severity !== "none", "Too optimistic has severity");
assert(tooOptimistic.signalAttribution.length > 0, "Has signal attribution");
assert(tooOptimistic.description.includes("probably bookable"), "Description mentions recommendation");

// With human override: system said pursue, human declined, outcome bad → human_override_correct
const humanOverrodeOptimism = analyzeDisagreement(mockOutcome({
  systemRecommendation: "worth_quoting" as SystemRecommendation,
  humanDecision: "declined" as HumanDecision,
  actualOutcome: "customer_ghosted" as ActualOutcome,
  wasSystemCorrect: false,
  systemConfidence: 72,
}));
assert(
  humanOverrodeOptimism.direction === "human_override_correct",
  "System optimistic + human declined + bad outcome → human override correct"
);

console.log("\n── Diagnostics: System Too Pessimistic ──");

// No human decision — pure system vs outcome
const tooPessimistic = analyzeDisagreement(mockOutcome({
  systemRecommendation: "not_a_fit" as SystemRecommendation,
  systemScores: mockSnapshot({
    fit: { score: 35, label: "poor", reasoning: ["-15: Cheapest mindset"], positiveSignals: [], negativeSignals: ["Cheapest mindset", "Vague scope"] },
    worthiness: { score: 30, label: "low", reasoning: ["-10: Unknown suburb"] },
    recommendation: { value: "not_a_fit", reason: "Poor fit", actionHint: "Decline" },
  }),
  humanDecision: null,
  actualOutcome: "completed_paid" as ActualOutcome,
  outcomeValue: 85000, // $850
  wasSystemCorrect: false,
}));
assert(
  tooPessimistic.direction === "system_too_pessimistic",
  "Not a fit + completed paid (no human) → too pessimistic"
);
assert(tooPessimistic.signalAttribution.length > 0, "Has signal attribution");
// Check that negative signals are flagged as over-weighted
const overWeighted = tooPessimistic.signalAttribution.filter(a => a.direction === "over");
assert(overWeighted.length > 0, "Over-weighted penalties identified");

console.log("\n── Diagnostics: Human Override Correct ──");

const humanCorrect = analyzeDisagreement(mockOutcome({
  systemRecommendation: "not_a_fit" as SystemRecommendation,
  systemScores: mockSnapshot({
    recommendation: { value: "not_a_fit", reason: "Poor fit", actionHint: "Decline" },
  }),
  systemConfidence: 75,
  humanDecision: "booked" as HumanDecision,
  actualOutcome: "completed_paid" as ActualOutcome,
  wasSystemCorrect: false,
}));
assert(
  humanCorrect.direction === "human_override_correct",
  "System said not_a_fit, human booked, outcome paid → human override correct"
);

console.log("\n── Diagnostics: Batch Analysis ──");

const batchOutcomes: OutcomeRecord[] = [
  // 3 aligned
  mockOutcome({ jobId: "j1", humanDecision: "quoted", actualOutcome: "completed_paid", wasSystemCorrect: true }),
  mockOutcome({ jobId: "j2", humanDecision: "quoted", actualOutcome: "completed_paid", wasSystemCorrect: true }),
  mockOutcome({ jobId: "j3", humanDecision: "followed_up", actualOutcome: "site_visit_booked", wasSystemCorrect: true }),
  // 2 false positives (system too optimistic — no human override)
  mockOutcome({
    jobId: "j4",
    systemRecommendation: "probably_bookable",
    humanDecision: null,
    actualOutcome: "customer_ghosted",
    wasSystemCorrect: false,
    systemConfidence: 70,
  }),
  mockOutcome({
    jobId: "j5",
    systemRecommendation: "worth_quoting",
    humanDecision: null,
    actualOutcome: "not_pursued",
    wasSystemCorrect: false,
    systemConfidence: 55,
  }),
  // 1 false negative (system too pessimistic — no human override)
  mockOutcome({
    jobId: "j6",
    systemRecommendation: "not_a_fit",
    systemScores: mockSnapshot({
      fit: { score: 30, label: "poor", reasoning: [], positiveSignals: [], negativeSignals: ["Cheapest mindset"] },
      worthiness: { score: 25, label: "low", reasoning: [] },
      recommendation: { value: "not_a_fit", reason: "Poor", actionHint: "Skip" },
    }),
    humanDecision: null,
    actualOutcome: "completed_paid",
    outcomeValue: 120000, // $1200
    wasSystemCorrect: false,
  }),
];

const summary = analyzeBatch(batchOutcomes);

assert(summary.totalOutcomes === 6, "Batch: 6 outcomes");
assert(summary.withHumanDecision === 3, "Batch: 3 with human decision (3 pure system-vs-outcome)");
assert(summary.agreementRate > 0, "Batch: agreement rate > 0");
assert(summary.correctRate > 0, "Batch: correct rate > 0");
assert(summary.disagreementsByDirection.system_too_optimistic >= 1, "Batch: has false positives");
assert(summary.disagreementsByDirection.system_too_pessimistic >= 1, "Batch: has false negatives");
assert(summary.falseNegativeRevenueLost > 0, "Batch: false negative revenue impact calculated");
assert(summary.falsePositiveTimeLost > 0, "Batch: false positive time impact calculated");

console.log("\n── Diagnostics: Category Patterns ──");

assert(Object.keys(summary.disagreementsByCategory).length > 0, "Category disaggrement patterns computed");
const catData = summary.disagreementsByCategory["services.trades.carpentry"];
assert(catData !== undefined, "Carpentry category tracked");
assert(catData.total > 0, "Carpentry has outcomes");
assert(typeof catData.rate === "number", "Carpentry has disagreement rate");

console.log("\n── Diagnostics: Signal Patterns ──");

// At least one direction of signal patterns should be populated
const hasSignalPatterns =
  summary.topOverweightedSignals.length > 0 || summary.topUnderweightedSignals.length > 0;
assert(hasSignalPatterns, "Signal frequency patterns computed");

if (summary.topOverweightedSignals.length > 0) {
  const top = summary.topOverweightedSignals[0];
  assert(top.signal.length > 0, "Top over-weighted signal has name");
  assert(top.count > 0, "Top over-weighted signal has count");
  assert(typeof top.avgImpact === "number", "Top over-weighted signal has avg impact");
}

console.log("\n── Diagnostics: Edge Cases ──");

// Empty batch
const emptySummary = analyzeBatch([]);
assert(emptySummary.totalOutcomes === 0, "Empty batch: 0 outcomes");
assert(emptySummary.agreementRate === 0, "Empty batch: 0 agreement rate");
assert(emptySummary.correctRate === 0, "Empty batch: 0 correct rate");

// Single aligned outcome
const singleSummary = analyzeBatch([
  mockOutcome({ humanDecision: "quoted", actualOutcome: "completed_paid", wasSystemCorrect: true }),
]);
assert(singleSummary.totalOutcomes === 1, "Single: 1 outcome");
assert(singleSummary.agreementRate === 1, "Single aligned: 100% agreement");

// ═══════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════

console.log(`\n${"═".repeat(50)}`);
console.log(`Codegen + Diagnostics Tests: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}`);

if (failed > 0) process.exit(1);
