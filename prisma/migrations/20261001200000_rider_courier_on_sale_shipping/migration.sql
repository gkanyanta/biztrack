-- When the rider carries a parcel to Platinum, the fee he pays belongs on the order as its
-- shipping cost, and the company owes him that money whether or not cash changed hands that day.
-- Gross profit already subtracts shippingCost, so an expense recorded this way must not also
-- raise a Delivery Costs expense on settlement — that would charge the same kwacha twice.
ALTER TABLE "RiderExpense" ADD COLUMN "onSaleShipping" BOOLEAN NOT NULL DEFAULT false;
