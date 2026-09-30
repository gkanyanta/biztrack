// Delivery cash reaching the ledger
//
// Ported from the throwaway scripts these features were built against, so the coverage is the
// same coverage that caught the bugs in the first place rather than something written afterwards
// to look thorough.

const { client } = require('../lib/harness');

module.exports = {
  name: 'Delivery cash reaching the ledger',
  seed: 'delivery',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    // The suites were written against two names for the same thing; both are the shared client.
    const BASE = base;
    const mk = (token) => client(base, token);
    const api = mk;
    const saleState = async (id) => {
      const s = await prisma.sale.findUnique({ where: { id }, select: { status: true, amountPaid: true, paymentStatus: true } });
      return { status: s.status, amountPaid: Number(s.amountPaid), paymentStatus: s.paymentStatus };
    };
    const payments = (saleId) => prisma.creditPayment.findMany({ where: { saleId } });


  const login = async (u, p) => (await api()('POST', '/auth/login', { username: u, password: p })).body.token;
  const admin = api(await login('boss', 'secret123'));
  const rider = api(await login('rider1', 'secret123'));

  const [s1, s2, s3] = seed.saleIds;
  const { pendingId, partialId, riderId } = seed;

  // --- assign the whole run ---
  const assigned = await admin('POST', '/deliveries', { riderId, saleIds: [s1, s2, s3, pendingId, partialId] });
  eq('assign 5 orders', assigned.status, 201);
  const byOrder = {};
  for (const d of assigned.body) byOrder[d.saleId] = d.id;

  // --- rider completes the run ---
  for (const id of Object.values(byOrder)) await rider('PUT', `/deliveries/${id}/status`, { status: 'PickedUp' });

  await rider('PUT', `/deliveries/${byOrder[s1]}/status`, { status: 'Delivered', recipientName: 'Gate guard', cashCollected: 1500 });
  await rider('PUT', `/deliveries/${byOrder[s2]}/status`, { status: 'Delivered', recipientName: 'Wife', cashCollected: 2000 });
  await rider('PUT', `/deliveries/${byOrder[pendingId]}/status`, { status: 'Delivered', cashCollected: 800 });
  await rider('PUT', `/deliveries/${byOrder[partialId]}/status`, { status: 'Delivered', cashCollected: 500 });
  const failed = await rider('PUT', `/deliveries/${byOrder[s3]}/status`, { status: 'Failed', failureReason: 'Customer not home' });
  eq('failure needs no cash', failed.status, 200);

  section('after the rider has done the run, before the office confirms anything');
  eq('delivered order closes, money untouched', await saleState(s1), { status: 'Delivered', amountPaid: 0, paymentStatus: 'Unpaid' });
  eq('collected cash is not yet a payment', (await payments(s1)).length, 0);
  eq('a Pending order is left for someone to confirm', await saleState(pendingId), { status: 'Pending', amountPaid: 0, paymentStatus: 'Unpaid' });
  eq('a failed drop does not close the order', (await saleState(s3)).status, 'Confirmed');

  section('the office confirms the cash arrived');
  const r1 = await admin('PUT', `/deliveries/${byOrder[s1]}/remit`, { cashRemitted: true });
  eq('remit succeeds', r1.status, 200);
  eq('exact collection settles the order', await saleState(s1), { status: 'Delivered', amountPaid: 1500, paymentStatus: 'Paid' });
  const p1 = await payments(s1);
  eq('one payment written', p1.length, 1);
  eq('payment is cash, tied to the delivery', [Number(p1[0].amount), p1[0].paymentMethod, p1[0].deliveryId === byOrder[s1]], [1500, 'Cash', true]);
  eq('payment names the rider', p1[0].reference, 'Delivery — Musa');

  await admin('PUT', `/deliveries/${byOrder[partialId]}/remit`, { cashRemitted: true });
  eq('part-paid order tops up to Paid', await saleState(partialId), { status: 'Delivered', amountPaid: 1500, paymentStatus: 'Paid' });

  await admin('PUT', `/deliveries/${byOrder[s2]}/remit`, { cashRemitted: true });
  const p2 = await payments(s2);
  eq('over-collection posts only what the order owed', Number(p2[0].amount), 1500);
  eq('order is not pushed past its total', await saleState(s2), { status: 'Delivered', amountPaid: 1500, paymentStatus: 'Paid' });
  eq('the real handover is kept in the note', p2[0].notes, 'Rider handed over 2000.00 against a balance of 1500.00');

  section('corrections');
  const undo = await admin('PUT', `/deliveries/${byOrder[s1]}/remit`, { cashRemitted: false });
  eq('undo returns 200', undo.status, 200);
  eq('undo takes the money back out', await saleState(s1), { status: 'Delivered', amountPaid: 0, paymentStatus: 'Unpaid' });
  eq('undo removes the payment row', (await payments(s1)).length, 0);

  const remitFailed = await admin('PUT', `/deliveries/${byOrder[s3]}/remit`, { cashRemitted: true });
  eq('cannot confirm cash for a run that never completed', remitFailed.status, 400);

  const riderRemit = await rider('PUT', `/deliveries/${byOrder[partialId]}/remit`, { cashRemitted: true });
  eq('a rider cannot confirm his own cash', riderRemit.status, 403);

  const twice = await admin('PUT', `/deliveries/${byOrder[partialId]}/remit`, { cashRemitted: true });
  eq('confirming twice is harmless', twice.status, 200);
  eq('and does not double-post', (await payments(partialId)).length, 1);

  section('a completed run corrected back off Delivered');
  const reopen = await admin('PUT', `/deliveries/${byOrder[partialId]}/status`, { status: 'Failed', failureReason: 'Logged against the wrong order' });
  eq('reopen returns 200', reopen.status, 200);
  eq('its cash comes back out of the books', await saleState(partialId), { status: 'Shipped', amountPaid: 1000, paymentStatus: 'Partial' });
  eq('and the payment row is gone', (await payments(partialId)).length, 0);
  eq('cash no longer reads as confirmed', reopen.body.cashRemitted, false);

  section('deleting a delivery that had confirmed cash');
  const del = await admin('DELETE', `/deliveries/${byOrder[s2]}`);
  eq('delete returns 200', del.status, 200);
  eq('its payment is reversed, not orphaned', (await payments(s2)).length, 0);
  eq('the order is owed again', await saleState(s2), { status: 'Delivered', amountPaid: 0, paymentStatus: 'Unpaid' });

  section('the order status log');
  const logs = await prisma.orderStatusLog.findMany({ where: { saleId: partialId }, orderBy: { createdAt: 'asc' } });
  eq('delivery movements are on the timeline', logs.map(l => `${l.fromStatus}->${l.toStatus}`), ['Confirmed->Delivered', 'Delivered->Shipped']);

  section('rider scoping');
  // The rider role no longer reaches the general delivery list at all. It was already scoped to
  // his own runs, but his app only ever calls /deliveries/my/runs, so the surface is narrowed.
  const others = await rider('GET', '/deliveries');
  eq('the general delivery list is closed to a rider', others.status, 403);
  const own = await rider('GET', '/deliveries/my/runs');
  eq('but his own runs are still his', own.status, 200);
  const cashTab = await admin('GET', '/deliveries?unremitted=true');
  // ORD-1's remittance was undone above, so it is correctly owed again; ORD-PARTIAL was
  // reopened as Failed and ORD-2 deleted, so neither is waiting on cash any more.
  eq('unremitted list is what is still owed', cashTab.body.map(d => d.orderNumber).sort(), ['ORD-1', 'ORD-PENDING']);
  const confirmedTab = await admin('GET', '/deliveries?remitted=true');
  eq('confirmed list is the other half', confirmedTab.body.length, 0);
  },
};
