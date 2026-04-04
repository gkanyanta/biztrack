/**
 * Migration script: Convert single-tenant to multi-tenant
 *
 * This script:
 * 1. Creates the Company table and inserts "Privtech Solutions Limited"
 * 2. Adds companyId column (nullable) to all data tables
 * 3. Backfills companyId with the Privtech company ID
 * 4. Makes companyId NOT NULL
 * 5. Drops old unique constraints and creates compound uniques
 * 6. Adds foreign keys
 */

const { PrismaClient } = require('@prisma/client');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/biztrack?schema=public';

async function migrate() {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  console.log('Starting multi-tenant migration...');
  console.log('Database:', DATABASE_URL.replace(/:[^:@]+@/, ':***@'));

  try {
    // Step 1: Create Company table
    console.log('\n1. Creating Company table...');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Company" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "slug" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Company_slug_key" ON "Company"("slug")
    `);

    // Step 2: Insert Privtech Solutions Limited
    console.log('2. Inserting Privtech Solutions Limited...');
    const companyId = 'company_privtech_001';
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Company" ("id", "name", "slug", "createdAt", "updatedAt")
      VALUES ($1, 'Privtech Solutions Limited', 'privtech-solutions', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("slug") DO NOTHING
    `, companyId);

    // Step 3: Add companyId to all tables (nullable first)
    const tables = ['User', 'Product', 'Sale', 'Customer', 'Expense', 'StockLog', 'OrderStatusLog', 'ShippingRate', 'Setting'];

    for (const table of tables) {
      console.log(`3. Adding companyId to ${table}...`);
      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "companyId" TEXT`);
      } catch (e) {
        if (e.message.includes('already exists')) {
          console.log(`   companyId already exists on ${table}, skipping`);
        } else throw e;
      }
    }

    // Step 4: Backfill companyId
    console.log('\n4. Backfilling companyId for all existing data...');
    for (const table of tables) {
      const result = await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "companyId" = $1 WHERE "companyId" IS NULL`, companyId);
      console.log(`   ${table}: updated ${result} rows`);
    }

    // Step 5: Make companyId NOT NULL
    console.log('\n5. Setting companyId to NOT NULL...');
    for (const table of tables) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ALTER COLUMN "companyId" SET NOT NULL`);
    }

    // Step 6: Add foreign keys
    console.log('\n6. Adding foreign keys...');
    for (const table of tables) {
      const fkName = `${table}_companyId_fkey`;
      try {
        await prisma.$executeRawUnsafe(`
          ALTER TABLE "${table}" ADD CONSTRAINT "${fkName}"
          FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE
        `);
      } catch (e) {
        if (e.message.includes('already exists')) {
          console.log(`   FK ${fkName} already exists, skipping`);
        } else throw e;
      }
    }

    // Step 7: Drop old unique constraints and create compound ones
    console.log('\n7. Updating unique constraints...');

    // Product: sku -> (companyId, sku)
    try { await prisma.$executeRawUnsafe(`ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_sku_key"`); } catch (e) {}
    try { await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "Product_sku_key"`); } catch (e) {}
    try { await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Product_companyId_sku_key" ON "Product"("companyId", "sku")`); } catch (e) { if (!e.message.includes('already exists')) throw e; }

    // Sale: orderNumber -> (companyId, orderNumber)
    try { await prisma.$executeRawUnsafe(`ALTER TABLE "Sale" DROP CONSTRAINT IF EXISTS "Sale_orderNumber_key"`); } catch (e) {}
    try { await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "Sale_orderNumber_key"`); } catch (e) {}
    try { await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Sale_companyId_orderNumber_key" ON "Sale"("companyId", "orderNumber")`); } catch (e) { if (!e.message.includes('already exists')) throw e; }

    // ShippingRate: city -> (companyId, city)
    try { await prisma.$executeRawUnsafe(`ALTER TABLE "ShippingRate" DROP CONSTRAINT IF EXISTS "ShippingRate_city_key"`); } catch (e) {}
    try { await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "ShippingRate_city_key"`); } catch (e) {}
    try { await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "ShippingRate_companyId_city_key" ON "ShippingRate"("companyId", "city")`); } catch (e) { if (!e.message.includes('already exists')) throw e; }

    // Setting: key -> (companyId, key)
    try { await prisma.$executeRawUnsafe(`ALTER TABLE "Setting" DROP CONSTRAINT IF EXISTS "Setting_key_key"`); } catch (e) {}
    try { await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "Setting_key_key"`); } catch (e) {}
    try { await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Setting_companyId_key_key" ON "Setting"("companyId", "key")`); } catch (e) { if (!e.message.includes('already exists')) throw e; }

    console.log('\n=== Migration complete! ===');
    console.log('Company ID for Privtech Solutions Limited:', companyId);

    // Verify
    const counts = {};
    for (const table of tables) {
      const result = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as count FROM "${table}" WHERE "companyId" = $1`, companyId);
      counts[table] = Number(result[0].count);
    }
    console.log('\nVerification - records per table:', counts);

  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

migrate().catch(() => process.exit(1));
