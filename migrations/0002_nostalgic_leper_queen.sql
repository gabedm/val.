CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"task" text NOT NULL,
	"policy_revision" integer,
	"version" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"trace" jsonb NOT NULL,
	"output" jsonb,
	"usage" jsonb NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"purpose" text NOT NULL,
	"draft" jsonb NOT NULL,
	"agent_run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "evaluation" jsonb;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "agent_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_drafts" ADD CONSTRAINT "policy_drafts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;