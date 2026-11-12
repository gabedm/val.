CREATE TABLE "consents" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text NOT NULL,
	"preview_id" text NOT NULL,
	"preview_hash" text NOT NULL,
	"approve_purchase" boolean NOT NULL,
	"approve_old_exit_after_readiness" boolean NOT NULL,
	"consumed_by_operation_id" text,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"candidate_id" text NOT NULL,
	"entitlement_revision" integer NOT NULL,
	"result" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exit_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text NOT NULL,
	"transition_id" text NOT NULL,
	"review_id" text NOT NULL,
	"review_hash" text NOT NULL,
	"approve_remaining_exits" boolean NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exit_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"transition_id" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"material_terms" jsonb NOT NULL,
	"readiness_evidence_ids" jsonb NOT NULL,
	"hash_payload" text NOT NULL,
	"review_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"revision" integer NOT NULL,
	"purpose" text NOT NULL,
	"required_capabilities" jsonb NOT NULL,
	"recurring_ceiling_minor" integer NOT NULL,
	"preserve_history" boolean NOT NULL,
	"allow_investigation" boolean NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_case_revision" UNIQUE("case_id","revision")
);
--> statement-breakpoint
CREATE TABLE "previews" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"recommendation_id" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"material_terms" jsonb NOT NULL,
	"hash_payload" text NOT NULL,
	"preview_hash" text NOT NULL,
	"backup_evidence_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"plan_id" text,
	"subscription_id" text,
	"entitlement_revision" integer NOT NULL,
	"public_speaker_labels" boolean NOT NULL,
	"account_speaker_labels" boolean NOT NULL,
	"history_retained" boolean NOT NULL,
	"access_status" text NOT NULL,
	"paid_through" timestamp with time zone,
	"access_ends_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_transcripts" (
	"account_id" text NOT NULL,
	"id" text NOT NULL,
	"title" text NOT NULL,
	"turns" jsonb NOT NULL,
	CONSTRAINT "provider_transcripts_account_id_id_pk" PRIMARY KEY("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"revision" integer NOT NULL,
	"recurring_minor" integer NOT NULL,
	"due_now_minor" integer NOT NULL,
	"evidence_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"action" text NOT NULL,
	"candidate_id" text,
	"evidence_ids" jsonb NOT NULL,
	"explanation" text NOT NULL,
	"uncertainties" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"exit_authorization_id" text,
	"state" text NOT NULL,
	"old_subscription_id" text NOT NULL,
	"accepted_policy_revision" integer NOT NULL,
	"accepted_purchase_terms" jsonb NOT NULL,
	"capability_status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"capability_evidence_id" text,
	"history_status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"history_evidence_id" text,
	"exits_paused_at" timestamp with time zone,
	"last_error" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transitions_consent_id_unique" UNIQUE("consent_id")
);
--> statement-breakpoint
ALTER TABLE "operations" ALTER COLUMN "custom_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "faults" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_preview_id_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."previews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_authorizations" ADD CONSTRAINT "exit_authorizations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_authorizations" ADD CONSTRAINT "exit_authorizations_transition_id_transitions_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."transitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_authorizations" ADD CONSTRAINT "exit_authorizations_review_id_exit_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."exit_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_reviews" ADD CONSTRAINT "exit_reviews_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_reviews" ADD CONSTRAINT "exit_reviews_transition_id_transitions_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."transitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_transcripts" ADD CONSTRAINT "provider_transcripts_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transitions" ADD CONSTRAINT "transitions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transitions" ADD CONSTRAINT "transitions_consent_id_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transitions_one_open_per_case" ON "transitions" USING btree ("case_id") WHERE "transitions"."closed_at" is null;