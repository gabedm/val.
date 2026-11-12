CREATE TABLE "paypal_wallet_reviews" (
  "owner_id" text NOT NULL REFERENCES "owners"("id"),
  "environment" text NOT NULL CHECK ("environment" IN ('sandbox', 'live')),
  "payment_key" text NOT NULL CHECK ("payment_key" ~ '^[a-f0-9]{64}$'),
  "choice" text NOT NULL CHECK ("choice" IN ('month', 'year', '30_days', 'not_recurring', 'later')),
  "revision" integer NOT NULL CHECK ("revision" BETWEEN 1 AND 2000000000),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("owner_id", "environment", "payment_key")
);
--> statement-breakpoint
INSERT INTO "paypal_wallet_reviews" ("owner_id", "environment", "payment_key", "choice", "revision")
SELECT connection."owner_id", connection."environment", candidate->>'key', candidate->>'choice', 1
FROM "paypal_wallet_connections" connection
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(connection."result"->'candidates') = 'array'
    THEN connection."result"->'candidates' ELSE '[]'::jsonb END
) candidate
WHERE connection."environment" IN ('sandbox', 'live')
  AND candidate->>'key' ~ '^[a-f0-9]{64}$'
  AND candidate->>'choice' IN ('month', 'year', '30_days', 'not_recurring', 'later')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "paypal_wallet_reviews" ("owner_id", "environment", "payment_key", "choice", "revision")
SELECT portfolio."owner_id", deployment."paypal_wallet_environment", item->'paypalEvidence'->>'key',
  CASE WHEN item->'paypalEvidence'->>'excludedByOwner' = 'true' THEN 'later' ELSE item->>'cycle' END, 1
FROM "owner_subscriptions" portfolio
CROSS JOIN "application_deployment" deployment
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(portfolio."subscriptions") = 'array'
    THEN portfolio."subscriptions" ELSE '[]'::jsonb END
) item
WHERE deployment."id" = 'primary'
  AND deployment."paypal_wallet_environment" IN ('sandbox', 'live')
  AND item->'paypalEvidence'->>'key' ~ '^[a-f0-9]{64}$'
  AND (
    item->'paypalEvidence'->>'excludedByOwner' = 'true'
    OR (item->'paypalEvidence'->>'cycleBasis' = 'owner_confirmation'
      AND item->>'cycle' IN ('month', 'year', '30_days'))
  )
ON CONFLICT DO NOTHING;
