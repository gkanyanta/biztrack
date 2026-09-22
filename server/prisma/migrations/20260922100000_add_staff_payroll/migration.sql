-- Salaried staff (inventory clerk, rider) get the same pay treatment consultants already had:
-- what they are owed, what has been paid, and advances that net off the balance. Kept out of
-- the Consultant table because a Consultant row is selectable as a sale's source and as a
-- stock location, which an inventory clerk or a rider must never be.
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "jobTitle" TEXT,
    "monthlySalary" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "monthlyAllowance" DECIMAL(10,2) NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "notes" TEXT,
    "userId" TEXT,
    "riderId" TEXT,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StaffPayment" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'salary',
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "expenseId" TEXT,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Staff_userId_key" ON "Staff"("userId");
CREATE UNIQUE INDEX "Staff_riderId_key" ON "Staff"("riderId");
CREATE INDEX "Staff_companyId_idx" ON "Staff"("companyId");
CREATE UNIQUE INDEX "StaffPayment_expenseId_key" ON "StaffPayment"("expenseId");
CREATE INDEX "StaffPayment_staffId_idx" ON "StaffPayment"("staffId");
CREATE INDEX "StaffPayment_companyId_idx" ON "StaffPayment"("companyId");

ALTER TABLE "Staff" ADD CONSTRAINT "Staff_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffPayment" ADD CONSTRAINT "StaffPayment_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffPayment" ADD CONSTRAINT "StaffPayment_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffPayment" ADD CONSTRAINT "StaffPayment_expenseId_fkey"
  FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Paying anyone is now a real cost, so a payment owns the expense it raised and can undo it.
-- Consultant payments get the same link; existing rows stay null until the backfill runs.
ALTER TABLE "CommissionPayment" ADD COLUMN "expenseId" TEXT;
CREATE UNIQUE INDEX "CommissionPayment_expenseId_key" ON "CommissionPayment"("expenseId");
ALTER TABLE "CommissionPayment" ADD CONSTRAINT "CommissionPayment_expenseId_fkey"
  FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
