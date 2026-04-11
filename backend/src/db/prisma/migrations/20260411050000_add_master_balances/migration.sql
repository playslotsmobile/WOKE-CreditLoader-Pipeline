-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'BLOCKED_LOW_MASTER';

-- CreateTable
CREATE TABLE "master_balances" (
    "id" SERIAL NOT NULL,
    "platform" "Platform" NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL,
    "tier" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "master_balances_platform_checked_at_idx" ON "master_balances"("platform", "checked_at" DESC);
