/**
 * cellPacker.ts
 *
 * Structured Multi-Cell Packing for Semantic Objects
 *
 * A semantic object occupies one or more 1KB cells:
 *
 *   Cell 0 — Semantic Object (256-byte header + 768-byte payload)
 *     The header carries identity, type hash, linearity, versioning.
 *     The 768-byte payload holds the semantic IR (type registry data,
 *     state snapshot, domain fields).
 *
 *   Cell 1 — BUMP Merkle Path (1024 bytes, first continuation cell)
 *     Contains the BRC-74 merkle proof for SPV validation.
 *     Packed FIRST in continuation sequence for LIFO alt-stack ordering:
 *     when the Forth 2-PDA pops continuation cells off the alt stack,
 *     BUMP is on top → fail-fast SPV validation before touching payload.
 *
 *   Cell 2 — Atomic BEEF (1024 bytes)
 *     The full transaction envelope: 0x01010101 prefix + subject TXID +
 *     BRC-62 BEEF structure containing the anchor tx + ancestor graph.
 *     Validates the anchor transaction and all its inputs via recursive SPV.
 *
 *   Cell 3+ — State Envelope / Data Cells (1024 bytes each)
 *     State merkle envelope (our custom format mapping state hashes to the
 *     merkle root inscribed in the anchor tx), plus arbitrary extensions.
 *     Popped last on the alt stack — only reached if BUMP + BEEF pass.
 *
 * All cells are exactly 1024 bytes. Zero-padded if content is shorter.
 *
 * LIFO Stack Ordering:
 *   The Forth 2-PDA alt stack is LIFO. Continuation cells are pushed
 *   in sequence (Cell 1 first, Cell 2 next, ...). When popped:
 *     - Cell N (last) comes off first
 *     - Cell 1 (BUMP) comes off last → it's on top after all pops
 *   Wait — that's wrong. For BUMP to be on top after popping all
 *   continuation cells, we push in REVERSE order:
 *     Push Cell N, ..., Cell 2, Cell 1
 *   Pop order: Cell 1 (BUMP), Cell 2, ..., Cell N
 *   This gives us fail-fast: validate BUMP first, then process data.
 *
 *   However, the BYTE LAYOUT is still Cell 0, Cell 1, Cell 2, ...
 *   The push order is a runtime concern, not a serialization concern.
 *   The packer lays out bytes sequentially; the Forth interpreter
 *   pushes them onto the alt stack in reverse order for LIFO access.
 */

import { createHash } from "crypto";
import type { MerkleEnvelope } from "./merkleEnvelope";
import { serializeMerkleEnvelope } from "./merkleEnvelope";

import {
  buildCellHeader,
  packCell,
  unpackCell,
  type CellHeader,
  type PipelinePhase,
  type Dimension,
  type Linearity,
} from "../domain/bridge/typeHashRegistry";

// ── Constants ────────────────────────────────────────────────────────────────

export const CELL_SIZE = 1024;
export const HEADER_SIZE = 256;
export const PAYLOAD_SIZE = CELL_SIZE - HEADER_SIZE; // 768

/**
 * Continuation cell type tags (first byte of each continuation cell).
 *
 * Ordered by verification priority (LIFO pop order from alt stack):
 *   0x01 BUMP          — fail-fast: is the anchor tx in a block?
 *   0x02 ATOMIC_BEEF   — full SPV: is the anchor tx + ancestry valid?
 *   0x03 ENVELOPE      — state proof: which semantic states are under this merkle root?
 *   0x04 DATA          — arbitrary extension payload
 *   0x05 STATE         — overflow state data
 */
export const CONTINUATION_TYPE = {
  BUMP:         0x01,   // BRC-74 merkle path (lightweight, ~330 bytes)
  ATOMIC_BEEF:  0x02,   // Atomic BEEF (BRC-95 variant): 0x01010101 prefix + subject TXID + tx graph
  ENVELOPE:     0x03,   // State merkle envelope: our custom format mapping state hashes → root
  DATA:         0x04,   // Arbitrary data payload
  STATE:        0x05,   // Overflow state data
} as const;

export type ContinuationType = (typeof CONTINUATION_TYPE)[keyof typeof CONTINUATION_TYPE];

/** Continuation cell header: 8 bytes at the start of each continuation cell */
export interface ContinuationHeader {
  cellType: ContinuationType;  // 1 byte
  cellIndex: number;           // 2 bytes (position in continuation sequence, 1-based)
  totalCells: number;          // 2 bytes (total continuation cells, excludes Cell 0)
  payloadSize: number;         // 2 bytes (actual data bytes in this cell, max 1016)
  reserved: number;            // 1 byte
}

const CONTINUATION_HEADER_SIZE = 8;
const CONTINUATION_PAYLOAD_SIZE = CELL_SIZE - CONTINUATION_HEADER_SIZE; // 1016

// ── Multi-Cell Object ────────────────────────────────────────────────────────

export interface ContinuationCell {
  type: ContinuationType;
  data: Buffer;  // up to 1016 bytes
}

export interface MultiCellObject {
  /** Cell 0: semantic object header (256 bytes) */
  header: Buffer;
  /** Cell 0: semantic payload (up to 768 bytes) */
  payload: Buffer;
  /** Cells 1..N: ordered continuation cells */
  continuations: ContinuationCell[];
}

export interface PackedMultiCell {
  /** Total packed bytes (N × 1024) */
  buffer: Buffer;
  /** How many 1KB cells */
  cellCount: number;
  /** Content hash of the entire packed buffer */
  contentHash: Buffer;
}

// ── Packing ──────────────────────────────────────────────────────────────────

/**
 * Build a continuation cell header (8 bytes).
 */
function buildContinuationHeader(h: ContinuationHeader): Buffer {
  const buf = Buffer.alloc(CONTINUATION_HEADER_SIZE, 0);
  buf.writeUInt8(h.cellType, 0);
  buf.writeUInt16LE(h.cellIndex, 1);
  buf.writeUInt16LE(h.totalCells, 3);
  buf.writeUInt16LE(h.payloadSize, 5);
  buf.writeUInt8(h.reserved, 7);
  return buf;
}

/**
 * Parse a continuation cell header from a 1KB cell buffer.
 */
function parseContinuationHeader(cell: Buffer): ContinuationHeader {
  return {
    cellType: cell.readUInt8(0) as ContinuationType,
    cellIndex: cell.readUInt16LE(1),
    totalCells: cell.readUInt16LE(3),
    payloadSize: cell.readUInt16LE(5),
    reserved: cell.readUInt8(7),
  };
}

/**
 * Pack a multi-cell semantic object into a contiguous byte buffer.
 *
 * Layout:
 *   [Cell 0: 256-byte header + 768-byte payload]
 *   [Cell 1: 8-byte continuation header + 1016-byte BUMP data]
 *   [Cell 2: 8-byte continuation header + 1016-byte Atomic BEEF / envelope / data]
 *   ...
 *
 * The Cell 0 header's cellCount field is set to the total cell count.
 *
 * @returns Packed buffer of exactly (1 + continuations.length) × 1024 bytes
 */
export function packMultiCell(obj: MultiCellObject): PackedMultiCell {
  const totalCells = 1 + obj.continuations.length;

  // Validate payload fits in Cell 0
  if (obj.payload.length > PAYLOAD_SIZE) {
    throw new Error(
      `Cell 0 payload too large: ${obj.payload.length} bytes (max ${PAYLOAD_SIZE}). ` +
      `Use continuation cells for overflow data.`
    );
  }

  // Validate continuation data fits
  for (let i = 0; i < obj.continuations.length; i++) {
    if (obj.continuations[i].data.length > CONTINUATION_PAYLOAD_SIZE) {
      throw new Error(
        `Continuation cell ${i + 1} data too large: ${obj.continuations[i].data.length} bytes ` +
        `(max ${CONTINUATION_PAYLOAD_SIZE})`
      );
    }
  }

  const buffer = Buffer.alloc(totalCells * CELL_SIZE, 0);

  // ── Cell 0: header + payload ──
  // Patch the cellCount in the header to reflect total cells
  const header = Buffer.from(obj.header); // don't mutate original
  header.writeUInt32LE(totalCells, 86);
  header.copy(buffer, 0);
  obj.payload.copy(buffer, HEADER_SIZE);

  // ── Cells 1..N: continuation cells ──
  for (let i = 0; i < obj.continuations.length; i++) {
    const cont = obj.continuations[i];
    const cellOffset = (i + 1) * CELL_SIZE;

    const contHeader = buildContinuationHeader({
      cellType: cont.type,
      cellIndex: i + 1,
      totalCells: obj.continuations.length,
      payloadSize: cont.data.length,
      reserved: 0,
    });

    contHeader.copy(buffer, cellOffset);
    cont.data.copy(buffer, cellOffset + CONTINUATION_HEADER_SIZE);
  }

  const hash = createHash("sha256").update(buffer).digest();

  return {
    buffer,
    cellCount: totalCells,
    contentHash: hash,
  };
}

/**
 * Unpack a multi-cell buffer back into structured form.
 */
export function unpackMultiCell(buffer: Buffer): MultiCellObject {
  if (buffer.length < CELL_SIZE) {
    throw new Error(`Buffer too small: ${buffer.length} bytes (minimum ${CELL_SIZE})`);
  }
  if (buffer.length % CELL_SIZE !== 0) {
    throw new Error(`Buffer size ${buffer.length} is not a multiple of ${CELL_SIZE}`);
  }

  // Derive cell count from buffer length, not header field.
  // The buffer we received is the source of truth — the header's cellCount
  // at offset 86 is advisory (written by the sender). We validate against
  // actual bytes, which is strictly more robust for adversarial inputs.
  const totalCells = buffer.length / CELL_SIZE;

  // ── Cell 0 ──
  const header = Buffer.from(buffer.subarray(0, HEADER_SIZE));
  // Offset 90 = payloadSize: how many bytes of Cell 0's 768-byte region
  // contain meaningful data (rest is zero-padding).
  // Offset 86 = cellCount: intentionally NOT read here — see above.
  const payloadSize = header.readUInt32LE(90);
  const payload = Buffer.from(buffer.subarray(HEADER_SIZE, HEADER_SIZE + Math.min(payloadSize, PAYLOAD_SIZE)));

  // ── Cells 1..N ──
  const continuations: ContinuationCell[] = [];
  for (let i = 1; i < totalCells; i++) {
    const cellOffset = i * CELL_SIZE;
    const cellSlice = buffer.subarray(cellOffset, cellOffset + CELL_SIZE);
    const contHeader = parseContinuationHeader(cellSlice);

    continuations.push({
      type: contHeader.cellType,
      data: Buffer.from(cellSlice.subarray(
        CONTINUATION_HEADER_SIZE,
        CONTINUATION_HEADER_SIZE + contHeader.payloadSize,
      )),
    });
  }

  return { header, payload, continuations };
}

// ── BUMP Cell Construction (BRC-74 opaque binary) ────────────────────────────

/**
 * BRC-74 BUMP header info extracted from raw bytes.
 *
 * We parse just enough to validate structure and extract routing info.
 * The full BUMP is an opaque blob — the BSV SDK handles merkle root
 * computation and verification against the block header service.
 *
 * BRC-74 binary layout:
 *   [VarInt: blockHeight]
 *   [1 byte: treeHeight]
 *   [levels 0..treeHeight-1, each: VarInt nLeaves, then leaf entries]
 *
 * Each leaf: [VarInt offset] [1 byte flags] [optional 32-byte hash]
 *   flags: 0x00 = hash follows (sibling), 0x01 = duplicate working hash,
 *          0x02 = hash follows (client txid)
 *
 * Verification is NOT done here. The Forth VM / BSV SDK:
 *   1. Parses the BUMP to extract blockHeight + txid(s)
 *   2. Computes merkle root by walking the tree level by level
 *   3. Queries the SPV header service for the block at that height
 *   4. Compares computed root against block header's merkle root
 *   5. If mismatch → FAIL FAST, reject the semantic object
 */
export interface BumpHeader {
  /** Block height where the transaction was mined */
  blockHeight: number;
  /** Height of the merkle tree in this block */
  treeHeight: number;
  /** Byte offset where level data begins (after blockHeight + treeHeight) */
  dataOffset: number;
}

/**
 * Read a VarInt from a buffer at the given offset.
 * Returns the value and the number of bytes consumed.
 * Handles Bitcoin VarInt encoding: 1, 3, 5, or 9 bytes.
 */
function readVarInt(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  const first = buf.readUInt8(offset);
  if (first < 0xfd) {
    return { value: first, bytesRead: 1 };
  } else if (first === 0xfd) {
    return { value: buf.readUInt16LE(offset + 1), bytesRead: 3 };
  } else if (first === 0xfe) {
    return { value: buf.readUInt32LE(offset + 1), bytesRead: 5 };
  } else {
    // 0xff — 8 byte, but we cap at Number.MAX_SAFE_INTEGER
    const lo = buf.readUInt32LE(offset + 1);
    const hi = buf.readUInt32LE(offset + 5);
    return { value: hi * 0x100000000 + lo, bytesRead: 9 };
  }
}

/**
 * Parse the header of a raw BRC-74 BUMP binary.
 * Extracts blockHeight and treeHeight for validation/routing.
 * Does NOT parse the full tree — that's the BSV SDK's job.
 *
 * @throws if the buffer is too short or treeHeight is unreasonable
 */
export function parseBumpHeader(raw: Buffer): BumpHeader {
  if (raw.length < 2) {
    throw new Error(`BUMP too short: ${raw.length} bytes (minimum 2)`);
  }

  const { value: blockHeight, bytesRead } = readVarInt(raw, 0);
  const treeHeight = raw.readUInt8(bytesRead);

  if (treeHeight > 64) {
    throw new Error(`BUMP treeHeight ${treeHeight} exceeds maximum (64)`);
  }

  return {
    blockHeight,
    treeHeight,
    dataOffset: bytesRead + 1,
  };
}

/**
 * Create BUMP continuation cells from raw BRC-74 binary.
 *
 * The raw bytes come directly from the BSV SDK or transaction processor.
 * We validate the header (blockHeight + treeHeight) but treat the rest
 * as opaque — the packer doesn't understand merkle tree internals.
 *
 * Typically fits in one cell. A block with 2^30 transactions would need
 * a tree of height 30 with ~30 sibling hashes = ~1000 bytes. Compound
 * paths (multiple txids in one block) could push past 1016 bytes, in
 * which case we split across multiple BUMP cells.
 */
export function createBumpCells(bumpRaw: Buffer): ContinuationCell[] {
  // Validate header before packing
  parseBumpHeader(bumpRaw);

  const cells: ContinuationCell[] = [];
  let offset = 0;

  while (offset < bumpRaw.length) {
    const chunk = bumpRaw.subarray(offset, offset + CONTINUATION_PAYLOAD_SIZE);
    cells.push({
      type: CONTINUATION_TYPE.BUMP,
      data: Buffer.from(chunk),
    });
    offset += CONTINUATION_PAYLOAD_SIZE;
  }

  return cells;
}

// ── Atomic BEEF Cell Construction ────────────────────────────────────────────

/** Atomic BEEF prefix: 0x01010101 (4 bytes) */
export const ATOMIC_BEEF_PREFIX = Buffer.from([0x01, 0x01, 0x01, 0x01]);

/**
 * An Atomic BEEF payload ready for cell packing.
 *
 * This is the pre-serialized Atomic BEEF binary — the caller is responsible
 * for constructing it from the BSV SDK's transaction builder. We don't
 * build the transaction graph here; we just pack it into cells.
 *
 * Expected binary layout (per BRC):
 *   [4 bytes: 0x01010101 prefix]
 *   [32 bytes: subject TXID]
 *   [N bytes: standard BEEF structure (0100beef + BUMPs + transactions)]
 */
export interface AtomicBeefPayload {
  /** The subject transaction ID (32 bytes) */
  subjectTxid: Buffer;
  /** The raw Atomic BEEF binary (including prefix + TXID + BEEF body) */
  rawBytes: Buffer;
}

/**
 * Validate that raw bytes are a well-formed Atomic BEEF prefix.
 * Checks the 0x01010101 magic and extracts the subject TXID.
 */
export function parseAtomicBeefHeader(raw: Buffer): { subjectTxid: Buffer } {
  if (raw.length < 36) {
    throw new Error(`Atomic BEEF too short: ${raw.length} bytes (minimum 36)`);
  }
  if (!raw.subarray(0, 4).equals(ATOMIC_BEEF_PREFIX)) {
    throw new Error(
      `Invalid Atomic BEEF prefix: expected 01010101, got ${raw.subarray(0, 4).toString("hex")}`
    );
  }
  return { subjectTxid: Buffer.from(raw.subarray(4, 36)) };
}

/**
 * Create Atomic BEEF continuation cells from a pre-serialized Atomic BEEF binary.
 *
 * The raw bytes should already be in Atomic BEEF format:
 *   [01010101][subject TXID][0100beef...BUMPs...transactions]
 *
 * If it fits in one cell (≤ 1016 bytes), returns one cell.
 * Otherwise splits across multiple cells, all tagged ATOMIC_BEEF.
 * The receiver concatenates them in order to reconstruct the full binary.
 */
export function createAtomicBeefCells(atomicBeefRaw: Buffer): ContinuationCell[] {
  // Validate prefix before packing
  parseAtomicBeefHeader(atomicBeefRaw);

  const cells: ContinuationCell[] = [];
  let offset = 0;

  while (offset < atomicBeefRaw.length) {
    const chunk = atomicBeefRaw.subarray(offset, offset + CONTINUATION_PAYLOAD_SIZE);
    cells.push({
      type: CONTINUATION_TYPE.ATOMIC_BEEF,
      data: Buffer.from(chunk),
    });
    offset += CONTINUATION_PAYLOAD_SIZE;
  }

  return cells;
}

// ── State Envelope Cell Construction ─────────────────────────────────────────

/**
 * Split a serialized state merkle envelope across one or more ENVELOPE cells.
 *
 * This is our CUSTOM format (not BRC-62/95) — it maps semantic state hashes
 * to a merkle root that was inscribed in the anchor transaction.
 *
 * If the envelope fits in a single cell (≤ 1016 bytes), returns one cell.
 * Otherwise, splits across multiple cells, all tagged ENVELOPE.
 */
export function createEnvelopeCells(envelope: MerkleEnvelope): ContinuationCell[] {
  const serialized = serializeMerkleEnvelope(envelope);
  const cells: ContinuationCell[] = [];

  let offset = 0;
  while (offset < serialized.length) {
    const chunk = serialized.subarray(offset, offset + CONTINUATION_PAYLOAD_SIZE);
    cells.push({
      type: CONTINUATION_TYPE.ENVELOPE,
      data: Buffer.from(chunk),
    });
    offset += CONTINUATION_PAYLOAD_SIZE;
  }

  return cells;
}

/**
 * Create a generic data continuation cell.
 */
export function createDataCell(data: Buffer): ContinuationCell {
  if (data.length > CONTINUATION_PAYLOAD_SIZE) {
    throw new Error(
      `Data too large for single cell: ${data.length} bytes (max ${CONTINUATION_PAYLOAD_SIZE})`
    );
  }

  return {
    type: CONTINUATION_TYPE.DATA,
    data: Buffer.from(data),
  };
}

/**
 * Split arbitrary data across multiple DATA continuation cells.
 */
export function createDataCells(data: Buffer): ContinuationCell[] {
  const cells: ContinuationCell[] = [];
  let offset = 0;

  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + CONTINUATION_PAYLOAD_SIZE);
    cells.push({
      type: CONTINUATION_TYPE.DATA,
      data: Buffer.from(chunk),
    });
    offset += CONTINUATION_PAYLOAD_SIZE;
  }

  return cells;
}

// ── High-Level Assembly ──────────────────────────────────────────────────────

export interface AssembleOptions {
  /** Cell 0 header (256 bytes from buildCellHeader) */
  header: Buffer;
  /** Cell 0 payload (semantic IR, max 768 bytes) */
  payload: Buffer;
  /** Optional raw BRC-74 BUMP binary → Cell 1 (fail-fast SPV) */
  bumpRaw?: Buffer;
  /** Optional raw Atomic BEEF binary → Cell 2 (full transaction SPV) */
  atomicBeef?: Buffer;
  /** Optional state merkle envelope → Cell 3+ (state hash → root mapping) */
  stateEnvelope?: MerkleEnvelope;
  /** Optional extra data payloads → appended last */
  extraData?: Buffer[];
}

/**
 * Assemble a complete multi-cell semantic object with three-phase verification.
 *
 * Cell layout (verification order when popped from alt stack):
 *   Cell 0: Semantic object (header + payload) — always present
 *   Cell 1: BUMP (if provided) — "is the anchor tx mined?" (fail-fast)
 *   Cell 2: Atomic BEEF (if provided) — "is the anchor tx + ancestry valid?" (full SPV)
 *   Cell 3+: State envelope (if provided) — "which states are under this root?"
 *   Cell N+: Extra data (if provided) — arbitrary extensions
 *
 * Byte layout is sequential. The Forth interpreter pushes continuation
 * cells onto the alt stack in reverse order for LIFO access:
 *   Pop 1: BUMP → verify against block header from SPV client
 *   Pop 2: Atomic BEEF → recursive ancestor validation
 *   Pop 3: State envelope → selective disclosure of anchored states
 *   Pop 4+: Data → application-specific
 */
export function assembleSemanticObject(opts: AssembleOptions): PackedMultiCell {
  const continuations: ContinuationCell[] = [];

  // Phase 1: BUMP (always first — fail-fast block inclusion check)
  if (opts.bumpRaw) {
    continuations.push(...createBumpCells(opts.bumpRaw));
  }

  // Phase 2: Atomic BEEF (full transaction graph SPV)
  if (opts.atomicBeef) {
    continuations.push(...createAtomicBeefCells(opts.atomicBeef));
  }

  // Phase 3: State envelope (state hash → merkle root mapping)
  if (opts.stateEnvelope) {
    continuations.push(...createEnvelopeCells(opts.stateEnvelope));
  }

  // Phase 4: Extra data (arbitrary extensions)
  if (opts.extraData) {
    for (const data of opts.extraData) {
      continuations.push(...createDataCells(data));
    }
  }

  return packMultiCell({
    header: opts.header,
    payload: opts.payload,
    continuations,
  });
}

// ── Disassembly ──────────────────────────────────────────────────────────────

export interface DisassembledObject {
  /** Cell 0 header fields */
  header: CellHeader;
  /** Cell 0 payload */
  payload: Buffer;
  /**
   * Phase 1: Raw BRC-74 BUMP from Cell 1 (if present).
   * Opaque binary — pass to the BSV SDK for merkle root computation.
   * The SDK computes the root, then verifies it against the block
   * header service. Use parseBumpHeader() to extract blockHeight.
   */
  bumpRaw?: Buffer;
  /**
   * Phase 2: Atomic BEEF from Cell 2 (if present).
   * Raw binary starting with 0x01010101 prefix + subject TXID + BEEF body.
   * Pass to the BSV SDK for full recursive SPV validation.
   */
  atomicBeef?: Buffer;
  /**
   * Phase 3: State envelope from Cell 3+ (if present).
   * Our custom format mapping semantic state hashes to the merkle root.
   * Pass to deserializeMerkleEnvelope() to extract proofs.
   */
  envelopeData?: Buffer;
  /** Extra data payloads (if present) */
  extraData: Buffer[];
}

/**
 * Disassemble a packed multi-cell buffer into typed components.
 * Reconstructs multi-cell payloads by concatenating chunks in order.
 */
export function disassembleSemanticObject(buffer: Buffer): DisassembledObject {
  const multi = unpackMultiCell(buffer);
  const { header: headerFields } = unpackCell(
    Buffer.concat([multi.header, multi.payload, Buffer.alloc(Math.max(0, CELL_SIZE - HEADER_SIZE - multi.payload.length))])
  );

  const bumpChunks: Buffer[] = [];
  const atomicBeefChunks: Buffer[] = [];
  const envelopeChunks: Buffer[] = [];
  const extraData: Buffer[] = [];

  for (const cont of multi.continuations) {
    switch (cont.type) {
      case CONTINUATION_TYPE.BUMP:
        bumpChunks.push(cont.data);
        break;
      case CONTINUATION_TYPE.ATOMIC_BEEF:
        atomicBeefChunks.push(cont.data);
        break;
      case CONTINUATION_TYPE.ENVELOPE:
        envelopeChunks.push(cont.data);
        break;
      case CONTINUATION_TYPE.DATA:
        extraData.push(cont.data);
        break;
      case CONTINUATION_TYPE.STATE:
        extraData.push(cont.data);
        break;
    }
  }

  return {
    header: headerFields,
    payload: multi.payload,
    bumpRaw: bumpChunks.length > 0 ? Buffer.concat(bumpChunks) : undefined,
    atomicBeef: atomicBeefChunks.length > 0 ? Buffer.concat(atomicBeefChunks) : undefined,
    envelopeData: envelopeChunks.length > 0 ? Buffer.concat(envelopeChunks) : undefined,
    extraData,
  };
}
