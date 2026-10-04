// Looking back at a day already worked
//
// Every other delivery screen answers "what is outstanding right now". None of them could answer
// "what happened on Tuesday": the rider's own screen filtered to today and dropped yesterday at
// midnight, and the office saw open runs and unremitted cash but never a completed delivery that
// had no cash behind it. So a day nobody balanced on the day became unreachable — the rows were
// in the database and no screen would show them.
//
// This also covers the fare on a mid-flight handover, because that is the other way a figure used
// to go missing: handing a parcel to a hired courier changed who was carrying it and lost what
// the trip cost.

const { loginAs } = require('../lib/harness');

// What the server calls a Zambian day.
const dayKey = (d) => new Date(d.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);

module.exports = {
  name: 'A rider\'s past days can be read',
  seed: 'rider',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    const admin = await loginAs(base, 'boss');
    const greg = await loginAs(base, 'greg');

    const today = new Date();
    const threeDaysAgo = new Date(today.getTime() - 3 * 86400000);
    const tenDaysAgo = new Date(today.getTime() - 10 * 86400000);

    const product = await prisma.product.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
    const order = async (ref, total = 400) => prisma.sale.create({
      data: {
        orderNumber: ref, totalPrice: total, amountPaid: 0, paymentStatus: 'Unpaid', paymentType: 'Cash',
        status: 'Confirmed', customerName: `Customer ${ref}`, customerCity: 'Lusaka', companyId: seed.companyId,
        items: { create: [{ productId: product.id, qty: 1, unitPrice: total, costPrice: 100, totalPrice: total }] },
      },
    });

    section('a day three days back, with cash he never handed over');
    const past = await order('ORD-PAST');
    await prisma.delivery.create({
      data: {
        saleId: past.id, riderId: seed.gregRiderId, status: 'Delivered',
        assignedAt: threeDaysAgo, deliveredAt: threeDaysAgo,
        cashCollected: 400, cashRemitted: false, companyId: seed.companyId,
      },
    });
    // The delivery that used to vanish: completed, nothing collected, so it appeared on no screen.
    const noCash = await order('ORD-NOCASH');
    await prisma.delivery.create({
      data: {
        saleId: noCash.id, riderId: seed.gregRiderId, status: 'Delivered',
        assignedAt: threeDaysAgo, deliveredAt: threeDaysAgo,
        cashCollected: 0, cashRemitted: false, companyId: seed.companyId,
      },
    });

    const hist = await admin('GET', `/deliveries/riders/${seed.gregRiderId}/history`);
    eq('the office can read it', hist.status, 200);
    const pastDay = hist.body.days.find(d => d.date === dayKey(threeDaysAgo));
    eq('that day is there at all', !!pastDay, true);
    eq('both drops are on it', pastDay.delivered, 2);
    near('with the cash he took', pastDay.cashCollected, 400);
    near('none of which reached the books', pastDay.cashHeld, 400);
    eq('so the day is not settled', pastDay.settled, false);
    eq('and the drop with no cash is listed too', pastDay.deliveries.some(d => d.orderNumber === 'ORD-NOCASH'), true);
    eq('he sent no report for it', pastDay.report, null);
    eq('which the totals count', hist.body.totals.reportsMissing >= 1, true);

    section('a day outside the window is left out');
    const old = await order('ORD-OLD');
    await prisma.delivery.create({
      data: {
        saleId: old.id, riderId: seed.gregRiderId, status: 'Delivered',
        assignedAt: tenDaysAgo, deliveredAt: tenDaysAgo,
        cashCollected: 150, cashRemitted: true, companyId: seed.companyId,
      },
    });
    const narrow = await admin('GET', `/deliveries/riders/${seed.gregRiderId}/history?from=${dayKey(threeDaysAgo)}&to=${dayKey(today)}`);
    eq('ten days back is not in a four-day window', narrow.body.days.some(d => d.date === dayKey(tenDaysAgo)), false);
    const wide = await admin('GET', `/deliveries/riders/${seed.gregRiderId}/history?from=${dayKey(tenDaysAgo)}&to=${dayKey(today)}`);
    eq('but it is in a wider one', wide.body.days.some(d => d.date === dayKey(tenDaysAgo)), true);
    near('and that cash did reach the books', wide.body.days.find(d => d.date === dayKey(tenDaysAgo)).cashRemitted, 150);

    section('what he reported sits next to what the records say');
    await prisma.riderDailyReport.create({
      data: {
        riderId: seed.gregRiderId, date: new Date(dayKey(threeDaysAgo) + 'T00:00:00.000Z'),
        deliveriesCompleted: 3, cashCollected: 500, expensesPaid: 0,
        cashHandedOver: 400, closingFloat: 100, companyId: seed.companyId,
      },
    });
    const withReport = await admin('GET', `/deliveries/riders/${seed.gregRiderId}/history`);
    const d3 = withReport.body.days.find(d => d.date === dayKey(threeDaysAgo));
    eq('the report is attached to its day', d3.report.deliveriesCompleted, 3);
    eq('and the gap is spelled out', d3.variance.deliveriesCompleted, 1);
    near('for the money too', d3.variance.cashCollected, 100);
    eq('an unchecked report leaves the day unsettled', d3.settled, false);

    section('settling the day closes it');
    const held = d3.deliveries.find(d => d.orderNumber === 'ORD-PAST');
    const remit = await admin('PUT', `/deliveries/${held.id}/remit`, { cashRemitted: true });
    eq('cash can be recorded on a past day', remit.status, 200);
    await prisma.riderDailyReport.updateMany({
      where: { riderId: seed.gregRiderId, date: new Date(dayKey(threeDaysAgo) + 'T00:00:00.000Z') },
      data: { acknowledgedAt: new Date() },
    });
    const settled = await admin('GET', `/deliveries/riders/${seed.gregRiderId}/history`);
    const d3b = settled.body.days.find(d => d.date === dayKey(threeDaysAgo));
    near('nothing of ours is left in his pocket', d3b.cashHeld, 0);
    eq('so the day reads settled', d3b.settled, true);

    section('only an admin may read it');
    const asRider = await greg('GET', `/deliveries/riders/${seed.gregRiderId}/history`);
    eq('the rider cannot ask for it', asRider.status === 403 || asRider.status === 404, true);
    const missing = await admin('GET', '/deliveries/riders/nope/history');
    eq('nor can a rider who does not exist be read', missing.status, 404);

    section('the rider can look back at his own day');
    const hisToday = await greg('GET', '/deliveries/my/runs');
    eq('today says so', hisToday.body.isToday, true);
    eq('and is dated', hisToday.body.date, dayKey(today));
    const hisPast = await greg('GET', `/deliveries/my/runs?date=${dayKey(threeDaysAgo)}`);
    eq('an earlier day comes back', hisPast.status, 200);
    eq('marked as not today', hisPast.body.isToday, false);
    eq('with the two drops he made', hisPast.body.completedToday.length, 2);
    eq('and no open runs, because those are not that day\'s business', hisPast.body.open.length, 0);
    // The bug as the user met it: yesterday's work absent from his phone.
    eq('today does not show that day\'s drops', hisToday.body.completedToday.some(d => d.orderNumber === 'ORD-PAST'), false);

    section('and report on a day he missed');
    const late = await greg('POST', '/deliveries/my/report', {
      date: dayKey(threeDaysAgo), cashHandedOver: 400, closingFloat: 0,
    });
    eq('a late report is accepted', late.status, 201);
    eq('against the day it belongs to', dayKey(new Date(late.body.date)), dayKey(threeDaysAgo));
    const reread = await greg('GET', `/deliveries/my/report?date=${dayKey(threeDaysAgo)}`);
    near('and it reads back with that day\'s figures', reread.body.actuals.cashCollected, 400);

    section('a car is not asked for a daily report');
    // The owner delivers sometimes. His rider record carries his admin login, not a rider one,
    // and he is not going to send himself a report — counting every drop of his as a missing
    // report was noise on a screen whose whole job is to show what needs attention.
    const ownerUser = await prisma.user.findFirst({ where: { username: 'boss' }, select: { id: true } });
    const car = await prisma.rider.create({
      data: { name: 'The Owner', vehicle: 'Car', userId: ownerUser.id, companyId: seed.companyId },
    });
    const carDrop = await order('ORD-CAR');
    await prisma.delivery.create({
      data: {
        saleId: carDrop.id, riderId: car.id, status: 'Delivered',
        assignedAt: threeDaysAgo, deliveredAt: threeDaysAgo,
        cashCollected: 0, companyId: seed.companyId,
      },
    });
    const carHist = await admin('GET', `/deliveries/riders/${car.id}/history`);
    eq('his day is still there', carHist.body.days.some(d => d.date === dayKey(threeDaysAgo)), true);
    eq('but no report is expected of him', carHist.body.rider.expectsReports, false);
    eq('so nothing is counted as missing', carHist.body.totals.reportsMissing, 0);
    const gregHist = await admin('GET', `/deliveries/riders/${seed.gregRiderId}/history`);
    eq('while a rider with a login is still expected to report', gregHist.body.rider.expectsReports, true);

    section('a fare on a mid-flight handover lands on the order');
    const moving = await order('ORD-HANDOVER', 600);
    const assigned = await admin('POST', '/deliveries', { saleIds: [moving.id], riderId: seed.gregRiderId });
    eq('ours is carrying it', assigned.status, 201);
    const before = await prisma.sale.findUnique({ where: { id: moving.id }, select: { shippingCost: true } });
    near('and it has cost us nothing yet', parseFloat(before.shippingCost), 0);

    const handed = await admin('PUT', `/deliveries/${assigned.body[0].id}/rider`, {
      courier: 'yango', riderId: null, courierCost: 85, courierRef: 'ABC 123',
    });
    eq('handing it to a hired car works', handed.status, 200);
    eq('the rider is off it', handed.body.rider, null);
    eq('the reference is kept', handed.body.courierRef, 'ABC 123');
    const after = await prisma.sale.findUnique({ where: { id: moving.id }, select: { shippingCost: true } });
    near('and the fare is now a cost of the order', parseFloat(after.shippingCost), 85);

    section('handing it on again adds the second fare rather than replacing the first');
    const again = await admin('PUT', `/deliveries/${assigned.body[0].id}/rider`, {
      courier: 'other', riderId: null, courierCost: 40,
    });
    eq('accepted', again.status, 200);
    const twice = await prisma.sale.findUnique({ where: { id: moving.id }, select: { shippingCost: true } });
    near('both trips are paid for', parseFloat(twice.shippingCost), 125);

    section('a handover is not money owed back to the rider');
    // He never put his hand in his pocket — the office booked the car. Crediting him here would
    // pay him for a fare he did not front.
    const owed = await prisma.riderExpense.count({ where: { riderId: seed.gregRiderId, companyId: seed.companyId } });
    eq('so no expense of his was raised', owed, 0);

    section('a nonsense fare is refused');
    const bad = await admin('PUT', `/deliveries/${assigned.body[0].id}/rider`, {
      courier: 'yango', riderId: null, courierCost: -5,
    });
    eq('a negative fare is rejected', bad.status, 400);
    const unchanged = await prisma.sale.findUnique({ where: { id: moving.id }, select: { shippingCost: true } });
    near('and nothing moved', parseFloat(unchanged.shippingCost), 125);

    section('handing it back to one of us costs nothing');
    const backToUs = await admin('PUT', `/deliveries/${assigned.body[0].id}/rider`, {
      courier: 'rider', riderId: seed.gregRiderId,
    });
    eq('accepted', backToUs.status, 200);
    eq('he is carrying it again', backToUs.body.rider.id, seed.gregRiderId);
    const stillSame = await prisma.sale.findUnique({ where: { id: moving.id }, select: { shippingCost: true } });
    near('and what the earlier trips cost stands', parseFloat(stillSame.shippingCost), 125);
  },
};
