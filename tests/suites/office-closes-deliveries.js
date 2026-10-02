// Closing a delivery nobody's phone is handling
//
// A delivery with a rider gets moved along from his app. One without — a hired car, or a run the
// owner does himself — has nobody whose app will ever touch it, and the office screen offered
// only reassign and delete. So those sat in "in progress" forever, which is exactly what happened
// to the Yango drops.

const { loginAs, TEST_PASSWORD } = require('../lib/harness');

module.exports = {
  name: 'The office can close a delivery',
  seed: 'rider',
  async run({ base, prisma, seed, t }) {
    const { eq, section } = t;
    const admin = await loginAs(base, 'boss');
    const greg = await loginAs(base, 'greg');

    const bcrypt = require('bcryptjs');
    await prisma.user.create({
      data: { username: 'bea_close', password: await bcrypt.hash(TEST_PASSWORD, 10), name: 'Beatrice', role: 'inventory', companyId: seed.companyId },
    });
    const bea = await loginAs(base, 'bea_close');

    const product = await prisma.product.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
    const order = async (ref, total = 500) => prisma.sale.create({
      data: {
        orderNumber: ref, totalPrice: total, amountPaid: 0, paymentStatus: 'Unpaid', paymentType: 'Cash',
        status: 'Confirmed', customerName: `Customer ${ref}`, customerCity: 'Lusaka', companyId: seed.companyId,
        items: { create: [{ productId: product.id, qty: 1, unitPrice: total, costPrice: 100, totalPrice: total }] },
      },
    });

    section('a hired car has nobody whose app would close it');
    const hired = await order('ORD-YANGO');
    const booked = await admin('POST', '/deliveries', { saleIds: [hired.id], courier: 'yango', courierCost: 90 });
    eq('booked', booked.status, 201);
    eq('it carries no rider', booked.body[0].rider, null);
    const openList = await admin('GET', '/deliveries?open=true');
    eq('so it sits in progress', openList.body.some(d => d.orderNumber === 'ORD-YANGO'), true);
    // The hole: before this, nothing could move it out of that list.
    const closed = await admin('PUT', `/deliveries/${booked.body[0].id}/status`, {
      status: 'Delivered', recipientName: 'Gate guard', cashCollected: 0,
    });
    eq('the office can close it', closed.status, 200);
    eq('and it leaves the in-progress list',
       (await admin('GET', '/deliveries?open=true')).body.some(d => d.orderNumber === 'ORD-YANGO'), false);
    const hiredSale = await prisma.sale.findUnique({ where: { id: hired.id }, select: { status: true } });
    eq('the order is delivered with it', hiredSale.status, 'Delivered');

    section('the warehouse can close one too');
    const theirs = await order('ORD-BEA-CLOSE');
    const b = await bea('POST', '/deliveries', { saleIds: [theirs.id], courier: 'other', courierRef: 'Bus' });
    eq('she can close a hired drop', (await bea('PUT', `/deliveries/${b.body[0].id}/status`, { status: 'Delivered', cashCollected: 0 })).status, 200);

    section('an order the owner delivers himself');
    // He is an admin with a rider record, so he gets no rider app and closes it from the office.
    const gerald = await prisma.rider.create({ data: { name: 'Gerald', isActive: true, companyId: seed.companyId } });
    const mine = await order('ORD-GERALD', 700);
    const assigned = await admin('POST', '/deliveries', { saleIds: [mine.id], riderId: gerald.id });
    eq('it can be assigned to him', assigned.body[0].rider?.name, 'Gerald');
    eq('it does not appear on the rider app of somebody else',
       (await greg('GET', '/deliveries/my/runs')).body.open.some(d => d.orderNumber === 'ORD-GERALD'), false);
    const done = await admin('PUT', `/deliveries/${assigned.body[0].id}/status`, {
      status: 'Delivered', recipientName: 'Customer', cashCollected: 700,
    });
    eq('and he closes it from the office', done.status, 200);
    eq('with the cash recorded against him', done.body.cashCollected, '700');
    const acct = (await admin('GET', '/deliveries/finances')).body;
    eq('so it shows as cash he is holding',
       acct.riderAccounts.find(a => a.name === 'Gerald')?.holding, 700);

    section('failing one from the office');
    const bad = await order('ORD-FAIL-OFFICE');
    const toFail = await admin('POST', '/deliveries', { saleIds: [bad.id], courier: 'yango' });
    const noReason = await admin('PUT', `/deliveries/${toFail.body[0].id}/status`, { status: 'Failed' });
    eq('a failure still needs a reason', noReason.status, 400);
    const failed = await admin('PUT', `/deliveries/${toFail.body[0].id}/status`, {
      status: 'Failed', failureReason: 'Courier could not deliver',
    });
    eq('with one it is accepted', failed.status, 200);
    eq('and the reason is kept', failed.body.failureReason, 'Courier could not deliver');
    eq('it leaves the in-progress list too',
       (await admin('GET', '/deliveries?open=true')).body.some(d => d.orderNumber === 'ORD-FAIL-OFFICE'), false);

    section('a rider still cannot close somebody else\'s');
    const other = await order('ORD-NOT-HIS');
    const theirRun = await admin('POST', '/deliveries', { saleIds: [other.id], riderId: seed.otherRiderId });
    eq('it is invisible to him', (await greg('PUT', `/deliveries/${theirRun.body[0].id}/status`, { status: 'Delivered' })).status, 404);

    section('handing an in-progress delivery to somebody else');
    // The reassign dropdown used to offer only our own people, so a delivery already on Yango
    // showed as nobody and touching it would have quietly made it a rider delivery.
    const movable = await order('ORD-HANDOVER');
    const onYango = await admin('POST', '/deliveries', { saleIds: [movable.id], courier: 'yango', courierRef: 'ABC 123' });
    eq('it starts on a hired car', onYango.body[0].courier, 'yango');
    eq('with no rider', onYango.body[0].rider, null);

    const toGreg = await admin('PUT', `/deliveries/${onYango.body[0].id}/rider`, { courier: 'rider', riderId: seed.gregRiderId });
    eq('it can be handed to one of ours', toGreg.status, 200);
    eq('who is now carrying it', toGreg.body.rider?.id, seed.gregRiderId);
    eq('and the courier reads as us', toGreg.body.courier, 'rider');
    eq('so it reaches his run sheet',
       (await greg('GET', '/deliveries/my/runs')).body.open.some(d => d.orderNumber === 'ORD-HANDOVER'), true);

    const backToHired = await admin('PUT', `/deliveries/${onYango.body[0].id}/rider`, { courier: 'other', riderId: null, courierRef: 'Bus to Kabwe' });
    eq('and handed back out to a hired courier', backToHired.body.courier, 'other');
    eq('which drops the rider rather than leaving him on it', backToHired.body.rider, null);
    eq('keeping the new reference', backToHired.body.courierRef, 'Bus to Kabwe');
    eq('and it leaves his run sheet',
       (await greg('GET', '/deliveries/my/runs')).body.open.some(d => d.orderNumber === 'ORD-HANDOVER'), false);

    section('everyone who assigns sees the same choices');
    // The bug was two pickers offering different options. The endpoint has to accept the same
    // set from whoever is asking, or the screens will disagree again.
    const hers = await order('ORD-BEA-YANGO');
    const beaYango = await bea('POST', '/deliveries', { saleIds: [hers.id], courier: 'yango', courierCost: 70 });
    eq('the warehouse can book a hired car', beaYango.body[0].courier, 'yango');
    const beaToRider = await bea('PUT', `/deliveries/${beaYango.body[0].id}/rider`, { courier: 'rider', riderId: seed.gregRiderId });
    eq('and hand it to one of ours', beaToRider.body.rider?.id, seed.gregRiderId);
    const adminYango = await admin('PUT', `/deliveries/${beaYango.body[0].id}/rider`, { courier: 'yango', riderId: null });
    eq('and an admin can do exactly the same', adminYango.body.courier, 'yango');
  },
};
