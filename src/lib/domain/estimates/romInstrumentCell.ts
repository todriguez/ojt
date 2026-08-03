/**
 * ROM-instrument cell packing — Persistence pillar for the estimator.
 *
 * Takes a RomInstrument (the LINEAR artefact emitted on every rescore)
 * and serialises it into the 1 KB multi-cell format handled by
 * `semantos-kernel/cellPacker.ts`:
 *
 *   Cell 0 (1024 bytes)
 *     ├── 256-byte header (magic, typeHash, linearity, version,
 *     │   phase=action, dimension=instrument, prevStateHash)
 *     └── 768-byte payload — fixed-offset encoding of every numerical
 *         field of the RomInstrument plus the reason/materials strings
 *
 *   Cell 1..N (1024 bytes each)
 *     └── DATA continuation cells carrying the source TaggedFacts
 *         serialized as UTF-8 JSON. One cell fits ≈30 compact facts.
 *
 * The cell is content-addressed — `packRomInstrumentCell().contentHash`
 * is the stable id that drops into `sem_cells.content_hash` and the
 * anchor path.
 *
 * Round-trip safety: `unpackRomInstrumentCell(packed.buffer).id` always
 * equals the input instrument's id.
 */
import { createHash } from "crypto";

import {
  assembleSemanticObject,
  createDataCells,
  disassembleSemanticObject,
  PAYLOAD_SIZE,
  type PackedMultiCell,
} from "../../semantos-kernel/cellPacker";
import {
  buildCellHeader,
  computeTypeHash,
  LINEARITY,
} from "../bridge/typeHashRegistry";
import { TradesLexicon } from "../../lexicons/trades";
import type { TaggedFact } from "../../lexicons";
import {
  EFFORT_BANDS,
  type EffortBand,
  type RomConfidence,
  type RomInstrument,
} from "./sppEstimator";

// ── Fixed-offset payload layout ──────────────────────────────────────────────
// All offsets within Cell 0's 768-byte payload region.

const OFFSET_ID           =   0; //  32 bytes, UTF-8 (right-padded with 0x00)
const OFFSET_TRADE_IDX    =  32; //   1 byte,  index into TradesLexicon.categories
const OFFSET_BAND_IDX     =  33; //   1 byte,  index into EFFORT_BANDS
const OFFSET_CONFIDENCE   =  34; //   1 byte,  0=first_pass, 1=rough, 2=tight
const OFFSET_LABOUR_ONLY  =  35; //   1 byte,  0 | 1
const OFFSET_COST_MIN     =  36; //   4 bytes, uint32 LE (AUD)
const OFFSET_COST_MAX     =  40; //   4 bytes, uint32 LE (AUD)
const OFFSET_HOURS_MIN_X10=  44; //   2 bytes, uint16 LE (hours × 10)
const OFFSET_HOURS_MAX_X10=  46; //   2 bytes, uint16 LE (hours × 10)
const OFFSET_EMITTED_AT   =  48; //   8 bytes, uint64 LE (ms since epoch)
const OFFSET_REASON_LEN   =  56; //   2 bytes, uint16 LE
const OFFSET_REASON       =  58; // 200 bytes, UTF-8
const OFFSET_MAT_LEN      = 258; //   2 bytes, uint16 LE
const OFFSET_MAT          = 260; // 400 bytes, UTF-8
const OFFSET_REVISION     = 660; //   2 bytes, uint16 LE (amendment revision)
const OFFSET_SUPERSEDES   = 662; //  32 bytes, UTF-8 (supersedes instrument id)
const PAYLOAD_LOGICAL_END = 694; // remaining 74 bytes reserved

const CONFIDENCE_BYTES: Record<RomConfidence, number> = {
  first_pass: 0,
  rough:      1,
  tight:      2,
};
const CONFIDENCE_FROM_BYTE: RomConfidence[] = ["first_pass", "rough", "tight"];

// ── Type hash: stable id for "ROM instrument emitted by OJT estimator" ───
// Same inputs → same 32-byte hash, so every RomInstrument cell shares a
// typeHash and routers/validators can filter by it.
const ROM_TYPE_HASH = computeTypeHash(
  "services.trades.rom-estimate",   // WHAT
  "estimate",                        // HOW
  "inst.rom-bracket",                // INSTRUMENT
);

// 16-byte owner id for the OJT estimator itself. Stable, hard-coded —
// identifies the emitting cell-engine, not the job.
const OJT_ESTIMATOR_OWNER_ID = Buffer.alloc(16, 0);
Buffer.from("ojt-estimator-v1").copy(OJT_ESTIMATOR_OWNER_ID);

// ── Packing ──────────────────────────────────────────────────────────────────

export interface PackRomOptions {
  /** The instrument to pack. */
  instrument: RomInstrument;
  /** Prev-state-hash from the estimator version chain (32 bytes). */
  prevStateHash: Buffer;
  /** Optional: the raw message that led to this estimate, appended as a
   *  payload note when budget allows. Truncated if it overflows. */
  rawMessage?: string;
}

export interface PackedRomCell extends PackedMultiCell {
  instrumentId: string;
  /** Number of facts serialised into continuation cells. */
  factCount: number;
}

/** Serialise a RomInstrument into a packed multi-cell buffer. */
export function packRomInstrumentCell(opts: PackRomOptions): PackedRomCell {
  const { instrument, prevStateHash } = opts;

  // ── Payload ──
  const payload = Buffer.alloc(PAYLOAD_SIZE, 0);

  writeFixedString(payload, OFFSET_ID, instrument.id, 32);

  payload.writeUInt8(tradeIndex(instrument.trade), OFFSET_TRADE_IDX);
  payload.writeUInt8(bandIndex(instrument.band), OFFSET_BAND_IDX);
  payload.writeUInt8(CONFIDENCE_BYTES[instrument.confidence], OFFSET_CONFIDENCE);
  payload.writeUInt8(instrument.labourOnly ? 1 : 0, OFFSET_LABOUR_ONLY);

  payload.writeUInt32LE(clampU32(instrument.costMin), OFFSET_COST_MIN);
  payload.writeUInt32LE(clampU32(instrument.costMax), OFFSET_COST_MAX);
  payload.writeUInt16LE(clampU16(Math.round(instrument.hoursMin * 10)), OFFSET_HOURS_MIN_X10);
  payload.writeUInt16LE(clampU16(Math.round(instrument.hoursMax * 10)), OFFSET_HOURS_MAX_X10);
  payload.writeBigUInt64LE(BigInt(Date.parse(instrument.emittedAt)), OFFSET_EMITTED_AT);

  writeLengthPrefixed(payload, OFFSET_REASON_LEN, OFFSET_REASON, instrument.reason, 200);
  writeLengthPrefixed(payload, OFFSET_MAT_LEN, OFFSET_MAT, instrument.materialsNote ?? "", 400);
  payload.writeUInt16LE(clampU16(instrument.revision), OFFSET_REVISION);
  writeFixedString(payload, OFFSET_SUPERSEDES, instrument.supersedes ?? "", 32);

  // ── Header ──
  const header = buildCellHeader({
    typeHash: ROM_TYPE_HASH,
    linearity: LINEARITY.LINEAR,      // instrument is LINEAR: consumed once per turn
    ownerId: OJT_ESTIMATOR_OWNER_ID,
    phase: "action",                  // ROM is an action output
    dimension: "instrument",          // the INSTRUMENT axis of WHAT/HOW/INSTRUMENT
    prevStateHash,
    payloadSize: PAYLOAD_LOGICAL_END,
    version: 1,
  });

  // ── Continuation cells: evidence refs as JSON ──
  const factsJson = Buffer.from(JSON.stringify(instrument.evidenceRefs), "utf8");
  const continuationData = factsJson.length > 0 ? [factsJson] : undefined;

  const packed = assembleSemanticObject({
    header,
    payload,
    extraData: continuationData,
  });

  // Annotate with estimator-specific metadata for callers. We shadow
  // `contentHash` from the underlying packed cell (stable id) and expose
  // the instrument id separately for indexing.
  return Object.assign(packed, {
    instrumentId: instrument.id,
    factCount: instrument.evidenceRefs.length,
  });
}

// ── Unpacking (round-trip) ──────────────────────────────────────────────────

export interface UnpackedRomCell {
  instrument: Omit<RomInstrument, "evidenceRefs"> & { evidenceRefs: TaggedFact[] };
  prevStateHash: Buffer;
  typeHash: Buffer;
  cellCount: number;
}

/** Inverse of `packRomInstrumentCell` — used by tests, the instrument
 *  viewer tile, and anyone replaying cells from the anchor chain. */
export function unpackRomInstrumentCell(buffer: Buffer): UnpackedRomCell {
  const disassembled = disassembleSemanticObject(buffer);
  const payload = disassembled.payload;

  const instrument = {
    id: readFixedString(payload, OFFSET_ID, 32),
    trade: TradesLexicon.categories[payload.readUInt8(OFFSET_TRADE_IDX)],
    band: EFFORT_BANDS[payload.readUInt8(OFFSET_BAND_IDX)] as EffortBand,
    confidence: CONFIDENCE_FROM_BYTE[payload.readUInt8(OFFSET_CONFIDENCE)],
    labourOnly: payload.readUInt8(OFFSET_LABOUR_ONLY) === 1,
    costMin: payload.readUInt32LE(OFFSET_COST_MIN),
    costMax: payload.readUInt32LE(OFFSET_COST_MAX),
    hoursMin: payload.readUInt16LE(OFFSET_HOURS_MIN_X10) / 10,
    hoursMax: payload.readUInt16LE(OFFSET_HOURS_MAX_X10) / 10,
    emittedAt: new Date(Number(payload.readBigUInt64LE(OFFSET_EMITTED_AT))).toISOString(),
    reason: readLengthPrefixed(payload, OFFSET_REASON_LEN, OFFSET_REASON),
    materialsNote: (readLengthPrefixed(payload, OFFSET_MAT_LEN, OFFSET_MAT) || null) as string | null,
    evidenceRefs: parseFacts(disassembled.extraData),
    revision: payload.readUInt16LE(OFFSET_REVISION) || 1,
    supersedes: (readFixedString(payload, OFFSET_SUPERSEDES, 32) || null) as string | null,
  };

  return {
    instrument,
    prevStateHash: disassembled.header.prevStateHash,
    typeHash: disassembled.header.typeHash,
    cellCount: buffer.length / 1024,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function tradeIndex(trade: RomInstrument["trade"]): number {
  const idx = (TradesLexicon.categories as readonly string[]).indexOf(trade);
  if (idx < 0) throw new Error(`TradeCategory not in lexicon: ${trade}`);
  return idx;
}

function bandIndex(band: EffortBand): number {
  const idx = (EFFORT_BANDS as readonly string[]).indexOf(band);
  if (idx < 0) throw new Error(`EffortBand not recognised: ${band}`);
  return idx;
}

function writeFixedString(buf: Buffer, offset: number, value: string, capacity: number): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > capacity) {
    throw new Error(`String overflow at offset ${offset}: ${encoded.length}B > ${capacity}B`);
  }
  encoded.copy(buf, offset);
}

function readFixedString(buf: Buffer, offset: number, capacity: number): string {
  const slice = buf.subarray(offset, offset + capacity);
  let end = slice.length;
  while (end > 0 && slice[end - 1] === 0) end--;
  return slice.subarray(0, end).toString("utf8");
}

function writeLengthPrefixed(
  buf: Buffer,
  lenOffset: number,
  dataOffset: number,
  value: string,
  capacity: number,
): void {
  const encoded = Buffer.from(value, "utf8");
  const length = Math.min(encoded.length, capacity);
  buf.writeUInt16LE(length, lenOffset);
  encoded.subarray(0, length).copy(buf, dataOffset);
}

function readLengthPrefixed(buf: Buffer, lenOffset: number, dataOffset: number): string {
  const length = buf.readUInt16LE(lenOffset);
  return buf.subarray(dataOffset, dataOffset + length).toString("utf8");
}

function clampU32(n: number): number {
  return Math.max(0, Math.min(0xffff_ffff, Math.round(n)));
}

function clampU16(n: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(n)));
}

function parseFacts(chunks: ReadonlyArray<Buffer>): TaggedFact[] {
  if (chunks.length === 0) return [];
  const joined = Buffer.concat([...chunks]).toString("utf8").trim();
  if (!joined) return [];
  try {
    const parsed = JSON.parse(joined);
    return Array.isArray(parsed) ? (parsed as TaggedFact[]) : [];
  } catch {
    return [];
  }
}

/** Hash the raw cell bytes — this is the content-addressed id that drops
 *  into `sem_cells.content_hash` and is what gets anchored on-chain. */
export function romCellContentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
