CREATE TABLE "owner_review_batches" (
  "owner_id" text PRIMARY KEY REFERENCES "owners"("id"),
  "revision" integer NOT NULL,
  "service_ids" jsonb NOT NULL,
  "completed" jsonb NOT NULL,
  "failed" jsonb NOT NULL,
  "attempts" jsonb NOT NULL,
  "status" text NOT NULL,
  "current_service_id" text,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_token" text,
  "lease_until" timestamp with time zone
);
