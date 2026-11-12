CREATE TABLE "subscription_product_profiles" (
  "key" text PRIMARY KEY NOT NULL, "version" text NOT NULL, "profile" jsonb NOT NULL, "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_recognized_services" (
  "owner_id" text NOT NULL REFERENCES "owners"("id"), "service_id" text NOT NULL, "name" text NOT NULL, "profile" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL, PRIMARY KEY("owner_id", "service_id")
);
