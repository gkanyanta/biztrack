// The rider's own money
//
// Ported from the throwaway scripts these features were built against, so the coverage is the
// same coverage that caught the bugs in the first place rather than something written afterwards
// to look thorough.

const { client } = require('../lib/harness');

module.exports = {
  name: "The rider's own money",
  seed: 'rider',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    // The suites were written against two names for the same thing; both are the shared client.
    const BASE = base;
    const mk = (token) => client(base, token);
    const api = mk;
    const wages = (cat) => prisma.expense.findMany({ where: { category: cat } });


  const login = async (u) => (await mk()('POST', '/auth/login', { username: u, password: 'secret123' })).body.token;
  const admin = mk(await login('boss'));
  const greg = mk(await login('greg'));
  const other = mk(await login('other'));

  console.log('-- his account before he spends anything --');
  let acct = (await greg('GET', '/deliveries/my/account')).body;
  eq('holding the three K500 collections', acct.holding, 1500);
  eq('nothing of his own is out', acct.owedToRider, 0);
  eq('so he owes the company all of it', acct.netDue, 1500);

  section('he pays for things on the road');
  const e1 = await greg('POST', '/deliveries/my/expenses', { category: 'Platinum courier', amount: 200, description: 'Parcel to Ndola', rechargeable: true, saleId: seed.saleIds[0] });
  eq('a rechargeable courier fee is accepted', e1.status, 201);
  const e2 = await greg('POST', '/deliveries/my/expenses', { category: 'Fuel', amount: 150, rechargeable: false });
  eq('and fuel, which is the company\'s own cost', e2.status, 201);
  const bad = await greg('POST', '/deliveries/my/expenses', { category: 'Bribes', amount: 50 });
  eq('an invented category is refused', bad.status, 400);
  const zero = await greg('POST', '/deliveries/my/expenses', { category: 'Fuel', amount: 0 });
  eq('so is a zero amount', zero.status, 400);

  acct = (await greg('GET', '/deliveries/my/account')).body;
  eq('his own money out is now K350', acct.owedToRider, 350);
  eq('so he hands over K1,150, not K1,500', acct.netDue, 1150);
  eq('no expense reaches the books yet', (await wages('Delivery Costs')).length, 0);

  section('one rider cannot see another\'s money');
  const otherView = (await other('GET', '/deliveries/my/expenses')).body;
  eq("the second rider's list is empty", otherView.length, 0);
  const otherAcct = (await other('GET', '/deliveries/my/account')).body;
  eq('and his account is clean', [otherAcct.holding, otherAcct.owedToRider], [0, 0]);
  const adminAsRider = await admin('GET', '/deliveries/my/account');
  eq('an admin is not a rider', adminAsRider.status, 403);

  section('his account of the day');
  const pre = (await greg('GET', '/deliveries/my/report')).body;
  eq('the form is pre-filled with three drops done', pre.actuals.deliveriesCompleted, 3);
  eq('one failed', pre.actuals.deliveriesFailed, 1);
  eq('and the reason is carried through', pre.actuals.failureReasons[0].reason, 'Customer not available');
  eq('cash the records show', pre.actuals.cashCollected, 1500);
  eq('and what he logged spending', pre.actuals.expensesPaid, 350);

  const rep = await greg('POST', '/deliveries/my/report', {
    deliveriesCompleted: 3, deliveriesFailed: 1, cashCollected: 1500, expensesPaid: 350, cashHandedOver: 1100, closingFloat: 50,
  });
  eq('the report is accepted', rep.status, 201);
  const again = await greg('POST', '/deliveries/my/report', { deliveriesCompleted: 3, deliveriesFailed: 1, cashCollected: 1500, expensesPaid: 350, cashHandedOver: 1150, closingFloat: 0 });
  eq('sending again corrects rather than duplicates', again.status, 201);
  eq('still only one report for the day', (await prisma.riderDailyReport.count({ where: { riderId: seed.gregRiderId } })), 1);

  const reviewed = (await admin('GET', '/deliveries/reports')).body;
  eq('the office sees it', reviewed.length, 1);
  eq('with the system figures beside his', reviewed[0].actuals.cashCollected, 1500);
  eq('and nothing unaccounted for', reviewed[0].variance.unaccounted, 0);

  section('settling: the company carried the fuel');
  const fuelId = e2.body.id;
  const s2 = await admin('PUT', `/deliveries/expenses/${fuelId}`, { settle: true, outcome: 'company_cost' });
  eq('settled', s2.status, 200);
  const dc = await wages('Delivery Costs');
  eq('a Delivery Costs expense is raised', dc.length, 1);
  eq('for the full K150', Number(dc[0].amount), 150);
  acct = (await greg('GET', '/deliveries/my/account')).body;
  eq('and it clears off what he is owed', acct.owedToRider, 200);

  section('settling a fee that already sits on the order');
  const s1 = await admin('PUT', `/deliveries/expenses/${e1.body.id}`, { settle: true, outcome: 'recharged', rechargedAmount: 200 });
  eq('settled', s1.status, 200);
  eq('no second cost is booked', (await wages('Delivery Costs')).length, 1);
  // Billing the customer for a courier drop is the order's delivery charge. Keeping a recharge
  // figure on the expense row as well would be a second place for the same decision to live.
  eq('so no recharge figure is kept on the expense', Number(s1.body.rechargedAmount || 0), 0);
  const feeOrder = await prisma.sale.findUnique({ where: { id: seed.saleIds[0] }, select: { shippingCost: true } });
  eq("and the fee is the order's delivery cost", Number(feeOrder.shippingCost), 200);
  acct = (await greg('GET', '/deliveries/my/account')).body;
  eq('he is square on his own money', acct.owedToRider, 0);
  eq('so he owes the full collections again', acct.netDue, 1500);

  section('a partial recharge splits the difference');
  const e3 = await greg('POST', '/deliveries/my/expenses', { category: 'Other courier', amount: 300, rechargeable: true });
  const s3 = await admin('PUT', `/deliveries/expenses/${e3.body.id}`, { settle: true, outcome: 'recharged', rechargedAmount: 180 });
  eq('settled', s3.status, 200);
  const dc2 = await wages('Delivery Costs');
  eq('only the part not charged on becomes a cost', dc2.length, 2);
  eq('which is K120 of the K300', Number(dc2.find(e => Number(e.amount) === 120)?.amount), 120);

  section('corrections');
  const un = await admin('PUT', `/deliveries/expenses/${fuelId}`, { unsettle: true });
  eq('unsettling works', un.status, 200);
  eq('and takes its expense back out', (await wages('Delivery Costs')).length, 1);
  acct = (await greg('GET', '/deliveries/my/account')).body;
  eq('the fuel is owed to him again', acct.owedToRider, 150);
  const delSettled = await greg('DELETE', `/deliveries/my/expenses/${e1.body.id}`);
  eq('he cannot delete something already settled', delSettled.status, 400);
  const delOwn = await greg('DELETE', `/deliveries/my/expenses/${fuelId}`);
  eq('but he can take back an unsettled one', delOwn.status, 200);

  section('the delivery finances dashboard');
  const fin = (await admin('GET', '/deliveries/finances')).body;
  eq('three deliveries in the window', fin.deliveries, 3);
  eq("the wage comes from Greg's payroll record", fin.cost.riderMonthly, 3100);
  eq('and it says so', fin.cost.riderPaidFromPayroll, true);
  near('bike hire is the weekly rate over 52/12', fin.cost.bikeMonthly, 5200, 1);
  near('fixed monthly is the two together', fin.cost.fixedMonthly, 8300, 1);
  near('prorated across 30 days', fin.cost.fixedInWindow, 8300 * (30 / 30.44), 5);
  eq('fees billed are the three K60 charges', fin.income.feesBilled, 180);
  near('cash through his hands', fin.income.cashCollectedAtDoors, 1500, 0.01);
  eq('the courier benchmark is the K50 default', fin.courierFee, 50);
  const expectedTotal = fin.cost.fixedInWindow + fin.cost.borneByCompany;
  near('total cost is fixed plus what the company carried', fin.cost.total, expectedTotal, 0.02);
  near('net is fees less total cost', fin.net, fin.income.feesBilled - fin.cost.total, 0.02);
  eq('and his position is on it', fin.riderAccounts.find(a => a.riderId === seed.gregRiderId).netDue, 1500);

  section('acknowledging the report');
  const ackd = await admin('PUT', `/deliveries/reports/${reviewed[0].id}/acknowledge`, { acknowledged: true });
  eq('acknowledged', ackd.status, 200);
  eq('and the timestamp is set', !!ackd.body.acknowledgedAt, true);
  const open = (await admin('GET', '/deliveries/reports?unacknowledged=true')).body;
  eq('so it drops off the waiting list', open.length, 0);

    section("a parcel taken to a courier is the order's delivery cost");
    // Its own order, so this section does not inherit the fee the earlier one posted.
    const freshProduct = await prisma.product.findFirst({ where: { companyId: seed.companyId }, select: { id: true } });
    const courierSale = await prisma.sale.create({
      data: {
        orderNumber: 'ORD-COURIER', totalPrice: 700, status: 'Confirmed', paymentType: 'Cash',
        customerName: 'Ndola Customer', companyId: seed.companyId,
        items: { create: [{ productId: freshProduct.id, qty: 1, unitPrice: 700, costPrice: 100, totalPrice: 700 }] },
      },
      select: { id: true, shippingCost: true, shippingCharge: true },
    });
    eq('the order starts with no delivery cost', Number(courierSale.shippingCost), 0);

    const drop = await greg('POST', '/deliveries/my/expenses', {
      category: 'Platinum courier', amount: 180, saleId: courierSale.id, rechargeable: true,
      description: 'Parcel to Ndola',
    });
    eq('he can log the drop against the order', drop.status, 201);
    eq('and it is marked as living on the order', drop.body.onSaleShipping, true);

    const afterDrop = await prisma.sale.findUnique({ where: { id: courierSale.id }, select: { shippingCost: true } });
    eq("the fee became the order's delivery cost", Number(afterDrop.shippingCost), 180);

    acct = (await greg('GET', '/deliveries/my/account')).body;
    eq('and the company owes him the fee', acct.owedToRider, 180);

    section('settling it must not charge the same money twice');
    // Gross profit already subtracts shippingCost, so a second expense would double it.
    const beforeSettle = (await wages('Delivery Costs')).length;
    const settled = await admin('PUT', `/deliveries/expenses/${drop.body.id}`, { settle: true, outcome: 'company_cost' });
    eq('settling is accepted', settled.status, 200);
    eq('no delivery-cost expense is raised', (await wages('Delivery Costs')).length, beforeSettle);
    const stillOnSale = await prisma.sale.findUnique({ where: { id: courierSale.id }, select: { shippingCost: true } });
    eq('the cost stays on the order where it belongs', Number(stillOnSale.shippingCost), 180);
    acct = (await greg('GET', '/deliveries/my/account')).body;
    eq('and he is square again', acct.owedToRider, 0);

    section('fuel is not a parcel, so it behaves as before');
    const fuelAgain = await greg('POST', '/deliveries/my/expenses', { category: 'Fuel', amount: 60 });
    eq('it is not tied to an order', fuelAgain.body.onSaleShipping, false);
    const beforeFuel = (await wages('Delivery Costs')).length;
    await admin('PUT', `/deliveries/expenses/${fuelAgain.body.id}`, { settle: true, outcome: 'company_cost' });
    eq('so settling it does raise an expense', (await wages('Delivery Costs')).length, beforeFuel + 1);

    section('taking back a drop takes its cost off the order');
    const second = await greg('POST', '/deliveries/my/expenses', {
      category: 'Other courier', amount: 95, saleId: courierSale.id,
    });
    const bumped = await prisma.sale.findUnique({ where: { id: courierSale.id }, select: { shippingCost: true } });
    eq('a second leg adds to the cost rather than replacing it', Number(bumped.shippingCost), 275);
    eq('removing it is allowed while unsettled', (await greg('DELETE', `/deliveries/my/expenses/${second.body.id}`)).status, 200);
    const restored = await prisma.sale.findUnique({ where: { id: courierSale.id }, select: { shippingCost: true } });
    eq('and the order goes back to what it was', Number(restored.shippingCost), 180);

    section('a courier fee with no order named stays an ordinary expense');
    const loose = await greg('POST', '/deliveries/my/expenses', { category: 'Platinum courier', amount: 50 });
    eq('nothing is posted to any order', loose.body.onSaleShipping, false);
    eq('and it still shows as his money out', (await greg('GET', '/deliveries/my/account')).body.owedToRider, 50);
  },
};
