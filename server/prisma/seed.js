const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  // Create admin user
  const hashedPassword = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      password: hashedPassword,
      name: 'Admin',
      role: 'admin'
    }
  });

  // Default settings
  const settings = [
    { key: 'currency', value: 'ZMW' },
    { key: 'businessName', value: 'BizTrack' },
    { key: 'currencySymbol', value: 'K' }
  ];

  for (const s of settings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      update: {},
      create: s
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
      where: { city: r.city },
      update: {},
      create: r
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
