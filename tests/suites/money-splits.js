// Money splits knows about everything the business spends, not only what is typed on the
// Expenses page: staff pay from Payroll, and the rider and courier fares held on the orders.
const { loginAs } = require('../lib/harness');

module.exports = {
  name: 'Money splits',
  seed: 'moneysplits',
  async run({ base, seed, t }) {
    const { eq, section } = t;
    const boss = await loginAs(base, 'boss');

    section('staff pay comes from Payroll');
    await boss('POST', `/payroll/staff/${seed.gregId}/payments`, { amount: 200, type: 'salary', paymentMethod: 'Cash' });
    await boss('POST', `/payroll/staff/${seed.gregId}/payments`, { amount: 100, type: 'advance' });
    const m = (await boss('GET', '/reports/money-splits')).body;
    eq('the salary paid through Payroll is staff pay, and the advance is not a cost', m.actual.staff, 200);

    section('delivery takes the fares on orders as well as delivery expenses');
    eq('the K40 fare on an order, rider costs carried and shipping expenses', [m.actual.delivery, m.deliveryBreakdown], [90, { fares: 40, carried: 50 }]);

    section('the rest of the month');
    eq('revenue counts what was sold, not what was cancelled', [m.revenue, m.cogs], [900, 300]);
    eq('and says how much of it is still to collect', [m.collected, m.uncollected], [700, 200]);
    eq('every other bucket as before', [m.actual.ads, m.actual.otherOps, m.actual.stock, m.actual.uncategorized], [50, 10, 1000, 25]);
    eq('profit is what is left after all of it', m.profitActual, 900 - 300 - (50 + 200 + 90 + 10 + 25));
    eq('no Payroll expense is left over as uncategorised', Object.keys(m.byCategory).sort(), ['Delivery Costs', 'Facebook Ads', 'Other', 'Rent', 'Salaries & Wages', 'Shipping', 'Stock Purchase']);

    section('targets');
    eq('a company that set its targets before these buckets has no target for them yet', m.noTarget, ['staff', 'delivery']);
    await boss('PUT', '/settings', { alloc_stock: 40, alloc_ads: 10, alloc_staff: 10, alloc_delivery: 5, alloc_otherOps: 3, alloc_ownerDraw: 12, alloc_taxReserve: 5, alloc_profit: 15 });
    const set = (await boss('GET', '/reports/money-splits')).body;
    eq('once set, they are measured like the others', [set.noTarget, set.targetAmounts.staff, set.targetAmounts.delivery], [[], 90, 45]);

    section('a month is a month in Zambia');
    const mar = (await boss('GET', '/reports/money-splits?month=2026-03')).body;
    eq('orders from 00:30 on the 1st to 23:30 on the 31st Lusaka time are March, and no others', [mar.month, mar.revenue], ['2026-03', 600]);
  },
};
