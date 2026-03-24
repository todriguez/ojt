/**
 * index.ts
 *
 * Semantos Kernel — Main Barrel Export
 *
 * Exports all semantic kernel components:
 *   - Core schema (universal runtime tables)
 *   - Base adapter (vertical-agnostic operations)
 *   - Merkle envelope (state chain proof structure)
 *   - Cell packer (structured multi-cell packing with LIFO ordering)
 *   - Type hash registry (bridge to type system)
 *   - Verticals (domain-specific implementations)
 */

// Core
export * from "./schema.core";
export * from "./adapter.base";
export * from "./merkleEnvelope";
export * from "./cellPacker";

// Type hash registry (re-export from original location during transition)
export * from "../domain/bridge/typeHashRegistry";

// Verticals
export * as trades from "./verticals/trades";
