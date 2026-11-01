-- CreateTable
CREATE TABLE "OrderQuery" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "consultantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "raisedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderQueryMessage" (
    "id" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderQueryMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderQuery_companyId_status_idx" ON "OrderQuery"("companyId", "status");

-- CreateIndex
CREATE INDEX "OrderQuery_consultantId_status_idx" ON "OrderQuery"("consultantId", "status");

-- CreateIndex
CREATE INDEX "OrderQuery_saleId_idx" ON "OrderQuery"("saleId");

-- CreateIndex
CREATE INDEX "OrderQueryMessage_queryId_idx" ON "OrderQueryMessage"("queryId");

-- AddForeignKey
ALTER TABLE "OrderQuery" ADD CONSTRAINT "OrderQuery_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderQuery" ADD CONSTRAINT "OrderQuery_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "Consultant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderQuery" ADD CONSTRAINT "OrderQuery_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderQueryMessage" ADD CONSTRAINT "OrderQueryMessage_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "OrderQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

