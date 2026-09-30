-- Walk-in customers come to the house, buy, and carry the goods away. That is not a delivery
-- that happens to be instant; it is a different thing, and recording it as one is what lets an
-- order be complete on creation without pretending a rider took it somewhere.
-- Everything already in the table was delivered, so that is the default.
ALTER TABLE "Sale" ADD COLUMN "fulfilment" TEXT NOT NULL DEFAULT 'delivery';
