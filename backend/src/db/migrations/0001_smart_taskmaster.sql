ALTER TYPE "conversation_status" ADD VALUE 'extracting';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "extraction_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "extraction_attempts" integer DEFAULT 0 NOT NULL;