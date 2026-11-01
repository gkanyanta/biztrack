-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "zraClassCode" TEXT,
ADD COLUMN     "zraRegisteredAt" TIMESTAMP(3),
ADD COLUMN     "zraTaxCategory" TEXT;

-- CreateTable
CREATE TABLE "ZraConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "vsdcUrl" TEXT,
    "tpin" TEXT,
    "branchId" TEXT NOT NULL DEFAULT '000',
    "deviceSerial" TEXT,
    "defaultTaxCategory" TEXT,
    "startDate" TIMESTAMP(3),
    "qtyUnitCode" TEXT NOT NULL DEFAULT 'U',
    "pkgUnitCode" TEXT NOT NULL DEFAULT 'NT',
    "originCountry" TEXT,
    "deliveryClassCode" TEXT,
    "deliveryRegisteredAt" TIMESTAMP(3),
    "refundReasonCode" TEXT,
    "initialisedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZraConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalDocument" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invoiceNo" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "request" JSONB,
    "issuedAt" TIMESTAMP(3),
    "rcptNo" INTEGER,
    "sdcId" TEXT,
    "mrcNo" TEXT,
    "intrlData" TEXT,
    "rcptSign" TEXT,
    "receiptDate" TEXT,
    "qrCodeUrl" TEXT,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZraConfig_companyId_key" ON "ZraConfig"("companyId");

-- CreateIndex
CREATE INDEX "FiscalDocument_companyId_status_idx" ON "FiscalDocument"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalDocument_saleId_kind_key" ON "FiscalDocument"("saleId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalDocument_companyId_invoiceNo_key" ON "FiscalDocument"("companyId", "invoiceNo");

-- AddForeignKey
ALTER TABLE "ZraConfig" ADD CONSTRAINT "ZraConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalDocument" ADD CONSTRAINT "FiscalDocument_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalDocument" ADD CONSTRAINT "FiscalDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

