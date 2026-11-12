CREATE TABLE "owner_subscriptions" (
  "owner_id" text PRIMARY KEY REFERENCES "owners"("id"),
  "revision" integer NOT NULL,
  "subscriptions" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_subscription_reviews" (
  "id" text PRIMARY KEY,
  "owner_id" text NOT NULL REFERENCES "owners"("id"),
  "portfolio_revision" integer NOT NULL,
  "service_id" text NOT NULL,
  "version" jsonb NOT NULL,
  "input" jsonb NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
