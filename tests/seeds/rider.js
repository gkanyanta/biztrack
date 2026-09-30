// Two riders with logins, one linked to payroll, three delivered orders and a failure.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

module.exports = async function seed(prisma) {

  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co', consultantPayDay: 11 } });
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: company.id } });

  const gregUser = await prisma.user.create({ data: { username: 'greg', password: pw, name: 'Greg', role: 'rider', companyId: company.id } });
  const greg = await prisma.rider.create({ data: { name: 'Greg Kanyanta', companyId: company.id, userId: gregUser.id } });
  // A second rider, to prove one cannot see the other's money.
  const otherUser = await prisma.user.create({ data: { username: 'other', password: pw, name: 'Other', role: 'rider', companyId: company.id } });
  const other = await prisma.rider.create({ data: { name: 'Other Rider', companyId: company.id, userId: otherUser.id } });

  // Greg's pay record, linked to his rider profile so the dashboard reads the real wage.
  await prisma.staff.create({
    data: { name: 'Greg Kanyanta', jobTitle: 'Delivery Rider', monthlySalary: 3000, monthlyAllowance: 100,
            startDate: new Date('2026-09-01'), riderId: greg.id, userId: gregUser.id, companyId: company.id },
  });

  const product = await prisma.product.create({ data: { name: 'Widget', sku: 'W1', costPrice: 100, sellingPrice: 500, stock: 200, companyId: company.id } });

  // Three delivered orders, each with K500 collected at the door and a K60 delivery fee billed.
  const saleIds = [];
  for (let i = 1; i <= 3; i++) {
    const sale = await prisma.sale.create({
      data: { orderNumber: `ORD-${i}`, totalPrice: 500, amountPaid: 0, paymentStatus: 'Unpaid', paymentType: 'Cash',
              status: 'Confirmed', shippingCharge: 60, customerName: `Customer ${i}`, customerCity: 'Lusaka', companyId: company.id,
              items: { create: [{ productId: product.id, qty: 1, unitPrice: 500, costPrice: 100, totalPrice: 500 }] } },
    });
    saleIds.push(sale.id);
    await prisma.delivery.create({
      data: { saleId: sale.id, riderId: greg.id, status: 'Delivered', deliveredAt: new Date(),
              cashCollected: 500, cashRemitted: false, companyId: company.id },
    });
  }
  // One failed drop, so the daily report has a failure to explain.
  const failSale = await prisma.sale.create({
    data: { orderNumber: 'ORD-FAIL', totalPrice: 300, amountPaid: 0, paymentStatus: 'Unpaid', paymentType: 'Cash',
            status: 'Confirmed', customerName: 'Absent Customer', companyId: company.id,
            items: { create: [{ productId: product.id, qty: 1, unitPrice: 300, costPrice: 100, totalPrice: 300 }] } },
  });
  await prisma.delivery.create({
    data: { saleId: failSale.id, riderId: greg.id, status: 'Failed', failedAt: new Date(),
            failureReason: 'Customer not available', cashCollected: 0, companyId: company.id },
  });

  return { companyId: company.id, gregRiderId: greg.id, otherRiderId: other.id, saleIds };
};
