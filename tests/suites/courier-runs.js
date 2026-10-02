// Out-of-town parcels, batched into the day's sessions
//
// Nine of ten live orders go out of town, so a courier drop is the main flow. A run is one trip
// to one courier at one session; Platinum charges per parcel because each goes to a different
// customer in a different town; and payment comes after dispatch, which makes a dispatched
// parcel money owed rather than a job finished.

const { client, loginAs, TEST_PASSWORD } = require('../lib/harness');

module.exports = {
  name: 'Courier runs and payment after dispatch',
  seed: 'rider',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    const admin = await loginAs(base, 'boss');
    const greg = await loginAs(base, 'greg');

    const bcrypt = require('bcryptjs');
    await prisma.user.create({
      data: { username: 'bea_runs', password: await bcrypt.hash(TEST_PASSWORD, 10), name: 'Beatrice', role: 'inventory', companyId: seed.companyId },
    });
    const bea = await loginAs(base, 'bea_runs');

    const product = await prisma.product.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
    // Out-of-town orders, unpaid — the customer pays once they have the receipt.
    const order = async (ref, town, total, items = 1) => prisma.sale.create({
      data: {
        orderNumber: ref, totalPrice: total, amountPaid: 0, paymentStatus: 'Unpaid', paymentType: 'Cash',
        status: 'Shipped', customerName: `Customer ${ref}`, customerCity: town, companyId: seed.companyId,
        items: { create: Array.from({ length: items }, () => ({ productId: product.id, qty: 1, unitPrice: total / items, costPrice: 100, totalPrice: total / items })) },
      },
    });

    section("the day's three sessions exist before anything is on them");
    const empty = await bea('GET', '/deliveries/runs');
    eq('she can see the sessions', empty.status, 200);
    eq('there are three', empty.body.sessions.length, 3);
    eq('named as the day runs', empty.body.sessions.map(s => s.slotLabel), ['Morning run', 'Afternoon run', 'Day-end run']);
    eq('at nine, one and four', empty.body.sessions.map(s => s.slot), ['09:00', '13:00', '16:00']);
    eq('all empty and open', empty.body.sessions.every(s => s.parcelCount === 0 && s.status === 'Open'), true);
    eq('and it says which session a parcel ready now would make', !!empty.body.next.slot, true);

    section('putting prepared parcels on a session');
    const a = await order('ORD-SOLWEZI', 'Solwezi', 900, 3);
    const b = await order('ORD-MONGU', 'Mongu', 450);
    const added = await bea('POST', '/deliveries/runs/parcels', {
      slot: '09:00', saleIds: [a.id, b.id], riderId: seed.gregRiderId,
    });
    eq('she can load the morning run', added.status, 201);
    eq('it holds both parcels', added.body.parcelCount, 2);
    eq('and names the towns they are going to', added.body.towns.sort(), ['Mongu', 'Solwezi']);
    // A parcel is one order, and an order carries however many products it carries.
    eq('a parcel carries all the order\'s products', added.body.parcels.find(p => p.orderNumber === 'ORD-SOLWEZI').items.length, 3);
    eq('the rider for the run is set', added.body.rider?.id, seed.gregRiderId);
    eq('and what is owed on it is visible before it goes', added.body.outstandingTotal, 1350);

    const again = await bea('POST', '/deliveries/runs/parcels', { slot: '09:00', saleIds: [a.id] });
    eq('an order already on a run cannot be added twice', again.status, 400);
    const badSlot = await bea('POST', '/deliveries/runs/parcels', { slot: '11:30', saleIds: [b.id] });
    eq('an invented session is refused', badSlot.status, 400);

    section('a parcel can come back off while the run is open');
    const c = await order('ORD-KATETE', 'Katete', 300);
    const three = await bea('POST', '/deliveries/runs/parcels', { slot: '09:00', saleIds: [c.id] });
    eq('three on the run now', three.body.parcelCount, 3);
    const pulled = await bea('DELETE', `/deliveries/runs/${three.body.id}/parcels/${three.body.parcels.find(p => p.orderNumber === 'ORD-KATETE').deliveryId}`);
    eq('and one can be pulled back', pulled.body.parcelCount, 2);

    section('dispatching it: a fee and a receipt for each parcel');
    const runId = added.body.id;
    const list = (await bea('GET', '/deliveries/runs')).body.sessions.find(s => s.slot === '09:00');
    const solwezi = list.parcels.find(p => p.orderNumber === 'ORD-SOLWEZI');
    const mongu = list.parcels.find(p => p.orderNumber === 'ORD-MONGU');

    const bad = await bea('PUT', `/deliveries/runs/${runId}/dispatch`, {
      parcels: [{ deliveryId: solwezi.deliveryId, fee: -5 }],
    });
    eq('a negative fee is refused', bad.status, 400);

    const dispatched = await bea('PUT', `/deliveries/runs/${runId}/dispatch`, {
      parcels: [
        { deliveryId: solwezi.deliveryId, fee: 180, receiptNo: 'PLT-00412' },
        { deliveryId: mongu.deliveryId, fee: 120, receiptNo: 'PLT-00413' },
      ],
    });
    eq('the run goes out', dispatched.status, 200);
    eq('and is marked dispatched', dispatched.body.status, 'Dispatched');
    eq('with the fees totalled', dispatched.body.feesTotal, 300);
    eq('every parcel is now with the courier', dispatched.body.parcels.every(p => p.status === 'AtCourier'), true);
    eq('each carrying its receipt', dispatched.body.parcels.map(p => p.receiptNo).sort(), ['PLT-00412', 'PLT-00413']);

    const solwaziSale = await prisma.sale.findUnique({ where: { id: a.id }, select: { shippingCost: true, status: true } });
    eq('the fee is the order\'s delivery cost', Number(solwaziSale.shippingCost), 180);
    eq('and the order is not delivered — it is with Platinum', solwaziSale.status !== 'Delivered', true);

    section('the rider is credited what he paid out');
    const acct = (await greg('GET', '/deliveries/my/account')).body;
    eq('both fees are owed back to him', acct.owedToRider, 300);
    const his = (await greg('GET', '/deliveries/my/expenses')).body;
    eq('each logged against its own order', his.filter(e => e.onSaleShipping).length, 2);

    eq('a dispatched run cannot go out twice',
       (await bea('PUT', `/deliveries/runs/${runId}/dispatch`, { parcels: [] })).status, 400);
    eq('nor can parcels be added to it',
       (await bea('POST', '/deliveries/runs/parcels', { slot: '09:00', saleIds: [c.id] })).status, 400);

    section('dispatched means money owed, not a job finished');
    const owing = await admin('GET', '/deliveries/awaiting-payment');
    eq('both parcels are waiting on payment', owing.body.parcels.length, 2);
    eq('for the full order value', owing.body.total, 1350);
    eq('each showing the receipt the customer was sent', owing.body.parcels.every(p => p.receiptNo), true);
    eq('and how long it has been waiting', typeof owing.body.parcels[0].daysWaiting, 'number');

    section('confirming the customer paid');
    const paid = await admin('PUT', `/deliveries/${mongu.deliveryId}/payment-received`, {});
    eq('confirming is accepted', paid.status, 200);
    const mongoSale = await prisma.sale.findUnique({ where: { id: b.id }, select: { paymentStatus: true, amountPaid: true, status: true } });
    eq('the order is paid in full', mongoSale.paymentStatus, 'Paid');
    eq('for the amount outstanding', Number(mongoSale.amountPaid), 450);
    eq('and only then is the order delivered', mongoSale.status, 'Delivered');
    const payments = await prisma.creditPayment.findMany({ where: { saleId: b.id } });
    eq('a real payment is recorded', payments.length, 1);
    eq('referencing the courier receipt', payments[0].reference.includes('PLT-00413'), true);

    const after = await admin('GET', '/deliveries/awaiting-payment');
    eq('so it leaves the awaiting-payment list', after.body.parcels.length, 1);
    eq('leaving only what is still owed', after.body.total, 900);

    const overpay = await admin('PUT', `/deliveries/${solwezi.deliveryId}/payment-received`, { amount: 5000 });
    eq('more than is owed is refused', overpay.status, 400);
    const part = await admin('PUT', `/deliveries/${solwezi.deliveryId}/payment-received`, { amount: 400 });
    eq('a part payment is accepted', part.status, 200);
    const partSale = await prisma.sale.findUnique({ where: { id: a.id }, select: { paymentStatus: true, status: true } });
    eq('the order reads partly paid', partSale.paymentStatus, 'Partial');
    eq('and stays with the courier until it is settled', partSale.status !== 'Delivered', true);
    eq('so it is still on the list', (await admin('GET', '/deliveries/awaiting-payment')).body.parcels.length, 1);

    section('who may touch any of this');
    eq('a rider cannot see the runs', (await greg('GET', '/deliveries/runs')).status, 403);
    eq('nor the awaiting-payment list', (await greg('GET', '/deliveries/awaiting-payment')).status, 403);
    eq('nor confirm a payment', (await greg('PUT', `/deliveries/${solwezi.deliveryId}/payment-received`, {})).status, 403);

    section('which towns we cover is a setting, not a hardcoded Lusaka');
    const here = await order('ORD-HOME', 'Lusaka', 200);
    const away = await order('ORD-AWAY', 'Kitwe', 200);
    const nowhere = await order('ORD-NOTOWN', null, 200);

    const unset = (await bea('GET', '/deliveries/unassigned')).body;
    const find = (rows, ref) => rows.find(r => r.orderNumber === ref);
    eq('with nothing set it falls back to Lusaka', find(unset, 'ORD-HOME').isOutOfTown, false);
    eq('so Kitwe is out of town', find(unset, 'ORD-AWAY').isOutOfTown, true);
    // A blank town is nobody's decision yet, and treating it as local would put it on the bike.
    eq('and an order with no town is treated as out of town', find(unset, 'ORD-NOTOWN').isOutOfTown, true);

    await admin('PUT', '/settings', { delivery_local_cities: 'Lusaka, Kitwe' });
    const two = (await bea('GET', '/deliveries/unassigned')).body;
    eq('adding Kitwe makes it local', find(two, 'ORD-AWAY').isOutOfTown, false);
    eq('Lusaka stays local', find(two, 'ORD-HOME').isOutOfTown, false);
    const runs2 = (await bea('GET', '/deliveries/runs')).body;
    eq('and the runs screen is told what counts as local', runs2.localCities, ['Lusaka', 'Kitwe']);

    await admin('PUT', '/settings', { delivery_local_cities: 'Ndola' });
    const moved = (await bea('GET', '/deliveries/unassigned')).body;
    eq('moving base makes Lusaka out of town', find(moved, 'ORD-HOME').isOutOfTown, true);
    eq('and the new base local', find(moved, 'ORD-NOTOWN').isOutOfTown, true);

    // Whitespace and case are how a real person types a list.
    await admin('PUT', '/settings', { delivery_local_cities: '  lusaka ,  KITWE  ' });
    const messy = (await bea('GET', '/deliveries/unassigned')).body;
    eq('it copes with spacing and case', [find(messy, 'ORD-HOME').isOutOfTown, find(messy, 'ORD-AWAY').isOutOfTown], [false, false]);

    await admin('PUT', '/settings', { delivery_local_cities: '' });
    const blank = (await bea('GET', '/deliveries/unassigned')).body;
    eq('cleared, it falls back to Lusaka again', find(blank, 'ORD-HOME').isOutOfTown, false);
  },
};
