-- AlterEnum
ALTER TYPE "delivery_status" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "endpoints" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6);
