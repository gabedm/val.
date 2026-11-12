ALTER TABLE "application_deployment" ADD COLUMN "worker_generation" integer;
--> statement-breakpoint
ALTER TABLE "application_deployment" ADD COLUMN "worker_revision" text;
