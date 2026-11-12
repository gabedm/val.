CREATE TABLE "owner_subscription_switches" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL REFERENCES "owners"("id"),
  "revision" integer DEFAULT 1 NOT NULL,
  "phase" text NOT NULL,
  "state" jsonb NOT NULL,
  "secrets" text,
  "browser_slots" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_token" text,
  "lease_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "owner_subscription_switches_owner" ON "owner_subscription_switches" ("owner_id", "created_at");
CREATE UNIQUE INDEX "owner_subscription_switches_active" ON "owner_subscription_switches" ("owner_id")
WHERE "phase" NOT IN ('completed', 'stopped')
OR ("state"->>'purchaseDispatchedAt' IS NOT NULL AND "state"->'newProof' = 'null'::jsonb)
OR ("state"->>'cancelDispatchedAt' IS NOT NULL AND "state"->'oldProof' = 'null'::jsonb);
