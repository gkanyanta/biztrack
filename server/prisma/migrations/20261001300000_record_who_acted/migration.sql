-- Nothing recorded who did anything. That was tolerable while one shared admin account did all
-- of it, but the warehouse now assigns runs, marks orders packed and records counter sales, and
-- "who dispatched this" had no answer. All three columns are nullable: every row written before
-- today genuinely has no actor, and the storefront has no user behind it at all.
ALTER TABLE "OrderStatusLog" ADD COLUMN "byUserId" TEXT;
ALTER TABLE "Delivery" ADD COLUMN "assignedById" TEXT;
ALTER TABLE "Sale" ADD COLUMN "recordedById" TEXT;

CREATE INDEX "OrderStatusLog_byUserId_idx" ON "OrderStatusLog"("byUserId");
CREATE INDEX "Delivery_assignedById_idx" ON "Delivery"("assignedById");
CREATE INDEX "Sale_recordedById_idx" ON "Sale"("recordedById");

ALTER TABLE "OrderStatusLog" ADD CONSTRAINT "OrderStatusLog_byUserId_fkey"
  FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_assignedById_fkey"
  FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
