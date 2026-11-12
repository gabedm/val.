CREATE TABLE "paypal_subscription_links" (
  "id" text PRIMARY KEY,
  "owner_id" text NOT NULL REFERENCES "owners"("id"),
  "merchant" text NOT NULL CHECK ("merchant" IN ('A', 'B')),
  "subscription_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "custom_id" text NOT NULL,
  "service_id" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "paypal_subscription_links_remote" UNIQUE ("merchant", "subscription_id")
);
--> statement-breakpoint
CREATE INDEX "paypal_subscription_links_owner" ON "paypal_subscription_links" ("owner_id");
