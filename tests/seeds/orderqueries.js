// Two consultants with an unpaid order each, an order nobody sold, an inventory clerk, and a
// second company with an order of its own, for the office asking consultants about orders.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

module.exports = async function seed(prisma) {
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co' } });
  const other = await prisma.company.create({ data: { name: 'Other Co', slug: 'other-co' } });
  const user = (username, name, role, companyId = company.id) => prisma.user.create({ data: { username, password: pw, name, role, companyId } });
  await user('boss', 'Gerald', 'admin');
  await user('bea', 'Beatrice', 'inventory');
  await user('otherboss', 'Other Boss', 'admin', other.id);
  const consultant = async (username, name) => {
    const u = await user(username, name, 'consultant');
    return prisma.consultant.create({ data: { name, payType: 'revenue_pct', commissionRate: 5, userId: u.id, companyId: company.id } });
  };
  const annie = await consultant('annie', 'Annie');
  const evelyn = await consultant('evelyn', 'Evelyn');

  const product = await prisma.product.create({ data: { name: 'Speaker', sku: 'SPK-1', costPrice: 100, sellingPrice: 300, stock: 50, companyId: company.id } });
  const sale = (orderNumber, consultantId, companyId = company.id, extra = {}) => prisma.sale.create({
    data: {
      orderNumber, date: new Date(), status: 'Delivered', totalPrice: 300, amountPaid: 0, paymentType: 'Cash', paymentStatus: 'Unpaid',
      customerName: `Customer ${orderNumber}`, consultantId, companyId, ...extra,
      ...(companyId === company.id && { items: { create: [{ productId: product.id, qty: 1, unitPrice: 300, costPrice: 100, totalPrice: 300 }] } }),
    },
  });
  const annieSale = await sale('ORD-A1', annie.id, company.id, { amountPaid: 100, paymentStatus: 'Partial' });
  const evelynSale = await sale('ORD-E1', evelyn.id);
  const directSale = await sale('ORD-D1', null);
  const otherSale = await sale('ORD-X1', null, other.id);
  await prisma.paymentNote.create({ data: { saleId: annieSale.id, note: 'Paid K100 on delivery', companyId: company.id } });
  await prisma.paymentNote.create({ data: { saleId: annieSale.id, note: 'Balance promised Friday', companyId: company.id } });

  return { companyId: company.id, annieSaleId: annieSale.id, evelynSaleId: evelynSale.id, directSaleId: directSale.id, otherSaleId: otherSale.id };
};
