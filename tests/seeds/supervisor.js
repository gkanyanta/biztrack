// A sales team for the supervisor: Evelyn (to be made supervisor), Anna and Lizzy with logins,
// an inactive consultant and a stock location to refuse as destinations, Anna's orders in every
// state that matters (waiting to go out, out and unpaid, one drawn from her own stock), one of
// Evelyn's, and a second company whose orders must stay out of sight.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

module.exports = async function seed(prisma) {
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co', consultantPayDay: 11 } });
  const other = await prisma.company.create({ data: { name: 'Other Co', slug: 'other-co' } });
  const user = (username, name, role, companyId = company.id) => prisma.user.create({ data: { username, password: pw, name, role, companyId } });
  await user('boss', 'Gerald', 'admin');
  const consultant = async (username, name, extra = {}) => {
    const u = username ? await user(username, name, 'consultant') : null;
    return prisma.consultant.create({ data: { name, payType: 'revenue_pct', commissionRate: 5, monthlyAllowance: 400, userId: u?.id || null, companyId: company.id, ...extra } });
  };
  const evelyn = await consultant('evelyn', 'Evelyn');
  const anna = await consultant('anna', 'Anna');
  const lizzy = await consultant('lizzy', 'Lizzy');
  const gone = await consultant(null, 'Fidelis', { isActive: false });
  const store = await consultant(null, 'Kitwe Store', { isStockLocation: true });
  const otherC = await prisma.consultant.create({ data: { name: 'Other Seller', companyId: other.id } });

  const product = await prisma.product.create({ data: { name: 'Speaker', sku: 'SPK-1', costPrice: 100, sellingPrice: 300, stock: 50, supplier: 'Secret Supplier', companyId: company.id } });
  const otherProduct = await prisma.product.create({ data: { name: 'Lamp', sku: 'L-1', costPrice: 10, sellingPrice: 99, stock: 5, companyId: other.id } });
  await prisma.consultantStock.create({ data: { consultantId: anna.id, productId: product.id, qty: 5, companyId: company.id } });

  let n = 0;
  const sale = (consultantId, { status = 'Confirmed', paid = 0, fromOwnStock = false, companyId = company.id } = {}) => prisma.sale.create({
    data: {
      orderNumber: `ORD-${String(++n).padStart(3, '0')}`, date: new Date(), status, totalPrice: 300, amountPaid: paid,
      paymentType: 'Cash', paymentStatus: paid >= 300 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid',
      customerName: `Customer ${n}`, customerPhone: '0970000000', customerCity: 'Lusaka', consultantId, companyId,
      items: { create: [{
        productId: companyId === company.id ? product.id : otherProduct.id, qty: 1, unitPrice: 300, costPrice: companyId === company.id ? 100 : 10, totalPrice: 300,
        stockSourceConsultantId: fromOwnStock ? consultantId : null,
      }] },
    },
  });
  const annaPending = await sale(anna.id);
  const annaOut = await sale(anna.id, { status: 'Delivered' });
  const annaOwnStock = await sale(anna.id, { fromOwnStock: true });
  const annaPaid = await sale(anna.id, { status: 'Delivered', paid: 300 });
  const evelynSale = await sale(evelyn.id, { paid: 300 });
  const otherSale = await sale(otherC.id, { companyId: other.id });

  return {
    evelynId: evelyn.id, annaId: anna.id, lizzyId: lizzy.id, goneId: gone.id, storeId: store.id,
    annaPendingId: annaPending.id, annaOutId: annaOut.id, annaOwnStockId: annaOwnStock.id, annaPaidId: annaPaid.id,
    evelynSaleId: evelynSale.id, otherSaleId: otherSale.id,
  };
};
