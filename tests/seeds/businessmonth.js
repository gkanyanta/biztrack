// Orders either side of the boundaries a business month can have: the pay day that starts the
// cycle running now, the 1st that starts the calendar month, and the same in March 2026, where
// the cycle is 11 Mar to 10 Apr. Times are given in UTC; Zambia is two hours ahead.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

const PAY_DAY = 11;
const HOUR = 3600 * 1000;
// Midnight in Zambia on a calendar day.
const zmMidnight = (y, m0, d) => new Date(Date.UTC(y, m0, d) - 2 * HOUR);

module.exports = async function seed(prisma) {
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co', consultantPayDay: PAY_DAY } });
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: company.id } });
  const product = await prisma.product.create({ data: { name: 'Speaker', sku: 'SPK-1', costPrice: 100, sellingPrice: 300, stock: 50, companyId: company.id } });

  let n = 0;
  const sales = [];
  const sale = async (date, price) => {
    await prisma.sale.create({
      data: {
        orderNumber: `ORD-${String(++n).padStart(4, '0')}`, date, status: 'Delivered', totalPrice: price, amountPaid: price,
        paymentType: 'Cash', paymentStatus: 'Paid', companyId: company.id,
        items: { create: [{ productId: product.id, qty: 1, unitPrice: price, costPrice: 100, totalPrice: price }] },
      },
    });
    sales.push({ date, price });
  };

  // Today in Zambia, and where the current cycle and calendar month begin.
  const now = new Date();
  const z = new Date(now.getTime() + 2 * HOUR);
  const [y, m, d] = [z.getUTCFullYear(), z.getUTCMonth(), z.getUTCDate()];
  const cycleStart = zmMidnight(y, d >= PAY_DAY ? m : m - 1, PAY_DAY);
  const monthStart = zmMidnight(y, m, 1);
  await sale(new Date(cycleStart.getTime() + HOUR), 300);      // the first hour of this cycle
  await sale(new Date(cycleStart.getTime() - HOUR), 500);      // the last hour of the one before
  await sale(new Date(monthStart.getTime() + HOUR), 700);      // the first hour of this calendar month
  await sale(new Date(monthStart.getTime() - HOUR), 1100);     // the last hour of last month

  // March 2026: the cycle that starts on 11 Mar runs to the end of 10 Apr.
  await sale(new Date('2026-03-10T21:30:00Z'), 2000); // 10 Mar 23:30 in Lusaka: the cycle before
  await sale(new Date('2026-03-10T22:30:00Z'), 300);  // 11 Mar 00:30: first in the cycle
  await sale(new Date('2026-04-10T21:30:00Z'), 300);  // 10 Apr 23:30: last in the cycle
  await sale(new Date('2026-04-10T22:30:00Z'), 4000); // 11 Apr 00:30: the next cycle

  return { companyId: company.id, cycleStart, monthStart, sales };
};
