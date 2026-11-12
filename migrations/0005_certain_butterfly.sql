CREATE TABLE "login_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"session_id_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "login_attempts_session_id_hash_unique" UNIQUE("session_id_hash")
);
--> statement-breakpoint
CREATE TABLE "login_identities" (
	"subject_hash" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_session_id_hash_sessions_id_hash_fk" FOREIGN KEY ("session_id_hash") REFERENCES "public"."sessions"("id_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_identities" ADD CONSTRAINT "login_identities_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;