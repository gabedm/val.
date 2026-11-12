CREATE TABLE "judge_demo_access" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_demo_owners" (
  "owner_id" text PRIMARY KEY NOT NULL REFERENCES "owners"("id"),
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_demo_counters" (
  "key" text PRIMARY KEY NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "used_micros" integer DEFAULT 0 NOT NULL,
  "window_started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_demo_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL REFERENCES "owners"("id"),
  "reserved_micros" integer NOT NULL,
  "charged_micros" integer NOT NULL,
  "state" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "judge_demo_requests_owner_created" ON "judge_demo_requests" ("owner_id", "created_at");
