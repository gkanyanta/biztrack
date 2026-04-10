-- CreateTable (if not exists)
CREATE TABLE IF NOT EXISTS "SaleItem" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "costPrice" DECIMAL(10,2) NOT NULL,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "serialNumber" TEXT,

    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

-- AddForeignKeys (if not exist)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SaleItem_saleId_fkey') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SaleItem_productId_fkey') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Migrate existing sale data into SaleItem (only for sales that have productId and no SaleItem yet)
INSERT INTO "SaleItem" ("id", "saleId", "productId", "qty", "unitPrice", "costPrice", "totalPrice")
SELECT
  'si_' || "id",
  "id",
  "productId",
  "qty",
  "unitPrice",
  "costPrice",
  "totalPrice"
FROM "Sale"
WHERE "productId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "SaleItem" WHERE "SaleItem"."saleId" = "Sale"."id");

-- Drop old columns from Sale that are now in SaleItem
ALTER TABLE "Sale" DROP CONSTRAINT IF EXISTS "Sale_productId_fkey";
ALTER TABLE "Sale" DROP COLUMN IF EXISTS "productId";
ALTER TABLE "Sale" DROP COLUMN IF EXISTS "qty";
ALTER TABLE "Sale" DROP COLUMN IF EXISTS "unitPrice";
ALTER TABLE "Sale" DROP COLUMN IF EXISTS "costPrice";
