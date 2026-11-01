// A company about to start ZRA Smart Invoice: an admin, a product with its ZRA classification and
// one without, the platform superadmin who switches it on, and a second company that must not see
// or touch any of it.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

module.exports = async function seed(prisma) {
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  const company = await prisma.company.create({ data: { name: 'Test Co', slug: 'test-co' } });
  const other = await prisma.company.create({ data: { name: 'Other Co', slug: 'other-co' } });
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: company.id } });
  await prisma.user.create({ data: { username: 'otherboss', password: pw, name: 'Other Boss', role: 'admin', companyId: other.id } });
  await prisma.user.create({ data: { username: 'root', password: pw, name: 'Platform', role: 'superadmin' } });

  const speaker = await prisma.product.create({ data: { name: 'Speaker', variantLabel: 'Black', sku: 'SPK-1', costPrice: 100, sellingPrice: 150, stock: 100, zraClassCode: '52161512', companyId: company.id } });
  const cable = await prisma.product.create({ data: { name: 'Cable', sku: 'CBL-1', costPrice: 20, sellingPrice: 50, stock: 100, companyId: company.id } });

  return { companyId: company.id, otherId: other.id, speakerId: speaker.id, cableId: cable.id };
};
