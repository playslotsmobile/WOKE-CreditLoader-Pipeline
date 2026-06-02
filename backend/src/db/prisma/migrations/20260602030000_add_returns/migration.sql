-- Payment returns / chargebacks tracking.
-- Returns surface only in QuickBooks Payments (card processor) and leave no
-- trace in the QB Accounting API, so rows here are recorded via manual flag
-- or QBO web-scrape detection. Each row = cash clawed back + credits already
-- delivered (unrecoverable).
CREATE TABLE "returns" (
  "id"            SERIAL PRIMARY KEY,
  "invoice_id"    INTEGER,
  "qb_invoice_id" TEXT NOT NULL,
  "vendor_id"     INTEGER,
  "vendor_name"   TEXT NOT NULL,
  "business_name" TEXT,
  "amount_lost"   DECIMAL(10,2) NOT NULL,
  "credits_lost"  INTEGER NOT NULL DEFAULT 0,
  "method"        TEXT,
  "return_date"   TIMESTAMP(3),
  "detected_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source"        TEXT NOT NULL DEFAULT 'manual',
  "acknowledged"  BOOLEAN NOT NULL DEFAULT false,
  "note"          TEXT
);

-- One return record per QB invoice — natural dedup so alerts fire once.
CREATE UNIQUE INDEX "returns_qb_invoice_id_key" ON "returns"("qb_invoice_id");
CREATE INDEX "returns_vendor_id_idx" ON "returns"("vendor_id");

ALTER TABLE "returns"
  ADD CONSTRAINT "returns_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "returns"
  ADD CONSTRAINT "returns_vendor_id_fkey"
  FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
