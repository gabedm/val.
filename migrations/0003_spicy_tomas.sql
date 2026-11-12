ALTER TABLE "agent_runs" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "advisory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "advisory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "advisory" boolean DEFAULT false NOT NULL;