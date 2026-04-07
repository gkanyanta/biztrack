/**
 * Migration script: Convert single-product sales to multi-item sales.
 *
 * This script reads the old productId/qty/unitPrice/costPrice columns
 * from the Sale table and creates SaleItem records for each sale.
 *
 * Run AFTER `prisma db push` has added the SaleItem table.
 * Run BEFORE dropping the old columns from Sale.
 *
 * Usage: DATABASE_URL="..." node scripts/migrate-sale-items.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Raw query to get old sale data (columns may not be in Prisma client anymore)
  const sales = await prisma.$queryRaw`
    SELECT id, "productId", qty, "unitPrice", "costPrice", "totalPrice"
    FROM "Sale"
    WHERE "productId" IS NOT NULL
  `;

  console.log(`Found ${sales.length} sales to migrate`);

  let migrated = 0;
  let skipped = 0;

  for (const sale of sales) {
    // Check if this sale already has items
    const existingItems = await prisma.saleItem.count({ where: { saleId: sale.id } });
    if (existingItems > 0) {
      skipped++;
      continue;
    }

    await prisma.saleItem.create({
      data: {
        saleId: sale.id,
        productId: sale.productId,
        qty: sale.qty,
        unitPrice: sale.unitPrice,
        costPrice: sale.costPrice,
        totalPrice: sale.totalPrice,
      },
    });
    migrated++;
  }

  console.log(`Migrated: ${migrated}, Skipped (already had items): ${skipped}`);
  console.log('Done! You can now safely drop the old columns from Sale.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
