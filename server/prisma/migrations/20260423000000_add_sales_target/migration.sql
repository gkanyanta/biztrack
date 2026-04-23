-- CreateTable
CREATE TABLE "SalesTarget" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "revenueTarget" DECIMAL(12,2) NOT NULL,
    "savingsRate" DECIMAL(5,4) NOT NULL DEFAULT 0.25,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesTarget_companyId_periodStart_periodEnd_idx" ON "SalesTarget"("companyId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "SalesTarget" ADD CONSTRAINT "SalesTarget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
