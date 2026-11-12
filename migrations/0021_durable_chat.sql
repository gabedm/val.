CREATE TABLE "owner_chat_requests" (
  "owner_id" text NOT NULL REFERENCES "owners"("id"),
  "id" text NOT NULL,
  "command_hash" text NOT NULL,
  "command" jsonb NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('queued','running','complete','failed')),
  "progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reply" jsonb,
  "error" jsonb,
  "attempts" integer DEFAULT 0 NOT NULL,
  "review_id" text,
  "lease_token" text,
  "lease_until" timestamp with time zone,
  "worker_revision" text,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("owner_id", "id")
);
CREATE INDEX "owner_chat_requests_queue" ON "owner_chat_requests" ("status", "next_attempt_at");
CREATE INDEX "owner_chat_requests_owner" ON "owner_chat_requests" ("owner_id", "created_at");
CREATE UNIQUE INDEX "owner_chat_requests_active" ON "owner_chat_requests" ("owner_id") WHERE "status" IN ('queued','running');
CREATE TABLE "chat_model_health" (
  "model" text PRIMARY KEY NOT NULL,
  "failures" integer DEFAULT 0 NOT NULL,
  "open_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
