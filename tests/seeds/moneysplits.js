// A month of trading to split: sales paid and on credit, fares on orders, expenses in every
// bucket and one in none, a staff member to pay through Payroll, sales either side of the month
// boundary in Zambian time, and a second company whose money must not appear.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

module.exports = async function seed(prisma) {
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co' } });
  const other = await prisma.company.create({ data: { name: 'Other Co', slug: 'other-co' } });
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: company.id } });
  const greg = await prisma.staff.create({ data: { name: 'Greg', monthlySalary: 3000, startDate: new Date('2020-01-01'), companyId: company.id } });

  const product = await prisma.product.create({ data: { name: 'Speaker', sku: 'SPK-1', costPrice: 100, sellingPrice: 300, stock: 50, companyId: company.id } });
  const otherProduct = await prisma.product.create({ data: { name: 'Lamp', sku: 'L-1', costPrice: 10, sellingPrice: 999, stock: 5, companyId: other.id } });
  let n = 0;
  const sale = (companyId, productId, { qty, price, date = new Date(), status = 'Delivered', amountPaid, shippingCost = 0, paymentType = 'Cash' }) => prisma.sale.create({
    data: {
      orderNumber: `ORD-${String(++n).padStart(4, '0')}`, date, status, totalPrice: qty * price, amountPaid: amountPaid ?? qty * price,
      shippingCost, paymentType, paymentStatus: (amountPaid ?? qty * price) >= qty * price ? 'Paid' : 'Partial', companyId,
      items: { create: [{ productId, qty, unitPrice: price, costPrice: companyId === company.id ? 100 : 10, totalPrice: qty * price }] },
    },
  });

  // This month.
  await sale(company.id, product.id, { qty: 2, price: 300, shippingCost: 40 });
  await sale(company.id, product.id, { qty: 1, price: 300, amountPaid: 100, paymentType: 'Credit' });
  await sale(company.id, product.id, { qty: 5, price: 300, status: 'Cancelled' });
  await sale(other.id, otherProduct.id, { qty: 1, price: 999, shippingCost: 77 });
  const spend = (category, amount, companyId = company.id) => prisma.expense.create({ data: { description: category, category, amount, companyId } });
  await spend('Facebook Ads', 50);
  await spend('Delivery Costs', 30);
  await spend('Shipping', 20);
  await spend('Other', 10);
  await spend('Rent', 25);
  await spend('Stock Purchase', 1000);
  await spend('Salaries & Wages', 5000, other.id);

  // March 2026, with an order either side of midnight on each boundary in Zambia (UTC+2).
  await sale(company.id, product.id, { qty: 1, price: 300, date: new Date('2026-02-28T21:30:00Z') }); // 28 Feb, 23:30 in Lusaka
  await sale(company.id, product.id, { qty: 1, price: 300, date: new Date('2026-02-28T22:30:00Z') }); //  1 Mar, 00:30 in Lusaka
  await sale(company.id, product.id, { qty: 1, price: 300, date: new Date('2026-03-31T21:30:00Z') }); // 31 Mar, 23:30 in Lusaka
  await sale(company.id, product.id, { qty: 1, price: 300, date: new Date('2026-03-31T22:30:00Z') }); //  1 Apr, 00:30 in Lusaka

  return { companyId: company.id, gregId: greg.id };
};
