ALTER TABLE "paypal_wallet_connections" ADD COLUMN "browser_reserved" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "paypal_wallet_connections" SET "browser_reserved" = true WHERE "phase" NOT IN ('queued', 'complete', 'disconnected');
