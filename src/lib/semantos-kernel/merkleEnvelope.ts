/**
 * Merkle Envelope — State Chain Proof Structure
 *
 * Builds merkle trees over state hash chains for efficient on-chain anchoring.
 * Instead of inscribing N states on-chain, inscribe one merkle root.
 * BEEF envelopes (BRC-95) carry the proof paths for selective disclosure.
 *
 * Compatible with semantos/bitcoin-script/formats/beef.fs
 */
import { createHash } from "crypto";

// SHA256 helper
function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

// Double SHA256 (Bitcoin standard)
function sha256d(data: Buffer): Buffer {
  return sha256(sha256(data));
}

export interface MerkleNode {
  hash: Buffer;     // 32 bytes
  left?: MerkleNode;
  right?: MerkleNode;
  index?: number;   // leaf index
}

export interface MerkleProof {
  leafHash: Buffer;
  leafIndex: number;
  siblings: Array<{ hash: Buffer; position: "left" | "right" }>;
  root: Buffer;
}

export interface MerkleEnvelope {
  version: number;
  root: Buffer;           // 32-byte merkle root
  leafCount: number;
  proofs: MerkleProof[];  // selective disclosure proofs
  rawLeaves: Buffer[];    // the state hashes in order
}

/**
 * Build a merkle tree from an array of state hashes.
 * Each hash is 32 bytes (SHA256 of the state).
 * Uses double-SHA256 for internal nodes (Bitcoin convention).
 */
export function buildMerkleTree(leaves: Buffer[]): MerkleNode {
  if (leaves.length === 0) {
    throw new Error("Cannot build merkle tree from empty leaves");
  }

  // Create leaf nodes
  let level: MerkleNode[] = leaves.map((hash, index) => ({ hash, index }));

  // If odd number of leaves, duplicate the last one
  while (level.length > 1) {
    const nextLevel: MerkleNode[] = [];

    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last if odd

      const combined = Buffer.concat([left.hash, right.hash]);
      const parentHash = sha256d(combined);

      nextLevel.push({ hash: parentHash, left, right });
    }

    level = nextLevel;
  }

  return level[0];
}

/**
 * Compute the merkle root from an array of state hashes.
 */
export function computeMerkleRoot(stateHashes: Buffer[]): Buffer {
  return buildMerkleTree(stateHashes).hash;
}

/**
 * Generate a merkle proof for a specific leaf index.
 */
export function generateMerkleProof(leaves: Buffer[], leafIndex: number): MerkleProof {
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error(`Leaf index ${leafIndex} out of range [0, ${leaves.length})`);
  }

  const siblings: Array<{ hash: Buffer; position: "left" | "right" }> = [];
  let currentIndex = leafIndex;
  let level = leaves.slice(); // copy

  while (level.length > 1) {
    // Pad if odd
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1]);
    }

    const nextLevel: Buffer[] = [];

    for (let i = 0; i < level.length; i += 2) {
      const leftHash = level[i];
      const rightHash = level[i + 1];

      // If current index is in this pair, record the sibling
      if (i === currentIndex || i + 1 === currentIndex) {
        if (currentIndex % 2 === 0) {
          // Current is left, sibling is right
          siblings.push({ hash: rightHash, position: "right" });
        } else {
          // Current is right, sibling is left
          siblings.push({ hash: leftHash, position: "left" });
        }
      }

      const combined = Buffer.concat([leftHash, rightHash]);
      nextLevel.push(sha256d(combined));
    }

    currentIndex = Math.floor(currentIndex / 2);
    level = nextLevel;
  }

  return {
    leafHash: leaves[leafIndex],
    leafIndex,
    siblings,
    root: level[0],
  };
}

/**
 * Verify a merkle proof against a root.
 */
export function verifyMerkleProof(proof: MerkleProof, expectedRoot: Buffer): boolean {
  let currentHash = proof.leafHash;

  for (const sibling of proof.siblings) {
    const combined = sibling.position === "right"
      ? Buffer.concat([currentHash, sibling.hash])
      : Buffer.concat([sibling.hash, currentHash]);

    currentHash = sha256d(combined);
  }

  return currentHash.equals(expectedRoot);
}

/**
 * Build a complete merkle envelope for a state hash chain.
 * This is the artifact that gets stored in sem_anchor_requests.beefEnvelope.
 *
 * @param stateHashes - ordered array of state hashes from the chain
 * @param disclosureIndices - which leaves to include proofs for (default: all)
 */
export function buildMerkleEnvelope(
  stateHashes: Buffer[],
  disclosureIndices?: number[],
): MerkleEnvelope {
  const root = computeMerkleRoot(stateHashes);

  const indices = disclosureIndices ?? stateHashes.map((_, i) => i);
  const proofs = indices.map(i => generateMerkleProof(stateHashes, i));

  return {
    version: 1,
    root,
    leafCount: stateHashes.length,
    proofs,
    rawLeaves: stateHashes,
  };
}

/**
 * Serialize a merkle envelope to bytes for storage in beefEnvelope column.
 * Format:
 *   [1 byte version] [4 bytes leaf count] [32 bytes root]
 *   [4 bytes proof count]
 *   For each proof:
 *     [4 bytes leaf index] [32 bytes leaf hash]
 *     [4 bytes sibling count]
 *     For each sibling:
 *       [1 byte position (0=left, 1=right)] [32 bytes hash]
 */
export function serializeMerkleEnvelope(envelope: MerkleEnvelope): Buffer {
  const parts: Buffer[] = [];

  // Header
  const header = Buffer.alloc(37);
  header.writeUInt8(envelope.version, 0);
  header.writeUInt32LE(envelope.leafCount, 1);
  envelope.root.copy(header, 5);
  parts.push(header);

  // Proof count
  const proofCount = Buffer.alloc(4);
  proofCount.writeUInt32LE(envelope.proofs.length, 0);
  parts.push(proofCount);

  // Each proof
  for (const proof of envelope.proofs) {
    const proofHeader = Buffer.alloc(40);
    proofHeader.writeUInt32LE(proof.leafIndex, 0);
    proof.leafHash.copy(proofHeader, 4);
    proofHeader.writeUInt32LE(proof.siblings.length, 36);
    parts.push(proofHeader);

    for (const sib of proof.siblings) {
      const sibBuf = Buffer.alloc(33);
      sibBuf.writeUInt8(sib.position === "left" ? 0 : 1, 0);
      sib.hash.copy(sibBuf, 1);
      parts.push(sibBuf);
    }
  }

  return Buffer.concat(parts);
}

/**
 * Deserialize a merkle envelope from bytes.
 */
export function deserializeMerkleEnvelope(data: Buffer): MerkleEnvelope {
  let offset = 0;

  const version = data.readUInt8(offset); offset += 1;
  const leafCount = data.readUInt32LE(offset); offset += 4;
  const root = data.subarray(offset, offset + 32); offset += 32;

  const proofCount = data.readUInt32LE(offset); offset += 4;

  const proofs: MerkleProof[] = [];
  for (let p = 0; p < proofCount; p++) {
    const leafIndex = data.readUInt32LE(offset); offset += 4;
    const leafHash = data.subarray(offset, offset + 32); offset += 32;
    const sibCount = data.readUInt32LE(offset); offset += 4;

    const siblings: Array<{ hash: Buffer; position: "left" | "right" }> = [];
    for (let s = 0; s < sibCount; s++) {
      const pos = data.readUInt8(offset) === 0 ? "left" as const : "right" as const; offset += 1;
      const hash = Buffer.from(data.subarray(offset, offset + 32)); offset += 32;
      siblings.push({ hash, position: pos });
    }

    proofs.push({ leafHash: Buffer.from(leafHash), leafIndex, siblings, root: Buffer.from(root) });
  }

  return { version, root: Buffer.from(root), leafCount, proofs, rawLeaves: [] };
}
