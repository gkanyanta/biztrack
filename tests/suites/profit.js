// Profit on the P&L, the sales report, the dashboard and the profit sort. An order's total
// already has the delivery charge added and the discount taken off, so neither may be counted
// a second time; only the fare paid to the rider or courier comes off.
const { loginAs } = require('../lib/harness');

module.exports = {
  name: 'Profit figures',
  seed: 'profit',
  async run({ base, seed, t }) {
    const { eq, section } = t;
    const boss = await loginAs(base, 'boss');
    const order = (name, qty, extra) => boss('POST', '/sales', {
      customerName: name, status: 'Pending', items: [{ productId: seed.productId, qty, unitPrice: 300 }], ...extra,
    });

    section('the order total already carries the charge and the discount');
    // Profit 620 - 200 - 40 = 380 (counting the charge and discount again would make it 400).
    const a = await order('Alice', 2, { shippingCharge: 50, discount: 30, shippingCost: 40 });
    eq('2 × K300 + K50 delivery − K30 discount is a K620 order', [a.status, Number(a.body.totalPrice)], [201, 620]);
    // Profit 400 - 100 - 120 = 180 (it would read 280).
    const x = await order('Xavier', 1, { shippingCharge: 100, shippingCost: 120 });
    // Profit 300 - 100 = 200.
    const y = await order('Yvonne', 1, {});
    eq('the other two orders are K400 and K300', [Number(x.body.totalPrice), Number(y.body.totalPrice)], [400, 300]);

    section('P&L');
    const pnl = (await boss('GET', '/reports/pnl')).body;
    eq('revenue is the order totals', pnl.revenue, 1320);
    eq('gross profit takes off cost of goods and fares only', pnl.grossProfit, 760);
    eq('net profit takes off expenses, leaving out stock purchases', pnl.netProfit, 735);
    eq('the delivery charged and discounts are still reported', [pnl.shippingCharge, pnl.discount], [150, 30]);

    section('sales report and dashboard');
    eq('the sales report profit agrees', (await boss('GET', '/reports/sales')).body.summary.totalProfit, 760);
    const dash = (await boss('GET', '/dashboard')).body;
    eq('the dashboard agrees', [dash.grossProfit, dash.netProfit], [760, 735]);
    const month = new Date().toISOString().slice(0, 7);
    eq("the month's profit takes the fares off too", dash.monthlySummary.find(m => m.month === month)?.profit, 735);

    section('sorting orders by profit');
    const sorted = (await boss('GET', '/sales?sortBy=profit&sortDir=desc&page=1')).body.data.map(s => s.customerName);
    eq('highest profit first: Alice (K380), Yvonne (K200), Xavier (K180)', sorted, ['Alice', 'Yvonne', 'Xavier']);
    const asc = (await boss('GET', '/sales?sortBy=profit&sortDir=asc&page=1')).body.data.map(s => s.customerName);
    eq('and lowest first when asked', asc, ['Xavier', 'Yvonne', 'Alice']);
  },
};
