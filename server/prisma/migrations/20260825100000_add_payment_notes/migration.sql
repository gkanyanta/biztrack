-- Timestamped payment-position comments on an order (activity trail, not a single
-- overwritable status field) — e.g. "will pay tomorrow via MoMo", "paid, ref 4521".
CREATE TABLE "PaymentNote" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentNote_saleId_idx" ON "PaymentNote"("saleId");

-- CreateIndex
CREATE INDEX "PaymentNote_companyId_idx" ON "PaymentNote"("companyId");

-- AddForeignKey
ALTER TABLE "PaymentNote" ADD CONSTRAINT "PaymentNote_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentNote" ADD CONSTRAINT "PaymentNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
