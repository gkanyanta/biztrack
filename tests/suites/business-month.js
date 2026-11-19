// A company can count its months by calendar or by pay cycle. Everything that says "this
// month" on the dashboard follows the choice, and Money Splits can show either.
const { loginAs } = require('../lib/harness');

module.exports = {
  name: 'Business month: calendar or pay cycle',
  seed: 'businessmonth',
  async run({ base, seed, t }) {
    const { eq, section } = t;
    const boss = await loginAs(base, 'boss');
    const now = new Date();
    const takenSince = (from) => seed.sales.filter(s => new Date(s.date) >= from && new Date(s.date) <= now).reduce((a, s) => a + s.price, 0);

    section('calendar months unless the company says otherwise');
    let d = (await boss('GET', '/dashboard')).body;
    eq('the dashboard counts by calendar month', d.businessMonth.basis, 'calendar');
    eq('so this month starts on the 1st, midnight in Zambia', d.growth.thisMonthRevenue, takenSince(seed.monthStart));
    eq('and the monthly chart is calendar months', d.monthlySummary.find(x => x.month === '2026-03').revenue, 2300);

    section('switching to the pay cycle');
    eq('the setting is saved', (await boss('PUT', '/settings', { monthBasis: 'cycle' })).status, 200);
    d = (await boss('GET', '/dashboard')).body;
    eq('the dashboard says it counts by cycle, from pay day', [d.businessMonth.basis, d.businessMonth.payDay], ['cycle', 11]);
    eq('and names the cycle by its dates', /^11 [A-Z][a-z]{2} – 10 [A-Z][a-z]{2} \d{4}$/.test(d.businessMonth.current.name), true);
    eq('the target tracker counts from pay day', d.growth.thisMonthRevenue, takenSince(seed.cycleStart));
    eq('so do this cycle\'s profit and savings', d.savings.thisMonth.grossProfit,
       seed.sales.filter(s => new Date(s.date) >= seed.cycleStart && new Date(s.date) <= now).reduce((a, s) => a + s.price - 100, 0));
    const mar = d.monthlySummary.find(x => x.month === '2026-03');
    eq('the chart groups orders by cycle: 11 Mar to the end of 10 Apr', [mar.revenue, mar.orders, mar.label], [600, 2, 'Mar–Apr']);
    eq('the order an hour before it belongs to the cycle before', d.monthlySummary.find(x => x.month === '2026-02').revenue, 2000);
    eq('a date range on the dashboard does not change what this cycle is',
       (await boss('GET', '/dashboard?from=2026-03-01&to=2026-03-31')).body.growth.thisMonthRevenue, takenSince(seed.cycleStart));

    section('money splits, either way');
    const cal = (await boss('GET', '/reports/money-splits?month=2026-03')).body;
    eq('a calendar month by default, whatever the dashboard counts by', [cal.basis, cal.name, cal.revenue], ['calendar', 'March 2026', 2300]);
    const cyc = (await boss('GET', '/reports/money-splits?month=2026-03&basis=cycle')).body;
    eq('or the pay cycle starting in that month', [cyc.basis, cyc.month, cyc.name, cyc.revenue], ['cycle', '2026-03', '11 Mar – 10 Apr 2026', 600]);
    eq('offering the last twelve cycles to choose from', [cyc.periods.length, /^11 /.test(cyc.periods[0].name)], [12, true]);

    section('back to calendar');
    await boss('PUT', '/settings', { monthBasis: 'calendar' });
    eq('the dashboard follows', (await boss('GET', '/dashboard')).body.growth.thisMonthRevenue, takenSince(seed.monthStart));
  },
};
