-- Salary advances staff ask for themselves. Paying one out creates a Loan, which the pay run deducts.
-- CreateTable
CREATE TABLE "AdvanceRequest" (
    "id" TEXT NOT NULL,
    "consultantId" TEXT,
    "staffId" TEXT,
    "requestedById" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "instalments" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedAmount" DECIMAL(10,2),
    "approvedInstalments" INTEGER,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "loanId" TEXT,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceRequest_loanId_key" ON "AdvanceRequest"("loanId");

-- CreateIndex
CREATE INDEX "AdvanceRequest_companyId_status_idx" ON "AdvanceRequest"("companyId", "status");

-- CreateIndex
CREATE INDEX "AdvanceRequest_consultantId_idx" ON "AdvanceRequest"("consultantId");

-- CreateIndex
CREATE INDEX "AdvanceRequest_staffId_idx" ON "AdvanceRequest"("staffId");

-- AddForeignKey
ALTER TABLE "AdvanceRequest" ADD CONSTRAINT "AdvanceRequest_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "Consultant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRequest" ADD CONSTRAINT "AdvanceRequest_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRequest" ADD CONSTRAINT "AdvanceRequest_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRequest" ADD CONSTRAINT "AdvanceRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

