// Order status and fulfilment
//
// Ported from the throwaway scripts these features were built against, so the coverage is the
// same coverage that caught the bugs in the first place rather than something written afterwards
// to look thorough.

const { client } = require('../lib/harness');

module.exports = {
  name: 'Order status and fulfilment',
  seed: 'payroll',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    // The suites were written against two names for the same thing; both are the shared client.
    const BASE = base;
    const mk = (token) => client(base, token);
    const api = mk;

  const login = async (u) => (await mk()('POST', '/auth/login', { username: u, password: 'secret123' })).body.token;
  const admin = mk(await login('boss'));
  const product = await prisma.product.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
  const consultant = await prisma.consultant.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
  // Give the consultant stock so an order can legitimately be sourced from them.
  if (consultant) {
    await prisma.consultantStock.upsert({
      where: { consultantId_productId: { consultantId: consultant.id, productId: product.id } },
      update: { qty: 50 }, create: { consultantId: consultant.id, productId: product.id, qty: 50, companyId: seed.companyId },
    });
  }
  const order = (status, source) => ({
    customerName: 'Status Test', customerCity: 'Lusaka', deliveryAddress: 'Plot 1', status,
    items: [{ productId: product.id, qty: 1, unitPrice: 200, stockSourceConsultantId: source || null }],
  });

  console.log('-- a warehouse order cannot be born already gone --');
  for (const st of ['Delivered', 'Shipped']) {
    const r = await admin('POST', '/sales', order(st));
    eq(`created as ${st} is refused`, r.status, 400);
    eq(`  and says why`, r.body.error.includes('coming from the warehouse'), true);
  }

  section('but the real flow still works');
  const conf = await admin('POST', '/sales', order('Confirmed'));
  eq('Confirmed is accepted', conf.status, 201);
  eq('and lands in Confirmed', conf.body.status, 'Confirmed');
  const pend = await admin('POST', '/sales', order('Pending'));
  eq('Pending is accepted', pend.status, 201);
  const noStatus = await admin('POST', '/sales', { customerName: 'No status', items: [{ productId: product.id, qty: 1, unitPrice: 100 }] });
  eq('omitting status still defaults to Pending', noStatus.body.status, 'Pending');

  section('it can be advanced afterwards, which is the point');
  eq('Confirmed -> Shipped by the warehouse', (await admin('PUT', `/sales/${conf.body.id}/status`, { status: 'Shipped' })).status, 200);
  eq('Shipped -> Delivered on drop-off', (await admin('PUT', `/sales/${conf.body.id}/status`, { status: 'Delivered' })).status, 200);
  const logs = await prisma.orderStatusLog.findMany({ where: { saleId: conf.body.id }, orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true } });
  eq('and the timeline records the real journey', logs.map(l => `${l.fromStatus}->${l.toStatus}`), ['New->Confirmed', 'Confirmed->Shipped', 'Shipped->Delivered']);

  if (consultant) {
    section("a consultant selling their own stock is exempt");
    const own = await admin('POST', '/sales', order('Delivered', consultant.id));
    eq('created as Delivered is allowed', own.status, 201);
    eq('and really is Delivered', own.body.status, 'Delivered');
  }

  section('the public storefront is untouched');
  const company = await prisma.company.findUnique({ where: { id: seed.companyId }, select: { slug: true } });
  const store = await fetch(`${BASE}/store/${company.slug}/order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerName: 'Web Buyer', customerPhone: '0977123456', items: [{ productId: product.id, qty: 1 }] }),
  });
  eq('a storefront order still goes through', store.status, 201);
  const web = await store.json().catch(() => null);
  if (web?.id) {
    const ws = await prisma.sale.findUnique({ where: { id: web.id }, select: { status: true } });
    eq('and arrives as Pending', ws.status, 'Pending');
  }

  section('a walk-in collected at the counter is a different thing');
  const collected = await admin('POST', '/sales', {
    ...order('Delivered'), fulfilment: 'collection', source: 'Walk-in',
  });
  eq('a collection can be recorded as Delivered', collected.status, 201);
  eq('and is stored as a collection', collected.body.fulfilment, 'collection');
  const shippedColl = await admin('POST', '/sales', { ...order('Shipped'), fulfilment: 'collection' });
  eq('Shipped is allowed on a collection too', shippedColl.status, 201);
  eq('a delivery order is still refused', (await admin('POST', '/sales', order('Delivered'))).status, 400);
  eq('and defaults to delivery when unstated', conf.body.fulfilment, 'delivery');

  section('and it is nobody\'s run');
  const queue = await admin('GET', '/deliveries/unassigned');
  const numbers = queue.body.map(o => o.id);
  eq('the collection is not in the assign queue', numbers.includes(collected.body.id), false);
  eq('but the confirmed delivery order is', numbers.includes(pend.body.id), true);

  section('attribution decides whose commission it is');
  if (consultant) {
    const attributed = await admin('POST', '/sales', {
      ...order('Delivered'), fulfilment: 'collection', consultantId: consultant.id,
    });
    eq('a counter sale can be credited to a consultant', attributed.status, 201);
    eq('and carries their id', attributed.body.consultantId, consultant.id);
    const house = await admin('POST', '/sales', { ...order('Delivered'), fulfilment: 'collection' });
    eq("or to nobody, for the business's own customer", house.body.consultantId, null);
  }

  section('the warehouse can read names to attribute with, but not pay terms');
  const bcrypt3 = require('bcryptjs');
  await prisma.user.create({
    data: { username: 'bea_counter', password: await bcrypt3.hash('secret123', 10), name: 'Beatrice', role: 'inventory', companyId: seed.companyId },
  });
  const bea = mk(await login('bea_counter'));
  const names = await bea('GET', '/consultants/names');
  eq('she can list consultant names', names.status, 200);
  if (names.body.length) {
    eq('and gets only id and name', Object.keys(names.body[0]).sort(), ['id', 'name']);
  }
  eq('the full consultant record stays closed to her', (await bea('GET', '/consultants')).status, 403);
  const herSale = await bea('POST', '/sales', { ...order('Delivered'), fulfilment: 'collection' });
  eq('and she can record a counter sale', herSale.status, 201);
  },
};
