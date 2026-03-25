import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────

export const organisationTypeEnum = pgEnum("organisation_type", [
  "sole_trader",
  "partnership",
  "company",
]);

export const operatorStatusEnum = pgEnum("operator_status", [
  "active",
  "inactive",
  "on_leave",
]);

export const contactChannelEnum = pgEnum("contact_channel", [
  "sms",
  "email",
  "phone",
  "whatsapp",
  "messenger",
  "webchat",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "new_lead",
  "partial_intake",
  "awaiting_customer",
  "ready_for_review",
  "estimate_presented",
  "estimate_accepted",
  "not_price_aligned",
  "not_a_fit",
  "needs_site_visit",
  "bookable",
  "scheduled",
  "in_progress",
  "hanging_weather",
  "hanging_parts",
  "return_visit_required",
  "complete",
  "invoice_pending",
  "invoiced",
  "paid",
  "archived",
]);

export const urgencyEnum = pgEnum("urgency", [
  "emergency",
  "urgent",
  "next_week",
  "next_2_weeks",
  "flexible",
  "when_convenient",
  "unspecified",
]);

export const effortBandEnum = pgEnum("effort_band", [
  "quick",
  "short",
  "quarter_day",
  "half_day",
  "full_day",
  "multi_day",
  "unknown",
]);

export const jobCategoryEnum = pgEnum("job_category", [
  "carpentry",
  "plumbing",
  "electrical",
  "painting",
  "general",
  "fencing",
  "tiling",
  "roofing",
  "doors_windows",
  "gardening",
  "cleaning",
  "other",
]);

// ── Universal Taxonomy ──────────────────────
export const categoryDimensionEnum = pgEnum("category_dimension", [
  "what",
  "how",
  "instrument",
]);

export interface CategoryAttribute {
  name: string;
  type: string;
  required: boolean;
  description: string;
  extractionHint?: string;
}

export const leadSourceEnum = pgEnum("lead_source", [
  "website_chat",
  "facebook",
  "instagram",
  "phone",
  "referral",
  "repeat",
  "walk_in",
  "agent_pdf",
  "other",
]);

export const senderTypeEnum = pgEnum("sender_type", [
  "customer",
  "operator",
  "system",
  "ai",
]);

export const messageTypeEnum = pgEnum("message_type", [
  "text",
  "voice",
  "image",
  "file",
  "system",
]);

export const estimateTypeEnum = pgEnum("estimate_type", [
  "auto_rom",
  "operator_rom",
  "formal_quote",
  "revised",
]);

export const visitTypeEnum = pgEnum("visit_type", [
  "inspection",
  "quote_visit",
  "scheduled_work",
  "return_visit",
  "emergency",
]);

export const visitOutcomeEnum = pgEnum("visit_outcome", [
  "completed",
  "partial",
  "rescheduled",
  "no_access",
  "cancelled",
]);

export const actorTypeEnum = pgEnum("actor_type", [
  "operator",
  "customer",
  "system",
  "ai",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "viewed",
  "partial",
  "paid",
  "overdue",
  "cancelled",
]);

export const recommendationEnum = pgEnum("recommendation", [
  "ignore",
  "only_if_nearby",
  "needs_site_visit",
  "probably_bookable",
  "worth_quoting",
  "priority_lead",
  "not_price_aligned",
  "not_a_fit",
]);

export const customerFitLabelEnum = pgEnum("customer_fit_label", [
  "poor_fit",
  "risky",
  "mixed",
  "good_fit",
  "strong_fit",
]);

export const quoteWorthinessLabelEnum = pgEnum("quote_worthiness_label", [
  "ignore",
  "only_if_convenient",
  "maybe_quote",
  "worth_quoting",
  "priority",
]);

export const confidenceLabelEnum = pgEnum("confidence_label", [
  "low",
  "medium",
  "high",
]);

export const suburbGroupEnum = pgEnum("suburb_group", [
  "core",
  "extended",
  "outside",
  "unknown",
]);

export const humanDecisionEnum = pgEnum("human_decision", [
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

export const actualOutcomeEnum = pgEnum("actual_outcome", [
  "completed",
  "disputed",
  "cancelled",
  "rejected",
  "evaluated_unresponsive",
  "inspected_declined",
  "inspected_committed",
  "diverted",
  "unresponsive",
  "not_pursued",
  "still_active",
]);

export const missTypeEnum = pgEnum("miss_type", [
  "false_negative",
  "false_positive",
  "underquoted_risk",
  "overestimated_friction",
  "customer_turned_painful",
  "not_worth_travel",
  "ideal_fill_job_missed",
  "site_visit_wasted",
  "good_repeat_misread",
  "scope_creep",
  "too_small_but_took_anyway",
  "good_customer_low_value",
  "schedule_gap_fill",
  "none",
]);

export const estimateAckStatusEnum = pgEnum("estimate_ack_status", [
  "pending",
  "accepted",
  "tentative",
  "pushback",
  "rejected",
  "wants_exact_price",
  "rate_shopping",
]);

// ─────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────

// ── Organisations ────────────────────────────

export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  type: organisationTypeEnum("type").notNull().default("sole_trader"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Operators ────────────────────────────────

export const operators = pgTable("operators", {
  id: uuid("id").primaryKey().defaultRandom(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  status: operatorStatusEnum("status").notNull().default("active"),
  capabilityTags: jsonb("capability_tags").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Customers ────────────────────────────────

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    name: varchar("name", { length: 255 }).notNull(),
    mobile: varchar("mobile", { length: 50 }),
    email: varchar("email", { length: 255 }),
    preferredContactChannel: contactChannelEnum("preferred_contact_channel"),
    mobileVerifiedAt: timestamp("mobile_verified_at", { withTimezone: true }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("customers_org_idx").on(table.organisationId),
    index("customers_email_idx").on(table.email),
    index("customers_mobile_idx").on(table.mobile),
  ]
);

// ── Sites ────────────────────────────────────

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    addressLine1: varchar("address_line_1", { length: 255 }),
    addressLine2: varchar("address_line_2", { length: 255 }),
    suburb: varchar("suburb", { length: 100 }),
    postcode: varchar("postcode", { length: 10 }),
    state: varchar("state", { length: 10 }).default("QLD"),
    lat: numeric("lat", { precision: 10, scale: 7 }),
    lng: numeric("lng", { precision: 10, scale: 7 }),
    accessNotes: text("access_notes"),
    siteNotes: text("site_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sites_customer_idx").on(table.customerId),
    index("sites_suburb_idx").on(table.suburb),
  ]
);

// ── Jobs ─────────────────────────────────────

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    customerId: uuid("customer_id").references(() => customers.id),
    siteId: uuid("site_id").references(() => sites.id),
    createdByOperatorId: uuid("created_by_operator_id").references(() => operators.id),
    assignedOperatorId: uuid("assigned_operator_id").references(() => operators.id),

    // Lead metadata
    leadSource: leadSourceEnum("lead_source").default("website_chat"),
    jobType: jobCategoryEnum("job_type").default("general"), // DEPRECATED: use categoryPath
    subcategory: varchar("subcategory", { length: 100 }),    // DEPRECATED: use categoryPath

    // Universal taxonomy columns
    categoryPath: varchar("category_path", { length: 255 }),  // e.g. "services.trades.plumbing"
    txType: varchar("tx_type", { length: 50 }),                // e.g. "hire"
    instrumentType: varchar("instrument_type", { length: 100 }), // e.g. "inst.contract.service-agreement"

    // Description
    descriptionRaw: text("description_raw"),
    descriptionSummary: text("description_summary"),

    // Status
    status: jobStatusEnum("status").notNull().default("new_lead"),
    urgency: urgencyEnum("urgency").default("unspecified"),

    // Qualification
    serviceAreaOk: boolean("service_area_ok"),
    customerFitScore: integer("customer_fit_score"), // 0-100
    quoteWorthinessScore: integer("quote_worthiness_score"), // 0-100

    // Effort estimation
    effortBand: effortBandEnum("effort_band"),
    estimatedHoursMin: numeric("estimated_hours_min", { precision: 5, scale: 1 }),
    estimatedHoursMax: numeric("estimated_hours_max", { precision: 5, scale: 1 }),
    estimatedCostMin: integer("estimated_cost_min"),
    estimatedCostMax: integer("estimated_cost_max"),

    // Flags
    requiresSiteVisit: boolean("requires_site_visit").default(false),
    completenessScore: integer("completeness_score").default(0), // 0-100

    // ── Denormalized scoring columns (for fast queue queries) ──
    recommendation: recommendationEnum("recommendation"),
    recommendationReason: text("recommendation_reason"),
    customerFitLabel: customerFitLabelEnum("customer_fit_label"),
    quoteWorthinessLabel: quoteWorthinessLabelEnum("quote_worthiness_label"),
    confidenceScore: integer("confidence_score"),
    confidenceLabel: confidenceLabelEnum("confidence_label"),
    estimateAckStatus: estimateAckStatusEnum("estimate_ack_status"),
    suburbGroup: suburbGroupEnum("suburb_group"),
    needsReview: boolean("needs_review").default(false),
    isRepeatCustomer: boolean("is_repeat_customer").default(false),
    repeatJobCount: integer("repeat_job_count").default(0),

    // Conversation tracking
    lastCustomerMessageAt: timestamp("last_customer_message_at", { withTimezone: true }),
    conversationSessionId: varchar("conversation_session_id", { length: 100 }),

    // Accumulated conversation state (JSON blob from extraction merges)
    metadata: jsonb("metadata"),

    // Semantos bridge columns
    typeHash: varchar("type_hash", { length: 64 }),   // SHA256 hex of (WHAT:HOW:INST)
    stateHash: varchar("state_hash", { length: 64 }),  // SHA256 hex of current accumulated state

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("jobs_org_idx").on(table.organisationId),
    index("jobs_customer_idx").on(table.customerId),
    index("jobs_status_idx").on(table.status),
    index("jobs_assigned_idx").on(table.assignedOperatorId),
    index("jobs_created_idx").on(table.createdAt),
    index("jobs_recommendation_idx").on(table.recommendation),
    index("jobs_suburb_group_idx").on(table.suburbGroup),
    index("jobs_needs_review_idx").on(table.needsReview),
    index("jobs_confidence_idx").on(table.confidenceScore),
    index("jobs_category_path_idx").on(table.categoryPath),
  ]
);

// ── Messages ─────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id),
    customerId: uuid("customer_id").references(() => customers.id),
    senderType: senderTypeEnum("sender_type").notNull(),
    channel: contactChannelEnum("channel").default("webchat"),
    messageType: messageTypeEnum("message_type").notNull().default("text"),
    rawContent: text("raw_content").notNull(),
    transcript: text("transcript"), // for voice messages
    extractedJson: jsonb("extracted_json"), // structured extraction output
    channelId: text("channel_id"), // FK → sem_channels.id (nullable for backward compat)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_job_idx").on(table.jobId),
    index("messages_customer_idx").on(table.customerId),
    index("messages_created_idx").on(table.createdAt),
    index("messages_channel_idx").on(table.channelId),
  ]
);

// ── Uploads ──────────────────────────────────

export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id),
    messageId: uuid("message_id").references(() => messages.id),
    fileType: varchar("file_type", { length: 50 }).notNull(), // image/jpeg, audio/webm, etc.
    storageUrl: text("storage_url").notNull(),
    metadataJson: jsonb("metadata_json"), // dimensions, duration, size, etc.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("uploads_job_idx").on(table.jobId),
    index("uploads_message_idx").on(table.messageId),
  ]
);

// ── Estimates ────────────────────────────────

export const estimates = pgTable(
  "estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    estimateType: estimateTypeEnum("estimate_type").notNull().default("auto_rom"),
    effortBand: effortBandEnum("effort_band"),
    hoursMin: numeric("hours_min", { precision: 5, scale: 1 }),
    hoursMax: numeric("hours_max", { precision: 5, scale: 1 }),
    costMin: integer("cost_min"),
    costMax: integer("cost_max"),
    labourOnly: boolean("labour_only").default(true),
    materialsNote: text("materials_note"),
    assumptionNotes: text("assumption_notes"),
    customerAcknowledgedEstimate: boolean("customer_acknowledged_estimate").default(false),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("estimates_job_idx").on(table.jobId)]
);

// ── Visits (Phase B but cheap to add now) ────

export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    assignedOperatorId: uuid("assigned_operator_id").references(() => operators.id),
    visitType: visitTypeEnum("visit_type").notNull(),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    outcome: visitOutcomeEnum("outcome"),
    notes: text("notes"),
    nextAction: text("next_action"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("visits_job_idx").on(table.jobId),
    index("visits_operator_idx").on(table.assignedOperatorId),
    index("visits_scheduled_idx").on(table.scheduledStart),
  ]
);

// ── Job State Events (audit log) ─────────────

export const jobStateEvents = pgTable(
  "job_state_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    fromState: jobStatusEnum("from_state"),
    toState: jobStatusEnum("to_state").notNull(),
    reason: text("reason"),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("job_state_events_job_idx").on(table.jobId),
    index("job_state_events_created_idx").on(table.createdAt),
  ]
);

// ── Invoices (Phase C but schema is cheap) ───

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    externalInvoiceId: varchar("external_invoice_id", { length: 255 }),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    amount: integer("amount"), // cents
    sentAt: timestamp("sent_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("invoices_job_idx").on(table.jobId),
    index("invoices_status_idx").on(table.status),
  ]
);

// ── Scoring Policies ────────────────────────

export const scoringPolicies = pgTable(
  "scoring_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: integer("version").notNull().unique(),
    name: varchar("name", { length: 100 }).notNull(),
    weights: jsonb("weights").notNull(),        // PolicyWeights JSON
    thresholds: jsonb("thresholds").notNull(),   // Recommendation thresholds JSON
    createdBy: varchar("created_by", { length: 100 }).notNull().default("system"),
    changeNotes: text("change_notes").notNull(),
    tunedFromVersion: integer("tuned_from_version"),
    tuningLocked: boolean("tuning_locked").notNull().default(false),
    isActive: boolean("is_active").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("scoring_policies_version_idx").on(table.version),
    index("scoring_policies_active_idx").on(table.isActive),
  ]
);

// ── Job Outcomes (post-mortem capture) ──────

export const jobOutcomes = pgTable(
  "job_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id)
      .unique(),
    policyVersion: integer("policy_version").notNull(),
    systemPolicySnapshot: jsonb("system_policy_snapshot"),       // full weights+thresholds at time of scoring
    systemRecommendation: varchar("system_recommendation", { length: 50 }).notNull(),
    systemScores: jsonb("system_scores").notNull(),              // SystemScoresSnapshot
    systemConfidence: integer("system_confidence"),               // 0-100
    scoringContext: jsonb("scoring_context"),                     // ScoringContext at time of scoring
    humanDecision: humanDecisionEnum("human_decision"),
    humanOverrideReason: text("human_override_reason"),
    actualOutcome: actualOutcomeEnum("actual_outcome"),
    outcomeValue: integer("outcome_value"),                      // cents
    outcomeNotes: text("outcome_notes"),
    missType: missTypeEnum("miss_type"),
    wasSystemCorrect: boolean("was_system_correct"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("job_outcomes_job_idx").on(table.jobId),
    index("job_outcomes_policy_idx").on(table.policyVersion),
    index("job_outcomes_decision_idx").on(table.humanDecision),
    index("job_outcomes_outcome_idx").on(table.actualOutcome),
  ]
);

// ─────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────

export const organisationsRelations = relations(organisations, ({ many }) => ({
  operators: many(operators),
  customers: many(customers),
  jobs: many(jobs),
}));

export const operatorsRelations = relations(operators, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [operators.organisationId],
    references: [organisations.id],
  }),
  assignedJobs: many(jobs),
  visits: many(visits),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [customers.organisationId],
    references: [organisations.id],
  }),
  sites: many(sites),
  jobs: many(jobs),
  messages: many(messages),
}));

export const sitesRelations = relations(sites, ({ one, many }) => ({
  customer: one(customers, {
    fields: [sites.customerId],
    references: [customers.id],
  }),
  jobs: many(jobs),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [jobs.organisationId],
    references: [organisations.id],
  }),
  customer: one(customers, {
    fields: [jobs.customerId],
    references: [customers.id],
  }),
  site: one(sites, {
    fields: [jobs.siteId],
    references: [sites.id],
  }),
  createdByOperator: one(operators, {
    fields: [jobs.createdByOperatorId],
    references: [operators.id],
    relationName: "createdByOperator",
  }),
  assignedOperator: one(operators, {
    fields: [jobs.assignedOperatorId],
    references: [operators.id],
    relationName: "assignedOperator",
  }),
  messages: many(messages),
  uploads: many(uploads),
  estimates: many(estimates),
  visits: many(visits),
  stateEvents: many(jobStateEvents),
  invoices: many(invoices),
  outcome: one(jobOutcomes, {
    fields: [jobs.id],
    references: [jobOutcomes.jobId],
  }),
  instruments: many(instruments),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  job: one(jobs, {
    fields: [messages.jobId],
    references: [jobs.id],
  }),
  customer: one(customers, {
    fields: [messages.customerId],
    references: [customers.id],
  }),
  uploads: many(uploads),
}));

export const uploadsRelations = relations(uploads, ({ one }) => ({
  job: one(jobs, {
    fields: [uploads.jobId],
    references: [jobs.id],
  }),
  message: one(messages, {
    fields: [uploads.messageId],
    references: [messages.id],
  }),
}));

export const estimatesRelations = relations(estimates, ({ one }) => ({
  job: one(jobs, {
    fields: [estimates.jobId],
    references: [jobs.id],
  }),
}));

export const visitsRelations = relations(visits, ({ one }) => ({
  job: one(jobs, {
    fields: [visits.jobId],
    references: [jobs.id],
  }),
  assignedOperator: one(operators, {
    fields: [visits.assignedOperatorId],
    references: [operators.id],
  }),
}));

export const jobStateEventsRelations = relations(jobStateEvents, ({ one }) => ({
  job: one(jobs, {
    fields: [jobStateEvents.jobId],
    references: [jobs.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  job: one(jobs, {
    fields: [invoices.jobId],
    references: [jobs.id],
  }),
}));

export const scoringPoliciesRelations = relations(scoringPolicies, ({ many }) => ({
  outcomes: many(jobOutcomes),
}));

export const jobOutcomesRelations = relations(jobOutcomes, ({ one }) => ({
  job: one(jobs, {
    fields: [jobOutcomes.jobId],
    references: [jobs.id],
  }),
}));

// ─────────────────────────────────────────────
// Sprint 5A: Sessions & Audit Log
// ─────────────────────────────────────────────

export const sessionTypeEnum = pgEnum("session_type", [
  "customer",
  "admin",
]);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id").references(() => customers.id),
    adminEmail: text("admin_email"),
    sessionType: sessionTypeEnum("session_type").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    revoked: boolean("revoked").default(false).notNull(),
  },
  (table) => [
    index("sessions_customer_id_idx").on(table.customerId),
    index("sessions_token_hash_idx").on(table.tokenHash),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ]
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  customer: one(customers, {
    fields: [sessions.customerId],
    references: [customers.id],
  }),
}));

export const auditActorTypeEnum = pgEnum("audit_actor_type", [
  "admin",
  "customer",
  "system",
]);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorType: auditActorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_log_actor_idx").on(table.actorType, table.actorId),
    index("audit_log_action_idx").on(table.action),
    index("audit_log_created_at_idx").on(table.createdAt),
  ]
);

// ── Categories (Universal Taxonomy) ─────────

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    path: varchar("path", { length: 255 }).notNull().unique(), // LTREE-style: "services.trades.plumbing"
    dimension: categoryDimensionEnum("dimension").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    level: integer("level").notNull().default(0),
    parentPath: varchar("parent_path", { length: 255 }),
    description: text("description"),
    keywords: jsonb("keywords").$type<string[]>().default([]),
    attributes: jsonb("attributes").$type<CategoryAttribute[]>().default([]),
    valueMultiplier: numeric("value_multiplier", { precision: 3, scale: 2 }).default("1.00"),
    siteVisitLikely: boolean("site_visit_likely").default(false),
    licensedTrade: boolean("licensed_trade").default(false),
    validTxTypes: jsonb("valid_tx_types").$type<string[]>().default([]),
    modalTemplate: varchar("modal_template", { length: 50 }),
    embeddingText: text("embedding_text"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("categories_dimension_idx").on(table.dimension),
    index("categories_level_idx").on(table.level),
    index("categories_parent_path_idx").on(table.parentPath),
    index("categories_slug_idx").on(table.slug),
  ]
);

// ── Instruments (Capsule storage) ───────────

export const instrumentStatusEnum = pgEnum("instrument_status", [
  "draft",
  "presented",
  "accepted",
  "rejected",
  "superseded",
  "expired",
]);

export const instruments = pgTable(
  "instruments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),

    // Semantos type triple
    instrumentPath: varchar("instrument_path", { length: 255 }).notNull(), // e.g. "inst.quote.rom"
    categoryPath: varchar("category_path", { length: 255 }),               // WHAT dimension
    txType: varchar("tx_type", { length: 50 }),                            // HOW dimension
    typeHash: varchar("type_hash", { length: 64 }).notNull(),              // SHA256(WHAT:HOW:INST)

    // State integrity
    stateHash: varchar("state_hash", { length: 64 }),     // state hash at time of rendering
    parentStateHash: varchar("parent_state_hash", { length: 64 }), // prev state hash (Patch linkage)

    // Linearity: "affine" | "relevant" — instruments are capsules (relevant)
    linearity: varchar("linearity", { length: 20 }).notNull().default("relevant"),

    // Rendered content
    status: instrumentStatusEnum("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    renderedJson: jsonb("rendered_json").notNull(),        // Full RenderedInstrument payload
    renderedText: text("rendered_text"),                    // Human-readable text version
    totalAmountCents: integer("total_amount_cents"),        // Denormalised for queries
    gstAmountCents: integer("gst_amount_cents"),

    // Lifecycle
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("instruments_job_idx").on(table.jobId),
    index("instruments_org_idx").on(table.organisationId),
    index("instruments_type_hash_idx").on(table.typeHash),
    index("instruments_status_idx").on(table.status),
    index("instruments_instrument_path_idx").on(table.instrumentPath),
  ]
);

export const instrumentsRelations = relations(instruments, ({ one }) => ({
  job: one(jobs, {
    fields: [instruments.jobId],
    references: [jobs.id],
  }),
  organisation: one(organisations, {
    fields: [instruments.organisationId],
    references: [organisations.id],
  }),
}));
