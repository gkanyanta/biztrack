// An admin, one product, and expenses either side of the Stock Purchase line, for checking the
// profit figures. The sales themselves are recorded through the API so the order totals are the
// ones the system really works out.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

module.exports = async function seed(prisma) {
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co' } });
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: company.id } });
  const product = await prisma.product.create({ data: { name: 'Speaker', sku: 'SPK-1', costPrice: 100, sellingPrice: 300, stock: 50, companyId: company.id } });
  await prisma.expense.create({ data: { description: 'Rent', category: 'Rent', amount: 25, companyId: company.id } });
  await prisma.expense.create({ data: { description: 'Restock', category: 'Stock Purchase', amount: 1000, companyId: company.id } });
  return { companyId: company.id, productId: product.id };
};
