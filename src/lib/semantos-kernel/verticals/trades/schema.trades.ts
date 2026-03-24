/**
 * schema.trades.ts
 *
 * Vertical Grammar — Trades/Services Domain
 *
 * Trades/Services-specific projection tables for semantic objects.
 * These tables denormalize the universal semantic core into domain terminology.
 *
 * Tables:
 *   - tradesJobs: Job opportunities with scoring and status
 *   - tradesCustomers: Customer entities
 *   - tradesSites: Physical locations for work
 *   - tradesVisits: Site visits and inspections
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

// ═══ C.1 Trades JOBS ════════════════════════════════════════════════════════
// Job opportunity as a semantic object — the main lead entity.
// All denormalized fields are for fast reads; canonical data lives in objectState.

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

// ═══ C.2 Trades CUSTOMER ════════════════════════════════════════════════════
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

// ═══ C.3 Trades SITE ════════════════════════════════════════════════════════
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

// ═══ C.4 Trades VISIT ══════════════════════════════════════════════════════
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
  object: one(semanticObjects, { fields: [tradesVisits.jobObjectId], references: [semanticObjects.id] }),
}));
