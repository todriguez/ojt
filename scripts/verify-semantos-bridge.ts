/**
 * Verify the compiler ↔ semantos bridge:
 *   - Type hash determinism
 *   - Cell packing/unpacking roundtrip
 *   - CategoryResolution carries typeHash
 *   - Linearity mapping correctness
 */

import {
  computeTypeHash,
  computeWhatHash,
  computeHowHash,
  computeInstHash,
  computePhaseHash,
  buildCellHeader,
  packCell,
  unpackCell,
  contentHash,
  isValidCell,
  PHASE_BYTES,
  DIMENSION_BYTES,
  LINEARITY,
  PHASE_LINEARITY,
} from "../src/lib/domain/bridge";
import { resolveCategory } from "../src/lib/domain/categories/categoryResolver";
import type { AccumulatedJobState } from "../src/lib/ai/extractors/extractionSchema";

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

// ── Type Hash Determinism ──────────────────────

console.log("\n── Type Hash Determinism ──");

const hash1 = computeTypeHash("services.trades.carpentry", "hire", "inst.contract.service-agreement");
const hash2 = computeTypeHash("services.trades.carpentry", "hire", "inst.contract.service-agreement");
const hash3 = computeTypeHash("services.trades.plumbing", "hire", "inst.quote.rom");

assert(hash1.length === 32, "Type hash is 32 bytes");
assert(hash1.equals(hash2), "Same inputs → same hash (deterministic)");
assert(!hash1.equals(hash3), "Different inputs → different hash");

const whatHash = computeWhatHash("services.trades.carpentry");
const howHash = computeHowHash("hire");
const instHash = computeInstHash("inst.contract.service-agreement");
assert(whatHash.length === 32, "WHAT hash is 32 bytes");
assert(howHash.length === 32, "HOW hash is 32 bytes");
assert(instHash.length === 32, "INST hash is 32 bytes");
assert(!whatHash.equals(howHash), "WHAT ≠ HOW hash");

const phaseHash = computePhaseHash("parse");
assert(phaseHash.length === 32, "Phase hash is 32 bytes");

// Verify hex output is valid
const hexStr = hash1.toString("hex");
assert(hexStr.length === 64, "Hex string is 64 chars");
assert(/^[0-9a-f]+$/.test(hexStr), "Hex string is lowercase hex");

console.log("\n── Cell Header Construction ──");

const ownerId = Buffer.alloc(16, 0x42); // mock owner
const parentHash = computeTypeHash("test", "test", "test");

const header = buildCellHeader({
  typeHash: hash1,
  linearity: LINEARITY.AFFINE,
  ownerId,
  phase: "ast",
  dimension: "composite",
  parentHash,
  payloadSize: 500,
});

assert(header.length === 256, "Header is 256 bytes");
assert(header.readUInt32LE(16) === LINEARITY.AFFINE, "Linearity field = AFFINE (2)");
assert(header.readUInt32LE(20) === 1, "Version field = 1");
assert(header.readUInt32LE(86) === 1, "CellCount = 1 (500 bytes fits)");
assert(header.readUInt32LE(90) === 500, "TotalSize = 500");
assert(header.readUInt8(94) === PHASE_BYTES.ast, "Phase byte = AST (0x02)");
assert(header.readUInt8(95) === DIMENSION_BYTES.composite, "Dimension byte = COMPOSITE (0x00)");
assert(header.subarray(30, 62).equals(hash1), "TypeHash in header matches input");
assert(header.subarray(62, 78).equals(ownerId), "OwnerID in header matches input");
assert(header.subarray(96, 128).equals(parentHash), "ParentHash in reserved block");

// Multi-cell header
const bigHeader = buildCellHeader({
  typeHash: hash1,
  linearity: LINEARITY.LINEAR,
  ownerId,
  phase: "codegen",
  dimension: "instrument",
  payloadSize: 1200, // exceeds 768
});
assert(bigHeader.readUInt32LE(86) === 2, "CellCount = 2 for 1200-byte payload");

console.log("\n── Cell Pack / Unpack Roundtrip ──");

const payload = Buffer.from(JSON.stringify({ test: "hello", score: 42 }));
// Rebuild header with actual payload size (previous header had payloadSize: 500)
const roundtripHeader = buildCellHeader({
  typeHash: hash1,
  linearity: LINEARITY.AFFINE,
  ownerId,
  phase: "ast",
  dimension: "composite",
  parentHash,
  payloadSize: payload.length,
});
const cell = packCell(roundtripHeader, payload);
assert(cell.length === 1024, "Single cell is 1024 bytes");
assert(isValidCell(cell), "Cell passes magic number validation");

const { header: unpacked, payload: unpackedPayload } = unpackCell(cell);
assert(unpacked.linearity === LINEARITY.AFFINE, "Unpacked linearity matches");
assert(unpacked.version === 1, "Unpacked version matches");
assert(unpacked.cellCount === 1, "Unpacked cellCount matches");
assert(unpacked.totalSize === payload.length, "Unpacked totalSize matches payload");
assert(unpacked.phase === PHASE_BYTES.ast, "Unpacked phase matches");
assert(unpacked.dimension === DIMENSION_BYTES.composite, "Unpacked dimension matches");
assert(unpacked.typeHash.equals(hash1), "Unpacked typeHash matches");
assert(unpackedPayload.equals(payload), "Unpacked payload matches original");

// Content hash
const ch = contentHash(payload);
assert(ch.length === 32, "Content hash is 32 bytes");
const ch2 = contentHash(payload);
assert(ch.equals(ch2), "Content hash is deterministic");

console.log("\n── Invalid Cell Rejection ──");

assert(!isValidCell(Buffer.alloc(100)), "Short buffer rejected");
assert(!isValidCell(Buffer.alloc(1024, 0)), "Zero-filled cell rejected");

console.log("\n── CategoryResolution Type Hash ──");

const state = {
  jobType: "carpentry",
  scopeDescription: "deck build 20sqm hardwood",
  estimatePresented: true,
  estimateAckStatus: "accepted",
} as AccumulatedJobState;

const resolution = resolveCategory(state);
assert(resolution !== null, "Category resolves");
assert(typeof resolution!.typeHash === "string", "Resolution carries typeHash");
assert(resolution!.typeHash.length === 64, "typeHash is 64 hex chars (32 bytes)");

// Verify it matches independently computed hash
const independentHash = computeTypeHash(
  resolution!.path,
  resolution!.txType,
  resolution!.instrumentPath
).toString("hex");
assert(resolution!.typeHash === independentHash, "Resolution typeHash matches independent computation");

// Different state → different type hash (different instrument)
const preAcceptState = {
  jobType: "carpentry",
  scopeDescription: "deck build",
  estimatePresented: false,
  estimateAckStatus: null,
} as AccumulatedJobState;
const preAcceptRes = resolveCategory(preAcceptState);
assert(preAcceptRes !== null, "Pre-accept resolves");
assert(preAcceptRes!.typeHash !== resolution!.typeHash, "Different instrument → different type hash");

console.log("\n── Phase / Linearity Constants ──");

assert(PHASE_BYTES.source === 0x00, "source = 0x00");
assert(PHASE_BYTES.parse === 0x01, "parse = 0x01");
assert(PHASE_BYTES.ast === 0x02, "ast = 0x02");
assert(PHASE_BYTES.typecheck === 0x03, "typecheck = 0x03");
assert(PHASE_BYTES.optimise === 0x04, "optimise = 0x04");
assert(PHASE_BYTES.codegen === 0x05, "codegen = 0x05");
assert(PHASE_BYTES.action === 0x06, "action = 0x06");
assert(PHASE_BYTES.outcome === 0x07, "outcome = 0x07");
assert(PHASE_BYTES.unknown === 0xff, "unknown = 0xFF");

assert(LINEARITY.LINEAR === 1, "LINEAR = 1");
assert(LINEARITY.AFFINE === 2, "AFFINE = 2");
assert(LINEARITY.RELEVANT === 3, "RELEVANT = 3");
assert(LINEARITY.DEBUG === 4, "DEBUG = 4");

assert(PHASE_LINEARITY.parse === LINEARITY.LINEAR, "Parse produces LINEAR objects");
assert(PHASE_LINEARITY.ast === LINEARITY.AFFINE, "AST produces AFFINE objects");
assert(PHASE_LINEARITY.codegen === LINEARITY.RELEVANT, "Codegen produces RELEVANT objects");
assert(PHASE_LINEARITY.action === LINEARITY.LINEAR, "Actions are LINEAR");

assert(DIMENSION_BYTES.composite === 0x00, "composite = 0x00");
assert(DIMENSION_BYTES.what === 0x01, "what = 0x01");
assert(DIMENSION_BYTES.how === 0x02, "how = 0x02");
assert(DIMENSION_BYTES.instrument === 0x03, "instrument = 0x03");

console.log(`\n${"═".repeat(50)}`);
console.log(`Semantos Bridge Tests: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}`);

if (failed > 0) process.exit(1);
