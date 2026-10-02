-- Nine of ten live orders go out of town, to nine different towns, so a courier drop-off is the
-- main flow rather than an exception. Batching them into the day's sessions is the point: one
-- trip with seven parcels instead of seven trips.
--
-- Payment comes after dispatch. Platinum's receipt for each parcel is sent to the customer as
-- proof it is on its way, and only then do they pay. So a dispatched parcel is money owed, and
-- the receipt number is what the customer pays against — which is why it lives on the parcel.
CREATE TABLE "CourierRun" (
    "id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "courier" TEXT NOT NULL DEFAULT 'Platinum',
    "riderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "dispatchedAt" TIMESTAMP(3),
    "dispatchedById" TEXT,
    "notes" TEXT,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CourierRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Delivery" ADD COLUMN "courierRunId" TEXT;
ALTER TABLE "Delivery" ADD COLUMN "courierReceiptNo" TEXT;

-- One run per courier per session per day, so adding a parcel finds the run rather than
-- inventing a second one beside it.
CREATE UNIQUE INDEX "CourierRun_companyId_scheduledFor_courier_key" ON "CourierRun"("companyId", "scheduledFor", "courier");
CREATE INDEX "CourierRun_companyId_status_idx" ON "CourierRun"("companyId", "status");
CREATE INDEX "Delivery_courierRunId_idx" ON "Delivery"("courierRunId");

ALTER TABLE "CourierRun" ADD CONSTRAINT "CourierRun_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CourierRun" ADD CONSTRAINT "CourierRun_dispatchedById_fkey"
  FOREIGN KEY ("dispatchedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CourierRun" ADD CONSTRAINT "CourierRun_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_courierRunId_fkey"
  FOREIGN KEY ("courierRunId") REFERENCES "CourierRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
