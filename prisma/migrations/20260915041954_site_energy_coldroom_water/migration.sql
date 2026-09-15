-- CreateEnum
CREATE TYPE "EnergyUseCode" AS ENUM ('BRINE_COMPRESSOR', 'COLDROOM_TENANT', 'COLDROOM_ICE_STORE', 'WATER_DELIVERED', 'WATER_ICE_FEED', 'OFFICE_CCTV', 'CRUSHER');

-- AlterTable
ALTER TABLE "water_delivery" ADD COLUMN     "retail_m3" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "energy_use" (
    "id" SERIAL NOT NULL,
    "code" "EnergyUseCode" NOT NULL,
    "name" TEXT NOT NULL,
    "name_bm" TEXT,
    "counts_as_ice" BOOLEAN NOT NULL,
    "note" TEXT NOT NULL,

    CONSTRAINT "energy_use_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_energy_use" (
    "id" BIGSERIAL NOT NULL,
    "cost_date" DATE NOT NULL,
    "use_code" "EnergyUseCode" NOT NULL,
    "kwh" DECIMAL(14,2) NOT NULL,
    "kwh_source" "KwhSource" NOT NULL,
    "basis" TEXT NOT NULL,
    "rate_rm_per_kwh" DECIMAL(8,5) NOT NULL,
    "rate_basis" TEXT NOT NULL DEFAULT 'CONFIRMED_BILL',
    "cost_rm" DECIMAL(14,2) NOT NULL,
    "status" "CostStatus" NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_energy_use_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coldroom_monthly" (
    "period_month" DATE NOT NULL,
    "metered_kwh" DECIMAL(14,2),
    "ratono_rm" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "yemint_rm" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "ice_store_invoiced_rm" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "coldroom_monthly_pkey" PRIMARY KEY ("period_month")
);

-- CreateIndex
CREATE UNIQUE INDEX "energy_use_code_key" ON "energy_use"("code");

-- CreateIndex
CREATE INDEX "daily_energy_use_cost_date_idx" ON "daily_energy_use"("cost_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_energy_use_cost_date_use_code_key" ON "daily_energy_use"("cost_date", "use_code");

-- AddForeignKey
ALTER TABLE "daily_energy_use" ADD CONSTRAINT "daily_energy_use_use_code_fkey" FOREIGN KEY ("use_code") REFERENCES "energy_use"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
