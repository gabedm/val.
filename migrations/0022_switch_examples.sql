CREATE TABLE "owner_switch_examples" (
  "owner_id" text PRIMARY KEY NOT NULL REFERENCES "owners"("id"),
  "example_owner_id" text NOT NULL UNIQUE REFERENCES "owners"("id"),
  "session_id" text NOT NULL UNIQUE,
  "provider_origin" text NOT NULL,
  "company" text NOT NULL,
  "purpose" text NOT NULL,
  "switch_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
