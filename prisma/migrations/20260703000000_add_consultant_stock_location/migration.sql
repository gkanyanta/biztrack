-- Marks a Consultant row as a non-commission stock pool (e.g. "My Car") rather than a
-- salesperson, so commission/pay-statement calculations can exclude it while the existing
-- mini-stock/transfer/sale-source machinery treats it exactly like a real consultant.
ALTER TABLE "Consultant" ADD COLUMN "isStockLocation" BOOLEAN NOT NULL DEFAULT false;
