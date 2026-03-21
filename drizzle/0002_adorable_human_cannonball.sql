CREATE TYPE "public"."actual_outcome" AS ENUM('completed_paid', 'completed_disputed', 'booked_cancelled', 'quoted_rejected', 'quoted_ghosted', 'site_visit_declined', 'site_visit_booked', 'customer_went_elsewhere', 'customer_ghosted', 'not_pursued', 'still_active');--> statement-breakpoint
CREATE TYPE "public"."confidence_label" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."customer_fit_label" AS ENUM('poor_fit', 'risky', 'mixed', 'good_fit', 'strong_fit');--> statement-breakpoint
CREATE TYPE "public"."estimate_ack_status" AS ENUM('pending', 'accepted', 'tentative', 'pushback', 'rejected', 'wants_exact_price', 'rate_shopping');--> statement-breakpoint
CREATE TYPE "public"."human_decision" AS ENUM('followed_up', 'quoted', 'booked', 'site_visited', 'declined', 'archived', 'referred_out', 'deferred', 'let_expire');--> statement-breakpoint
CREATE TYPE "public"."miss_type" AS ENUM('false_negative', 'false_positive', 'underquoted_risk', 'overestimated_friction', 'customer_turned_painful', 'not_worth_travel', 'ideal_fill_job_missed', 'site_visit_wasted', 'good_repeat_misread', 'scope_creep', 'too_small_but_took_anyway', 'good_customer_low_value', 'schedule_gap_fill', 'none');--> statement-breakpoint
CREATE TYPE "public"."quote_worthiness_label" AS ENUM('ignore', 'only_if_convenient', 'maybe_quote', 'worth_quoting', 'priority');--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('ignore', 'only_if_nearby', 'needs_site_visit', 'probably_bookable', 'worth_quoting', 'priority_lead', 'not_price_aligned', 'not_a_fit');--> statement-breakpoint
CREATE TYPE "public"."suburb_group" AS ENUM('core', 'extended', 'outside', 'unknown');--> statement-breakpoint
CREATE TABLE "job_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"system_policy_snapshot" jsonb,
	"system_recommendation" varchar(50) NOT NULL,
	"system_scores" jsonb NOT NULL,
	"system_confidence" integer,
	"scoring_context" jsonb,
	"human_decision" "human_decision",
	"human_override_reason" text,
	"actual_outcome" "actual_outcome",
	"outcome_value" integer,
	"outcome_notes" text,
	"miss_type" "miss_type",
	"was_system_correct" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "job_outcomes_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "scoring_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"weights" jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"created_by" varchar(100) DEFAULT 'system' NOT NULL,
	"change_notes" text NOT NULL,
	"tuned_from_version" integer,
	"tuning_locked" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoring_policies_version_unique" UNIQUE("version")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "recommendation" "recommendation";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "recommendation_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "customer_fit_label" "customer_fit_label";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "quote_worthiness_label" "quote_worthiness_label";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "confidence_score" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "confidence_label" "confidence_label";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "estimate_ack_status" "estimate_ack_status";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "suburb_group" "suburb_group";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "needs_review" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "is_repeat_customer" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "repeat_job_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "job_outcomes" ADD CONSTRAINT "job_outcomes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_outcomes_job_idx" ON "job_outcomes" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_outcomes_policy_idx" ON "job_outcomes" USING btree ("policy_version");--> statement-breakpoint
CREATE INDEX "job_outcomes_decision_idx" ON "job_outcomes" USING btree ("human_decision");--> statement-breakpoint
CREATE INDEX "job_outcomes_outcome_idx" ON "job_outcomes" USING btree ("actual_outcome");--> statement-breakpoint
CREATE INDEX "scoring_policies_version_idx" ON "scoring_policies" USING btree ("version");--> statement-breakpoint
CREATE INDEX "scoring_policies_active_idx" ON "scoring_policies" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "jobs_recommendation_idx" ON "jobs" USING btree ("recommendation");--> statement-breakpoint
CREATE INDEX "jobs_suburb_group_idx" ON "jobs" USING btree ("suburb_group");--> statement-breakpoint
CREATE INDEX "jobs_needs_review_idx" ON "jobs" USING btree ("needs_review");--> statement-breakpoint
CREATE INDEX "jobs_confidence_idx" ON "jobs" USING btree ("confidence_score");