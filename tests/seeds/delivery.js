// A rider with three unpaid deliveries on the bike, plus a failed one and a part-paid order.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

module.exports = async function seed(prisma) {

  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co' } });
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: company.id } });
  const riderUser = await prisma.user.create({ data: { username: 'rider1', password: pw, name: 'Musa', role: 'rider', companyId: company.id } });
  const rider = await prisma.rider.create({ data: { name: 'Musa', phone: '0977000000', companyId: company.id, userId: riderUser.id } });

  const product = await prisma.product.create({ data: { name: 'Widget', sku: 'W1', costPrice: 100, sellingPrice: 500, stock: 100, companyId: company.id } });

  // Three orders, all Confirmed (stock already out) and unpaid, each K1500.
  const sales = [];
  for (let i = 1; i <= 3; i++) {
    const s = await prisma.sale.create({
      data: {
        orderNumber: `ORD-${i}`, totalPrice: 1500, amountPaid: 0, paymentStatus: 'Unpaid', paymentType: 'Cash',
        status: 'Confirmed', customerName: `Customer ${i}`, customerCity: 'Lusaka', companyId: company.id,
        items: { create: [{ productId: product.id, qty: 3, unitPrice: 500, costPrice: 100, totalPrice: 1500 }] },
      },
    });
    sales.push(s);
  }
  // A fourth order that is still Pending — stock has never been taken out for it.
  const pending = await prisma.sale.create({
    data: {
      orderNumber: 'ORD-PENDING', totalPrice: 800, amountPaid: 0, paymentStatus: 'Unpaid', paymentType: 'Cash',
      status: 'Pending', customerName: 'Pending Customer', customerCity: 'Lusaka', companyId: company.id,
      items: { create: [{ productId: product.id, qty: 1, unitPrice: 800, costPrice: 100, totalPrice: 800 }] },
    },
  });
  // A fifth already part-paid: K1000 of K1500 down, K500 left for the rider to collect.
  const partial = await prisma.sale.create({
    data: {
      orderNumber: 'ORD-PARTIAL', totalPrice: 1500, amountPaid: 1000, paymentStatus: 'Partial', paymentType: 'Credit',
      status: 'Confirmed', customerName: 'Partial Customer', customerCity: 'Lusaka', companyId: company.id,
      items: { create: [{ productId: product.id, qty: 3, unitPrice: 500, costPrice: 100, totalPrice: 1500 }] },
    },
  });

  return { companyId: company.id, riderId: rider.id, saleIds: sales.map(s => s.id), pendingId: pending.id, partialId: partial.id };
};
