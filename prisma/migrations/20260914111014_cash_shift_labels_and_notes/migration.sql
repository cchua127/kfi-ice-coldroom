/*
  Warnings:

  - You are about to drop the column `shift_m` on the `cash_sales_daily` table. All the data in the column will be lost.
  - You are about to drop the column `shift_n` on the `cash_sales_daily` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "cash_sales_daily" DROP COLUMN "shift_m",
DROP COLUMN "shift_n",
ADD COLUMN     "shift_1" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "shift_2" DECIMAL(12,2) NOT NULL DEFAULT 0;
