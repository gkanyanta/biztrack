-- The rider spends the company's money as well as collecting it: a Platinum courier fee for an
-- out-of-town parcel, fuel, airtime. Settlement is net — he hands over collections minus what he
-- laid out — so these have to be tracked to know what he actually owes at the end of a day.
CREATE TABLE "RiderDailyReport" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "deliveriesCompleted" INTEGER NOT NULL DEFAULT 0,
    "deliveriesFailed" INTEGER NOT NULL DEFAULT 0,
    "cashCollected" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "expensesPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cashHandedOver" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "closingFloat" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RiderDailyReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiderExpense" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "description" TEXT,
    "rechargeable" BOOLEAN NOT NULL DEFAULT false,
    "saleId" TEXT,
    "rechargedAt" TIMESTAMP(3),
    "rechargedAmount" DECIMAL(10,2),
    "settledAt" TIMESTAMP(3),
    "expenseId" TEXT,
    "reportId" TEXT,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RiderExpense_pkey" PRIMARY KEY ("id")
);

-- One report per rider per day; a second submission edits the first.
CREATE UNIQUE INDEX "RiderDailyReport_riderId_date_key" ON "RiderDailyReport"("riderId", "date");
CREATE INDEX "RiderDailyReport_companyId_date_idx" ON "RiderDailyReport"("companyId", "date");
CREATE UNIQUE INDEX "RiderExpense_expenseId_key" ON "RiderExpense"("expenseId");
CREATE INDEX "RiderExpense_riderId_date_idx" ON "RiderExpense"("riderId", "date");
CREATE INDEX "RiderExpense_companyId_settledAt_idx" ON "RiderExpense"("companyId", "settledAt");

ALTER TABLE "RiderDailyReport" ADD CONSTRAINT "RiderDailyReport_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiderDailyReport" ADD CONSTRAINT "RiderDailyReport_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiderExpense" ADD CONSTRAINT "RiderExpense_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiderExpense" ADD CONSTRAINT "RiderExpense_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RiderExpense" ADD CONSTRAINT "RiderExpense_expenseId_fkey"
  FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RiderExpense" ADD CONSTRAINT "RiderExpense_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "RiderDailyReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RiderExpense" ADD CONSTRAINT "RiderExpense_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
