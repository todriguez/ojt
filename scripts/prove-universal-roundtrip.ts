#!/usr/bin/env npx tsx
/**
 * prove-universal-roundtrip.ts
 *
 * End-to-end proof that OJT's AccumulatedJobState → universal semantic core
 * → cell packing → unpack → deserialize is lossless.
 *
 * Steps:
 *   1. Create a realistic AccumulatedJobState (the AST)
 *   2. Map it to SemanticObject + ObjectState (Container, AFFINE)
 *   3. Simulate a message extraction merge → ObjectPatch (Patch, LINEAR)
 *   4. Generate a ROM instrument → Instrument (Capsule, RELEVANT)
 *   5. Pack all three into 1KB semantos cells via the bridge
 *   6. Unpack and verify lossless roundtrip
 *
 * Usage: npx tsx scripts/prove-universal-roundtrip.ts
 */

import { createHash } from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import {
  computeTypeHash,
  computePhaseHash,
  buildCellHeader,
  packCell,
  unpackCell,
  contentHash,
  isValidCell,
  LINEARITY,
  PHASE_LINEARITY,
} from "../src/lib/domain/bridge/typeHashRegistry";
import {
  type AccumulatedJobState,
  mergeExtraction,
  type MessageExtraction,
} from "../src/lib/ai/extractors/extractionSchema";

// ─── Test Utilities ──────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${label}`);
  } else {
    failCount++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function hashState(state: AccumulatedJobState): string {
  const sorted = Object.keys(state)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = (state as Record<string, unknown>)[key];
      return acc;
    }, {});
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function compressPayload(obj: unknown): { data: Buffer; hash: string; originalSize: number } {
  const json = JSON.stringify(obj);
  const originalSize = Buffer.byteLength(json, "utf-8");
  const data = gzipSync(Buffer.from(json, "utf-8"), { level: 9 });
  const hash = createHash("sha256").update(data).digest("hex");
  return { data, hash, originalSize };
}

function decompressPayload(data: Buffer): unknown {
  return JSON.parse(gunzipSync(data).toString("utf-8"));
}

// ─── Step 1: Create a realistic AccumulatedJobState ─────────────────────

console.log("\n═══ Trades/Services Universal Semantic Runtime — Roundtrip Proof ═══\n");
console.log("Step 1: Create realistic AccumulatedJobState\n");

const initialState: AccumulatedJobState = {
  customerName: "Sarah Mitchell",
  customerPhone: "0412 345 678",
  customerEmail: "sarah.m@example.com",
  suburb: "Paddington",
  locationClue: "near Latrobe Terrace",
  address: "42 Given Terrace",
  postcode: "4064",
  accessNotes: "Side gate, code 1234",
  jobType: "carpentry",
  jobTypeConfidence: "certain",
  jobSubcategory: "deck repair",
  repairReplaceSignal: "repair",
  scopeDescription: "Rotting deck boards on back deck, about 3x4m. Some joists may need replacing. Hardwood preferred.",
  quantity: "approximately 12 boards + 2-3 joists",
  materials: "hardwood (merbau or similar)",
  materialCondition: "some boards soft, possible water damage underneath",
  accessDifficulty: "ground_level",
  photosReferenced: true,
  urgency: "next_2_weeks",
  estimateReaction: "tentative",
  budgetReaction: "ok",
  customerToneSignal: "practical",
  micromanagerSignals: false,
  cheapestMindset: false,
  clarityScore: "clear",
  contactReadiness: "offered",
  conversationPhase: "reviewing_estimate",
  missingInfo: [],
  completenessScore: 78,
  scopeClarity: 80,
  locationClarity: 95,
  contactReadinessScore: 100,
  estimateReadiness: 85,
  decisionReadiness: 65,
  estimatePresented: true,
  estimateAcknowledged: true,
  estimateAckStatus: "tentative",
  estimateAckMessageId: "msg-abc-123",
  estimateAckTimestamp: "2026-03-23T10:30:00Z",
  customerFitScore: 72,
  customerFitLabel: "good_fit",
  quoteWorthinessScore: 68,
  quoteWorthinessLabel: "worth_quoting",
  recommendation: "worth_quoting",
  recommendationReason: "Clear scope, good location, reasonable customer — worth a site visit or quote",
  effortBandReason: "Deck repair ~12 boards + joists = quarter to half day depending on condition",
  romConfidence: "medium",
  labourOnly: false,
  materialsNote: "Customer to supply hardwood boards or we source — clarify on site",
};

const stateHash = hashState(initialState);
check("State created with 40+ fields", Object.keys(initialState).length >= 40);
check("State hash is 64-char hex", stateHash.length === 64);
console.log(`  State hash: ${stateHash.slice(0, 16)}...`);

// ─── Step 2: Map to SemanticObject + ObjectState ────────────────────────

console.log("\nStep 2: Map to SemanticObject + ObjectState (Container, AFFINE)\n");

const typeHash = computeTypeHash(
  "services.trades.carpentry",
  "hire",
  "inst.quote.rom"
);

const semanticObject = {
  id: "sem-obj-001",
  vertical: "trades",
  objectKind: "job",
  typeHash: typeHash.toString("hex"),
  typePath: "trades.job.carpentry.hire.rom",
  linearity: "AFFINE" as const,
  currentVersion: 1,
  currentStateHash: stateHash,
  flags: 0,
  status: "active" as const,
  ownerId: "operator-todd",
  createdBy: "system:chat-pipeline",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const objectState = {
  id: "state-001",
  objectId: semanticObject.id,
  version: 1,
  stateHash,
  prevStateHash: "",
  payload: initialState as unknown as Record<string, unknown>,
  payloadSize: 0, // computed below
  irVersion: 1,
  source: "extraction",
  createdBy: "system:chat-pipeline",
  compilerVersion: "trades-v5.1",
  createdAt: new Date(),
};

const compressed = compressPayload(initialState);
objectState.payloadSize = compressed.data.length;

check("SemanticObject.typeHash is 64-char hex", semanticObject.typeHash.length === 64);
check("ObjectState.payload roundtrips", hashState(objectState.payload as AccumulatedJobState) === stateHash);
check("Compressed payload fits analysis", compressed.data.length > 0);
console.log(`  Type hash: ${semanticObject.typeHash.slice(0, 16)}...`);
console.log(`  Payload: ${compressed.originalSize} bytes JSON → ${compressed.data.length} bytes gzip`);

// ─── Step 3: Simulate extraction merge → ObjectPatch ────────────────────

console.log("\nStep 3: Extraction merge → ObjectPatch (Patch, LINEAR)\n");

const newExtraction: MessageExtraction = {
  customerName: null,
  customerPhone: null,
  customerEmail: null,
  suburb: null,
  locationClue: null,
  address: null,
  postcode: null,
  accessNotes: null,
  jobType: null,
  jobTypeConfidence: null,
  jobSubcategory: null,
  repairReplaceSignal: null,
  scopeDescription: "Also noticed some railing posts are wobbly — might need re-bolting or replacing",
  quantity: null,
  materials: null,
  materialCondition: null,
  accessDifficulty: null,
  photosReferenced: null,
  urgency: null,
  estimateReaction: "accepted",
  budgetReaction: null,
  customerToneSignal: null,
  micromanagerSignals: null,
  cheapestMindset: null,
  clarityScore: null,
  contactReadiness: null,
  isComplete: false,
  missingInfo: [],
  conversationPhase: "confirmed",
};

const mergeResult = mergeExtraction(initialState, newExtraction);

const objectPatch = {
  id: "patch-001",
  objectId: semanticObject.id,
  fromVersion: 1,
  toVersion: 2,
  prevStateHash: mergeResult.prevStateHash,
  newStateHash: mergeResult.stateHash,
  patchKind: "extraction" as const,
  delta: mergeResult.delta,
  deltaCount: mergeResult.deltaCount,
  source: "message:msg-def-456",
  evidenceRef: "msg-def-456",
  authorObjectId: null,
  linearity: "LINEAR" as const,
  consumed: true,
  consumedAt: new Date(),
  createdAt: new Date(),
};

check("Merge produced delta", mergeResult.deltaCount > 0, `${mergeResult.deltaCount} fields changed`);
check("prevStateHash matches pre-merge", mergeResult.prevStateHash === stateHash);
check("newStateHash differs from prev", mergeResult.stateHash !== mergeResult.prevStateHash);
check("Scope was merged (low overlap = concatenation)", mergeResult.state.scopeDescription?.includes("railing") ?? false);
check("estimateReaction updated to accepted", mergeResult.state.estimateReaction === "accepted");
check("conversationPhase updated to confirmed", mergeResult.state.conversationPhase === "confirmed");
console.log(`  Delta: ${mergeResult.deltaCount} fields changed`);
console.log(`  Changed fields: ${Object.keys(mergeResult.delta).join(", ")}`);

// ─── Step 4: Generate ROM instrument → Instrument (Capsule, RELEVANT) ───

console.log("\nStep 4: ROM instrument → Instrument (Capsule, RELEVANT)\n");

const romInstrument = {
  id: "inst-001",
  objectId: semanticObject.id,
  stateHash: mergeResult.stateHash,
  stateId: "state-002",
  instrumentType: "rom-quote",
  instrumentPath: "inst.quote.rom",
  payload: {
    v: 1,
    type: "rom-quote",
    content: {
      effortBand: "half_day",
      hoursMin: 3,
      hoursMax: 5,
      costMin: 350,
      costMax: 650,
      labourOnly: false,
      materialsNote: "Hardwood boards ~$200-350 depending on species. Customer may supply.",
      assumptions: [
        "Deck subframe is generally sound (2-3 joists max)",
        "Ground level access, no scaffolding",
        "Hardwood — merbau or spotted gum",
        "Railing post re-bolting included",
      ],
      validFor: "7 days",
      presentedText: "For the deck repair — replacing about 12 boards and checking those joists — you'd be looking at roughly $350-650 including materials. That covers a half day's work, hardwood boards, and fixing up those wobbly railing posts. Happy to confirm exact pricing after a quick look on site.",
    },
    generatedAt: new Date().toISOString(),
    compilerVersion: "trades-v5.1",
  },
  linearity: "RELEVANT" as const,
  status: "presented" as const,
  consumedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const instrumentCompressed = compressPayload(romInstrument.payload);
check("Instrument payload compresses", instrumentCompressed.data.length > 0);
check("Instrument has correct linearity", romInstrument.linearity === "RELEVANT");
check("Instrument references correct state", romInstrument.stateHash === mergeResult.stateHash);
console.log(`  ROM: $${romInstrument.payload.content.costMin}-$${romInstrument.payload.content.costMax}`);
console.log(`  Payload: ${instrumentCompressed.originalSize} bytes → ${instrumentCompressed.data.length} bytes gzip`);

// ─── Step 5: Pack into 1KB semantos cells ───────────────────────────────

console.log("\nStep 5: Pack all three linearity types into 1KB semantos cells\n");

const CELL_SIZE = 1024;
const HEADER_SIZE = 256;
const PAYLOAD_SIZE = CELL_SIZE - HEADER_SIZE;

function packToCell(
  payload: Buffer,
  typeHashBuf: Buffer,
  linearity: (typeof LINEARITY)[keyof typeof LINEARITY],
  phase: "source" | "parse" | "ast" | "typecheck" | "optimise" | "codegen" | "action" | "outcome" | "unknown",
  ownerBuf: Buffer,
  prevState?: Buffer,
): { cell: Buffer; cellCount: number } {
  const header = buildCellHeader({
    typeHash: typeHashBuf,
    linearity,
    ownerId: ownerBuf,
    phase,
    dimension: "composite",
    parentHash: undefined,
    prevStateHash: prevState,
    payloadSize: payload.length,
  });
  const cell = packCell(header, payload);
  const cellCount = Math.ceil(cell.length / CELL_SIZE);
  return { cell, cellCount };
}

const ownerBuf = createHash("sha256").update("operator-todd").digest().subarray(0, 16);

// Container cell (AFFINE) — AccumulatedJobState
const containerPayload = compressed.data;
const containerCell = packToCell(
  containerPayload,
  typeHash,
  LINEARITY.AFFINE,
  "ast",
  ownerBuf,
);

check(
  `Container: ${containerCell.cellCount} cell(s), ${containerPayload.length} bytes payload`,
  containerCell.cell.length >= CELL_SIZE,
);
check("Container cell has valid magic", isValidCell(containerCell.cell));

// Patch cell (LINEAR) — extraction delta
const patchPayload = compressPayload(mergeResult.delta);
const patchPhaseHash = computePhaseHash("parse");
const prevStateBuf = Buffer.from(mergeResult.prevStateHash, "hex");
const patchCell = packToCell(
  patchPayload.data,
  patchPhaseHash,
  LINEARITY.LINEAR,
  "parse",
  ownerBuf,
  prevStateBuf,
);

check(
  `Patch: ${patchCell.cellCount} cell(s), ${patchPayload.data.length} bytes payload`,
  patchCell.cell.length >= CELL_SIZE,
);
check("Patch cell has valid magic", isValidCell(patchCell.cell));

// Capsule cell (RELEVANT) — ROM instrument
const capsulePayload = instrumentCompressed;
const capsuleCell = packToCell(
  capsulePayload.data,
  typeHash,
  LINEARITY.RELEVANT,
  "codegen",
  ownerBuf,
);

check(
  `Capsule: ${capsuleCell.cellCount} cell(s), ${capsulePayload.data.length} bytes payload`,
  capsuleCell.cell.length >= CELL_SIZE,
);
check("Capsule cell has valid magic", isValidCell(capsuleCell.cell));

// ─── Step 6: Unpack and verify lossless roundtrip ───────────────────────

console.log("\nStep 6: Unpack cells and verify lossless roundtrip\n");

// Unpack container
const unpackedContainer = unpackCell(containerCell.cell);
check("Container linearity = AFFINE (2)", unpackedContainer.header.linearity === LINEARITY.AFFINE);
check("Container typeHash matches", unpackedContainer.header.typeHash.equals(typeHash));
check(
  "Container payload size matches",
  unpackedContainer.header.totalSize === containerPayload.length,
  `${unpackedContainer.header.totalSize} vs ${containerPayload.length}`,
);

// Decompress and compare
const recoveredState = decompressPayload(unpackedContainer.payload) as AccumulatedJobState;
const recoveredHash = hashState(recoveredState);
check("Container roundtrip: state hash matches", recoveredHash === stateHash);
check("Container roundtrip: customerName preserved", recoveredState.customerName === "Sarah Mitchell");
check("Container roundtrip: scopeDescription preserved", recoveredState.scopeDescription?.includes("Rotting deck boards") ?? false);
check("Container roundtrip: scores preserved", recoveredState.completenessScore === 78);

// Unpack patch
const unpackedPatch = unpackCell(patchCell.cell);
check("Patch linearity = LINEAR (1)", unpackedPatch.header.linearity === LINEARITY.LINEAR);
const recoveredDelta = decompressPayload(unpackedPatch.payload) as Record<string, { from: unknown; to: unknown }>;
check("Patch roundtrip: delta field count matches", Object.keys(recoveredDelta).length === mergeResult.deltaCount);
check("Patch roundtrip: delta contains scopeDescription", "scopeDescription" in recoveredDelta);
check("Patch roundtrip: delta contains estimateReaction", "estimateReaction" in recoveredDelta);

// Unpack capsule
const unpackedCapsule = unpackCell(capsuleCell.cell);
check("Capsule linearity = RELEVANT (3)", unpackedCapsule.header.linearity === LINEARITY.RELEVANT);
const recoveredInstrument = decompressPayload(unpackedCapsule.payload) as { content: { costMin: number; costMax: number } };
check("Capsule roundtrip: costMin preserved", recoveredInstrument.content.costMin === 350);
check("Capsule roundtrip: costMax preserved", recoveredInstrument.content.costMax === 650);

// Verify prevStateHash in patch header
check(
  "Patch prevStateHash in header",
  unpackedPatch.header.prevStateHash.toString("hex").startsWith(mergeResult.prevStateHash.slice(0, 32)),
  `header=${unpackedPatch.header.prevStateHash.toString("hex").slice(0, 16)}... expected=${mergeResult.prevStateHash.slice(0, 16)}...`,
);

// ─── Summary ─────────────────────────────────────────────────────────────

console.log("\n═══ Summary ═══\n");
console.log(`  Checks: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
console.log(`  Container: ${containerCell.cellCount} cell(s) / ${containerPayload.length} bytes (AFFINE)`);
console.log(`  Patch:     ${patchCell.cellCount} cell(s) / ${patchPayload.data.length} bytes (LINEAR)`);
console.log(`  Capsule:   ${capsuleCell.cellCount} cell(s) / ${capsulePayload.data.length} bytes (RELEVANT)`);
console.log(`  Roundtrip: ${failCount === 0 ? "✅ LOSSLESS" : "❌ DATA LOSS DETECTED"}`);
console.log();

if (failCount > 0) {
  process.exit(1);
}
