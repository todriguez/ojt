/**
 * Type Hash Registry
 *
 * Computes deterministic SHA256 type hashes from the compiler's type system.
 * These hashes are the canonical bridge between TypeScript types and
 * semantos cell headers (TYPE-HASH field, 32 bytes at offset 30).
 *
 * The same hash computed here in TypeScript can be computed in Forth
 * using the same input string and SHA256. That's the entire bridge.
 */

import { createHash } from "crypto";

// ── Core Hash Functions ─────────────────────────────

/**
 * Compute the composite type hash for a (WHAT, HOW, INSTRUMENT) triple.
 *
 * This goes in the semantos cell header TYPE-HASH field.
 * Format: SHA256(whatPath + ":" + howSlug + ":" + instPath)
 *
 * @example
 * computeTypeHash("services.trades.carpentry", "hire", "inst.contract.service-agreement")
 * // → <Buffer 7a 3f ...> (32 bytes)
 */
export function computeTypeHash(whatPath: string, howSlug: string, instPath: string): Buffer {
  const canonical = `${whatPath}:${howSlug}:${instPath}`;
  return sha256(canonical);
}

/**
 * Compute WHAT dimension hash.
 * Format: SHA256("what." + path)
 */
export function computeWhatHash(path: string): Buffer {
  return sha256(`what.${path}`);
}

/**
 * Compute HOW dimension hash.
 * Format: SHA256("how." + slug)
 */
export function computeHowHash(slug: string): Buffer {
  return sha256(`how.${slug}`);
}

/**
 * Compute INSTRUMENT dimension hash.
 * Format: SHA256("inst." + path)
 */
export function computeInstHash(path: string): Buffer {
  return sha256(`inst.${path}`);
}

/**
 * Compute pipeline phase hash.
 * Format: SHA256("phase." + phaseName)
 */
export function computePhaseHash(phase: PipelinePhase): Buffer {
  return sha256(`phase.${phase}`);
}

// ── Phase Constants ─────────────────────────────────

/** Pipeline phases as 1-byte enum (matches semantos header PHASE field) */
export const PHASE_BYTES = {
  source: 0x00,
  parse: 0x01,
  ast: 0x02,
  typecheck: 0x03,
  optimise: 0x04,
  codegen: 0x05,
  action: 0x06,
  outcome: 0x07,
  unknown: 0xff,
} as const;

export type PipelinePhase = keyof typeof PHASE_BYTES;

/** Dimension encoding (matches semantos header DIMENSION field) */
export const DIMENSION_BYTES = {
  composite: 0x00,
  what: 0x01,
  how: 0x02,
  instrument: 0x03,
} as const;

export type Dimension = keyof typeof DIMENSION_BYTES;

// ── Linearity Constants ─────────────────────────────

/** Linearity classes (matches semantos LINEARITY field at header offset 16) */
export const LINEARITY = {
  LINEAR: 1,    // Must be consumed exactly once (patches, payments)
  AFFINE: 2,    // Can be discarded but not duplicated (containers, certificates)
  RELEVANT: 3,  // Can be duplicated but not discarded (capsules, public data)
  DEBUG: 4,     // Unrestricted (testing only)
} as const;

export type Linearity = (typeof LINEARITY)[keyof typeof LINEARITY];

/** Which linearity class each compiler phase produces */
export const PHASE_LINEARITY: Record<PipelinePhase, Linearity> = {
  source: LINEARITY.RELEVANT,   // messages can be re-read
  parse: LINEARITY.LINEAR,      // extraction consumed once to merge
  ast: LINEARITY.AFFINE,        // container can be updated or discarded
  typecheck: LINEARITY.RELEVANT, // scores are reference data
  optimise: LINEARITY.LINEAR,   // scoring result consumed once
  codegen: LINEARITY.RELEVANT,  // instruments can be referenced multiple times
  action: LINEARITY.LINEAR,     // operator decision consumed once
  outcome: LINEARITY.RELEVANT,  // outcomes are reference data
  unknown: LINEARITY.DEBUG,
};

// ── Header Construction ─────────────────────────────

/** Semantos cell header: 256 bytes */
export interface CellHeader {
  magic: Buffer;          // 16 bytes: 0xDEADBEEF CAFEBABE 13371337 42424242
  linearity: number;      //  4 bytes
  version: number;        //  4 bytes
  flags: number;          //  4 bytes
  refCount: number;       //  2 bytes
  typeHash: Buffer;       // 32 bytes
  ownerId: Buffer;        // 16 bytes
  timestamp: bigint;      //  8 bytes
  cellCount: number;      //  4 bytes
  totalSize: number;      //  4 bytes
  // Reserved block (162 bytes), of which we use:
  phase: number;          //  1 byte  (offset 94)
  dimension: number;      //  1 byte  (offset 95)
  parentHash: Buffer;     // 32 bytes (offset 96)
  prevStateHash: Buffer;  // 32 bytes (offset 128)
  // remaining: 96 bytes reserved
}

const CELL_SIZE = 1024;
const HEADER_SIZE = 256;
const PAYLOAD_SIZE = CELL_SIZE - HEADER_SIZE;

const MAGIC = Buffer.from([
  0xde, 0xad, 0xbe, 0xef,
  0xca, 0xfe, 0xba, 0xbe,
  0x13, 0x37, 0x13, 0x37,
  0x42, 0x42, 0x42, 0x42,
]);

/**
 * Build a 256-byte cell header.
 */
export function buildCellHeader(opts: {
  typeHash: Buffer;
  linearity: Linearity;
  ownerId: Buffer;       // 16 bytes
  phase: PipelinePhase;
  dimension: Dimension;
  parentHash?: Buffer;   // 32 bytes, optional
  prevStateHash?: Buffer; // 32 bytes, optional
  payloadSize: number;
  version?: number;
}): Buffer {
  const header = Buffer.alloc(HEADER_SIZE, 0);
  const cellCount = Math.ceil((opts.payloadSize + HEADER_SIZE) / CELL_SIZE);

  // Magic (offset 0, 16 bytes)
  MAGIC.copy(header, 0);

  // Linearity (offset 16, 4 bytes LE)
  header.writeUInt32LE(opts.linearity, 16);

  // Version (offset 20, 4 bytes LE)
  header.writeUInt32LE(opts.version ?? 1, 20);

  // Flags (offset 24, 4 bytes LE)
  header.writeUInt32LE(0, 24);

  // RefCount (offset 28, 2 bytes LE)
  header.writeUInt16LE(1, 28);

  // TypeHash (offset 30, 32 bytes)
  opts.typeHash.copy(header, 30, 0, 32);

  // OwnerID (offset 62, 16 bytes)
  opts.ownerId.copy(header, 62, 0, 16);

  // Timestamp (offset 78, 8 bytes LE — BigInt)
  header.writeBigUInt64LE(BigInt(Date.now()), 78);

  // CellCount (offset 86, 4 bytes LE)
  header.writeUInt32LE(cellCount, 86);

  // TotalSize (offset 90, 4 bytes LE)
  header.writeUInt32LE(opts.payloadSize, 90);

  // ── Reserved block (offset 94) ──

  // Phase (offset 94, 1 byte)
  header.writeUInt8(PHASE_BYTES[opts.phase], 94);

  // Dimension (offset 95, 1 byte)
  header.writeUInt8(DIMENSION_BYTES[opts.dimension], 95);

  // ParentHash (offset 96, 32 bytes)
  if (opts.parentHash) {
    opts.parentHash.copy(header, 96, 0, 32);
  }

  // PrevStateHash (offset 128, 32 bytes)
  if (opts.prevStateHash) {
    opts.prevStateHash.copy(header, 128, 0, 32);
  }

  // Remaining 96 bytes at offset 160 stay zero

  return header;
}

/**
 * Pack a complete cell (header + payload).
 * Returns exactly 1024 bytes (or N×1024 for multi-cell).
 */
export function packCell(header: Buffer, payload: Buffer): Buffer {
  const cellCount = Math.ceil((payload.length + HEADER_SIZE) / CELL_SIZE);
  const totalBytes = cellCount * CELL_SIZE;
  const cell = Buffer.alloc(totalBytes, 0);

  header.copy(cell, 0);
  payload.copy(cell, HEADER_SIZE);

  return cell;
}

/**
 * Unpack a cell: extract header and payload.
 */
export function unpackCell(cell: Buffer): { header: CellHeader; payload: Buffer } {
  const linearity = cell.readUInt32LE(16);
  const version = cell.readUInt32LE(20);
  const flags = cell.readUInt32LE(24);
  const refCount = cell.readUInt16LE(28);
  const typeHash = cell.subarray(30, 62);
  const ownerId = cell.subarray(62, 78);
  const timestamp = cell.readBigUInt64LE(78);
  const cellCount = cell.readUInt32LE(86);
  const totalSize = cell.readUInt32LE(90);
  const phase = cell.readUInt8(94);
  const dimension = cell.readUInt8(95);
  const parentHash = cell.subarray(96, 128);
  const prevStateHash = cell.subarray(128, 160);

  const payload = cell.subarray(HEADER_SIZE, HEADER_SIZE + totalSize);

  return {
    header: {
      magic: cell.subarray(0, 16),
      linearity,
      version,
      flags,
      refCount,
      typeHash: Buffer.from(typeHash),
      ownerId: Buffer.from(ownerId),
      timestamp,
      cellCount,
      totalSize,
      phase,
      dimension,
      parentHash: Buffer.from(parentHash),
      prevStateHash: Buffer.from(prevStateHash),
    },
    payload: Buffer.from(payload),
  };
}

// ── Convenience ─────────────────────────────────────

/**
 * Compute the content hash of a payload (for integrity/chaining).
 */
export function contentHash(payload: Buffer): Buffer {
  return sha256Buffer(payload);
}

/**
 * Verify a cell's magic numbers.
 */
export function isValidCell(cell: Buffer): boolean {
  if (cell.length < HEADER_SIZE) return false;
  return cell.subarray(0, 16).equals(MAGIC);
}

// ── Internal ────────────────────────────────────────

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf-8").digest();
}

function sha256Buffer(input: Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}
