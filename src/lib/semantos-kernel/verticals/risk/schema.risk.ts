/**
 * schema.risk.ts
 *
 * Vertical Grammar — Blockchain Risk Assessment Domain
 *
 * Risk-assessment-specific projection tables for semantic objects.
 * Maps the BREM 9-cell matrix (3×3: Network × System State × Law)
 * onto the universal semantic core.
 *
 * Tables:
 *   - riskProjects: Assessed blockchain project with 9-cell scores
 *   - riskCellStates: Per-cell evidence chain and branch paths
 *   - riskMitigations: Prioritised de-risking instruments
 *   - riskChallenges: Score challenge/rebuttal audit trail
 */

import {
  pgTable,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { semanticObjects } from "../../schema.core";

// ═══ R.1 Risk PROJECTS ══════════════════════════════════════════════════════
// Blockchain project assessment as a semantic object — the main entity.
// The 9-cell scores are denormalized here for fast reads; canonical
// cell-level evidence lives in riskCellStates.

export const riskProjects = pgTable(
  "sem_risk_projects",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    objectId: text("object_id").notNull().unique(),

    // ── Link to existing BREM tables (dual-write during migration) ──
    legacyProjectId: text("legacy_project_id"), // Prisma Project.id from brem-agent

    // ── Project classification ──
    projectName: varchar("project_name", { length: 255 }).notNull(),
    organization: varchar("organization", { length: 255 }),
    segment: varchar("segment", { length: 50 }),         // "enterprise" | "defi" | "nft" | ...
    category: varchar("category", { length: 100 }),       // "payments" | "supply_chain" | ...
    region: varchar("region", { length: 50 }),
    protocolFamily: varchar("protocol_family", { length: 50 }),  // "stellar" | "ethereum" | "bsv" | ...
    permissionModel: varchar("permission_model", { length: 30 }), // "permissionless" | "permissioned" | "hybrid"
    consensusFamily: varchar("consensus_family", { length: 50 }),
    architectureType: varchar("architecture_type", { length: 50 }),
    governanceType: varchar("governance_type", { length: 50 }),
    threatModel: varchar("threat_model", { length: 30 }),  // "COOPERATIVE" | "ADVERSARIAL" | "HYBRID"

    // ── The 9-cell score vector ──
    naScore: integer("na_score"),  // Architecture (0–4)
    ncScore: integer("nc_score"),  // Consensus
    nsScore: integer("ns_score"),  // Scalability
    seScore: integer("se_score"),  // Execution
    smScore: integer("sm_score"),  // Mutation Authority — THE DIAGNOSTIC VARIABLE
    sfScore: integer("sf_score"),  // Economic Fitness
    lsScore: integer("ls_score"),  // Legal Standing
    lrScore: integer("lr_score"),  // Remedy
    lpScore: integer("lp_score"),  // Liability Precision

    // ── Domain aggregates ──
    networkDomain: real("network_domain"),        // mean(na, nc, ns)
    systemStateDomain: real("system_state_domain"), // mean(se, sm, sf)
    lawDomain: real("law_domain"),                // mean(ls, lr, lp)

    // ── Overall scoring ──
    overallScore: real("overall_score"),
    asymmetricScore: real("asymmetric_score"),     // weighted score (high cells amplified)
    riskBand: varchar("risk_band", { length: 20 }), // "LOW" | "MODERATE" | "HIGH" | "CRITICAL"
    riskLevel: varchar("risk_level", { length: 20 }), // "low" | "moderate" | "elevated" | "critical"

    // ── Threshold analysis ──
    aboveThreshold: boolean("above_threshold").default(false),      // overall >= 2.5
    domainCeilingTriggered: boolean("domain_ceiling_triggered").default(false), // any domain > 3.0
    flagged: boolean("flagged").default(false),                      // above_threshold OR domain_ceiling
    smZone: varchar("sm_zone", { length: 10 }),                      // "safe" | "caution" | "danger"

    // ── Discretion cluster analysis ──
    discretionClusterCount: integer("discretion_cluster_count").default(0), // how many cluster cells >= 3
    discretionClusterCells: jsonb("discretion_cluster_cells"),  // ["sm", "nc", ...] cells >= 3

    // ── Multi-platform ──
    isMultiPlatform: boolean("is_multi_platform").default(false),
    platformCount: integer("platform_count").default(1),
    smEffective: integer("sm_effective"),  // sm_base + ceil(log2(N)) for multi-platform

    // ── Investment context ──
    investmentUsd: real("investment_usd"),
    valueAtRiskUsd: real("value_at_risk_usd"),

    // ── State ──
    scoredCellCount: integer("scored_cell_count").default(0),
    assessmentStatus: varchar("assessment_status", { length: 20 }).notNull().default("in_progress"),
    // "in_progress" | "gated" | "scored" | "challenged" | "finalized"

    // ── Compiler metadata ──
    stateHash: varchar("state_hash", { length: 64 }),
    prevStateHash: varchar("prev_state_hash", { length: 64 }),
    mergeCount: integer("merge_count").default(0),
    version: integer("version").default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_risk_projects_object_idx").on(table.objectId),
    index("sem_risk_projects_legacy_idx").on(table.legacyProjectId),
    index("sem_risk_projects_sm_zone_idx").on(table.smZone),
    index("sem_risk_projects_flagged_idx").on(table.flagged),
    index("sem_risk_projects_risk_level_idx").on(table.riskLevel),
    index("sem_risk_projects_protocol_idx").on(table.protocolFamily),
    index("sem_risk_projects_status_idx").on(table.assessmentStatus),
  ]
);

// ═══ R.2 Risk CELL STATES ═══════════════════════════════════════════════════
// Per-cell evidence chain, branch path, and scoring history.
// One row per cell per project. Updated on each merge/re-score.

export const riskCellStates = pgTable(
  "sem_risk_cell_states",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectObjectId: text("project_object_id").notNull(),

    // ── Cell identity ──
    cellKey: varchar("cell_key", { length: 2 }).notNull(),  // "na", "nc", etc.
    domain: varchar("domain", { length: 20 }).notNull(),     // "network" | "systemState" | "law"
    sppRole: varchar("spp_role", { length: 15 }).notNull(),  // "structure" | "process" | "persistence"

    // ── Score ──
    score: integer("score"),  // 0–4
    scored: boolean("scored").default(false),

    // ── Branch path (decision tree audit) ──
    branchPathString: text("branch_path_string"),    // "Q1=shared_state → Q2=single_layer → Score=2"
    q1Answer: varchar("q1_answer", { length: 100 }),

    // ── Evidence chain ──
    evidence: jsonb("evidence"),  // EvidenceItem[] — text, source, sourceRef, confidence
    reasoning: text("reasoning"),

    // ── De-risking ──
    deRiskActions: jsonb("de_risk_actions"),  // string[]

    // ── Scoring method ──
    scoringMethod: varchar("scoring_method", { length: 30 }),
    // "systematic-with-review" | "expert-scored" | "agent-scored" | "dataset" | "unscored"

    // ── Versioning ──
    version: integer("version").default(0),
    firstScoredAt: timestamp("first_scored_at", { withTimezone: true }),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
  },
  (table) => [
    index("sem_risk_cells_project_idx").on(table.projectObjectId),
    index("sem_risk_cells_key_idx").on(table.projectObjectId, table.cellKey),
    index("sem_risk_cells_score_idx").on(table.cellKey, table.score),
  ]
);

// ═══ R.3 Risk MITIGATIONS ═══════════════════════════════════════════════════
// Typed de-risking instruments generated by the compiler.
// Each mitigation targets a specific cell and has impact/effort metadata.

export const riskMitigations = pgTable(
  "sem_risk_mitigations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectObjectId: text("project_object_id").notNull(),

    // ── Target ──
    cellKey: varchar("cell_key", { length: 2 }).notNull(),
    domain: varchar("domain", { length: 20 }).notNull(),

    // ── Instrument ──
    category: varchar("category", { length: 50 }).notNull(),
    // "governance_reform" | "architecture_simplification" | "legal_restructure" | ...
    actionSlug: varchar("action_slug", { length: 100 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description").notNull(),
    rationale: text("rationale"),

    // ── Impact ──
    impact: jsonb("impact"),  // { cellKey: string, from: number, to: number }[]
    totalImpact: real("total_impact"),
    priority: real("priority"),

    // ── Effort ──
    effort: varchar("effort", { length: 20 }),  // "low" | "medium" | "high"
    timeline: varchar("timeline", { length: 30 }), // "1-month" | "3-months" | "6-months" | "12-months"
    dependencies: jsonb("dependencies"),  // string[]
    verification: jsonb("verification"),  // string[] — how to verify completion

    // ── Status ──
    status: varchar("status", { length: 20 }).notNull().default("recommended"),
    // "recommended" | "accepted" | "in_progress" | "completed" | "rejected"

    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    compilerVersion: integer("compiler_version").default(1),
  },
  (table) => [
    index("sem_risk_mitigations_project_idx").on(table.projectObjectId),
    index("sem_risk_mitigations_cell_idx").on(table.cellKey),
    index("sem_risk_mitigations_priority_idx").on(table.priority),
    index("sem_risk_mitigations_status_idx").on(table.status),
  ]
);

// ═══ R.4 Risk CHALLENGES ════════════════════════════════════════════════════
// Score challenge/rebuttal audit trail.
// Each challenge is a state transition on the semantic object.

export const riskChallenges = pgTable(
  "sem_risk_challenges",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectObjectId: text("project_object_id").notNull(),

    // ── What was challenged ──
    cellKey: varchar("cell_key", { length: 2 }).notNull(),
    originalScore: integer("original_score").notNull(),
    challengedScore: integer("challenged_score"),  // null if challenge was rejected

    // ── Evidence ──
    challengeReason: text("challenge_reason").notNull(),
    challengeEvidence: jsonb("challenge_evidence"),  // EvidenceItem[]
    rebuttal: text("rebuttal"),     // bot's response to the challenge

    // ── Outcome ──
    accepted: boolean("accepted").notNull(),
    stateHashBefore: varchar("state_hash_before", { length: 64 }),
    stateHashAfter: varchar("state_hash_after", { length: 64 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sem_risk_challenges_project_idx").on(table.projectObjectId),
    index("sem_risk_challenges_cell_idx").on(table.cellKey),
  ]
);

// ═══ R.5 Risk SELECTION GATES ═══════════════════════════════════════════════
// Typed decision checkpoints on BREM cells.
// A gate opens when evidence quality is insufficient after extraction or
// when a score change requires participant confirmation.
//
// Gate lifecycle (LINEAR — state can only advance, never revert):
//   opened → interrogating → confirmed | challenged | escalated
//
// Each gate is bound to:
//   - A cell (the score under review)
//   - A channel (the conversation that opened it)
//   - A participant (who must clear it)
//
// Multiple gates can be open simultaneously on different cells.
// A project cannot be "finalized" until all gates are cleared.

export const riskSelectionGates = pgTable(
  "sem_risk_selection_gates",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectObjectId: text("project_object_id").notNull(),

    // ── What is gated ──
    cellKey: varchar("cell_key", { length: 2 }).notNull(),  // "na", "nc", etc.
    scoreAtOpen: integer("score_at_open").notNull(),         // score when gate opened
    scoreAtClose: integer("score_at_close"),                 // score when gate closed (null if open)

    // ── Gate identity ──
    gateKind: varchar("gate_kind", { length: 30 }).notNull(),
    // "evidence_quality"  — weak evidence after extraction
    // "score_challenge"   — participant challenges existing score
    // "delegation"        — cell delegated to a contributor for de-risking
    // "escalation"        — reviewer escalated from a contributor's gate

    // ── Lifecycle ──
    status: varchar("status", { length: 20 }).notNull().default("opened"),
    // "opened"        — gate created, awaiting interrogation
    // "interrogating"  — active probing conversation underway
    // "confirmed"     — evidence reviewed, score accepted (up or down)
    // "challenged"    — new evidence changed the score
    // "escalated"     — contributor couldn't resolve, bumped to reviewer
    // "expired"       — auto-closed after timeout without resolution

    // ── Participants ──
    openedByParticipantId: text("opened_by_participant_id"),   // who/what opened the gate
    assignedToParticipantId: text("assigned_to_participant_id"), // who must clear it
    resolvedByParticipantId: text("resolved_by_participant_id"), // who actually cleared it

    // ── Channel attribution ──
    channelId: text("channel_id"),                             // conversation where gate was opened
    resolutionChannelId: text("resolution_channel_id"),        // conversation where gate was resolved

    // ── Evidence chain ──
    openReason: text("open_reason").notNull(),                 // why the gate was opened
    resolutionReason: text("resolution_reason"),               // why the gate was closed
    evidenceItemIds: jsonb("evidence_item_ids"),               // string[] — evidence submitted during interrogation
    interrogationQuestions: jsonb("interrogation_questions"),   // string[] — questions asked
    interrogationAnswers: jsonb("interrogation_answers"),       // string[] — answers received

    // ── Patch chain (LINEAR) ──
    stateHashAtOpen: varchar("state_hash_at_open", { length: 64 }),
    stateHashAtClose: varchar("state_hash_at_close", { length: 64 }),
    patchId: text("patch_id"),  // objectPatch that recorded this gate transition

    // ── Timestamps ──
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    interrogationStartedAt: timestamp("interrogation_started_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // optional TTL
  },
  (table) => [
    index("sem_risk_gates_project_idx").on(table.projectObjectId),
    index("sem_risk_gates_cell_idx").on(table.projectObjectId, table.cellKey),
    index("sem_risk_gates_status_idx").on(table.status),
    index("sem_risk_gates_assigned_idx").on(table.assignedToParticipantId),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// RELATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const riskProjectsRelations = relations(riskProjects, ({ one, many }) => ({
  object: one(semanticObjects, { fields: [riskProjects.objectId], references: [semanticObjects.id] }),
  cellStates: many(riskCellStates),
  mitigations: many(riskMitigations),
  challenges: many(riskChallenges),
  selectionGates: many(riskSelectionGates),
}));

export const riskCellStatesRelations = relations(riskCellStates, ({ one }) => ({
  project: one(riskProjects, { fields: [riskCellStates.projectObjectId], references: [riskProjects.objectId] }),
}));

export const riskMitigationsRelations = relations(riskMitigations, ({ one }) => ({
  project: one(riskProjects, { fields: [riskMitigations.projectObjectId], references: [riskProjects.objectId] }),
}));

export const riskChallengesRelations = relations(riskChallenges, ({ one }) => ({
  project: one(riskProjects, { fields: [riskChallenges.projectObjectId], references: [riskProjects.objectId] }),
}));

export const riskSelectionGatesRelations = relations(riskSelectionGates, ({ one }) => ({
  project: one(riskProjects, { fields: [riskSelectionGates.projectObjectId], references: [riskProjects.objectId] }),
}));
