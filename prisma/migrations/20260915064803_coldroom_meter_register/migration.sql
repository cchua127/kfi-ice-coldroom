-- CreateTable
CREATE TABLE "coldroom_reading" (
    "id" BIGSERIAL NOT NULL,
    "period_month" DATE NOT NULL,
    "row_no" INTEGER NOT NULL,
    "room_code" TEXT NOT NULL,
    "tenant_label" TEXT,
    "own_use" BOOLEAN NOT NULL,
    "opening_kwh" DECIMAL(14,2) NOT NULL,
    "closing_kwh" DECIMAL(14,2) NOT NULL,
    "rate_rm_per_kwh" DECIMAL(8,4) NOT NULL,
    "usage_group" INTEGER,
    "note" TEXT,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "coldroom_reading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coldroom_reading_period_month_idx" ON "coldroom_reading"("period_month");

-- CreateIndex
CREATE INDEX "coldroom_reading_room_code_idx" ON "coldroom_reading"("room_code");

-- CreateIndex
CREATE UNIQUE INDEX "coldroom_reading_period_month_row_no_key" ON "coldroom_reading"("period_month", "row_no");
