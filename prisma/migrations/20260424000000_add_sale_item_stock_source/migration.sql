-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN "stockSourceConsultantId" TEXT;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_stockSourceConsultantId_fkey" FOREIGN KEY ("stockSourceConsultantId") REFERENCES "Consultant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
