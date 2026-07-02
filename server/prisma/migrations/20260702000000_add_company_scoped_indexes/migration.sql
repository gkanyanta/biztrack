-- Add indexes for companyId and other frequently-filtered foreign key columns.
-- Postgres does not auto-index foreign keys, so every companyId-scoped query
-- (list views, dashboard, reports) was doing a sequential scan. These match
-- the where-clause patterns actually used across server/src/routes/*.js.

CREATE INDEX "Sale_companyId_date_idx" ON "Sale"("companyId", "date");
CREATE INDEX "Sale_consultantId_idx" ON "Sale"("consultantId");

CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");
CREATE INDEX "SaleItem_productId_idx" ON "SaleItem"("productId");

CREATE INDEX "OrderStatusLog_saleId_idx" ON "OrderStatusLog"("saleId");
CREATE INDEX "OrderStatusLog_companyId_idx" ON "OrderStatusLog"("companyId");

CREATE INDEX "Customer_companyId_phone_idx" ON "Customer"("companyId", "phone");

CREATE INDEX "Expense_companyId_date_idx" ON "Expense"("companyId", "date");

CREATE INDEX "StockLog_companyId_productId_idx" ON "StockLog"("companyId", "productId");

CREATE INDEX "CreditPayment_saleId_idx" ON "CreditPayment"("saleId");
CREATE INDEX "CreditPayment_companyId_idx" ON "CreditPayment"("companyId");

CREATE INDEX "DebtReminder_saleId_idx" ON "DebtReminder"("saleId");
CREATE INDEX "DebtReminder_companyId_idx" ON "DebtReminder"("companyId");

CREATE INDEX "CommissionPayment_consultantId_idx" ON "CommissionPayment"("consultantId");
CREATE INDEX "CommissionPayment_companyId_idx" ON "CommissionPayment"("companyId");

CREATE INDEX "ConsultantStock_companyId_idx" ON "ConsultantStock"("companyId");

CREATE INDEX "StockTransfer_consultantId_idx" ON "StockTransfer"("consultantId");
CREATE INDEX "StockTransfer_companyId_idx" ON "StockTransfer"("companyId");
CREATE INDEX "StockTransfer_productId_idx" ON "StockTransfer"("productId");
