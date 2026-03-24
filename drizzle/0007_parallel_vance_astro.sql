CREATE TYPE "public"."sem_channel_kind" AS ENUM('participant_pair', 'group', 'system');--> statement-breakpoint
CREATE TYPE "public"."sem_identity_kind" AS ENUM('customer', 'admin', 'operator', 'external', 'ai');--> statement-breakpoint
CREATE TYPE "public"."sem_participant_role" AS ENUM('creator', 'contributor', 'approver', 'observer', 'executor');--> statement-breakpoint
ALTER TYPE "public"."sem_evidence_kind" ADD VALUE 'selection';--> statement-breakpoint
CREATE TABLE "sem_access_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"vertical" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"version" integer NOT NULL,
	"role_rules" jsonb NOT NULL,
	"override_hierarchy" jsonb NOT NULL,
	"ai_context_filter" jsonb NOT NULL,
	"is_template" boolean DEFAULT true NOT NULL,
	"source_template_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"tuning_locked" boolean DEFAULT false NOT NULL,
	"tuned_from_version" integer,
	"created_by" varchar(100),
	"change_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_channel_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"field_overrides" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"channel_kind" "sem_channel_kind" NOT NULL,
	"label" varchar(100),
	"participant_ids" jsonb NOT NULL,
	"edge_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sem_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"identity_ref" text NOT NULL,
	"identity_kind" "sem_identity_kind" NOT NULL,
	"participant_role" "sem_participant_role" NOT NULL,
	"display_name" varchar(255),
	"invited_by" text,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "sem_evidence_items" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "sem_channels" ADD CONSTRAINT "sem_channels_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sem_participants" ADD CONSTRAINT "sem_participants_object_id_sem_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."sem_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sem_access_policies_uniq" ON "sem_access_policies" USING btree ("vertical","name","version");--> statement-breakpoint
CREATE INDEX "sem_access_policies_active_idx" ON "sem_access_policies" USING btree ("vertical","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "sem_channel_policies_uniq" ON "sem_channel_policies" USING btree ("channel_id","participant_id");--> statement-breakpoint
CREATE INDEX "sem_channel_policies_channel_idx" ON "sem_channel_policies" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "sem_channels_object_idx" ON "sem_channels" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_channels_active_idx" ON "sem_channels" USING btree ("object_id","is_active");--> statement-breakpoint
CREATE INDEX "sem_participants_object_idx" ON "sem_participants" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "sem_participants_identity_idx" ON "sem_participants" USING btree ("identity_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "sem_participants_uniq" ON "sem_participants" USING btree ("object_id","identity_ref");--> statement-breakpoint
CREATE INDEX "messages_channel_idx" ON "messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "sem_evidence_channel_idx" ON "sem_evidence_items" USING btree ("channel_id");