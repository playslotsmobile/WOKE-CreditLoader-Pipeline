-- CreateTable
CREATE TABLE "credit_lines" (
    "id" SERIAL NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "cap_amount" DECIMAL(10,2) NOT NULL,
    "used_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_line_transactions" (
    "id" SERIAL NOT NULL,
    "credit_line_id" INTEGER NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "balance_before" DECIMAL(10,2) NOT NULL,
    "balance_after" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_line_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_lines_vendor_id_key" ON "credit_lines"("vendor_id");

-- CreateIndex
CREATE INDEX "credit_line_transactions_credit_line_id_idx" ON "credit_line_transactions"("credit_line_id");

-- CreateIndex
CREATE INDEX "credit_line_transactions_invoice_id_idx" ON "credit_line_transactions"("invoice_id");

-- AddForeignKey
ALTER TABLE "credit_lines" ADD CONSTRAINT "credit_lines_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_line_transactions" ADD CONSTRAINT "credit_line_transactions_credit_line_id_fkey" FOREIGN KEY ("credit_line_id") REFERENCES "credit_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_line_transactions" ADD CONSTRAINT "credit_line_transactions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
