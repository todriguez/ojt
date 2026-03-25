/**
 * schema.core.ts
 *
 * Semantic Kernel — Core Schema
 *
 * Vertical-agnostic core tables for the semantic runtime.
 * This is the universal layer — no domain-specific terminology.
 *
 * This schema mirrors the semantos 1KB cell object model:
 *   256-byte header → SemanticObject (identity, linearity, type hash, version)
 *   768-byte payload → ObjectState (versioned snapshots of semantic content)
 *   Patch cells → ObjectPatch (typed deltas between states)
 *   Capsule cells → Instrument (sealed, immutable artifacts)
 *   Binding layer → ObjectBinding (on-chain provenance)
 *
 * Three layers:
 *   A. Semantic Core — universal runtime (this file)
 *   B. Vertical Grammar — domain ontology, scoring dimensions, policies
 *   C. Vertical Projections — domain-specific convenience tables
 *
 * Core tables NEVER speak vertical slang. All business vernacular belongs
 * in vertical projection tables.
 */

import {
  pgTable,
  pgEnum,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Custom type for bytea (binary data) ─────────────────────────────────
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// A. SEMANTIC CORE — Universal Runtime
// ─────────────────────────────────────────────────────────────────────────────

// ═══ A.1 Enums ═══════════════════════════════════════════════════════════════

export const linearityEnum = pgEnum("sem_linearity", [
  "AFFINE",   // Mutable container (can be updated or discarded)
  "LINEAR",   // Single-use patch (consumed exactly once)
  "RELEVANT", // Immutable reference (can be read/copied freely)
]);

export const objectStatusEnum = pgEnum("sem_object_status", [
  "active",
  "archived",
  "spent",
  "tombstoned",
]);

export const patchKindEnum = pgEnum("sem_patch_kind", [
  "extraction",        // Message extraction merge
  "rescore",           // Scoring pipeline ran
  "manual_override",   // Human changed something
  "state_transition",  // Status changed (maps to jobStateEvents)
  "evidence_merge",    // New evidence incorporated
  "instrument_emit",   // Instrument generated
  "action",            // Operator/customer action
]);

export const instrumentStatusEnum = pgEnum("sem_instrument_status", [
  "generated",
  "presented",
  "accepted",
  "rejected",
  "superseded",
  "consumed",
  "expired",
]);

export const evidenceKindEnum = pgEnum("sem_evidence_kind", [
  "message",       // Customer/operator message
  "document",      // Uploaded file
  "observation",   // System observation
  "image",         // Photo/screenshot
  "voice",         // Voice message transcript
  "selection",     // Product/material selection decision
]);

export const participantRoleEnum = pgEnum("sem_participant_role", [
  "creator",       // Initiated the object (REA, homeowner)
  "contributor",   // Can add evidence/preferences (tenant)
  "approver",      // Must approve state transitions (landlord, budget holder)
  "observer",      // Can view but not modify (read-only stakeholder)
  "executor",      // Performs the work (operator/tradesperson)
]);

export const identityKindEnum = pgEnum("sem_identity_kind", [
  "customer",      // End customer (tenant, homeowner)
  "admin",         // Organisation admin
  "operator",      // Service provider (tradesperson)
  "external",      // External party (REA, landlord, supplier)
  "ai",            // AI assistant participant
]);

export const channelKindEnum = pgEnum("sem_channel_kind", [
  "participant_pair",  // 1:1 conversation (participant ↔ AI, or participant ↔ participant)
  "group",             // Multi-party channel (future)
  "system",            // System notifications channel
]);

export const outcomeDecisionEnum = pgEnum("sem_outcome_decision", [
  "followed_up",
  "evaluated",
  "committed",
  "inspected",
  "declined",
  "archived",
  "referred_out",
  "deferred",
  "let_expire",
]);

export const outcomeResultEnum = pgEnum("sem_outcome_result", [
  "completed",
  "disputed",
  "cancelled",
  "rejected",
  "evaluated_unresponsive",
  "diverted",
  "unresponsive",
  "not_pursued",
  "still_active",
]);

export const anchorStatusEnum = pgEnum("sem_anchor_status", [
  "none",
  "pending",
  "anchored",
  "failed",
]);

// ═══ A.2 SEMANTIC OBJECTS ═══════════════════════════════════════════════════
// The durable identity/header row. One per meaningful object in the system.
// This is the relational counterpart of the semantos 256-byte header.
//
// Core-agnostic: any durable semantic object across any vertical.
// The object itself is domain-agnostic — verticals interpret the payload.

export const semanticObjects = pgTable(
  "sem_objects",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),

    // ── Vertical routing ──
    vertical: varchar("vertical", { length: 50 }).notNull(), // "trades" | "brem" | ...
    objectKind: varchar("object_kind", { length: 50 }).notNull(), // "job" | "customer" | "site" | ...

    // ── Type system (the bridge) ──
    // TYPE-HASH = SHA256(vertical:objectKind:subtype)
    typeHash: varchar("type_hash", { length: 64 }).notNull(), // 64-char hex SHA256
    typePath: varchar("type_path", { length: 255 }), // human-readable: "trades.job.carpentry.hire"

    // ── Linearity (usage semantics from semantos) ──
    linearity: linearityEnum("linearity").notNull().default("AFFINE"),

    // ── Version anchor ──
    currentVersion: integer("current_version").notNull().default(1),
    currentStateHash: varchar("current_state_hash", { length: 64 }).notNull().default(""),

    // ── Flags (mirrors header flags field) ──
    flags: integer("flags").notNull().default(0), // bitfield: 0x01=immutable, 0x02=spent
    status: objectStatusEnum("status").notNull().default("active"),

    // ── External identity (for per-instance objects like jobs) ──
    // When provided, lookup uses (typeHash, externalId) instead of typeHash alone.
    // Null for singleton objects (type registries, policies) that are shared by type.
    externalId: varchar("external_id", { length: 255 }),

    // ── Ownership ──
    ownerId: text("owner_id"), // user ID, operator ID, org ID
    createdBy: text("created_by"), // who/what created this object

    // ── On-chain anchoring ──
    anchorStatus: anchorStatusEnum("anchor_status").notNull().default("none"),
    onChainTxid: varchar("on_chain_txid", { length: 64 }),
    merkleRoot: varchar("merkle_root", { length: 64 }),

    // ── Timestamps ──
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_objects_vertical_kind_idx").on(table.vertical, table.objectKind),
    index("sem_objects_type_hash_idx").on(table.typeHash),
    index("sem_objects_type_hash_external_idx").on(table.typeHash, table.externalId),
    index("sem_objects_state_hash_idx").on(table.currentStateHash),
    index("sem_objects_owner_idx").on(table.ownerId),
    index("sem_objects_status_idx").on(table.status),
    index("sem_objects_anchor_status_idx").on(table.anchorStatus),
  ]
);

// ═══ A.3 OBJECT STATES ═══════════════════════════════════════════════════════
// Immutable versioned snapshots. Each row is "what the object meant at version N".
// This is the Container cell's payload serialized.
// The payload is opaque JSONB at this layer. Verticals define its shape.

export const objectStates = pgTable(
  "sem_object_states",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Version chain ──
    version: integer("version").notNull(),
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    prevStateHash: varchar("prev_state_hash", { length: 64 }).notNull().default(""),

    // ── Payload (the semantic content) ──
    // IMPORTANT: Treat as typed IR, not arbitrary blob.
    //   - Serializers must be deterministic (same state → same bytes → same hash)
    //   - Schema changes require irVersion bump
    payload: jsonb("payload").notNull(), // JSONB: the full state at this version
    payloadSize: integer("payload_size").notNull().default(0),
    irVersion: integer("ir_version").notNull().default(1), // IR schema version

    // ── Provenance ──
    source: varchar("source", { length: 100 }), // "extraction", "merge", "manual"
    createdBy: text("created_by"),
    compilerVersion: varchar("compiler_version", { length: 50 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sem_object_states_version_uniq").on(table.objectId, table.version),
    index("sem_object_states_object_idx").on(table.objectId),
    index("sem_object_states_hash_idx").on(table.stateHash),
  ]
);

// ═══ A.4 OBJECT PATCHES ═════════════════════════════════════════════════════
// Typed deltas between states. Each row records what changed and why.
// This is the Patch cell (LINEAR: consumed exactly once).

export const objectPatches = pgTable(
  "sem_object_patches",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Version transition ──
    fromVersion: integer("from_version").notNull(),
    toVersion: integer("to_version").notNull(),
    prevStateHash: varchar("prev_state_hash", { length: 64 }).notNull(),
    newStateHash: varchar("new_state_hash", { length: 64 }).notNull(),

    // ── Delta content ──
    patchKind: patchKindEnum("patch_kind").notNull(),
    delta: jsonb("delta").notNull(), // { field: { from, to } }
    deltaCount: integer("delta_count").notNull().default(0),

    // ── Provenance ──
    source: text("source").notNull(), // "message:uuid", "user:manual", "system:scoring"
    evidenceRef: text("evidence_ref"), // link to evidence that triggered this
    authorObjectId: text("author_object_id"), // if another semantic object authored this

    // ── Artifact-level linearity ──
    linearity: linearityEnum("linearity").notNull().default("LINEAR"),
    consumed: boolean("consumed").notNull().default(true),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_patches_object_idx").on(table.objectId),
    index("sem_patches_kind_idx").on(table.patchKind),
    index("sem_patches_new_hash_idx").on(table.newStateHash),
  ]
);

// ═══ A.5 OBJECT BINDINGS ═════════════════════════════════════════════════════
// On-chain provenance and immutability markers.
// Not every object gets bound. When it does, this row records the anchoring.

export const objectBindings = pgTable(
  "sem_object_bindings",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── On-chain reference ──
    txid: varchar("txid", { length: 64 }),
    vout: integer("vout"),
    bumpHash: varchar("bump_hash", { length: 64 }),
    derivationIndex: integer("derivation_index"),

    // ── Binding state ──
    isOnChain: boolean("is_on_chain").notNull().default(false),
    isImmutable: boolean("is_immutable").notNull().default(false),
    isSpent: boolean("is_spent").notNull().default(false),

    // ── Which state version was bound ──
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    stateVersion: integer("state_version").notNull(),

    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_bindings_object_idx").on(table.objectId),
    index("sem_bindings_txid_idx").on(table.txid),
    index("sem_bindings_hash_idx").on(table.stateHash),
  ]
);

// ═══ A.6 OBJECT EDGES ═══════════════════════════════════════════════════════
// Relationships between semantic objects. First-class, typed, directional.

export const objectEdges = pgTable(
  "sem_object_edges",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    fromObjectId: text("from_object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),
    toObjectId: text("to_object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Edge semantics ──
    edgeType: varchar("edge_type", { length: 50 }).notNull(), // "produces" | "references" | "owns" | ...
    edgePayload: jsonb("edge_payload"), // optional metadata

    // ── Edge as object (provision for high-value edges) ──
    edgeObjectId: text("edge_object_id"), // optional: the SemanticObject that IS this edge

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_edges_from_idx").on(table.fromObjectId),
    index("sem_edges_to_idx").on(table.toObjectId),
    index("sem_edges_type_idx").on(table.edgeType),
  ]
);

// ═══ A.7 OBJECT SCORES ═══════════════════════════════════════════════════════
// Deterministic evaluated outputs. The optimiser's result.

export const objectScores = pgTable(
  "sem_object_scores",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Which state was scored ──
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    stateId: text("state_id"),

    // ── Policy and compiler version ──
    policyVersion: varchar("policy_version", { length: 50 }),
    compilerVersion: varchar("compiler_version", { length: 50 }),
    grammarVersion: varchar("grammar_version", { length: 50 }),
    classifierVersion: varchar("classifier_version", { length: 50 }),

    // ── Score content ──
    scoreKind: varchar("score_kind", { length: 50 }).notNull(), // domain-agnostic score type
    scorePayload: jsonb("score_payload").notNull(), // vertical-specific score structure

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_scores_object_idx").on(table.objectId),
    index("sem_scores_hash_idx").on(table.stateHash),
    index("sem_scores_kind_idx").on(table.scoreKind),
  ]
);

// ═══ A.8 POLICIES ═══════════════════════════════════════════════════════════
// Versioned rule bundles. The governance layer.

export const policies = pgTable(
  "sem_policies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    vertical: varchar("vertical", { length: 50 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    version: integer("version").notNull(),

    // ── Rule content ──
    policyPayload: jsonb("policy_payload").notNull(),
    description: text("description"),

    // ── Governance ──
    isActive: boolean("is_active").notNull().default(true),
    tuningLocked: boolean("tuning_locked").notNull().default(false),
    tunedFromVersion: integer("tuned_from_version"),

    createdBy: varchar("created_by", { length: 100 }),
    changeNotes: text("change_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sem_policies_uniq").on(table.vertical, table.name, table.version),
    index("sem_policies_active_idx").on(table.vertical, table.isActive),
  ]
);

// ═══ A.9 INSTRUMENTS ═════════════════════════════════════════════════════════
// Generated actionable artifacts. The codegen output.
// Capsules in semantos terms (RELEVANT: can be referenced; LINEAR when consumed).

export const semInstruments = pgTable(
  "sem_instruments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Which state produced this ──
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    stateId: text("state_id"),

    // ── Instrument identity ──
    instrumentType: varchar("instrument_type", { length: 50 }).notNull(), // domain-agnostic
    instrumentPath: varchar("instrument_path", { length: 255 }), // human-readable path

    // ── Content ──
    payload: jsonb("payload").notNull(),
    filePath: text("file_path"),

    // ── Artifact-level linearity ──
    linearity: linearityEnum("linearity").notNull().default("RELEVANT"),

    // ── Lifecycle ──
    status: instrumentStatusEnum("status").notNull().default("generated"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_instruments_object_idx").on(table.objectId),
    index("sem_instruments_type_idx").on(table.instrumentType),
    index("sem_instruments_status_idx").on(table.status),
  ]
);

// ═══ A.10 OUTCOMES ═══════════════════════════════════════════════════════════
// What actually happened. The diagnostics/PGO feedback loop.

export const outcomes = pgTable(
  "sem_outcomes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── System's assessment at decision time ──
    policyVersion: varchar("policy_version", { length: 50 }),
    systemSnapshot: jsonb("system_snapshot"), // scores/recommendation when decision was made

    // ── What actually happened ──
    humanDecision: outcomeDecisionEnum("human_decision"),
    actualOutcome: outcomeResultEnum("actual_outcome"),
    outcomeValue: integer("outcome_value"), // cents

    // ── Diagnostic classification ──
    missType: varchar("miss_type", { length: 50 }), // "TP" | "TN" | "FP" | "FN"
    wasSystemCorrect: boolean("was_system_correct"),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("sem_outcomes_object_idx").on(table.objectId),
    index("sem_outcomes_miss_idx").on(table.missType),
  ]
);

// ═══ A.11 EVIDENCE ITEMS ═════════════════════════════════════════════════════
// Source material. The lexer input store.
// Messages, uploads, observations — anything that feeds into the semantic parser.

export const evidenceItems = pgTable(
  "sem_evidence_items",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Evidence identity ──
    evidenceKind: evidenceKindEnum("evidence_kind").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata"),

    // ── Source ──
    sourceRef: text("source_ref").notNull(), // message UUID, filename, channel
    confidence: real("confidence").notNull().default(0.5),

    // ── Channel attribution (which conversation channel produced this evidence) ──
    channelId: text("channel_id"), // FK → sem_channels.id (nullable for backward compat)

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_evidence_object_idx").on(table.objectId),
    index("sem_evidence_kind_idx").on(table.evidenceKind),
    index("sem_evidence_channel_idx").on(table.channelId),
  ]
);

// ═══ A.12 SEMANTIC CELLS ═════════════════════════════════════════════════════
// Packed 1KB cells for the binary layer. The bridge to Forth/on-chain.

export const semanticCells = pgTable(
  "sem_cells",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull(),

    // ── Cell identity ──
    cellHash: varchar("cell_hash", { length: 64 }).notNull().unique(),
    linearity: linearityEnum("linearity").notNull(),

    // ── Sequence info ──
    cellIndex: integer("cell_index").notNull().default(0),
    continuationCount: integer("continuation_count").notNull().default(0),
    rootCellId: text("root_cell_id"),

    // ── State chain ──
    typeHash: varchar("type_hash", { length: 64 }).notNull(),
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    prevStateHash: varchar("prev_state_hash", { length: 64 }).notNull().default(""),

    // ── Version ──
    version: integer("version").notNull().default(1),
    schemaVersion: integer("schema_version").notNull().default(1),

    // ── Raw binary ──
    rawHeader: bytea("raw_header").notNull(),   // 256 bytes
    rawPayload: bytea("raw_payload").notNull(), // 768 bytes (padded)
    payloadSize: integer("payload_size").notNull(),

    // ── Metadata ──
    format: varchar("format", { length: 20 }).notNull().default("json-gzip"),
    flags: integer("flags").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_cells_object_idx").on(table.objectId),
    index("sem_cells_state_hash_idx").on(table.stateHash),
    index("sem_cells_type_hash_idx").on(table.typeHash),
    index("sem_cells_root_idx").on(table.rootCellId),
    index("sem_cells_linearity_idx").on(table.linearity),
  ]
);

// ═══ A.13 TAXONOMIES ═════════════════════════════════════════════════════════
// Type trees per vertical. Domain-specific classification hierarchy.

export const taxonomies = pgTable(
  "sem_taxonomies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    vertical: varchar("vertical", { length: 50 }).notNull(),
    dimension: varchar("dimension", { length: 50 }).notNull(), // "what" | "how" | "instrument"
    path: varchar("path", { length: 255 }).notNull(),
    parentPath: varchar("parent_path", { length: 255 }),

    // ── Node attributes ──
    attributes: jsonb("attributes"),
    keywords: jsonb("keywords").$type<string[]>().default([]),
    rules: jsonb("rules"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sem_taxonomies_uniq").on(table.vertical, table.dimension, table.path),
    index("sem_taxonomies_vertical_dim_idx").on(table.vertical, table.dimension),
  ]
);

// ═══ A.14 CLASSIFICATIONS ═════════════════════════════════════════════════════

export const classifications = pgTable(
  "sem_classifications",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull(),

    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    classPayload: jsonb("class_payload").notNull(),
    typeHash: varchar("type_hash", { length: 64 }).notNull(),
    confidence: real("confidence").notNull().default(0.5),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_class_object_idx").on(table.objectId),
    index("sem_class_type_hash_idx").on(table.typeHash),
  ]
);

// ═══ A.15 DIAGNOSTIC EVENTS ═════════════════════════════════════════════════

export const diagnosticEvents = pgTable(
  "sem_diagnostic_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull(),

    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    eventKind: varchar("event_kind", { length: 50 }).notNull(),
    payload: jsonb("payload").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_diag_object_idx").on(table.objectId),
    index("sem_diag_kind_idx").on(table.eventKind),
  ]
);

// ═══ A.16 PENDING WRITES ════════════════════════════════════════════════════
// Dead-letter queue for failed writes. Stores failed adapter function calls
// with their full payload for replay during recovery.

export const pendingWrites = pgTable(
  "sem_pending_writes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Write identity ──
    writeKind: varchar("write_kind", { length: 50 }).notNull(), // adapter function name
    payload: jsonb("payload").notNull(), // full arguments to replay

    // ── Retry tracking ──
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // "pending" | "retrying" | "completed" | "dead"
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),

    // ── Lifecycle ──
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("sem_pending_writes_object_idx").on(table.objectId),
    index("sem_pending_writes_status_idx").on(table.status),
    index("sem_pending_writes_retry_idx").on(table.nextRetryAt),
  ]
);

// ═══ A.17 ANCHOR REQUESTS ═══════════════════════════════════════════════════
// Two-phase commit protocol for on-chain anchoring.
// Manages the lifecycle of anchoring from request through broadcast to confirmation.

export const anchorRequests = pgTable(
  "sem_anchor_requests",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Object state being anchored ──
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    stateVersion: integer("state_version").notNull(),
    cellId: text("cell_id"), // reference to semanticCells if applicable

    // ── Anchor semantics ──
    anchorKind: varchar("anchor_kind", { length: 50 }).notNull(), // "milestone" | "settlement" | "proof"

    // ── Anchor lifecycle ──
    status: varchar("status", { length: 30 }).notNull().default("pending"), // "pending" | "broadcasting" | "confirming" | "anchored" | "failed"

    // ── On-chain reference ──
    txid: varchar("txid", { length: 64 }),
    vout: integer("vout"),
    merkleRoot: varchar("merkle_root", { length: 64 }),

    // ── BEEF envelope (if using BSV BEEF format) ──
    beefEnvelope: bytea("beef_envelope"),

    // ── Error handling ──
    errorMessage: text("error_message"),

    // ── Timestamps ──
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    broadcastAt: timestamp("broadcast_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    index("sem_anchor_requests_object_idx").on(table.objectId),
    index("sem_anchor_requests_status_idx").on(table.status),
    index("sem_anchor_requests_hash_idx").on(table.stateHash),
  ]
);

// ═══ A.18 PARTICIPANTS ═══════════════════════════════════════════════════════
// Who is involved in a semantic object. Universal identity model.
// Maps to Plexus identity nodes when integrated.

export const participants = pgTable(
  "sem_participants",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Identity (generic — maps to customerId, adminEmail, or Plexus certId) ──
    identityRef: text("identity_ref").notNull(),         // "customer:<uuid>" | "admin:<email>" | "plexus:<certId>"
    identityKind: identityKindEnum("identity_kind").notNull(),
    participantRole: participantRoleEnum("participant_role").notNull(),

    // ── Display ──
    displayName: varchar("display_name", { length: 255 }),

    // ── Lifecycle ──
    invitedBy: text("invited_by"),                       // identityRef of whoever added this participant
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_participants_object_idx").on(table.objectId),
    index("sem_participants_identity_idx").on(table.identityRef),
    uniqueIndex("sem_participants_uniq").on(table.objectId, table.identityRef),
  ]
);

// ═══ A.19 CHANNELS ══════════════════════════════════════════════════════════
// Conversation threads between participants on a semantic object.
// Each channel is a private evidence stream with its own message history.

export const channels = pgTable(
  "sem_channels",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Channel identity ──
    channelKind: channelKindEnum("channel_kind").notNull(),
    label: varchar("label", { length: 100 }),            // "Tenant ↔ AI", "REA ↔ Landlord"

    // ── Participant set ──
    participantIds: jsonb("participant_ids").notNull().$type<string[]>(), // sem_participants.id[]

    // ── Edge linkage — a channel IS a relationship ──
    edgeId: text("edge_id"),                             // FK → sem_object_edges.id

    // ── Lifecycle ──
    isActive: boolean("is_active").notNull().default(true),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_channels_object_idx").on(table.objectId),
    index("sem_channels_active_idx").on(table.objectId, table.isActive),
  ]
);

// ═══ A.20 ACCESS POLICIES ═══════════════════════════════════════════════════
// Versioned access rules governing participant visibility and contribution rights.
// Follows the scoring_policies pattern: immutable, versioned, auditable.

export const accessPolicies = pgTable(
  "sem_access_policies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    vertical: varchar("vertical", { length: 50 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    version: integer("version").notNull(),

    // ── Policy content ──
    roleRules: jsonb("role_rules").notNull(),             // per-role field visibility + contribution rights
    overrideHierarchy: jsonb("override_hierarchy").notNull(), // who outranks whom
    aiContextFilter: jsonb("ai_context_filter").notNull(),   // what the AI sees per role

    // ── Template vs instance ──
    isTemplate: boolean("is_template").notNull().default(true),
    sourceTemplateId: text("source_template_id"),

    // ── Governance ──
    isActive: boolean("is_active").notNull().default(true),
    tuningLocked: boolean("tuning_locked").notNull().default(false),
    tunedFromVersion: integer("tuned_from_version"),
    createdBy: varchar("created_by", { length: 100 }),
    changeNotes: text("change_notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sem_access_policies_uniq").on(table.vertical, table.name, table.version),
    index("sem_access_policies_active_idx").on(table.vertical, table.isActive),
  ]
);

// ═══ A.21 CHANNEL POLICIES ══════════════════════════════════════════════════
// Junction: links a channel + participant to their governing access policy.
// Supports sparse per-participant overrides on top of the template.

export const channelPolicies = pgTable(
  "sem_channel_policies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id").notNull(),              // FK → sem_channels.id
    policyId: text("policy_id").notNull(),                // FK → sem_access_policies.id
    participantId: text("participant_id").notNull(),       // FK → sem_participants.id

    // ── Per-participant overrides (sparse — only what differs from template) ──
    fieldOverrides: jsonb("field_overrides"),             // { "estimateCost": "visible" }

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sem_channel_policies_uniq").on(table.channelId, table.participantId),
    index("sem_channel_policies_channel_idx").on(table.channelId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// RELATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const semanticObjectsRelations = relations(semanticObjects, ({ many, one }) => ({
  states: many(objectStates),
  patches: many(objectPatches),
  bindings: many(objectBindings),
  edgesFrom: many(objectEdges, { relationName: "edgeFrom" }),
  edgesTo: many(objectEdges, { relationName: "edgeTo" }),
  scores: many(objectScores),
  instruments: many(semInstruments),
  outcomes: many(outcomes),
  evidence: many(evidenceItems),
  pendingWrites: many(pendingWrites),
  anchorRequests: many(anchorRequests),
  participants: many(participants),
  channels: many(channels),
}));

export const objectStatesRelations = relations(objectStates, ({ one }) => ({
  object: one(semanticObjects, { fields: [objectStates.objectId], references: [semanticObjects.id] }),
}));

export const objectPatchesRelations = relations(objectPatches, ({ one }) => ({
  object: one(semanticObjects, { fields: [objectPatches.objectId], references: [semanticObjects.id] }),
}));

export const objectBindingsRelations = relations(objectBindings, ({ one }) => ({
  object: one(semanticObjects, { fields: [objectBindings.objectId], references: [semanticObjects.id] }),
}));

export const objectEdgesRelations = relations(objectEdges, ({ one }) => ({
  fromObject: one(semanticObjects, { fields: [objectEdges.fromObjectId], references: [semanticObjects.id], relationName: "edgeFrom" }),
  toObject: one(semanticObjects, { fields: [objectEdges.toObjectId], references: [semanticObjects.id], relationName: "edgeTo" }),
}));

export const objectScoresRelations = relations(objectScores, ({ one }) => ({
  object: one(semanticObjects, { fields: [objectScores.objectId], references: [semanticObjects.id] }),
}));

export const semInstrumentsRelations = relations(semInstruments, ({ one }) => ({
  object: one(semanticObjects, { fields: [semInstruments.objectId], references: [semanticObjects.id] }),
}));

export const outcomesRelations = relations(outcomes, ({ one }) => ({
  object: one(semanticObjects, { fields: [outcomes.objectId], references: [semanticObjects.id] }),
}));

export const evidenceItemsRelations = relations(evidenceItems, ({ one }) => ({
  object: one(semanticObjects, { fields: [evidenceItems.objectId], references: [semanticObjects.id] }),
}));

export const pendingWritesRelations = relations(pendingWrites, ({ one }) => ({
  object: one(semanticObjects, { fields: [pendingWrites.objectId], references: [semanticObjects.id] }),
}));

export const anchorRequestsRelations = relations(anchorRequests, ({ one }) => ({
  object: one(semanticObjects, { fields: [anchorRequests.objectId], references: [semanticObjects.id] }),
}));

export const participantsRelations = relations(participants, ({ one }) => ({
  object: one(semanticObjects, { fields: [participants.objectId], references: [semanticObjects.id] }),
}));

export const channelsRelations = relations(channels, ({ one }) => ({
  object: one(semanticObjects, { fields: [channels.objectId], references: [semanticObjects.id] }),
}));
