CREATE TYPE "public"."sem_evidence_kind" AS ENUM('message', 'document', 'observation', 'image', 'voice');--> statement-breakpoint
CREATE TYPE "public"."sem_instrument_status" AS ENUM('generated', 'presented', 'accepted', 'rejected', 'superseded', 'consumed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."sem_linearity" AS ENUM('AFFINE', 'LINEAR', 'RELEVANT');--> statement-breakpoint
CREATE TYPE "public"."sem_object_status" AS ENUM('active', 'archived', 'spent', 'tombstoned');--> statement-breakpoint
CREATE TYPE "public"."sem_outcome_decision" AS ENUM('followed_up', 'quoted', 'booked', 'site_visited', 'declined', 'archived', 'referred_out', 'deferred', 'let_expire');--> statement-breakpoint
CREATE TYPE "public"."sem_outcome_result" AS ENUM('completed_paid', 'completed_disputed', 'booked_cancelled', 'quoted_rejected', 'quoted_ghosted', 'customer_went_elsewhere', 'customer_ghosted', 'not_pursued', 'still_active');--> statement-breakpoint
CREATE TYPE "public"."sem_patch_kind" AS ENUM('extraction', 'rescore', 'manual_override', 'state_transition', 'evidence_merge', 'instrument_emit', 'action');--> statement-breakpoint
CREATE TABLE "sem_classifications" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"class_payload" jsonb NOT NULL,
	"type_hash" varchar(64) NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_diagnostic_events" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"event_kind" varchar(50) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_evidence_items" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"evidence_kind" "sem_evidence_kind" NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"source_ref" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_object_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"txid" varchar(64),
	"vout" integer,
	"bump_hash" varchar(64),
	"derivation_index" integer,
	"is_on_chain" boolean DEFAULT false NOT NULL,
	"is_immutable" boolean DEFAULT false NOT NULL,
	"is_spent" boolean DEFAULT false NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"state_version" integer NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_object_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"from_object_id" text NOT NULL,
	"to_object_id" text NOT NULL,
	"edge_type" varchar(50) NOT NULL,
	"edge_payload" jsonb,
	"edge_object_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_object_patches" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"prev_state_hash" varchar(64) NOT NULL,
	"new_state_hash" varchar(64) NOT NULL,
	"patch_kind" "sem_patch_kind" NOT NULL,
	"delta" jsonb NOT NULL,
	"delta_count" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"evidence_ref" text,
	"author_object_id" text,
	"linearity" "sem_linearity" DEFAULT 'LINEAR' NOT NULL,
	"consumed" boolean DEFAULT true NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_object_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"state_id" text,
	"policy_version" varchar(50),
	"compiler_version" varchar(50),
	"grammar_version" varchar(50),
	"classifier_version" varchar(50),
	"score_kind" varchar(50) NOT NULL,
	"score_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_object_states" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"version" integer NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"prev_state_hash" varchar(64) DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_size" integer DEFAULT 0 NOT NULL,
	"ir_version" integer DEFAULT 1 NOT NULL,
	"source" varchar(100),
	"created_by" text,
	"compiler_version" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"policy_version" varchar(50),
	"system_snapshot" jsonb,
	"human_decision" "sem_outcome_decision",
	"actual_outcome" "sem_outcome_result",
	"outcome_value" integer,
	"miss_type" varchar(50),
	"was_system_correct" boolean,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sem_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"vertical" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"version" integer NOT NULL,
	"policy_payload" jsonb NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"tuning_locked" boolean DEFAULT false NOT NULL,
	"tuned_from_version" integer,
	"created_by" varchar(100),
	"change_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"state_id" text,
	"instrument_type" varchar(50) NOT NULL,
	"instrument_path" varchar(255),
	"payload" jsonb NOT NULL,
	"file_path" text,
	"linearity" "sem_linearity" DEFAULT 'RELEVANT' NOT NULL,
	"status" "sem_instrument_status" DEFAULT 'generated' NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_cells" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"cell_hash" varchar(64) NOT NULL,
	"linearity" "sem_linearity" NOT NULL,
	"cell_index" integer DEFAULT 0 NOT NULL,
	"continuation_count" integer DEFAULT 0 NOT NULL,
	"root_cell_id" text,
	"type_hash" varchar(64) NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"prev_state_hash" varchar(64) DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"raw_header" "bytea" NOT NULL,
	"raw_payload" "bytea" NOT NULL,
	"payload_size" integer NOT NULL,
	"format" varchar(20) DEFAULT 'json-gzip' NOT NULL,
	"flags" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sem_cells_cell_hash_unique" UNIQUE("cell_hash")
);
--> statement-breakpoint
CREATE TABLE "sem_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"vertical" varchar(50) NOT NULL,
	"object_kind" varchar(50) NOT NULL,
	"type_hash" varchar(64) NOT NULL,
	"type_path" varchar(255),
	"linearity" "sem_linearity" DEFAULT 'AFFINE' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"current_state_hash" varchar(64) DEFAULT '' NOT NULL,
	"flags" integer DEFAULT 0 NOT NULL,
	"status" "sem_object_status" DEFAULT 'active' NOT NULL,
	"owner_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_taxonomies" (
	"id" text PRIMARY KEY NOT NULL,
	"vertical" varchar(50) NOT NULL,
	"dimension" varchar(50) NOT NULL,
	"path" varchar(255) NOT NULL,
	"parent_path" varchar(255),
	"attributes" jsonb,
	"keywords" jsonb DEFAULT '[]'::jsonb,
	"rules" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_trades_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"legacy_customer_id" text,
	"name" varchar(255) NOT NULL,
	"phone" varchar(50),
	"email" varchar(255),
	"preferred_channel" varchar(20),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sem_trades_customers_object_id_unique" UNIQUE("object_id")
);
--> statement-breakpoint
CREATE TABLE "sem_trades_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"legacy_job_id" text,
	"customer_id" text,
	"customer_name" varchar(255),
	"site_id" text,
	"suburb" varchar(100),
	"postcode" varchar(10),
	"job_type" varchar(50),
	"job_subcategory" varchar(100),
	"category_path" varchar(255),
	"tx_type" varchar(50),
	"instrument_type" varchar(100),
	"job_status" varchar(50) DEFAULT 'new_lead' NOT NULL,
	"urgency" varchar(50) DEFAULT 'unspecified',
	"effort_band" varchar(20),
	"estimated_cost_min" integer,
	"estimated_cost_max" integer,
	"customer_fit_score" integer,
	"customer_fit_label" varchar(20),
	"quote_worthiness_score" integer,
	"quote_worthiness_label" varchar(20),
	"confidence_score" integer,
	"confidence_label" varchar(20),
	"completeness_score" integer DEFAULT 0,
	"recommendation" varchar(30),
	"recommendation_reason" text,
	"suburb_group" varchar(20),
	"needs_review" boolean DEFAULT false,
	"is_repeat_customer" boolean DEFAULT false,
	"repeat_job_count" integer DEFAULT 0,
	"estimate_presented" boolean DEFAULT false,
	"estimate_acknowledged" boolean DEFAULT false,
	"estimate_ack_status" varchar(30) DEFAULT 'pending',
	"lead_source" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sem_trades_jobs_object_id_unique" UNIQUE("object_id")
);
--> statement-breakpoint
CREATE TABLE "sem_trades_sites" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"legacy_site_id" text,
	"customer_object_id" text,
	"address" varchar(255),
	"suburb" varchar(100),
	"postcode" varchar(10),
	"state" varchar(10) DEFAULT 'QLD',
	"lat" real,
	"lng" real,
	"access_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sem_trades_sites_object_id_unique" UNIQUE("object_id")
);
--> statement-breakpoint
CREATE TABLE "sem_trades_visits" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"job_object_id" text NOT NULL,
	"visit_type" varchar(30) NOT NULL,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"outcome" varchar(30),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sem_trades_visits_object_id_unique" UNIQUE("object_id")
);
--> statement-breakpoint
ALTER TABLE "sem_evidence_items" ADD CONSTRAINT "sem_evidence_items_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_object_bindings" ADD CONSTRAINT "sem_object_bindings_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_object_edges" ADD CONSTRAINT "sem_object_edges_from_object_id_sem_objects_id_fk" FOREIGN KEY ("from_object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_object_edges" ADD CONSTRAINT "sem_object_edges_to_object_id_sem_objects_id_fk" FOREIGN KEY ("to_object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_object_patches" ADD CONSTRAINT "sem_object_patches_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_object_scores" ADD CONSTRAINT "sem_object_scores_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_object_states" ADD CONSTRAINT "sem_object_states_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_outcomes" ADD CONSTRAINT "sem_outcomes_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_instruments" ADD CONSTRAINT "sem_instruments_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sem_class_object_idx" ON "sem_classifications" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_class_type_hash_idx" ON "sem_classifications" USING btree ("type_hash");--> statement-breakpoint
CREATE INDEX "sem_diag_object_idx" ON "sem_diagnostic_events" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_diag_kind_idx" ON "sem_diagnostic_events" USING btree ("event_kind");--> statement-breakpoint
CREATE INDEX "sem_evidence_object_idx" ON "sem_evidence_items" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_evidence_kind_idx" ON "sem_evidence_items" USING btree ("evidence_kind");--> statement-breakpoint
CREATE INDEX "sem_bindings_object_idx" ON "sem_object_bindings" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_bindings_txid_idx" ON "sem_object_bindings" USING btree ("txid");--> statement-breakpoint
CREATE INDEX "sem_bindings_hash_idx" ON "sem_object_bindings" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "sem_edges_from_idx" ON "sem_object_edges" USING btree ("from_object_id");--> statement-breakpoint
CREATE INDEX "sem_edges_to_idx" ON "sem_object_edges" USING btree ("to_object_id");--> statement-breakpoint
CREATE INDEX "sem_edges_type_idx" ON "sem_object_edges" USING btree ("edge_type");--> statement-breakpoint
CREATE INDEX "sem_patches_object_idx" ON "sem_object_patches" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_patches_kind_idx" ON "sem_object_patches" USING btree ("patch_kind");--> statement-breakpoint
CREATE INDEX "sem_patches_new_hash_idx" ON "sem_object_patches" USING btree ("new_state_hash");--> statement-breakpoint
CREATE INDEX "sem_scores_object_idx" ON "sem_object_scores" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_scores_hash_idx" ON "sem_object_scores" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "sem_scores_kind_idx" ON "sem_object_scores" USING btree ("score_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "sem_object_states_version_uniq" ON "sem_object_states" USING btree ("object_id","version");--> statement-breakpoint
CREATE INDEX "sem_object_states_object_idx" ON "sem_object_states" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_object_states_hash_idx" ON "sem_object_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "sem_outcomes_object_idx" ON "sem_outcomes" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_outcomes_miss_idx" ON "sem_outcomes" USING btree ("miss_type");--> statement-breakpoint
CREATE UNIQUE INDEX "sem_policies_uniq" ON "sem_policies" USING btree ("vertical","name","version");--> statement-breakpoint
CREATE INDEX "sem_policies_active_idx" ON "sem_policies" USING btree ("vertical","is_active");--> statement-breakpoint
CREATE INDEX "sem_instruments_object_idx" ON "sem_instruments" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_instruments_type_idx" ON "sem_instruments" USING btree ("instrument_type");--> statement-breakpoint
CREATE INDEX "sem_instruments_status_idx" ON "sem_instruments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sem_cells_object_idx" ON "sem_cells" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_cells_state_hash_idx" ON "sem_cells" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "sem_cells_type_hash_idx" ON "sem_cells" USING btree ("type_hash");--> statement-breakpoint
CREATE INDEX "sem_cells_root_idx" ON "sem_cells" USING btree ("root_cell_id");--> statement-breakpoint
CREATE INDEX "sem_cells_linearity_idx" ON "sem_cells" USING btree ("linearity");--> statement-breakpoint
CREATE INDEX "sem_objects_vertical_kind_idx" ON "sem_objects" USING btree ("vertical","object_kind");--> statement-breakpoint
CREATE INDEX "sem_objects_type_hash_idx" ON "sem_objects" USING btree ("type_hash");--> statement-breakpoint
CREATE INDEX "sem_objects_state_hash_idx" ON "sem_objects" USING btree ("current_state_hash");--> statement-breakpoint
CREATE INDEX "sem_objects_owner_idx" ON "sem_objects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sem_objects_status_idx" ON "sem_objects" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sem_taxonomies_uniq" ON "sem_taxonomies" USING btree ("vertical","dimension","path");--> statement-breakpoint
CREATE INDEX "sem_taxonomies_vertical_dim_idx" ON "sem_taxonomies" USING btree ("vertical","dimension");--> statement-breakpoint
CREATE INDEX "sem_trades_customers_object_idx" ON "sem_trades_customers" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_trades_customers_legacy_idx" ON "sem_trades_customers" USING btree ("legacy_customer_id");--> statement-breakpoint
CREATE INDEX "sem_trades_customers_email_idx" ON "sem_trades_customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "sem_trades_customers_phone_idx" ON "sem_trades_customers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "sem_trades_jobs_object_idx" ON "sem_trades_jobs" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_trades_jobs_legacy_idx" ON "sem_trades_jobs" USING btree ("legacy_job_id");--> statement-breakpoint
CREATE INDEX "sem_trades_jobs_status_idx" ON "sem_trades_jobs" USING btree ("job_status");--> statement-breakpoint
CREATE INDEX "sem_trades_jobs_suburb_idx" ON "sem_trades_jobs" USING btree ("suburb");--> statement-breakpoint
CREATE INDEX "sem_trades_jobs_recommendation_idx" ON "sem_trades_jobs" USING btree ("recommendation");--> statement-breakpoint
CREATE INDEX "sem_trades_jobs_confidence_idx" ON "sem_trades_jobs" USING btree ("confidence_score");--> statement-breakpoint
CREATE INDEX "sem_trades_jobs_needs_review_idx" ON "sem_trades_jobs" USING btree ("needs_review");--> statement-breakpoint
CREATE INDEX "sem_trades_jobs_category_idx" ON "sem_trades_jobs" USING btree ("category_path");--> statement-breakpoint
CREATE INDEX "sem_trades_sites_object_idx" ON "sem_trades_sites" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_trades_sites_customer_idx" ON "sem_trades_sites" USING btree ("customer_object_id");--> statement-breakpoint
CREATE INDEX "sem_trades_sites_suburb_idx" ON "sem_trades_sites" USING btree ("suburb");--> statement-breakpoint
CREATE INDEX "sem_trades_visits_object_idx" ON "sem_trades_visits" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_trades_visits_job_idx" ON "sem_trades_visits" USING btree ("job_object_id");--> statement-breakpoint
CREATE INDEX "sem_trades_visits_scheduled_idx" ON "sem_trades_visits" USING btree ("scheduled_start");