// Who may reach what
//
// Ported from the throwaway scripts these features were built against, so the coverage is the
// same coverage that caught the bugs in the first place rather than something written afterwards
// to look thorough.

const { client } = require('../lib/harness');

module.exports = {
  name: 'Who may reach what',
  seed: 'rider',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    // The suites were written against two names for the same thing; both are the shared client.
    const BASE = base;
    const mk = (token) => client(base, token);
    const api = mk;

  const login = async (u) => (await mk()('POST', '/auth/login', { username: u, password: 'secret123' })).body.token;
  const admin = mk(await login('boss'));
  const greg = mk(await login('greg'));

  await prisma.setting.createMany({
    data: [
      { key: 'businessName', value: 'Test Co', companyId: seed.companyId },
      { key: 'lencoPublicKey', value: 'pub-abc123', companyId: seed.companyId },
      { key: 'lencoSecretKey', value: 'SECRET-DO-NOT-LEAK', companyId: seed.companyId },
    ], skipDuplicates: true,
  });

  console.log('-- the rider keeps what he needs --');
  for (const p of ['/deliveries/my/runs', '/deliveries/my/account', '/deliveries/my/expenses', '/deliveries/my/report', '/deliveries/my/reports']) {
    eq(`GET ${p}`, (await greg('GET', p)).status, 200);
  }
  eq('GET /auth/me', (await greg('GET', '/auth/me')).status, 200);
  // He must still be able to move his own delivery along — a fresh one, since the handler
  // rightly refuses to let a rider re-complete a finished delivery.
  const product = await prisma.product.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
  const fresh = await prisma.sale.create({
    data: { orderNumber: 'ORD-SCOPE', totalPrice: 400, status: 'Confirmed', paymentType: 'Cash',
            customerName: 'Scope Test', companyId: seed.companyId,
            items: { create: [{ productId: product.id, qty: 1, unitPrice: 400, costPrice: 100, totalPrice: 400 }] } },
  });
  const d = await prisma.delivery.create({
    data: { saleId: fresh.id, riderId: seed.gregRiderId, status: 'Assigned', companyId: seed.companyId },
  });
  eq('PUT his own delivery status', (await greg('PUT', `/deliveries/${d.id}/status`, { status: 'PickedUp' })).status, 200);
  // Another rider's delivery is invisible to him, which the handler's own scoping enforces.
  const theirs = await prisma.delivery.create({
    data: { saleId: (await prisma.sale.create({ data: { orderNumber: 'ORD-OTHER', totalPrice: 100, status: 'Confirmed', paymentType: 'Cash', companyId: seed.companyId } })).id,
            riderId: seed.otherRiderId, status: 'Assigned', companyId: seed.companyId },
  });
  eq("but another rider's is not his to touch", (await greg('PUT', `/deliveries/${theirs.id}/status`, { status: 'PickedUp' })).status, 404);

  section('and is shut out of everything else');
  const closed = ['/sales', '/sales/reports/daily', '/products', '/customers', '/expenses', '/quotes',
                  '/targets', '/settings', '/consultants', '/dashboard', '/inventory', '/payroll/summary',
                  '/payroll/staff', '/deliveries/riders', '/deliveries/expenses', '/deliveries/reports',
                  '/deliveries/finances', '/deliveries/performance', '/deliveries/unassigned', '/staff'];
  for (const p of closed) eq(`GET ${p} is refused`, (await greg('GET', p)).status, 403);
  eq('and so is the delivery list', (await greg('GET', '/deliveries')).status, 403);
  eq('POST /sales is refused', (await greg('POST', '/sales', { totalPrice: 1 })).status, 403);
  eq('a query string cannot slip past it', (await greg('GET', '/sales?limit=1')).status, 403);

  section('the payment secret stops leaving');
  const asAdmin = (await admin('GET', '/settings')).body;
  eq('an admin still gets the secret', asAdmin.lencoSecretKey, 'SECRET-DO-NOT-LEAK');
  eq('and the public key', asAdmin.lencoPublicKey, 'pub-abc123');
  // The rider cannot reach settings at all now, so check the redaction on a consultant instead —
  // the role that reads settings every time it prints a receipt.
  const bcrypt = require('bcryptjs');
  const cUser = await prisma.user.create({
    data: { username: 'annie_scope', password: await bcrypt.hash('secret123', 10), name: 'Annie', role: 'consultant', companyId: seed.companyId },
  });
  const consultant = await prisma.consultant.create({
    data: { name: 'Annie', payType: 'revenue_pct', commissionRate: 5, userId: cUser.id, companyId: seed.companyId },
  });
  if (consultant?.userId) {
    const cApi = mk(await login('annie_scope'));
    const asC = (await cApi('GET', '/settings')).body;
    eq('a consultant no longer gets the secret', asC.lencoSecretKey, undefined);
    eq('but keeps the public key', asC.lencoPublicKey, 'pub-abc123');
    eq('and the business name', asC.businessName, 'Test Co');
  } else {
    console.log('SKIP  no consultant login in this seed to check redaction against');
  }

  section('the inventory role can dispatch, but not touch the money');
  const bcrypt2 = require('bcryptjs');
  await prisma.user.create({
    data: { username: 'bea_scope', password: await bcrypt2.hash('secret123', 10), name: 'Beatrice', role: 'inventory', companyId: seed.companyId },
  });
  const bea = mk(await login('bea_scope'));

  eq('she sees the riders to pick from', (await bea('GET', '/deliveries/riders')).status, 200);
  eq('and the orders waiting to go out', (await bea('GET', '/deliveries/unassigned')).status, 200);
  eq('and what is on the road', (await bea('GET', '/deliveries')).status, 200);

  const toSend = await prisma.sale.create({
    data: { orderNumber: 'ORD-BEA', totalPrice: 250, status: 'Confirmed', paymentType: 'Cash',
            customerName: 'Dispatch Test', companyId: seed.companyId },
  });
  const assigned = await bea('POST', '/deliveries', { riderId: seed.gregRiderId, saleIds: [toSend.id] });
  eq('she can assign a run', assigned.status, 201);
  eq('and reassign it to another rider', (await bea('PUT', `/deliveries/${assigned.body[0].id}/rider`, { riderId: seed.otherRiderId })).status, 200);
  eq('and pull it back off the bike', (await bea('PUT', `/deliveries/${assigned.body[0].id}/rider`, { riderId: null })).status, 200);

  const delivered = await prisma.delivery.findFirst({ where: { status: 'Delivered' }, select: { id: true } });
  eq('but she cannot confirm cash arrived', (await bea('PUT', `/deliveries/${delivered.id}/remit`, { cashRemitted: true })).status, 403);
  eq("nor settle the rider's expenses", (await bea('GET', '/deliveries/expenses')).status, 403);
  eq('nor read his daily reports', (await bea('GET', '/deliveries/reports')).status, 403);
  eq('nor the delivery finances', (await bea('GET', '/deliveries/finances')).status, 403);
  eq('nor the performance figures', (await bea('GET', '/deliveries/performance')).status, 403);
  eq('nor delete a delivery', (await bea('DELETE', `/deliveries/${delivered.id}`)).status, 403);
  eq('nor create a rider', (await bea('POST', '/deliveries/riders', { name: 'Sneaky' })).status, 403);
  eq('nor hand out a rider login', (await bea('POST', `/deliveries/riders/${seed.gregRiderId}/login`, { username: 'x1', password: 'abc123' })).status, 403);
  eq('and still no payment secret for her', (await bea('GET', '/settings')).body.lencoSecretKey, undefined);
  },
};
