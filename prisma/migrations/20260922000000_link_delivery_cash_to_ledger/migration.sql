-- Cash a rider collects at the door becomes a real CreditPayment when the office confirms
-- it arrived. The link back to the delivery is what makes that reversible: un-tick the
-- remittance and the exact payment row can be found and removed.
ALTER TABLE "CreditPayment" ADD COLUMN "deliveryId" TEXT;

CREATE UNIQUE INDEX "CreditPayment_deliveryId_key" ON "CreditPayment"("deliveryId");

ALTER TABLE "CreditPayment" ADD CONSTRAINT "CreditPayment_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
