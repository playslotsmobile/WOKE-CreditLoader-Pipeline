-- AlterTable
ALTER TABLE "vendor_accounts" ADD COLUMN     "chain_to_acc_id" INTEGER,
ADD COLUMN     "load_type" TEXT NOT NULL DEFAULT 'vendor',
ADD COLUMN     "parent_vendor_acc_id" INTEGER;
