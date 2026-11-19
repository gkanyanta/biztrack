-- The day a payment was actually made, so a pay day recorded late keeps its real date.
ALTER TABLE "CommissionPayment" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "StaffPayment" ADD COLUMN "paidAt" TIMESTAMP(3);
