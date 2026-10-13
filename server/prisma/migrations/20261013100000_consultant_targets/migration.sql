-- A target per consultant per pay cycle, with the bonus that reaching it pays on the payslip.
-- CreateTable
CREATE TABLE "ConsultantTarget" (
    "id" TEXT NOT NULL,
    "consultantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "target" DECIMAL(12,2) NOT NULL,
    "bonus" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "bonusRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultantTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultantTarget_companyId_period_idx" ON "ConsultantTarget"("companyId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultantTarget_consultantId_period_key" ON "ConsultantTarget"("consultantId", "period");

-- AddForeignKey
ALTER TABLE "ConsultantTarget" ADD CONSTRAINT "ConsultantTarget_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "Consultant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultantTarget" ADD CONSTRAINT "ConsultantTarget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

