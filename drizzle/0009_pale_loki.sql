CREATE TABLE "sem_signed_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"patch_id" text NOT NULL,
	"bundle_version" smallint DEFAULT 1 NOT NULL,
	"signer_bca" varchar(45) NOT NULL,
	"signer_pubkey_hex" varchar(66) NOT NULL,
	"signer_cert_id" varchar(64),
	"recipient_bca" varchar(45),
	"recipient_pubkey_hex" varchar(66),
	"recipient_cert_id" varchar(64),
	"signature" varchar(144) NOT NULL,
	"signed_at" timestamp NOT NULL,
	"direction" varchar(10) NOT NULL,
	"verified" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "sem_object_patches" ADD COLUMN "timestamp" bigint;--> statement-breakpoint
ALTER TABLE "sem_object_patches" ADD COLUMN "facet_id" text;--> statement-breakpoint
ALTER TABLE "sem_object_patches" ADD COLUMN "facet_capabilities" integer[];--> statement-breakpoint
ALTER TABLE "sem_object_patches" ADD COLUMN "lexicon" varchar(100);--> statement-breakpoint
ALTER TABLE "sem_signed_bundles" ADD CONSTRAINT "sem_signed_bundles_patch_id_sem_object_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."sem_object_patches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sem_signed_bundles_patch_idx" ON "sem_signed_bundles" USING btree ("patch_id");--> statement-breakpoint
CREATE INDEX "sem_signed_bundles_direction_idx" ON "sem_signed_bundles" USING btree ("direction");--> statement-breakpoint
ALTER TABLE "sem_signed_bundles"
  ADD CONSTRAINT sem_signed_bundles_direction_check
  CHECK (direction IN ('inbound', 'outbound'));