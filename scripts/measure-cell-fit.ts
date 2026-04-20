/**
 * Measure serialised sizes of OJT compiler types
 * against semantos 1KB cell layout (256-byte header + 768-byte payload)
 */

const CELL_SIZE = 1024;
const HEADER_SIZE = 256;
const PAYLOAD_SIZE = 768;

function measureJson(label: string, obj: unknown): { label: string; bytes: number; fits: boolean; cells: number } {
  const json = JSON.stringify(obj);
  const bytes = Buffer.byteLength(json, "utf-8");
  const cells = Math.ceil((bytes + HEADER_SIZE) / CELL_SIZE);
  return { label, bytes, fits: bytes <= PAYLOAD_SIZE, cells };
}

// ── Simulate real-world OJT objects ──────────────

// 1. Category triple (the AST type identifier)
const categoryTriple = {
  what: "services.trades.carpentry",
  how: "tx.hire",
  instrument: "inst.contract.service-agreement",
};

// 2. Minimal AST node (just the typed intent)
const minimalAst = {
  ...categoryTriple,
  confidence: "high",
  valueMultiplier: 1.4,
  siteVisitLikely: true,
  licensedTrade: false,
};

// 3. Category resolution (full resolver output)
const categoryResolution = {
  path: "services.trades.carpentry",
  name: "Carpentry",
  confidence: "high",
  attributes: [
    { name: "timber_type", type: "enum", required: false, description: "Type of timber" },
    { name: "area_sqm", type: "number", required: false, description: "Area in square metres" },
    { name: "deck_style", type: "enum", required: false, description: "Style of deck" },
    { name: "height_off_ground", type: "enum", required: false, description: "Height classification" },
  ],
  txType: "hire",
  txName: "Service hire",
  settlementPattern: "milestone",
  instrumentPath: "inst.contract.service-agreement",
  scoringContext: { valueMultiplier: 1.4, siteVisitLikely: true, licensedTrade: false },
};

// 4. Accumulated job state (parser output — the big one)
const accumulatedState = {
  customerName: "Jane Smith",
  customerPhone: "0412345678",
  customerEmail: "jane@example.com",
  suburb: "Paddington",
  locationClue: "near the shops on Latrobe Tce",
  address: "42 Latrobe Terrace",
  postcode: "4064",
  jobType: "carpentry",
  scopeDescription: "Need a new hardwood deck built, about 20sqm, with stairs down to the yard. Access from side gate.",
  quantity: "20sqm",
  materials: "hardwood timber, screws, bearers, joists",
  estimatePresented: true,
  estimateAckStatus: "accepted",
  estimateAmount: "$4800-$7200",
  effortBand: "multi_day",
  tone: "practical",
  cheapestMindset: false,
  scopeClarity: 72,
  contactReadiness: 90,
  locationClarity: 85,
  estimateReadiness: 61,
  decisionReadiness: 45,
  communicationStyle: "clear",
  photosProvided: true,
  adversarialScore: 0,
  urgency: "flexible",
  accessDifficulty: "easy",
  preferredContact: "phone",
  availabilityWindow: "weekdays",
};

// 5. System scores snapshot (type checker + optimiser output)
const scoresSnapshot = {
  fit: {
    score: 78,
    label: "good",
    reasoning: ["+10: Clear communication", "+8: Practical tone", "+5: Photos provided", "+6: Flexible timing"],
    positiveSignals: ["Clear communication", "Practical tone", "Photos provided", "Flexible timing"],
    negativeSignals: [],
  },
  worthiness: {
    score: 67,
    label: "worth_quoting",
    reasoning: ["+12: Core suburb", "+10: Multi-day effort", "+8: Category value ×1.4", "+5: Site visit likely"],
  },
  recommendation: {
    value: "worth_quoting",
    reason: "Good customer, high-value job in core area, needs site visit to confirm scope",
    actionHint: "Schedule site visit, then send formal quote",
  },
  confidence: {
    score: 68,
    label: "moderate",
    factors: ["Scope clarity moderate (72)", "Location confirmed", "Photos help", "Multi-day reduces certainty"],
  },
  completeness: {
    total: 71,
    scopeClarity: 72,
    locationClarity: 85,
    contactReadiness: 90,
    estimateReadiness: 61,
    decisionReadiness: 45,
  },
  estimateAck: { status: "accepted", presented: true, acknowledged: true },
  category: {
    path: "services.trades.carpentry",
    name: "Carpentry",
    confidence: "high",
    valueMultiplier: 1.4,
    siteVisitLikely: true,
    licensedTrade: false,
  },
};

// 6. ROM estimate (codegen output — simple)
const romEstimate = {
  effortBand: "multi_day",
  costMin: 900,
  costMax: 2500,
  labourOnly: true,
  materialsNote: "Plus timber and hardware",
  hoursMin: 8,
  hoursMax: 24,
  confidenceNote: "Broad range — would need to see it to narrow down",
};

// 7. Fixed-price quote instrument (codegen output — rich)
const fixedPriceQuote = {
  instrumentPath: "inst.quote.fixed-price",
  categoryPath: "services.trades.carpentry",
  txType: "hire",
  generatedAt: "2026-03-22T10:30:00Z",
  version: 1,
  lineItems: [
    { description: "Deck construction labour", quantity: 3, unit: "days", unitPrice: 72000, total: 216000, category: "labour" },
    { description: "Stair construction", quantity: 1, unit: "item", unitPrice: 48000, total: 48000, category: "labour" },
    { description: "Hardwood timber + bearers", quantity: 1, unit: "lot", unitPrice: 350000, total: 350000, category: "materials" },
    { description: "Fasteners + hardware", quantity: 1, unit: "lot", unitPrice: 15000, total: 15000, category: "materials" },
  ],
  labourTotal: 264000,
  materialsTotal: 365000,
  totalExGst: 629000,
  gst: 62900,
  totalIncGst: 691900,
  validDays: 14,
  scopeSummary: "Construction of 20sqm hardwood deck with stairs to yard level at 42 Latrobe Tce, Paddington",
  inclusions: ["All labour for deck and stair construction", "Supply of hardwood decking boards, bearers, and joists", "Stainless steel fasteners and brackets"],
  exclusions: ["Council permits", "Engineering certification", "Staining or sealing"],
  conditions: ["Subject to site inspection confirming access and substructure requirements", "Price valid for 14 days"],
  paymentTerms: "50% deposit on acceptance, 50% on completion",
};

// 8. Service agreement instrument (codegen output — contract)
const serviceAgreement = {
  instrumentPath: "inst.contract.service-agreement",
  categoryPath: "services.trades.carpentry",
  txType: "hire",
  generatedAt: "2026-03-22T10:30:00Z",
  version: 1,
  parties: {
    provider: { name: "Todd Price", abn: "12 345 678 901", phone: "0400000000", licence: null },
    client: { name: "Jane Smith", phone: "0412345678", email: "jane@example.com" },
  },
  scope: "Construction of approximately 20sqm hardwood timber deck with stairs down to yard level",
  siteAddress: "42 Latrobe Terrace, Paddington QLD 4064",
  estimatedCost: { min: 629000, max: 691900, currency: "AUD", gstInclusive: true },
  estimatedDuration: "3-5 working days",
  paymentTerms: "50% deposit on acceptance, balance on completion",
  warranty: "12 months workmanship warranty on all labour",
  cancellation: "Either party may cancel with 48 hours written notice. Deposit refundable less materials ordered.",
  variations: "Any changes to agreed scope will be quoted separately before work proceeds.",
};

// 9. Disagreement analysis result (diagnostics output)
const disagreementResult = {
  direction: "system_too_optimistic",
  severity: "moderate",
  description: "System recommended worth_quoting but outcome was customer_ghosted",
  signalAttribution: [
    { signal: "fit.clearCommunication", phase: "fit", direction: "over", impact: 8, explanation: "Positive signal may have inflated fit" },
    { signal: "fit.practicalTone", phase: "fit", direction: "over", impact: 8, explanation: "Practical tone may have inflated fit" },
    { signal: "worthiness.coreSuburb", phase: "worthiness", direction: "over", impact: 12, explanation: "Core suburb bonus too high" },
  ],
  suggestedAdjustments: [
    { weight: "fit.clearCommunicationBonus", currentValue: 10, suggestedValue: 8, rationale: "Reduce by 2 points", confidence: "medium" },
    { weight: "thresholds.worthQuotingMinWorthiness", currentValue: 45, suggestedValue: 50, rationale: "Raise threshold", confidence: "medium" },
  ],
};

// 10. Job outcome record (diagnostics input)
const outcomeRecord = {
  jobId: "550e8400-e29b-41d4-a716-446655440000",
  policyVersion: 3,
  systemRecommendation: "worth_quoting",
  systemScores: scoresSnapshot,
  systemConfidence: 68,
  humanDecision: "declined",
  humanOverrideReason: "Customer seemed flaky on the phone",
  actualOutcome: "customer_ghosted",
  outcomeValue: null,
  missType: "false_positive",
  wasSystemCorrect: false,
};

// ── Measure everything ──────────────────────────

const measurements = [
  measureJson("Category triple (AST type ID)", categoryTriple),
  measureJson("Minimal AST node", minimalAst),
  measureJson("Category resolution (full)", categoryResolution),
  measureJson("Accumulated job state (parser output)", accumulatedState),
  measureJson("System scores snapshot (type checker output)", scoresSnapshot),
  measureJson("ROM estimate (simple codegen)", romEstimate),
  measureJson("Fixed-price quote (rich codegen)", fixedPriceQuote),
  measureJson("Service agreement (contract codegen)", serviceAgreement),
  measureJson("Disagreement result (diagnostics)", disagreementResult),
  measureJson("Job outcome record (full w/ scores)", outcomeRecord),
];

console.log("\n═══ OJT Type Sizes vs Semantos 1KB Cells ═══\n");
console.log(`Cell: ${CELL_SIZE} bytes | Header: ${HEADER_SIZE} bytes | Payload: ${PAYLOAD_SIZE} bytes\n`);
console.log("Type".padEnd(50) + "Bytes".padStart(7) + "  Fits?  Cells");
console.log("─".repeat(75));

for (const m of measurements) {
  const fits = m.fits ? "  ✅  " : "  ❌  ";
  const pct = ((m.bytes / PAYLOAD_SIZE) * 100).toFixed(0);
  console.log(
    m.label.padEnd(50) + String(m.bytes).padStart(7) + fits + String(m.cells).padStart(3) + `   (${pct}%)`
  );
}

console.log("\n── Multi-Cell Breakdown ──\n");
for (const m of measurements.filter((m) => !m.fits)) {
  console.log(`${m.label}: ${m.bytes} bytes → ${m.cells} cells`);
  console.log(`  Cell 1: 768 bytes payload (header + first chunk)`);
  for (let i = 1; i < m.cells; i++) {
    const remaining = m.bytes - 768 - (i - 1) * CELL_SIZE;
    const thisCell = Math.min(remaining, CELL_SIZE);
    console.log(`  Cell ${i + 1}: ${thisCell} bytes (continuation)`);
  }
}

// ── Compact binary estimation ──────────────────

console.log("\n── Binary-Packed Estimates (vs JSON) ──\n");

// Category triple as binary: 3 paths ≤ 64 bytes each = 192 bytes max
// But with hash-based type IDs: 3 × 32 = 96 bytes
console.log("Category triple (3 × SHA256):          96 bytes   (vs " + measureJson("", categoryTriple).bytes + " JSON)");

// Minimal AST: type hash + 4 fields = ~40 bytes
console.log("Minimal AST (binary packed):            ~40 bytes  (vs " + measureJson("", minimalAst).bytes + " JSON)");

// AccumulatedJobState: mostly short strings + numbers
// ~30 fields, avg 20 bytes each = ~600 bytes binary
const stateBytes = measureJson("", accumulatedState).bytes;
console.log(`Accumulated state (TLV-packed):        ~500 bytes  (vs ${stateBytes} JSON)`);

// Scores snapshot: numbers + short strings
const scoresBytes = measureJson("", scoresSnapshot).bytes;
console.log(`Scores snapshot (binary packed):       ~400 bytes  (vs ${scoresBytes} JSON)`);

// Fixed-price quote
const quoteBytes = measureJson("", fixedPriceQuote).bytes;
console.log(`Fixed-price quote (binary packed):     ~600 bytes  (vs ${quoteBytes} JSON)`);
