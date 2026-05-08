-- #14: Move per-invoice credit-line repayment intent from Setting kv to a typed column.
ALTER TABLE "invoices" ADD COLUMN "credit_line_repayment_intent" DECIMAL(10,2);

-- Backfill from existing Setting rows. Keys look like "credit_line_repayment_<invoiceId>".
UPDATE "invoices" i
SET "credit_line_repayment_intent" = CAST(s."value" AS DECIMAL(10,2))
FROM "settings" s
WHERE s."key" = 'credit_line_repayment_' || i."id";

-- Old Setting rows are left in place so a rollback to old code keeps working.
-- A separate cleanup migration removes them once we're confident in the new path.

-- #29: ProcessedWebhook is keyed only by paymentId, but a single QB Payment
-- can link multiple Invoices. The original unique blocked legitimate
-- per-invoice tracking on multi-invoice payments. Switch to a composite unique.
ALTER TABLE "processed_webhooks" DROP CONSTRAINT IF EXISTS "processed_webhooks_payment_id_key";
DROP INDEX IF EXISTS "processed_webhooks_payment_id_key";

-- New constraint: same payment can be processed once per invoice.
-- invoice_id is currently nullable; treat NULL as a distinct slot per row
-- by using a partial unique. Postgres treats NULLs as distinct in unique
-- indexes, so the simple two-column unique already covers this correctly.
ALTER TABLE "processed_webhooks"
  ADD CONSTRAINT "processed_webhooks_payment_invoice_unique"
  UNIQUE ("payment_id", "invoice_id");
