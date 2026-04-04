const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  // Create default company
  const company = await prisma.company.upsert({
    where: { slug: 'privtech-solutions' },
    update: {},
    create: {
      id: 'company_privtech_001',
      name: 'Privtech Solutions Limited',
      slug: 'privtech-solutions'
    }
  });

  // Create admin user
  const hashedPassword = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      password: hashedPassword,
      name: 'Admin',
      role: 'admin',
      companyId: company.id
    }
  });

  // Default settings
  const settings = [
    { key: 'currency', value: 'ZMW' },
    { key: 'businessName', value: 'Privtech Solutions Limited' },
    { key: 'currencySymbol', value: 'K' }
  ];

  for (const s of settings) {
    await prisma.setting.upsert({
      where: { companyId_key: { companyId: company.id, key: s.key } },
      update: {},
      create: { ...s, companyId: company.id }
    });
  }

  // Shipping rates
  const rates = [
    { city: 'Kitwe', region: 'Copperbelt', rate: 50 },
    { city: 'Lusaka', region: 'Lusaka', rate: 80 },
    { city: 'Ndola', region: 'Copperbelt', rate: 40 },
    { city: 'Livingstone', region: 'Southern', rate: 120 },
    { city: 'Chipata', region: 'Eastern', rate: 100 }
  ];

  for (const r of rates) {
    await prisma.shippingRate.upsert({
      where: { companyId_city: { companyId: company.id, city: r.city } },
      update: {},
      create: { ...r, companyId: company.id }
    });
  }

  console.log('Seed data created successfully');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
