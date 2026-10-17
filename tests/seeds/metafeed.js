// Stores with catalogue feeds: one with every kind of product the feed has to decide about, a
// second store whose products must never leak into the first's feed, and stores that are switched
// off, deactivated, token-protected, or have nothing publishable.
const bcrypt = require('bcryptjs');
const { TEST_PASSWORD } = require('../lib/harness');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8=';
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

module.exports = async function seed(prisma) {
  const pw = await bcrypt.hash(TEST_PASSWORD, 10);
  const feedOn = (companyId, extra = {}) => prisma.setting.createMany({
    data: Object.entries({ metaFeedEnabled: 'true', ...extra }).map(([key, value]) => ({ key, value, companyId })),
  });

  // ---- the store under test ----
  const shop = await prisma.company.create({ data: { name: 'Shop A', slug: 'shop-a' } });
  await feedOn(shop.id, { metaFeedBrand: 'Shop A' });
  await prisma.user.create({ data: { username: 'boss', password: pw, name: 'Boss', role: 'admin', companyId: shop.id } });
  await prisma.user.create({ data: { username: 'stores', password: pw, name: 'Stores', role: 'inventory', companyId: shop.id } });

  const base = { companyId: shop.id, costPrice: 777.77, supplier: 'Secret Supplier Ltd', category: 'Massage Guns', imageUrl: PNG };
  const make = (data) => prisma.product.create({ data: { ...base, ...data } });

  const plain = await make({ name: 'Massage Gun Pro', sku: 'MG-1', description: 'Deep tissue massage gun.', brand: 'Acme', sellingPrice: 1500, stock: 5 });
  const fallback = await make({ name: 'Cordless Roller', sku: 'MG-2', description: 'Rolling massager.', sellingPrice: 650.5, stock: 2, imageUrl: JPEG });
  const onSale = await make({ name: 'Fascial Gun', sku: 'MG-3', description: 'Small fascial gun.', sellingPrice: 1500, originalPrice: 2000, stock: 3 });
  const notASale = await make({ name: 'Mini Gun', sku: 'MG-4', description: 'Pocket gun.', sellingPrice: 900, originalPrice: 800, stock: 3 });
  const soldOut = await make({ name: 'Sold Out Gun', sku: 'MG-5', description: 'Gone for now.', sellingPrice: 1200, stock: 0 });
  const tricky = await make({ name: 'TV 55", Smart', sku: 'TV-55', category: 'TVs, Large', description: 'Says "wow",\nthen <b>stops</b>.', sellingPrice: 8999.99, stock: 1 });
  const inactive = await make({ name: 'Retired Gun', sku: 'MG-6', description: 'No longer sold.', sellingPrice: 1000, stock: 9, isActive: false });
  const noImage = await make({ name: 'Imageless Gun', sku: 'MG-7', description: 'No photo yet.', sellingPrice: 1000, stock: 9, imageUrl: null });
  const webp = await make({ name: 'Webp Gun', sku: 'MG-8', description: 'Wrong format photo.', sellingPrice: 1000, stock: 9, imageUrl: WEBP });
  const noDescription = await make({ name: 'Silent Gun', sku: 'MG-9', description: null, sellingPrice: 1000, stock: 9 });
  const free = await make({ name: 'Free Gun', sku: 'MG-10', description: 'Costs nothing.', sellingPrice: 0, stock: 9 });

  const group = await prisma.productGroup.create({ data: { name: 'T-Shirt', companyId: shop.id } });
  const red = await make({ name: 'T-Shirt', sku: 'TS-R', category: 'Clothing', description: 'Sports tee.', sellingPrice: 250, stock: 4, groupId: group.id, variantLabel: 'Red' });
  const blue = await make({ name: 'T-Shirt Blue', sku: 'TS-B', category: 'Clothing', description: 'Sports tee.', sellingPrice: 250, stock: 0, groupId: group.id, variantLabel: 'Blue' });

  // ---- another tenant, with its own domain, whose rows must stay out of Shop A's feed ----
  const rival = await prisma.company.create({ data: { name: 'Privtech', slug: 'privtech-solutions' } });
  await feedOn(rival.id, { metaFeedBrand: 'Privtech' });
  const rivalProduct = await prisma.product.create({ data: { name: 'Rival Widget', sku: 'MG-1', description: 'Belongs to the other store.', sellingPrice: 300, costPrice: 100, stock: 1, imageUrl: PNG, companyId: rival.id } });

  // ---- stores the feed must refuse ----
  const off = await prisma.company.create({ data: { name: 'Feed Off', slug: 'feed-off' } });
  await prisma.product.create({ data: { name: 'Hidden', sku: 'H1', description: 'x', sellingPrice: 10, costPrice: 1, stock: 1, imageUrl: PNG, companyId: off.id } });

  const closed = await prisma.company.create({ data: { name: 'Closed', slug: 'closed', isActive: false } });
  await feedOn(closed.id, { metaFeedBrand: 'Closed' });
  await prisma.product.create({ data: { name: 'Closed Item', sku: 'C1', description: 'x', sellingPrice: 10, costPrice: 1, stock: 1, imageUrl: PNG, companyId: closed.id } });

  const empty = await prisma.company.create({ data: { name: 'Nothing Ready', slug: 'nothing-ready' } });
  await feedOn(empty.id); // no fallback brand, and its only product has no brand either
  await prisma.product.create({ data: { name: 'Unbranded', sku: 'U1', description: 'x', sellingPrice: 10, costPrice: 1, stock: 1, imageUrl: PNG, companyId: empty.id } });

  const locked = await prisma.company.create({ data: { name: 'Locked', slug: 'locked' } });
  await feedOn(locked.id, { metaFeedBrand: 'Locked', metaFeedSecret: 'let-meta-in' });
  await prisma.product.create({ data: { name: 'Locked Item', sku: 'L1', description: 'x', sellingPrice: 10, costPrice: 1, stock: 1, imageUrl: PNG, companyId: locked.id } });

  return {
    ids: {
      plain: plain.id, fallback: fallback.id, onSale: onSale.id, notASale: notASale.id, soldOut: soldOut.id, tricky: tricky.id,
      inactive: inactive.id, noImage: noImage.id, webp: webp.id, noDescription: noDescription.id, free: free.id,
      red: red.id, blue: blue.id, rival: rivalProduct.id,
    },
    groupId: group.id,
  };
};
