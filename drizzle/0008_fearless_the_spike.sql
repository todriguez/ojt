-- Migration 0008: Kernel cleanup + externalId
--
-- 1. Add external_id to sem_objects for per-instance object lookup
--    Existing rows with null external_id continue to resolve via typeHash-only lookup
--    (correct for singleton objects). New per-instance objects (jobs) always pass
--    externalId and use the composite lookup.
--
-- 2. Rename vertical-specific enum values to generic equivalents.
--    Uses ALTER TYPE RENAME VALUE which is non-destructive and preserves existing rows.

-- ── 1. Add external_id column ──
ALTER TABLE "sem_objects" ADD COLUMN "external_id" varchar(255);--> statement-breakpoint
CREATE INDEX "sem_objects_type_hash_external_idx" ON "sem_objects" USING btree ("type_hash", "external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sem_objects_type_hash_external_unique_idx" ON "sem_objects" ("type_hash", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint

-- ── 2. Genericize human_decision enum (legacy schema) ──
ALTER TYPE "public"."human_decision" RENAME VALUE 'quoted' TO 'evaluated';--> statement-breakpoint
ALTER TYPE "public"."human_decision" RENAME VALUE 'booked' TO 'committed';--> statement-breakpoint
ALTER TYPE "public"."human_decision" RENAME VALUE 'site_visited' TO 'inspected';--> statement-breakpoint

-- ── 3. Genericize actual_outcome enum (legacy schema) ──
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'completed_paid' TO 'completed';--> statement-breakpoint
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'completed_disputed' TO 'disputed';--> statement-breakpoint
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'booked_cancelled' TO 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'quoted_rejected' TO 'rejected';--> statement-breakpoint
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'quoted_ghosted' TO 'evaluated_unresponsive';--> statement-breakpoint
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'site_visit_declined' TO 'inspected_declined';--> statement-breakpoint
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'site_visit_booked' TO 'inspected_committed';--> statement-breakpoint
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'customer_went_elsewhere' TO 'diverted';--> statement-breakpoint
ALTER TYPE "public"."actual_outcome" RENAME VALUE 'customer_ghosted' TO 'unresponsive';--> statement-breakpoint

-- ── 4. Genericize sem_outcome_decision enum (kernel schema) ──
ALTER TYPE "public"."sem_outcome_decision" RENAME VALUE 'quoted' TO 'evaluated';--> statement-breakpoint
ALTER TYPE "public"."sem_outcome_decision" RENAME VALUE 'booked' TO 'committed';--> statement-breakpoint
ALTER TYPE "public"."sem_outcome_decision" RENAME VALUE 'site_visited' TO 'inspected';--> statement-breakpoint

-- ── 5. Genericize sem_outcome_result enum (kernel schema) ──
ALTER TYPE "public"."sem_outcome_result" RENAME VALUE 'completed_paid' TO 'completed';--> statement-breakpoint
ALTER TYPE "public"."sem_outcome_result" RENAME VALUE 'completed_disputed' TO 'disputed';--> statement-breakpoint
ALTER TYPE "public"."sem_outcome_result" RENAME VALUE 'booked_cancelled' TO 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."sem_outcome_result" RENAME VALUE 'quoted_rejected' TO 'rejected';--> statement-breakpoint
ALTER TYPE "public"."sem_outcome_result" RENAME VALUE 'quoted_ghosted' TO 'evaluated_unresponsive';--> statement-breakpoint
ALTER TYPE "public"."sem_outcome_result" RENAME VALUE 'customer_went_elsewhere' TO 'diverted';--> statement-breakpoint
ALTER TYPE "public"."sem_outcome_result" RENAME VALUE 'customer_ghosted' TO 'unresponsive';
