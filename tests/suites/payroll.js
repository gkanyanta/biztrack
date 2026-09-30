// Payroll, advances and the P&L
//
// Ported from the throwaway scripts these features were built against, so the coverage is the
// same coverage that caught the bugs in the first place rather than something written afterwards
// to look thorough.

const { client } = require('../lib/harness');

module.exports = {
  name: 'Payroll, advances and the P&L',
  seed: 'payroll',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    // The suites were written against two names for the same thing; both are the shared client.
    const BASE = base;
    const mk = (token) => client(base, token);
    const wages = () => prisma.expense.findMany({ where: { category: 'Salaries & Wages' }, orderBy: { createdAt: 'asc' } });
    const find = (rows, name) => rows.find(r => r.name === name);


  const token = (await mk()('POST', '/auth/login', { username: 'boss', password: 'secret123' })).body.token;
  const api = mk(token);
  const { gregId, beaId, newbieId, annieId } = seed;

  console.log('-- what a salaried person has earned --');
  let s = (await api('GET', '/payroll/summary')).body;
  eq('both kinds of people appear', [s.salaried.length, s.commissioned.length], [3, 1]);
  eq('a full month earns the full salary', find(s.salaried, 'Greg Kanyanta').earned, 3000);
  eq('nothing paid yet, so all of it is owed', find(s.salaried, 'Greg Kanyanta').balance, 3000);
  const hannah = find(s.salaried, 'Halfway Hannah');
  near('joining mid-cycle prorates the salary', hannah.earned, 1000, 60);
  eq('and is flagged as a part cycle', hannah.prorated, true);
  near('the allowance prorates with it', hannah.allowanceCap, 50, 3);
  eq("the consultant's commission is 5% of a paid K1,000", find(s.commissioned, 'Annie').earned, 50);

  section('paying salary books a real expense');
  eq('no wage expenses before anyone is paid', (await wages()).length, 0);
  const paid = await api('POST', `/payroll/staff/${gregId}/payments`, { amount: 3000, type: 'salary', paymentMethod: 'Cash' });
  eq('payment accepted', paid.status, 201);
  const w = await wages();
  eq('one Salaries & Wages expense raised', w.length, 1);
  eq('for the amount paid', Number(w[0].amount), 3000);
  eq('named so the books read plainly', w[0].description.startsWith('Salary: Greg Kanyanta ('), true);
  eq('the payment owns its expense', paid.body.expenseId, w[0].id);

  s = (await api('GET', '/payroll/summary')).body;
  eq('and he is no longer owed', find(s.salaried, 'Greg Kanyanta').balance, 0);

  section('the communication allowance is capped');
  const a1 = await api('POST', `/payroll/staff/${gregId}/payments`, { amount: 100, type: 'allowance' });
  eq('K100 allowance goes through', a1.status, 201);
  const a2 = await api('POST', `/payroll/staff/${gregId}/payments`, { amount: 50, type: 'allowance' });
  eq('a second one is refused', a2.status, 400);
  eq('and says what is left', a2.body.error.includes('Remaining: K0.00'), true);
  s = (await api('GET', '/payroll/summary')).body;
  eq('allowance shows as fully drawn', find(s.salaried, 'Greg Kanyanta').allowanceRemaining, 0);
  eq('an allowance is a cost, so it is an expense', (await wages()).length, 2);

  section('an advance is a loan, not a cost');
  const adv = await api('POST', `/payroll/staff/${beaId}/payments`, { amount: 500, type: 'advance' });
  eq('advance accepted', adv.status, 201);
  eq('it raises no expense', adv.body.expenseId, null);
  eq('so the wage expense count is unchanged', (await wages()).length, 2);
  s = (await api('GET', '/payroll/summary')).body;
  eq('and it nets off what she is owed', find(s.salaried, 'Beatrice Kunda').balance, 2000);
  eq('while being visible as an advance', find(s.salaried, 'Beatrice Kunda').advancePaid, 500);

  section('advancing more than is earned');
  await api('POST', `/payroll/staff/${newbieId}/payments`, { amount: 1500, type: 'advance' });
  s = (await api('GET', '/payroll/summary')).body;
  const h2 = find(s.salaried, 'Halfway Hannah');
  eq('the balance goes negative — she owes it back', h2.balance < 0, true);

  section('undoing a payment undoes its cost');
  const hist = (await api('GET', `/payroll/staff/${gregId}/payments`)).body;
  const salaryRow = hist.find(p => p.type === 'salary');
  const del = await api('DELETE', `/payroll/payments/${salaryRow.id}`);
  eq('delete accepted', del.status, 200);
  eq('the expense goes with it', (await wages()).length, 1);
  s = (await api('GET', '/payroll/summary')).body;
  eq('and he is owed again', find(s.salaried, 'Greg Kanyanta').balance, 3000);

  section('consultants are paid the same way now');
  const cPay = await api('POST', `/consultants/${annieId}/payments`, { amount: 50, type: 'commission' });
  eq('consultant payment accepted', cPay.status, 201);
  eq('it raised a wage expense too', (await wages()).length, 2);
  eq('linked to the payment', !!cPay.body.expenseId, true);
  const cAdv = await api('POST', `/consultants/${annieId}/payments`, { amount: 200, type: 'advance' });
  eq('a consultant advance raises none', cAdv.body.expenseId, null);
  eq('so the count holds', (await wages()).length, 2);
  s = (await api('GET', '/payroll/summary')).body;
  eq('her balance nets the advance', find(s.commissioned, 'Annie').balance, -200);

  section('the payroll totals');
  s = (await api('GET', '/payroll/summary')).body;
  eq('headcount counts everyone active', s.totals.headcount, 4);
  const expectedOwed = [...s.salaried, ...s.commissioned].filter(p => p.activeInPeriod).reduce((a, b) => a + b.balance, 0);
  near('the owed total is the sum of the rows', s.totals.balance, expectedOwed, 0.02);

  section('and it reaches net profit');
  const dash = (await api('GET', '/dashboard')).body;
  const wagesTotal = (await wages()).reduce((a, b) => a + Number(b.amount), 0);
  // expenseByCategory is a { category: total } map.
  const cat = dash.expenseByCategory?.['Salaries & Wages'];
  eq('wages show as their own expense category', cat !== undefined, true);
  near('with the right total', Number(cat), wagesTotal, 0.02);
  // Net profit is grossProfit minus expenses, so the wages must be inside that subtraction.
  near('net profit is gross profit less every expense, wages included',
       dash.netProfit, dash.grossProfit - dash.totalExpenses, 0.02);
  eq('and wages are part of the expense total', dash.totalExpenses >= wagesTotal, true);
  },
};
