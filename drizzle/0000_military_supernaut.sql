CREATE TYPE "public"."actor_type" AS ENUM('operator', 'customer', 'system', 'ai');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('sms', 'email', 'phone', 'whatsapp', 'messenger', 'webchat');--> statement-breakpoint
CREATE TYPE "public"."effort_band" AS ENUM('quick', 'short', 'quarter_day', 'half_day', 'full_day', 'multi_day', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."estimate_type" AS ENUM('auto_rom', 'operator_rom', 'formal_quote', 'revised');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_category" AS ENUM('carpentry', 'plumbing', 'electrical', 'painting', 'general', 'fencing', 'tiling', 'roofing', 'doors_windows', 'gardening', 'cleaning', 'other');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('new_lead', 'partial_intake', 'awaiting_customer', 'ready_for_review', 'estimate_presented', 'estimate_accepted', 'not_price_aligned', 'not_a_fit', 'needs_site_visit', 'bookable', 'scheduled', 'in_progress', 'hanging_weather', 'hanging_parts', 'return_visit_required', 'complete', 'invoice_pending', 'invoiced', 'paid', 'archived');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('website_chat', 'facebook', 'instagram', 'phone', 'referral', 'repeat', 'walk_in', 'other');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'voice', 'image', 'file', 'system');--> statement-breakpoint
CREATE TYPE "public"."operator_status" AS ENUM('active', 'inactive', 'on_leave');--> statement-breakpoint
CREATE TYPE "public"."organisation_type" AS ENUM('sole_trader', 'partnership', 'company');--> statement-breakpoint
CREATE TYPE "public"."sender_type" AS ENUM('customer', 'operator', 'system', 'ai');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('emergency', 'urgent', 'next_week', 'next_2_weeks', 'flexible', 'when_convenient', 'unspecified');--> statement-breakpoint
CREATE TYPE "public"."visit_outcome" AS ENUM('completed', 'partial', 'rescheduled', 'no_access', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."visit_type" AS ENUM('inspection', 'quote_visit', 'scheduled_work', 'return_visit', 'emergency');--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"mobile" varchar(50),
	"email" varchar(255),
	"preferred_contact_channel" "contact_channel",
	"mobile_verified_at" timestamp with time zone,
	"email_verified_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"estimate_type" "estimate_type" DEFAULT 'auto_rom' NOT NULL,
	"effort_band" "effort_band",
	"hours_min" numeric(5, 1),
	"hours_max" numeric(5, 1),
	"cost_min" integer,
	"cost_max" integer,
	"labour_only" boolean DEFAULT true,
	"materials_note" text,
	"assumption_notes" text,
	"customer_acknowledged_estimate" boolean DEFAULT false,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"external_invoice_id" varchar(255),
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"amount" integer,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_state_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"from_state" "job_status",
	"to_state" "job_status" NOT NULL,
	"reason" text,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"customer_id" uuid,
	"site_id" uuid,
	"created_by_operator_id" uuid,
	"assigned_operator_id" uuid,
	"lead_source" "lead_source" DEFAULT 'website_chat',
	"job_type" "job_category" DEFAULT 'general',
	"subcategory" varchar(100),
	"description_raw" text,
	"description_summary" text,
	"status" "job_status" DEFAULT 'new_lead' NOT NULL,
	"urgency" "urgency" DEFAULT 'unspecified',
	"service_area_ok" boolean,
	"customer_fit_score" integer,
	"quote_worthiness_score" integer,
	"effort_band" "effort_band",
	"estimated_hours_min" numeric(5, 1),
	"estimated_hours_max" numeric(5, 1),
	"estimated_cost_min" integer,
	"estimated_cost_max" integer,
	"requires_site_visit" boolean DEFAULT false,
	"completeness_score" integer DEFAULT 0,
	"last_customer_message_at" timestamp with time zone,
	"conversation_session_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"customer_id" uuid,
	"sender_type" "sender_type" NOT NULL,
	"channel" "contact_channel" DEFAULT 'webchat',
	"message_type" "message_type" DEFAULT 'text' NOT NULL,
	"raw_content" text NOT NULL,
	"transcript" text,
	"extracted_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"phone" varchar(50),
	"status" "operator_status" DEFAULT 'active' NOT NULL,
	"capability_tags" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "organisation_type" DEFAULT 'sole_trader' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_line_1" varchar(255),
	"address_line_2" varchar(255),
	"suburb" varchar(100),
	"postcode" varchar(10),
	"state" varchar(10) DEFAULT 'QLD',
	"lat" numeric(10, 7),
	"lng" numeric(10, 7),
	"access_notes" text,
	"site_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"message_id" uuid,
	"file_type" varchar(50) NOT NULL,
	"storage_url" text NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"assigned_operator_id" uuid,
	"visit_type" "visit_type" NOT NULL,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"outcome" "visit_outcome",
	"notes" text,
	"next_action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_state_events" ADD CONSTRAINT "job_state_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_operator_id_operators_id_fk" FOREIGN KEY ("created_by_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_operator_id_operators_id_fk" FOREIGN KEY ("assigned_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_assigned_operator_id_operators_id_fk" FOREIGN KEY ("assigned_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_org_idx" ON "customers" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "customers_mobile_idx" ON "customers" USING btree ("mobile");--> statement-breakpoint
CREATE INDEX "estimates_job_idx" ON "estimates" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "invoices_job_idx" ON "invoices" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_state_events_job_idx" ON "job_state_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_state_events_created_idx" ON "job_state_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_org_idx" ON "jobs" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "jobs_customer_idx" ON "jobs" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_assigned_idx" ON "jobs" USING btree ("assigned_operator_id");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_job_idx" ON "messages" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "messages_customer_idx" ON "messages" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "messages_created_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sites_customer_idx" ON "sites" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sites_suburb_idx" ON "sites" USING btree ("suburb");--> statement-breakpoint
CREATE INDEX "uploads_job_idx" ON "uploads" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "uploads_message_idx" ON "uploads" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "visits_job_idx" ON "visits" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "visits_operator_idx" ON "visits" USING btree ("assigned_operator_id");--> statement-breakpoint
CREATE INDEX "visits_scheduled_idx" ON "visits" USING btree ("scheduled_start");