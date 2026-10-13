// One salaried person and one consultant, with orders spread over the three cycles before the
// current one so that pay runs can be finalised and carried into each other.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

const PAY_DAY = 11;
// The cycle `back` cycles before the current one, labelled by the month it is paid.
function cycle(back) {
  const d = new Date();
  const startsThisMonth = d.getDate() >= PAY_DAY;
  const m = (startsThisMonth ? d.getMonth() : d.getMonth() - 1) - back;
  const from = new Date(d.getFullYear(), m, PAY_DAY);
  const to = new Date(d.getFullYear(), m + 1, PAY_DAY);
  return { from, to, label: `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}` };
}

module.exports = async function seed(prisma) {
  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co', consultantPayDay: PAY_DAY } });
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: company.id } });

  const bea = await prisma.staff.create({
    data: { name: 'Beatrice Kunda', jobTitle: 'Inventory control', monthlySalary: 2500, monthlyAllowance: 100,
            startDate: new Date('2020-01-01'), companyId: company.id },
  });
  const annie = await prisma.consultant.create({
    data: { name: 'Annie', payType: 'revenue_pct', commissionRate: 5, tierThreshold: 0, tierRate: 0,
            monthlyAllowance: 400, startDate: new Date('2020-01-01'), companyId: company.id },
  });
  // Annie's own login, so what she is shown about her pay can be checked too.
  const annieUser = await prisma.user.create({ data: { username: 'annie', password: pw, name: 'Annie', role: 'consultant', companyId: company.id } });
  await prisma.consultant.update({ where: { id: annie.id }, data: { userId: annieUser.id } });
  const product = await prisma.product.create({ data: { name: 'Widget', sku: 'W1', costPrice: 100, sellingPrice: 500, stock: 100, companyId: company.id } });

  const [c0, c1, c2, c3] = [0, 1, 2, 3].map(cycle);
  const sale = (orderNumber, c, total, paid, extra = {}) => prisma.sale.create({
    data: {
      orderNumber, totalPrice: total, amountPaid: paid,
      paymentStatus: paid >= total ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid',
      paymentType: paid >= total ? 'Cash' : 'Credit', status: 'Delivered',
      date: new Date(c.from.getTime() + 86400000), consultantId: annie.id, companyId: company.id,
      items: { create: [{ productId: product.id, qty: 1, unitPrice: total, costPrice: 100, totalPrice: total }] },
      ...extra,
    },
  });

  // Three cycles back: one order never paid for, one paid. Settled by hand before pay runs.
  const oldUnpaid = await sale('ORD-A0', c3, 1000, 0);
  await sale('ORD-A00', c3, 400, 400);
  // Two cycles back, the first cycle to get a pay run: paid, part-paid on credit, and unpaid.
  await sale('ORD-S1', c2, 1000, 1000);
  const credit = await sale('ORD-S2', c2, 2000, 500);
  const returned = await sale('ORD-S3', c2, 800, 0, { shippingCost: 60 });
  // Last cycle and this one.
  await sale('ORD-S4', c1, 600, 600);
  await sale('ORD-S5', c0, 200, 200);

  return {
    companyId: company.id, beaId: bea.id, annieId: annie.id,
    oldUnpaidId: oldUnpaid.id, creditId: credit.id, returnedId: returned.id,
    L0: c0.label, L1: c1.label, L2: c2.label, L3: c3.label,
    L2From: c2.from.toISOString(), L2To: c2.to.toISOString(),
  };
};
