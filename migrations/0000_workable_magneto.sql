CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"scenario" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"initial_account_id" text NOT NULL,
	"replacement_account_id" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_id_owner" UNIQUE("id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"operation_id" text,
	"provider_id" text,
	"account_id" text,
	"plan_id" text,
	"entitlement_revision" integer,
	"kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"artifact_id" text,
	"summary" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"event_id" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"status" text NOT NULL,
	"claim_owner" text,
	"claim_generation" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_case_event_revision" UNIQUE("case_id","event_id","policy_revision")
);
--> statement-breakpoint
CREATE TABLE "operation_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"claim_generation" integer NOT NULL,
	"http_status" integer,
	"body" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"transition_id" text,
	"kind" text NOT NULL,
	"operation_key" text NOT NULL,
	"target_id" text,
	"status" text NOT NULL,
	"claim_generation" integer DEFAULT 0 NOT NULL,
	"claim_owner" text,
	"lease_expires_at" timestamp with time zone,
	"request_id" text,
	"request_body" text,
	"authority_hash" text,
	"return_token_hash" text,
	"remote_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"result_evidence_id" text,
	"merchant" text NOT NULL,
	"plan_id" text NOT NULL,
	"custom_id" text NOT NULL,
	"approval_url" text,
	"billing_status" text,
	"payment_status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"note" text,
	"probe" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "operations_id_case" UNIQUE("id","case_id")
);
--> statement-breakpoint
CREATE TABLE "owner_cookies" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"role" text,
	"owner_id" text,
	"csrf_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant" text NOT NULL,
	"event_id" text,
	"event_type" text,
	"verified" boolean NOT NULL,
	"rejection_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_operation_id_case_id_operations_id_case_id_fk" FOREIGN KEY ("operation_id","case_id") REFERENCES "public"."operations"("id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_observations" ADD CONSTRAINT "operation_observations_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_case_id_owner_id_cases_id_owner_id_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "public"."cases"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_cookies" ADD CONSTRAINT "owner_cookies_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_owner" ON "cases" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "evidence_case" ON "evidence" USING btree ("case_id","observed_at");--> statement-breakpoint
CREATE INDEX "jobs_pending" ON "jobs" USING btree ("created_at") WHERE "jobs"."status" in ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "operations_unresolved" ON "operations" USING btree ("status") WHERE "operations"."status" in ('PLANNED', 'IN_FLIGHT', 'UNKNOWN');--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_verified" ON "webhook_events" USING btree ("merchant","event_id") WHERE "webhook_events"."verified";