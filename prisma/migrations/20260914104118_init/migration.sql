-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STAFF', 'MANAGER');

-- CreateEnum
CREATE TYPE "LineCode" AS ENUM ('TUBE', 'BIG_POOL', 'BIMC', 'SMALL_POOL');

-- CreateEnum
CREATE TYPE "UnitCode" AS ENUM ('BAG', 'TONG', 'BARIS', 'SMALL_TONG', 'BLOK');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('PASAR', 'OUTSIDE', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "Shift" AS ENUM ('M', 'N', 'UNSPLIT');

-- CreateEnum
CREATE TYPE "QuantitySource" AS ENUM ('COUNTED', 'CONVENTION');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('TNB_BILL', 'SUPPLIER_DO', 'OTHER');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "CostStatus" AS ENUM ('PROVISIONAL', 'FINAL');

-- CreateEnum
CREATE TYPE "KwhSource" AS ENUM ('METERED', 'MODELLED');

-- CreateTable
CREATE TABLE "app_user" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMPTZ(6),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_log" (
    "id" BIGSERIAL NOT NULL,
    "table_name" TEXT NOT NULL,
    "row_pk" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "changed_by" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_line" (
    "id" SERIAL NOT NULL,
    "code" "LineCode" NOT NULL,
    "name" TEXT NOT NULL,
    "name_bm" TEXT,
    "active_from" DATE NOT NULL,
    "active_to" DATE,

    CONSTRAINT "production_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_unit" (
    "id" SERIAL NOT NULL,
    "line_id" INTEGER NOT NULL,
    "unit_code" "UnitCode" NOT NULL,
    "kg_per_unit" DECIMAL(10,3),
    "effective_from" DATE NOT NULL,
    "note" TEXT,

    CONSTRAINT "production_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tnb_account" (
    "id" SERIAL NOT NULL,
    "account_no" TEXT NOT NULL,
    "lot" TEXT,
    "declared_kw" DECIMAL(10,2),
    "deposit_rm" DECIMAL(14,2),
    "description" TEXT,

    CONSTRAINT "tnb_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "meter_no" TEXT,
    "line_id" INTEGER,
    "tnb_account_id" INTEGER,
    "ct_multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "digits" INTEGER NOT NULL DEFAULT 7,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,

    CONSTRAINT "meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kg_per_unit" DECIMAL(10,3),

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "note" TEXT,

    CONSTRAINT "price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_assumption" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "note" TEXT,
    "measured" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "cost_assumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "afa_rate" (
    "id" SERIAL NOT NULL,
    "period_month" DATE NOT NULL,
    "rate_per_kwh" DECIMAL(8,4) NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,

    CONSTRAINT "afa_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_reading" (
    "id" BIGSERIAL NOT NULL,
    "reading_date" DATE NOT NULL,
    "meter_id" INTEGER NOT NULL,
    "closing" DECIMAL(14,2) NOT NULL,
    "rollover" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "entered_by" INTEGER,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meter_reading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_daily" (
    "id" BIGSERIAL NOT NULL,
    "prod_date" DATE NOT NULL,
    "line_id" INTEGER NOT NULL,
    "shift" "Shift" NOT NULL DEFAULT 'UNSPLIT',
    "unit_code" "UnitCode" NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "foc_quantity" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tong_kosong" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "quantity_source" "QuantitySource" NOT NULL DEFAULT 'COUNTED',
    "note" TEXT,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "production_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_sales_daily" (
    "sale_date" DATE NOT NULL,
    "shift_m" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shift_n" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cash_sales_daily_pkey" PRIMARY KEY ("sale_date")
);

-- CreateTable
CREATE TABLE "outside_sale" (
    "id" BIGSERIAL NOT NULL,
    "sale_date" DATE NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outside_sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ice_purchase" (
    "id" BIGSERIAL NOT NULL,
    "buy_date" DATE NOT NULL,
    "supplier_id" INTEGER NOT NULL,
    "do_no" TEXT,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ice_purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "water_delivery" (
    "id" BIGSERIAL NOT NULL,
    "period_month" DATE NOT NULL,
    "tonnes" DECIMAL(12,2) NOT NULL,
    "note" TEXT,

    CONSTRAINT "water_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" BIGSERIAL NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_size" INTEGER,
    "uploaded_by" INTEGER,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tnb_bill" (
    "id" BIGSERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "invoice_no" TEXT,
    "bill_date" DATE,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "days" INTEGER,
    "kwh" DECIMAL(14,2) NOT NULL,
    "energy_rate" DECIMAL(8,4),
    "energy_rm" DECIMAL(14,2),
    "afa_rate_per_kwh" DECIMAL(8,4),
    "afa_rm" DECIMAL(14,2),
    "capacity_rate" DECIMAL(8,4),
    "capacity_rm" DECIMAL(14,2),
    "network_rate" DECIMAL(8,4),
    "network_rm" DECIMAL(14,2),
    "retail_rm" DECIMAL(14,2),
    "rebate_rate" DECIMAL(8,4),
    "rebate_rm" DECIMAL(14,2),
    "current_usage_rm" DECIMAL(14,2),
    "kwtbb_rm" DECIMAL(14,2),
    "sst_rm" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "current_charges_rm" DECIMAL(14,2),
    "previous_balance_rm" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rounding_rm" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_rm" DECIMAL(14,2) NOT NULL,
    "declared_kw" DECIMAL(10,2),
    "max_demand_kw" DECIMAL(10,2),
    "load_factor" DECIMAL(5,3),
    "power_factor" DECIMAL(5,3),
    "document_id" BIGINT,
    "parsed_json" JSONB,
    "status" "BillStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "confirmed_by" INTEGER,
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "tnb_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tnb_bill_meter_reading" (
    "id" BIGSERIAL NOT NULL,
    "bill_id" BIGINT NOT NULL,
    "meter_no" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "previous" DECIMAL(14,2) NOT NULL,
    "current" DECIMAL(14,2) NOT NULL,
    "usage" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "tnb_bill_meter_reading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_line_cost" (
    "id" BIGSERIAL NOT NULL,
    "cost_date" DATE NOT NULL,
    "line_id" INTEGER NOT NULL,
    "kwh" DECIMAL(14,2) NOT NULL,
    "kwh_source" "KwhSource" NOT NULL,
    "kg" DECIMAL(14,2) NOT NULL,
    "rate_rm_per_kwh" DECIMAL(8,5) NOT NULL,
    "cost_rm" DECIMAL(14,2) NOT NULL,
    "status" "CostStatus" NOT NULL,
    "bill_id" BIGINT,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_line_cost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "change_log_table_name_row_pk_idx" ON "change_log"("table_name", "row_pk");

-- CreateIndex
CREATE INDEX "change_log_changed_at_idx" ON "change_log"("changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "production_line_code_key" ON "production_line"("code");

-- CreateIndex
CREATE UNIQUE INDEX "production_unit_line_id_unit_code_effective_from_key" ON "production_unit"("line_id", "unit_code", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "tnb_account_account_no_key" ON "tnb_account"("account_no");

-- CreateIndex
CREATE UNIQUE INDEX "meter_code_key" ON "meter"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customer_name_key" ON "customer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "product_code_key" ON "product"("code");

-- CreateIndex
CREATE UNIQUE INDEX "price_customer_id_product_id_effective_from_key" ON "price"("customer_id", "product_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "cost_assumption_key_effective_from_key" ON "cost_assumption"("key", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "afa_rate_period_month_key" ON "afa_rate"("period_month");

-- CreateIndex
CREATE INDEX "meter_reading_meter_id_reading_date_idx" ON "meter_reading"("meter_id", "reading_date");

-- CreateIndex
CREATE UNIQUE INDEX "meter_reading_reading_date_meter_id_key" ON "meter_reading"("reading_date", "meter_id");

-- CreateIndex
CREATE INDEX "production_daily_prod_date_idx" ON "production_daily"("prod_date");

-- CreateIndex
CREATE UNIQUE INDEX "production_daily_prod_date_line_id_shift_unit_code_key" ON "production_daily"("prod_date", "line_id", "shift", "unit_code");

-- CreateIndex
CREATE INDEX "outside_sale_sale_date_idx" ON "outside_sale"("sale_date");

-- CreateIndex
CREATE UNIQUE INDEX "outside_sale_sale_date_customer_id_product_id_key" ON "outside_sale"("sale_date", "customer_id", "product_id");

-- CreateIndex
CREATE INDEX "ice_purchase_buy_date_idx" ON "ice_purchase"("buy_date");

-- CreateIndex
CREATE UNIQUE INDEX "water_delivery_period_month_key" ON "water_delivery"("period_month");

-- CreateIndex
CREATE UNIQUE INDEX "document_sha256_key" ON "document"("sha256");

-- CreateIndex
CREATE INDEX "tnb_bill_period_start_period_end_idx" ON "tnb_bill"("period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "tnb_bill_account_id_period_start_period_end_key" ON "tnb_bill"("account_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "tnb_bill_meter_reading_bill_id_meter_no_unit_key" ON "tnb_bill_meter_reading"("bill_id", "meter_no", "unit");

-- CreateIndex
CREATE INDEX "daily_line_cost_cost_date_idx" ON "daily_line_cost"("cost_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_line_cost_cost_date_line_id_key" ON "daily_line_cost"("cost_date", "line_id");

-- AddForeignKey
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_unit" ADD CONSTRAINT "production_unit_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "production_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "production_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_tnb_account_id_fkey" FOREIGN KEY ("tnb_account_id") REFERENCES "tnb_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price" ADD CONSTRAINT "price_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price" ADD CONSTRAINT "price_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_entered_by_fkey" FOREIGN KEY ("entered_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_daily" ADD CONSTRAINT "production_daily_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "production_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outside_sale" ADD CONSTRAINT "outside_sale_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outside_sale" ADD CONSTRAINT "outside_sale_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ice_purchase" ADD CONSTRAINT "ice_purchase_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tnb_bill" ADD CONSTRAINT "tnb_bill_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "tnb_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tnb_bill" ADD CONSTRAINT "tnb_bill_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tnb_bill" ADD CONSTRAINT "tnb_bill_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tnb_bill_meter_reading" ADD CONSTRAINT "tnb_bill_meter_reading_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "tnb_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_line_cost" ADD CONSTRAINT "daily_line_cost_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "production_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
