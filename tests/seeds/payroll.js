// Two salaried staff (one mid-cycle), a commission consultant, and one paid sale.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

// Pay day 11, so the current cycle runs from the 11th of one month to the 11th of the next.
const PAY_DAY = 11;
function cycleFor(ref) {
  const d = new Date(ref);
  const startsThisMonth = d.getDate() >= PAY_DAY;
  const from = new Date(d.getFullYear(), startsThisMonth ? d.getMonth() : d.getMonth() - 1, PAY_DAY);
  const to = new Date(d.getFullYear(), startsThisMonth ? d.getMonth() + 1 : d.getMonth(), PAY_DAY);
  return { from, to };
}

module.exports = async function seed(prisma) {

  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co', consultantPayDay: PAY_DAY } });
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: company.id } });

  const { from, to } = cycleFor(new Date());

  // Employed long before this cycle — a full month's pay.
  const greg = await prisma.staff.create({
    data: { name: 'Greg Kanyanta', jobTitle: 'Rider', monthlySalary: 3000, monthlyAllowance: 100,
            startDate: new Date('2026-01-01'), companyId: company.id },
  });
  const bea = await prisma.staff.create({
    data: { name: 'Beatrice Kunda', jobTitle: 'Inventory control', monthlySalary: 2500, monthlyAllowance: 100,
            startDate: new Date('2026-01-01'), companyId: company.id },
  });
  // Joined exactly halfway through the current cycle — pay should prorate to about half.
  const midpoint = new Date(from.getTime() + (to.getTime() - from.getTime()) / 2);
  const newbie = await prisma.staff.create({
    data: { name: 'Halfway Hannah', jobTitle: 'Packer', monthlySalary: 2000, monthlyAllowance: 100,
            startDate: midpoint, companyId: company.id },
  });

  // A consultant, so the payroll view has both kinds of people in it.
  const annie = await prisma.consultant.create({
    data: { name: 'Annie', payType: 'revenue_pct', commissionRate: 5, tierThreshold: 0, tierRate: 0,
            monthlyAllowance: 400, startDate: new Date('2026-01-01'), companyId: company.id },
  });
  const product = await prisma.product.create({ data: { name: 'Widget', sku: 'W1', costPrice: 100, sellingPrice: 500, stock: 100, companyId: company.id } });
  // One fully paid K1,000 sale in this cycle → 5% = K50 commission.
  await prisma.sale.create({
    data: { orderNumber: 'ORD-1', totalPrice: 1000, amountPaid: 1000, paymentStatus: 'Paid', status: 'Delivered',
            date: new Date(from.getTime() + 86400000), consultantId: annie.id, companyId: company.id,
            items: { create: [{ productId: product.id, qty: 2, unitPrice: 500, costPrice: 100, totalPrice: 1000 }] } },
  });

  return {
    companyId: company.id, companySlug: company.slug,
    gregId: greg.id, beaId: bea.id, newbieId: newbie.id, annieId: annie.id,
    cycleFrom: from.toISOString(), cycleTo: to.toISOString(),
  };
};
