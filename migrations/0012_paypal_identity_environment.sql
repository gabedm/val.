ALTER TABLE "application_deployment" ADD COLUMN "paypal_identity_environment" text DEFAULT 'sandbox' NOT NULL;
--> statement-breakpoint
ALTER TABLE "application_deployment" ADD CONSTRAINT "paypal_identity_environment_valid" CHECK ("paypal_identity_environment" IN ('sandbox', 'live'));
