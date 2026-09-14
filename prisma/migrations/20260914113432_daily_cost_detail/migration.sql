-- AlterTable
ALTER TABLE "daily_line_cost" ADD COLUMN     "foc_kg" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "from_convention" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "spans_days" INTEGER NOT NULL DEFAULT 1;
