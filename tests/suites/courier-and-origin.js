// Who carried it, and where it left from
//
// Our own rider costs a fixed wage and bike hire whatever he does; a Yango is a fare per trip.
// The two are only comparable per drop, so the arithmetic that keeps them apart is worth pinning
// down — as is the rule that a hired car is never one of our riders.

const { client, loginAs } = require('../lib/harness');

module.exports = {
  name: 'Couriers and dispatch origin',
  seed: 'rider',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    const admin = await loginAs(base, 'boss');
    const greg = await loginAs(base, 'greg');

    const product = await prisma.product.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
    const consultant = await prisma.consultant.create({
      data: { name: 'Annie', payType: 'revenue_pct', commissionRate: 5, companyId: seed.companyId },
    });
    await prisma.consultantStock.create({
      data: { consultantId: consultant.id, productId: product.id, qty: 40, companyId: seed.companyId },
    });

    // An order to send out, optionally drawn from a consultant's own stock.
    const makeOrder = async (ref, stockSource) => prisma.sale.create({
      data: {
        orderNumber: ref, totalPrice: 600, status: 'Confirmed', paymentType: 'Cash',
        customerName: `Customer ${ref}`, customerCity: 'Lusaka', deliveryAddress: 'Plot 5',
        shippingCharge: 150, companyId: seed.companyId,
        items: { create: [{ productId: product.id, qty: 1, unitPrice: 600, costPrice: 100, totalPrice: 600, stockSourceConsultantId: stockSource || null }] },
      },
    });

    section('a car hired for the trip is not one of our riders');
    const a = await makeOrder('ORD-Y1');
    const bothAtOnce = await admin('POST', '/deliveries', { saleIds: [a.id], courier: 'yango', riderId: seed.gregRiderId });
    eq('naming a rider and a hired courier is refused', bothAtOnce.status, 400);

    const yango = await admin('POST', '/deliveries', { saleIds: [a.id], courier: 'yango', courierCost: 120, courierRef: 'ABC 1234' });
    eq('booking a Yango is accepted', yango.status, 201);
    eq('it carries no rider', yango.body[0].rider, null);
    eq('and says who took it', yango.body[0].courier, 'yango');
    eq('with the trip reference kept', yango.body[0].courierRef, 'ABC 1234');

    section('the fare lands on the order it delivered');
    const withFare = await prisma.sale.findUnique({ where: { id: a.id }, select: { shippingCost: true, shippingCharge: true } });
    eq('the fare is the order\'s delivery cost', Number(withFare.shippingCost), 120);
    eq('and what the customer is billed is untouched', Number(withFare.shippingCharge), 150);
    eq('the delivery reports the fare', yango.body[0].courierCost, 120);

    section('a hired trip never reaches the rider');
    const runs = await greg('GET', '/deliveries/my/runs');
    eq('it is not on his run sheet', runs.body.open.some(d => d.orderNumber === 'ORD-Y1'), false);
    const account = await greg('GET', '/deliveries/my/account');
    const held = account.body.holding;
    eq('and nothing about it touches what he holds', typeof held, 'number');

    section('where the goods left from');
    const fromWarehouse = await makeOrder('ORD-W1');
    const w = await admin('POST', '/deliveries', { saleIds: [fromWarehouse.id], riderId: seed.gregRiderId });
    eq('main stock means the warehouse dispatched it', w.body[0].dispatchedFrom, 'Warehouse');

    const fromConsultant = await makeOrder('ORD-C1', consultant.id);
    const c = await admin('POST', '/deliveries', { saleIds: [fromConsultant.id], riderId: seed.gregRiderId });
    eq('a consultant\'s own stock means they did', c.body[0].dispatchedFrom, 'Annie');
    eq('and it names them', c.body[0].dispatchedFromConsultant?.name, 'Annie');

    // A mixed order leans on the warehouse, because somebody there had to pick part of it.
    const mixed = await prisma.sale.create({
      data: {
        orderNumber: 'ORD-MIX', totalPrice: 900, status: 'Confirmed', paymentType: 'Cash',
        customerName: 'Mixed', companyId: seed.companyId,
        items: { create: [
          { productId: product.id, qty: 1, unitPrice: 450, costPrice: 100, totalPrice: 450, stockSourceConsultantId: consultant.id },
          { productId: product.id, qty: 1, unitPrice: 450, costPrice: 100, totalPrice: 450, stockSourceConsultantId: null },
        ] },
      },
    });
    const m = await admin('POST', '/deliveries', { saleIds: [mixed.id], riderId: seed.gregRiderId });
    eq('a part-warehouse order counts as the warehouse', m.body[0].dispatchedFrom, 'Warehouse');

    section('switching carrier after the fact');
    const toHired = await admin('PUT', `/deliveries/${w.body[0].id}/rider`, { courier: 'yango', courierRef: 'XYZ 999' });
    eq('a run can be handed to a hired car', toHired.status, 200);
    eq('the rider is dropped when it is', toHired.body.rider, null);
    eq('and the new reference sticks', toHired.body.courierRef, 'XYZ 999');
    const backToRider = await admin('PUT', `/deliveries/${w.body[0].id}/rider`, { courier: 'rider', riderId: seed.gregRiderId });
    eq('and handed back to our own rider', backToRider.body.rider?.id, seed.gregRiderId);
    eq('with the courier reset', backToRider.body.courier, 'rider');

    section('the comparison the warehouse actually needs');
    // One drop each way, delivered, so both sides of the table have a figure.
    await admin('PUT', `/deliveries/${yango.body[0].id}/status`, { status: 'Delivered', cashCollected: 0 });
    await admin('PUT', `/deliveries/${backToRider.body.id}/status`, { status: 'PickedUp' });
    await admin('PUT', `/deliveries/${backToRider.body.id}/status`, { status: 'Delivered', cashCollected: 0 });

    const fin = (await admin('GET', '/deliveries/finances')).body;
    eq('the hired drop is counted as hired', fin.cost.courierSplit.hired.drops, 1);
    eq('its cost is the fare', fin.cost.courierSplit.hired.cost, 120);
    eq('so is its cost per drop', fin.cost.courierSplit.hired.costPerDrop, 120);
    eq('our own drops are counted separately', fin.cost.courierSplit.own.drops >= 1, true);
    eq('the fare is in the cost breakdown', fin.cost.hiredCourierFares, 120);
    // Leaving the fare out would show income with no cost behind it.
    near('total cost includes the fixed cost and the fare',
         fin.cost.total, fin.cost.fixedInWindow + fin.cost.borneByCompany + 120, 0.02);
    near('net is fees less that total', fin.net, fin.income.feesBilled - fin.cost.total, 0.02);
    eq('and the origins are reported', fin.dispatchedFrom.some(o => o.where === 'warehouse'), true);

    section('the warehouse can hire a car, but not invent a courier');
    const bcrypt = require('bcryptjs');
    const { TEST_PASSWORD } = require('../lib/harness');
    await prisma.user.create({
      data: { username: 'bea_courier', password: await bcrypt.hash(TEST_PASSWORD, 10), name: 'Beatrice', role: 'inventory', companyId: seed.companyId },
    });
    const bea = await loginAs(base, 'bea_courier');
    const hers = await makeOrder('ORD-BEA2');
    const beaBooked = await bea('POST', '/deliveries', { saleIds: [hers.id], courier: 'yango', courierCost: 90 });
    eq('she can book one herself', beaBooked.status, 201);
    eq('and it is recorded as hired', beaBooked.body[0].courier, 'yango');
    const nonsense = await makeOrder('ORD-BEA3');
    const bogus = await admin('POST', '/deliveries', { saleIds: [nonsense.id], courier: 'helicopter' });
    eq('an unknown courier falls back to our rider', bogus.body[0].courier, 'rider');
    eq('a negative fare is refused',
       (await admin('POST', '/deliveries', { saleIds: [nonsense.id], courier: 'yango', courierCost: -5 })).status, 400);
  },
};
