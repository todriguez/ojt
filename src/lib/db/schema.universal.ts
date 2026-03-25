/**
 * schema.universal.ts
 *
 * Universal Semantic Runtime Schema — Drizzle ORM
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
 *   C. Vertical Projections — trades/services-specific convenience tables
 *
 * Core tables NEVER speak vertical slang. No "suburb", "job type", "effort band".
 * All business vernacular belongs in vertical projection tables.
 *
 * This file co-exists with the existing schema.ts. The two schemas can share
 * the same Neon database — the universal tables use a "sem_" prefix to avoid
 * collisions with existing Trades/Services tables during the migration period.
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

// ═══ A.2 SEMANTIC OBJECTS ═══════════════════════════════════════════════════
// The durable identity/header row. One per meaningful object in the system.
// This is the relational counterpart of the semantos 256-byte header.
//
// Trades/Services examples: a job, a customer interaction, a quote lifecycle.
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

    // ── Ownership ──
    ownerId: text("owner_id"), // user ID, operator ID, org ID
    createdBy: text("created_by"), // who/what created this object

    // ── Timestamps ──
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_objects_vertical_kind_idx").on(table.vertical, table.objectKind),
    index("sem_objects_type_hash_idx").on(table.typeHash),
    index("sem_objects_state_hash_idx").on(table.currentStateHash),
    index("sem_objects_owner_idx").on(table.ownerId),
    index("sem_objects_status_idx").on(table.status),
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
// Trades/Services: job→quote, customer→site, job→visit, quote→acceptance.

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
// Trades/Services: customerFitScore, quoteWorthinessScore, completenessScore, etc.

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
    scoreKind: varchar("score_kind", { length: 50 }).notNull(), // "trades-worthiness" | "trades-fit" | "trades-confidence"
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
// Trades/Services: ROM quotes, formal quotes, service agreements, invoices.

export const semInstruments = pgTable(
  "sem_instruments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().references(() => semanticObjects.id, { onDelete: "cascade" }),

    // ── Which state produced this ──
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    stateId: text("state_id"),

    // ── Instrument identity ──
    instrumentType: varchar("instrument_type", { length: 50 }).notNull(), // "rom-quote" | "formal-quote" | "service-agreement" | "invoice"
    instrumentPath: varchar("instrument_path", { length: 255 }), // "inst.quote.rom"

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

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_evidence_object_idx").on(table.objectId),
    index("sem_evidence_kind_idx").on(table.evidenceKind),
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

// ─────────────────────────────────────────────────────────────────────────────
// B. VERTICAL GRAMMAR — Domain Ontology
// ─────────────────────────────────────────────────────────────────────────────

// ═══ B.1 TAXONOMIES ══════════════════════════════════════════════════════════
// Type trees per vertical. Trades/Services: WHAT/HOW/INSTRUMENT taxonomy.

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

// ═══ B.2 CLASSIFICATIONS ═════════════════════════════════════════════════════

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

// ═══ B.3 DIAGNOSTIC EVENTS ═══════════════════════════════════════════════════

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

// ─────────────────────────────────────────────────────────────────────────────
// C. VERTICAL PROJECTIONS — Trades/Services (Odd Job Todd)
// ─────────────────────────────────────────────────────────────────────────────
// Domain-specific convenience tables. These are projections over the semantic
// core using Trades/Services business vocabulary.
//
// These tables exist for:
//   1. Fast denormalized reads (no JSONB unpacking for common queries)
//   2. Domain-specific indexes and constraints
//   3. UI/API convenience (the admin dashboard needs to sort by suburb, urgency, etc.)
//
// They reference SemanticObject as their anchor.

// ═══ C.1 Trades/Services JOB ════════════════════════════════════════════════════════════
// The Trades/Services-specific view of a semantic object (job/lead).
// Denormalizes the most-queried fields from AccumulatedJobState for dashboard speed.

export const tradesJobs = pgTable(
  "sem_trades_jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().unique(),

    // ── Link to existing Trades/Services tables (dual-write during migration) ──
    legacyJobId: text("legacy_job_id"), // UUID from existing `jobs` table

    // ── Customer / Site (denormalized for fast reads) ──
    customerId: text("customer_id"),
    customerName: varchar("customer_name", { length: 255 }),
    siteId: text("site_id"),
    suburb: varchar("suburb", { length: 100 }),
    postcode: varchar("postcode", { length: 10 }),

    // ── Job classification ──
    jobType: varchar("job_type", { length: 50 }),
    jobSubcategory: varchar("job_subcategory", { length: 100 }),
    categoryPath: varchar("category_path", { length: 255 }), // "services.trades.plumbing"
    txType: varchar("tx_type", { length: 50 }),                // "hire"
    instrumentType: varchar("instrument_type", { length: 100 }),

    // ── Status & urgency ──
    jobStatus: varchar("job_status", { length: 50 }).notNull().default("new_lead"),
    urgency: varchar("urgency", { length: 50 }).default("unspecified"),

    // ── Effort estimation ──
    effortBand: varchar("effort_band", { length: 20 }),
    estimatedCostMin: integer("estimated_cost_min"),
    estimatedCostMax: integer("estimated_cost_max"),

    // ── Scoring (denormalized from ObjectScore) ──
    customerFitScore: integer("customer_fit_score"),
    customerFitLabel: varchar("customer_fit_label", { length: 20 }),
    quoteWorthinessScore: integer("quote_worthiness_score"),
    quoteWorthinessLabel: varchar("quote_worthiness_label", { length: 20 }),
    confidenceScore: integer("confidence_score"),
    confidenceLabel: varchar("confidence_label", { length: 20 }),
    completenessScore: integer("completeness_score").default(0),
    recommendation: varchar("recommendation", { length: 30 }),
    recommendationReason: text("recommendation_reason"),

    // ── Flags ──
    suburbGroup: varchar("suburb_group", { length: 20 }),
    needsReview: boolean("needs_review").default(false),
    isRepeatCustomer: boolean("is_repeat_customer").default(false),
    repeatJobCount: integer("repeat_job_count").default(0),
    estimatePresented: boolean("estimate_presented").default(false),
    estimateAcknowledged: boolean("estimate_acknowledged").default(false),
    estimateAckStatus: varchar("estimate_ack_status", { length: 30 }).default("pending"),

    // ── Lead source ──
    leadSource: varchar("lead_source", { length: 30 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_trades_jobs_object_idx").on(table.objectId),
    index("sem_trades_jobs_legacy_idx").on(table.legacyJobId),
    index("sem_trades_jobs_status_idx").on(table.jobStatus),
    index("sem_trades_jobs_suburb_idx").on(table.suburb),
    index("sem_trades_jobs_recommendation_idx").on(table.recommendation),
    index("sem_trades_jobs_confidence_idx").on(table.confidenceScore),
    index("sem_trades_jobs_needs_review_idx").on(table.needsReview),
    index("sem_trades_jobs_category_idx").on(table.categoryPath),
  ]
);

// ═══ C.2 Trades/Services CUSTOMER ═══════════════════════════════════════════════════════
// Trades/Services customer as a semantic object.

export const tradesCustomers = pgTable(
  "sem_trades_customers",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().unique(),
    legacyCustomerId: text("legacy_customer_id"),

    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 255 }),
    preferredChannel: varchar("preferred_channel", { length: 20 }),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_trades_customers_object_idx").on(table.objectId),
    index("sem_trades_customers_legacy_idx").on(table.legacyCustomerId),
    index("sem_trades_customers_email_idx").on(table.email),
    index("sem_trades_customers_phone_idx").on(table.phone),
  ]
);

// ═══ C.3 Trades/Services SITE ════════════════════════════════════════════════════════════
// Physical location linked to a customer.

export const tradesSites = pgTable(
  "sem_trades_sites",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().unique(),
    legacySiteId: text("legacy_site_id"),
    customerObjectId: text("customer_object_id"), // links to customer's SemanticObject

    address: varchar("address", { length: 255 }),
    suburb: varchar("suburb", { length: 100 }),
    postcode: varchar("postcode", { length: 10 }),
    state: varchar("state", { length: 10 }).default("QLD"),
    lat: real("lat"),
    lng: real("lng"),
    accessNotes: text("access_notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_trades_sites_object_idx").on(table.objectId),
    index("sem_trades_sites_customer_idx").on(table.customerObjectId),
    index("sem_trades_sites_suburb_idx").on(table.suburb),
  ]
);

// ═══ C.4 Trades/Services VISIT ══════════════════════════════════════════════════════════
// Site visit linked to a job.

export const tradesVisits = pgTable(
  "sem_trades_visits",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().unique(),
    jobObjectId: text("job_object_id").notNull(), // links to job's SemanticObject

    visitType: varchar("visit_type", { length: 30 }).notNull(), // "inspection" | "quote_visit" | "scheduled_work" | "return_visit"
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    outcome: varchar("outcome", { length: 30 }), // "completed" | "partial" | "rescheduled" | ...
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_trades_visits_object_idx").on(table.objectId),
    index("sem_trades_visits_job_idx").on(table.jobObjectId),
    index("sem_trades_visits_scheduled_idx").on(table.scheduledStart),
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
  tradesJob: one(tradesJobs, { fields: [semanticObjects.id], references: [tradesJobs.objectId] }),
  tradesCustomer: one(tradesCustomers, { fields: [semanticObjects.id], references: [tradesCustomers.objectId] }),
  tradesSite: one(tradesSites, { fields: [semanticObjects.id], references: [tradesSites.objectId] }),
  tradesVisit: one(tradesVisits, { fields: [semanticObjects.id], references: [tradesVisits.objectId] }),
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

export const tradesJobsRelations = relations(tradesJobs, ({ one }) => ({
  object: one(semanticObjects, { fields: [tradesJobs.objectId], references: [semanticObjects.id] }),
}));

export const tradesCustomersRelations = relations(tradesCustomers, ({ one }) => ({
  object: one(semanticObjects, { fields: [tradesCustomers.objectId], references: [semanticObjects.id] }),
}));

export const tradesSitesRelations = relations(tradesSites, ({ one }) => ({
  object: one(semanticObjects, { fields: [tradesSites.objectId], references: [semanticObjects.id] }),
}));

export const tradesVisitsRelations = relations(tradesVisits, ({ one }) => ({
  object: one(semanticObjects, { fields: [tradesVisits.objectId], references: [semanticObjects.id] }),
}));
