-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('PLAY777', 'ICONNECT');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('REQUESTED', 'PENDING', 'PAID', 'LOADING', 'LOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "LoadJobStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "vendors" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "qb_customer_id" TEXT NOT NULL,
    "telegram_chat_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_accounts" (
    "id" SERIAL NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "platform" "Platform" NOT NULL,
    "username" TEXT NOT NULL,
    "operator_id" TEXT,
    "rate" DECIMAL(5,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" SERIAL NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "qb_invoice_id" TEXT,
    "method" TEXT NOT NULL,
    "base_amount" DECIMAL(10,2) NOT NULL,
    "fee_amount" DECIMAL(10,2) NOT NULL,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'REQUESTED',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "loaded_at" TIMESTAMP(3),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_allocations" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "vendor_account_id" INTEGER NOT NULL,
    "dollar_amount" DECIMAL(10,2) NOT NULL,
    "credits" INTEGER NOT NULL,

    CONSTRAINT "invoice_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_jobs" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "vendor_account_id" INTEGER NOT NULL,
    "credits_amount" INTEGER NOT NULL,
    "status" "LoadJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "load_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendors_slug_key" ON "vendors"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- AddForeignKey
ALTER TABLE "vendor_accounts" ADD CONSTRAINT "vendor_accounts_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_allocations" ADD CONSTRAINT "invoice_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_allocations" ADD CONSTRAINT "invoice_allocations_vendor_account_id_fkey" FOREIGN KEY ("vendor_account_id") REFERENCES "vendor_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_jobs" ADD CONSTRAINT "load_jobs_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_jobs" ADD CONSTRAINT "load_jobs_vendor_account_id_fkey" FOREIGN KEY ("vendor_account_id") REFERENCES "vendor_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
