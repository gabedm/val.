ALTER TABLE "application_deployment" ADD COLUMN "paypal_wallet_environment" text;
--> statement-breakpoint
CREATE TABLE "paypal_wallet_connections" (
  "owner_id" text PRIMARY KEY NOT NULL REFERENCES "owners"("id"),
  "environment" text NOT NULL,
  "phase" text NOT NULL,
  "secrets" text,
  "result" jsonb,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_token" text,
  "lease_until" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
