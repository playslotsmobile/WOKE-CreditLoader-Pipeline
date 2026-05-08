-- Add per-vendor cash-method allowlist (replaces hardcoded constants/cash.js)
ALTER TABLE "vendors" ADD COLUMN "cash_allowed" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: preserve existing access for the two vendors that had it.
UPDATE "vendors" SET "cash_allowed" = true WHERE "slug" IN ('alex', 'claudia');
