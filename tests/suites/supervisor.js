// The admin can make a consultant sales supervisor. She then sees the whole team's orders, a
// team page and every order query, corrects customer details and moves orders between
// consultants before they go out, all logged. Cost prices, profit and pay stay out of her
// reach, and money on someone else's order stays with them and the office. She also sends orders
// out on our own riders, but closing a delivery, hiring a courier and the cash stay with the office.
const { loginAs } = require('../lib/harness');

module.exports = {
  name: 'Sales supervisor',
  seed: 'supervisor',
  async run({ base, prisma, seed, t }) {
    const { eq, section } = t;
    const boss = await loginAs(base, 'boss');
    const evelyn = await loginAs(base, 'evelyn');
    const anna = await loginAs(base, 'anna');
    const list = async (who) => {
      const body = (await who('GET', '/sales')).body;
      return Array.isArray(body) ? body : body.data;
    };
    const ids = (rows) => rows.map(r => r.id).sort();

    section('a consultant is not a supervisor until the admin says so');
    eq('she sees only her own orders', ids(await list(evelyn)), [seed.evelynSaleId]);
    eq('the team page is closed to her', (await evelyn('GET', '/team')).status, 403);
    eq('she cannot change a colleague\'s order', (await evelyn('PUT', `/sales/${seed.annaPendingId}/details`, { customerPhone: '0960000000' })).status, 403);
    eq('nor make herself supervisor', (await evelyn('PUT', `/consultants/${seed.evelynId}`, { isSupervisor: true })).status, 403);
    eq('deliveries are closed to her', [(await evelyn('GET', '/deliveries')).status, (await evelyn('GET', '/deliveries/riders')).status], [403, 403]);

    section('the admin makes her supervisor');
    const made = await boss('PUT', `/consultants/${seed.evelynId}`, { isSupervisor: true });
    eq('from the consultant record', [made.status, made.body.isSupervisor], [200, true]);
    eq('it takes effect without signing in again', (await evelyn('GET', '/auth/me')).body.isSupervisor, true);
    eq('and the consultants list shows it', (await boss('GET', '/consultants')).body.find(c => c.id === seed.evelynId).isSupervisor, true);

    section('she sees the team, never the costs or the pay');
    const rows = await list(evelyn);
    eq('every order of her company, and no other company\'s', ids(rows),
       [seed.annaPendingId, seed.annaOutId, seed.annaOwnStockId, seed.annaPaidId, seed.evelynSaleId].sort());
    const text = JSON.stringify(rows);
    eq('with no cost price or supplier on any line', [text.includes('costPrice'), text.includes('Secret Supplier')], [false, false]);
    eq('and only the seller\'s name, not their pay terms', [text.includes('commissionRate'), text.includes('monthlyAllowance')], [false, false]);
    const one = await evelyn('GET', `/sales/${seed.annaPendingId}`);
    eq('a colleague\'s order opens, without costs', [one.status, JSON.stringify(one.body).includes('costPrice')], [200, false]);
    eq('the consultant list itself stays the admin\'s', (await evelyn('GET', '/consultants')).status, 403);
    for (const [label, path] of [['payroll', '/payroll/run'], ['profit and loss', '/reports/pnl'], ['money splits', '/reports/money-splits'], ['the admin dashboard', '/dashboard']]) {
      eq(`${label} stays closed`, (await evelyn('GET', path)).status, 403);
    }

    section('the team page');
    const team = await evelyn('GET', '/team');
    eq('opens for her', team.status, 200);
    const annaRow = team.body.consultants.find(c => c.id === seed.annaId);
    eq('with each active consultant, stock locations and leavers left out',
       team.body.consultants.map(c => c.name).sort(), ['Anna', 'Evelyn', 'Lizzy']);
    eq('Anna\'s cycle: four orders, K1,200 sold, K300 collected', [annaRow.orders, annaRow.sales, annaRow.collected], [4, 1200, 300]);
    eq('the orders still to go out, hers among them', team.body.toGoOut.map(o => o.id).sort(), [seed.annaPendingId, seed.annaOwnStockId, seed.evelynSaleId].sort());
    eq('and the unpaid ones', team.body.unpaid.map(o => o.id).sort(), [seed.annaPendingId, seed.annaOutId, seed.annaOwnStockId].sort());
    const teamText = JSON.stringify(team.body);
    eq('nothing about pay or cost on it', ['costPrice', 'commission', 'netPay', 'bonus', 'Allowance'].filter(w => teamText.includes(w)), []);
    eq('the office sees the same page', (await boss('GET', '/team')).status, 200);

    section('order queries');
    const q = await boss('POST', '/order-queries', { saleId: seed.annaOutId, message: 'Has the customer paid?' });
    eq('the office asks Anna about her order', q.status, 201);
    eq('the supervisor sees the thread', (await evelyn('GET', '/order-queries')).body.some(x => x.id === q.body.id), true);
    eq('and can answer it', (await evelyn('POST', `/order-queries/${q.body.id}/messages`, { message: 'Paying on Friday' })).status, 200);

    section('correcting a customer\'s details, logged');
    const fix = await evelyn('PUT', `/sales/${seed.annaPendingId}/details`, { customerPhone: '0977111222', deliveryAddress: 'Plot 5, Kabulonga' });
    eq('she corrects the phone and address on Anna\'s order', [fix.status, fix.body.customerPhone, fix.body.deliveryAddress], [200, '0977111222', 'Plot 5, Kabulonga']);
    const logs = (await boss('GET', `/sales/${seed.annaPendingId}`)).body.changeLogs;
    eq('the office sees who changed what', [logs.length, logs[0].change, logs[0].byUser.name, logs[0].detail.includes('0970000000 → 0977111222')], [1, 'details', 'Evelyn', true]);
    eq('nothing to change is refused', (await evelyn('PUT', `/sales/${seed.annaPendingId}/details`, { customerPhone: '0977111222' })).status, 400);
    eq('an order already out is the office\'s to change', (await evelyn('PUT', `/sales/${seed.annaOutId}/details`, { customerPhone: '0960000000' })).status, 400);
    eq('another company\'s order does not exist for her', (await evelyn('PUT', `/sales/${seed.otherSaleId}/details`, { customerPhone: '0960000000' })).status, 404);

    section('moving an order to another consultant, logged');
    eq('not to someone who has left', (await evelyn('PUT', `/sales/${seed.annaPendingId}/consultant`, { consultantId: seed.goneId })).status, 400);
    eq('not to a stock location', (await evelyn('PUT', `/sales/${seed.annaPendingId}/consultant`, { consultantId: seed.storeId })).status, 400);
    eq('not to whoever already has it', (await evelyn('PUT', `/sales/${seed.annaPendingId}/consultant`, { consultantId: seed.annaId })).status, 400);
    eq('not an order drawn from Anna\'s own stock', (await evelyn('PUT', `/sales/${seed.annaOwnStockId}/consultant`, { consultantId: seed.lizzyId })).status, 400);
    eq('not an order already out', (await evelyn('PUT', `/sales/${seed.annaOutId}/consultant`, { consultantId: seed.lizzyId })).status, 400);
    const moved = await evelyn('PUT', `/sales/${seed.annaPendingId}/consultant`, { consultantId: seed.lizzyId });
    eq('Anna\'s waiting order goes to Lizzy', [moved.status, moved.body.consultant.name], [200, 'Lizzy']);
    eq('the order is Lizzy\'s now', (await prisma.sale.findUnique({ where: { id: seed.annaPendingId } })).consultantId, seed.lizzyId);
    const log = (await prisma.saleChangeLog.findMany({ where: { saleId: seed.annaPendingId, change: 'reassigned' } }))[0];
    eq('and the move is on record', log.detail, 'Anna → Lizzy');
    eq('Anna no longer sees it', ids(await list(anna)).includes(seed.annaPendingId), false);

    section('money on someone else\'s order stays with them and the office');
    eq('she cannot mark it paid', (await evelyn('PUT', `/sales/${seed.annaOutId}/payment`, { paymentStatus: 'Paid', amountPaid: 300 })).status, 404);
    eq('nor record a payment', (await evelyn('POST', `/sales/${seed.annaOutId}/payments`, { amount: 100 })).status, 404);
    eq('nor change its status', (await evelyn('PUT', `/sales/${seed.annaOutId}/status`, { status: 'Cancelled' })).status, 404);
    eq('nor edit the order itself', (await evelyn('PUT', `/sales/${seed.annaOutId}`, { discount: 50 })).status, 404);
    eq('nor delete it', (await evelyn('DELETE', `/sales/${seed.annaOutId}`)).status, 403);
    eq('the order is as it was', (await prisma.sale.findUnique({ where: { id: seed.annaOutId } })).status, 'Delivered');

    section('sending orders out on our riders');
    const riders = await evelyn('GET', '/deliveries/riders');
    eq('she sees the active riders by name, not their papers',
       [riders.status, riders.body.map(r => r.name), JSON.stringify(riders.body).includes('LIC-SECRET') || JSON.stringify(riders.body).includes('111111')],
       [200, ['Moses'], false]);
    const waiting = await evelyn('GET', '/deliveries/unassigned');
    eq('and the orders waiting for a rider', [waiting.status, waiting.body.some(s => s.id === seed.annaOwnStockId)], [200, true]);
    eq('she cannot book a hired courier, which costs a fare', (await evelyn('POST', '/deliveries', { saleIds: [seed.annaOwnStockId], courier: 'yango', courierCost: 80 })).status, 403);
    eq('nor use a rider who has stopped', (await evelyn('POST', '/deliveries', { saleIds: [seed.annaOwnStockId], riderId: seed.retiredRiderId })).status, 400);
    const sent = await evelyn('POST', '/deliveries', { saleIds: [seed.annaOwnStockId], riderId: seed.mosesId });
    eq('she puts Anna\'s order on Moses', [sent.status, sent.body[0]?.rider?.name, 'courierCost' in (sent.body[0] || {})], [201, 'Moses', false]);
    const deliveryId = sent.body[0].id;
    const evelynUser = await prisma.user.findUnique({ where: { username: 'evelyn' } });
    eq('with her name on the assignment', (await prisma.delivery.findUnique({ where: { id: deliveryId } })).assignedById, evelynUser.id);
    const onRoad = await evelyn('GET', '/deliveries?open=true');
    eq('she sees what is out on the road, with no cost on it', [onRoad.status, onRoad.body.map(d => d.id), JSON.stringify(onRoad.body).includes('courierCost')], [200, [deliveryId], false]);
    eq('but not the cash screens', [(await evelyn('GET', '/deliveries?unremitted=true')).status, (await evelyn('GET', '/deliveries?remitted=true')).status, (await evelyn('GET', '/deliveries')).status], [403, 403, 403]);
    eq('she takes it off Moses', [(await evelyn('PUT', `/deliveries/${deliveryId}/rider`, { riderId: null })).status, (await prisma.delivery.findUnique({ where: { id: deliveryId } })).riderId], [200, null]);
    eq('and gives it back', (await evelyn('PUT', `/deliveries/${deliveryId}/rider`, { riderId: seed.mosesId })).body.rider?.name, 'Moses');
    eq('but cannot hand it to a hired courier', (await evelyn('PUT', `/deliveries/${deliveryId}/rider`, { courier: 'yango' })).status, 403);

    section('closing a delivery stays with the rider and the office');
    eq('she cannot mark it delivered', (await evelyn('PUT', `/deliveries/${deliveryId}/status`, { status: 'Delivered', cashCollected: 300 })).status, 403);
    eq('nor failed', (await evelyn('PUT', `/deliveries/${deliveryId}/status`, { status: 'Failed', failureReason: 'x' })).status, 403);
    eq('nor confirm cash or delete it', [(await evelyn('PUT', `/deliveries/${deliveryId}/remit`, {})).status, (await evelyn('DELETE', `/deliveries/${deliveryId}`)).status], [403, 403]);
    eq('a consultant who is not supervisor cannot either', [(await anna('PUT', `/deliveries/${deliveryId}/status`, { status: 'Delivered', cashCollected: 300 })).status, (await anna('GET', '/deliveries')).status], [403, 403]);
    eq('the delivery is untouched', (await prisma.delivery.findUnique({ where: { id: deliveryId } })).status, 'Assigned');
    eq('the office closes it', (await boss('PUT', `/deliveries/${deliveryId}/status`, { status: 'Delivered', cashCollected: 300 })).status, 200);
    eq('after which she cannot move it', (await evelyn('PUT', `/deliveries/${deliveryId}/rider`, { riderId: null })).status, 400);

    section('the rest of the team is unchanged');
    eq('Anna still sees only her own', ids(await list(anna)), [seed.annaOutId, seed.annaOwnStockId, seed.annaPaidId].sort());
    eq('and has no team page', (await anna('GET', '/team')).status, 403);
    eq('nor any say over Evelyn\'s orders', (await anna('PUT', `/sales/${seed.evelynSaleId}/consultant`, { consultantId: seed.annaId })).status, 403);

    section('the admin switches it off');
    await boss('PUT', `/consultants/${seed.evelynId}`, { isSupervisor: false });
    eq('she is back to her own orders', ids(await list(evelyn)), [seed.evelynSaleId]);
    eq('and the team page closes', (await evelyn('GET', '/team')).status, 403);
    eq('as do deliveries', (await evelyn('GET', '/deliveries/riders')).status, 403);
    eq('the office can still move an order itself', (await boss('PUT', `/sales/${seed.evelynSaleId}/consultant`, { consultantId: seed.annaId })).status, 200);
  },
};
