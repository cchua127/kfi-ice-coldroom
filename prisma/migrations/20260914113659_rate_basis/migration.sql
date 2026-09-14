-- AlterTable
ALTER TABLE "daily_line_cost" ADD COLUMN     "rate_basis" TEXT NOT NULL DEFAULT 'CONFIRMED_BILL';
