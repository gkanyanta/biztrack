// A rider fixing his own mistake
//
// He closes a drop on his phone and sometimes gets it wrong: the wrong cash figure, or marked
// failed when the customer paid at the second knock. The screen refused any change to a finished
// drop — "ask an admin to correct it" — so every slip became a phone call.
//
// What the office actually needs is narrower than that: nothing may change under a figure it has
// already acted on. Two things count as having acted — the cash was posted to the order's ledger,
// or the day's report was checked. Before either, the fix is his to make; after, it is theirs.

const { loginAs } = require('../lib/harness');

const dayKey = (d) => new Date(d.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);

module.exports = {
  name: 'A rider can fix his own unchecked work',
  seed: 'rider',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    const admin = await loginAs(base, 'boss');
    const greg = await loginAs(base, 'greg');

    const product = await prisma.product.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
    const order = async (ref, total = 400) => prisma.sale.create({
      data: {
        orderNumber: ref, totalPrice: total, amountPaid: 0, paymentStatus: 'Unpaid', paymentType: 'Cash',
        status: 'Confirmed', customerName: `Customer ${ref}`, customerCity: 'Lusaka', companyId: seed.companyId,
        items: { create: [{ productId: product.id, qty: 1, unitPrice: total, costPrice: 100, totalPrice: total }] },
      },
    });
    const drop = async (ref, extra = {}) => {
      const sale = await order(ref);
      return prisma.delivery.create({
        data: { saleId: sale.id, riderId: seed.gregRiderId, status: 'Assigned', companyId: seed.companyId, ...extra },
      });
    };

    section('he took down the wrong amount');
    const wrong = await drop('ORD-WRONG');
    const closed = await greg('PUT', `/deliveries/${wrong.id}/status`, { status: 'Delivered', cashCollected: 300, recipientName: 'Mary' });
    eq('he closes it', closed.status, 200);
    near('with the figure he typed', parseFloat(closed.body.cashCollected), 300);

    const fixed = await greg('PUT', `/deliveries/${wrong.id}/status`, { status: 'Delivered', cashCollected: 400, recipientName: 'Mary Banda' });
    eq('and he can correct it himself', fixed.status, 200);
    near('to what he actually took', parseFloat(fixed.body.cashCollected), 400);
    eq('and fix the name too', fixed.body.recipientName, 'Mary Banda');

    section('correcting a figure does not move the day it happened on');
    // This matters because the day is what the office balances against. Re-stamping it to now
    // would quietly carry a Tuesday drop into Wednesday.
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
    const older = await drop('ORD-OLDER', { status: 'Delivered', deliveredAt: twoDaysAgo, assignedAt: twoDaysAgo, cashCollected: 100 });
    const redone = await greg('PUT', `/deliveries/${older.id}/status`, { status: 'Delivered', cashCollected: 250 });
    eq('the correction lands', redone.status, 200);
    near('on the new figure', parseFloat(redone.body.cashCollected), 250);
    eq('and the day it happened is untouched', dayKey(new Date(redone.body.deliveredAt)), dayKey(twoDaysAgo));
    const hist = await admin('GET', `/deliveries/riders/${seed.gregRiderId}/history`);
    eq('so it stays on that day in the history', hist.body.days.find(d => d.date === dayKey(twoDaysAgo)).deliveries.some(d => d.orderNumber === 'ORD-OLDER'), true);

    section('it turned out not to have arrived after all');
    const reversed = await greg('PUT', `/deliveries/${wrong.id}/status`, { status: 'Failed', failureReason: 'Customer could not pay' });
    eq('he can take it back off delivered', reversed.status, 200);
    eq('it reads as failed', reversed.body.status, 'Failed');
    eq('and the reason is kept', reversed.body.failureReason, 'Customer could not pay');
    const sale = await prisma.sale.findUnique({ where: { id: reversed.body.saleId }, select: { status: true } });
    eq('the order is no longer delivered', sale.status, 'Shipped');

    section('and a failure he logged wrongly can be put right');
    const mis = await drop('ORD-MIS');
    await greg('PUT', `/deliveries/${mis.id}/status`, { status: 'Failed', failureReason: 'Customer not available' });
    const better = await greg('PUT', `/deliveries/${mis.id}/status`, { status: 'Failed', failureReason: 'Wrong or incomplete address' });
    eq('the reason can be changed', better.status, 200);
    eq('to the right one', better.body.failureReason, 'Wrong or incomplete address');
    const arrived = await greg('PUT', `/deliveries/${mis.id}/status`, { status: 'Delivered', cashCollected: 400 });
    eq('or it can become a delivery', arrived.status, 200);
    near('with its cash', parseFloat(arrived.body.cashCollected), 400);
    // A failure still needs a reason, however he got there.
    const noReason = await greg('PUT', `/deliveries/${mis.id}/status`, { status: 'Failed' });
    eq('a failure without a reason is still refused', noReason.status, 400);

    section('once the office banks the cash it is theirs');
    const banked = await drop('ORD-BANKED');
    await greg('PUT', `/deliveries/${banked.id}/status`, { status: 'Delivered', cashCollected: 400 });
    const remit = await admin('PUT', `/deliveries/${banked.id}/remit`, { cashRemitted: true });
    eq('the office posts it to the ledger', remit.status, 200);
    const tooLate = await greg('PUT', `/deliveries/${banked.id}/status`, { status: 'Delivered', cashCollected: 50 });
    eq('he cannot change it now', tooLate.status, 400);
    const stillThere = await prisma.delivery.findUnique({ where: { id: banked.id }, select: { cashCollected: true } });
    near('and the figure stands', parseFloat(stillThere.cashCollected), 400);
    // The office is not locked out by its own sign-off.
    const byOffice = await admin('PUT', `/deliveries/${banked.id}/status`, { status: 'Delivered', cashCollected: 350 });
    eq('but the office can still correct it', byOffice.status, 200);
    near('to what it should be', parseFloat(byOffice.body.cashCollected), 350);

    section('and once the day is checked, so is everything on it');
    const onDay = await drop('ORD-CHECKED');
    await greg('PUT', `/deliveries/${onDay.id}/status`, { status: 'Delivered', cashCollected: 400 });
    const today = dayKey(new Date());
    await prisma.riderDailyReport.create({
      data: {
        riderId: seed.gregRiderId, date: new Date(today + 'T00:00:00.000Z'),
        deliveriesCompleted: 1, cashCollected: 400, cashHandedOver: 400,
        acknowledgedAt: new Date(), companyId: seed.companyId,
      },
    });
    const shut = await greg('PUT', `/deliveries/${onDay.id}/status`, { status: 'Delivered', cashCollected: 10 });
    eq('a checked day closes his finished drops', shut.status, 400);
    const runs = await greg('GET', '/deliveries/my/runs');
    eq('and his screen knows it', runs.body.dayChecked, true);

    section('a run still in his hands is never locked');
    // The lock is about finished work. An open run is work he is still doing.
    const openRun = await drop('ORD-OPEN');
    const picked = await greg('PUT', `/deliveries/${openRun.id}/status`, { status: 'PickedUp' });
    eq('he can still pick it up', picked.status, 200);
    const closeIt = await greg('PUT', `/deliveries/${openRun.id}/status`, { status: 'Delivered', cashCollected: 400 });
    eq('and close it, checked day or not', closeIt.status, 200);

    section('he still cannot touch a run that is not his');
    const others = await drop('ORD-OTHER');
    await prisma.delivery.update({ where: { id: others.id }, data: { riderId: seed.otherRiderId } });
    const poach = await greg('PUT', `/deliveries/${others.id}/status`, { status: 'Delivered', cashCollected: 400 });
    eq('not found, as far as he is concerned', poach.status, 404);
  },
};
