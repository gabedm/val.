CREATE TABLE "owner_price_checks" (
  "owner_id" text NOT NULL REFERENCES "owners"("id"),
  "service_id" text NOT NULL,
  "revision" integer NOT NULL,
  "cadence" jsonb,
  "anchor_at" timestamptz NOT NULL,
  "next_check_at" timestamptz,
  "retry_at" timestamptz,
  "last_checked_at" timestamptz,
  "status" text NOT NULL,
  "advice" jsonb,
  "advice_revision" integer,
  "lease_token" text,
  "lease_until" timestamptz,
  PRIMARY KEY ("owner_id", "service_id")
);
CREATE INDEX "owner_price_checks_due" ON "owner_price_checks" ("next_check_at");
