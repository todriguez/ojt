CREATE TYPE "public"."category_dimension" AS ENUM('what', 'how', 'instrument');--> statement-breakpoint
CREATE TYPE "public"."instrument_status" AS ENUM('draft', 'presented', 'accepted', 'rejected', 'superseded', 'expired');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" varchar(255) NOT NULL,
	"dimension" "category_dimension" NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"parent_path" varchar(255),
	"description" text,
	"keywords" jsonb DEFAULT '[]'::jsonb,
	"attributes" jsonb DEFAULT '[]'::jsonb,
	"value_multiplier" numeric(3, 2) DEFAULT '1.00',
	"site_visit_likely" boolean DEFAULT false,
	"licensed_trade" boolean DEFAULT false,
	"valid_tx_types" jsonb DEFAULT '[]'::jsonb,
	"modal_template" varchar(50),
	"embedding_text" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"instrument_path" varchar(255) NOT NULL,
	"category_path" varchar(255),
	"tx_type" varchar(50),
	"type_hash" varchar(64) NOT NULL,
	"state_hash" varchar(64),
	"parent_state_hash" varchar(64),
	"linearity" varchar(20) DEFAULT 'relevant' NOT NULL,
	"status" "instrument_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"rendered_json" jsonb NOT NULL,
	"rendered_text" text,
	"total_amount_cents" integer,
	"gst_amount_cents" integer,
	"presented_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "category_path" varchar(255);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "tx_type" varchar(50);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "instrument_type" varchar(100);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "type_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "state_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_dimension_idx" ON "categories" USING btree ("dimension");--> statement-breakpoint
CREATE INDEX "categories_level_idx" ON "categories" USING btree ("level");--> statement-breakpoint
CREATE INDEX "categories_parent_path_idx" ON "categories" USING btree ("parent_path");--> statement-breakpoint
CREATE INDEX "categories_slug_idx" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "instruments_job_idx" ON "instruments" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "instruments_org_idx" ON "instruments" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "instruments_type_hash_idx" ON "instruments" USING btree ("type_hash");--> statement-breakpoint
CREATE INDEX "instruments_status_idx" ON "instruments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "instruments_instrument_path_idx" ON "instruments" USING btree ("instrument_path");--> statement-breakpoint
CREATE INDEX "jobs_category_path_idx" ON "jobs" USING btree ("category_path");