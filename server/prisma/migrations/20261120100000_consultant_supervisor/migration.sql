-- A consultant who supervises the sales team, and a log of changes made to other people's orders.
ALTER TABLE "Consultant" ADD COLUMN "isSupervisor" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SaleChangeLog" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "byUserId" TEXT,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleChangeLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SaleChangeLog_saleId_idx" ON "SaleChangeLog"("saleId");
CREATE INDEX "SaleChangeLog_companyId_idx" ON "SaleChangeLog"("companyId");

ALTER TABLE "SaleChangeLog" ADD CONSTRAINT "SaleChangeLog_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleChangeLog" ADD CONSTRAINT "SaleChangeLog_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SaleChangeLog" ADD CONSTRAINT "SaleChangeLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
