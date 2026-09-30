-- Not every drop goes on our own bike. When the rider is swamped or the address is too far, the
-- warehouse books a Yango, and that fare is a real per-trip cost that has to be comparable with
-- what the bike costs us. A hired courier carries no riderId, so the rider's own balance and run
-- sheet are unaffected by it.
ALTER TABLE "Delivery" ADD COLUMN "courier" TEXT NOT NULL DEFAULT 'rider';
ALTER TABLE "Delivery" ADD COLUMN "courierRef" TEXT;

-- And not every dispatch leaves the warehouse: a consultant sometimes hands an order over from
-- stock they are already carrying. Null means the warehouse, which is what every existing row was.
ALTER TABLE "Delivery" ADD COLUMN "dispatchedFromConsultantId" TEXT;

CREATE INDEX "Delivery_companyId_courier_idx" ON "Delivery"("companyId", "courier");
CREATE INDEX "Delivery_dispatchedFromConsultantId_idx" ON "Delivery"("dispatchedFromConsultantId");

ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_dispatchedFromConsultantId_fkey"
  FOREIGN KEY ("dispatchedFromConsultantId") REFERENCES "Consultant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
