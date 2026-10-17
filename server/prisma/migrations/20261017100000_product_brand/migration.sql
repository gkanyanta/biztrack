-- The manufacturer brand the Meta catalogue feed sends. Optional: blank falls back to the
-- store-wide brand set in Settings, and a product with neither is left out of the feed.
ALTER TABLE "Product" ADD COLUMN "brand" TEXT;
