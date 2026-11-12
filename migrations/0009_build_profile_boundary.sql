CREATE TABLE "application_deployment" (
  "id" text PRIMARY KEY NOT NULL,
  "profile" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
