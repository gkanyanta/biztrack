// Salary advances people ask for themselves, and when they start coming back off pay.
const { loginAs } = require('../lib/harness');
const { getConsultantPayPeriod } = require('../../server/src/utils/payPeriod');

module.exports = {
  name: 'Salary advance requests',
  seed: 'advances',
  async run({ base, prisma, seed, t }) {
    const { eq, section } = t;
    const [boss, annie, bea, musa, loose, otherboss] = await Promise.all(
      ['boss', 'annie', 'bea', 'musa', 'loose', 'otherboss'].map(u => loginAs(base, u)));
    const thisCycle = getConsultantPayPeriod(new Date(), 11).label;
    const slipFor = (run, personId) => run.body.payslips.find(p => p.personId === personId);
    const loanLines = (slip) => (slip?.lines || []).filter(l => l.kind === 'loan').map(l => l.amount);

    section('asking for one');
    const asked = await annie('POST', '/advances/mine', { amount: 900, instalments: 3, reason: 'School fees' });
    eq('a consultant can ask for an advance, stating the instalments', [asked.status, asked.body.status, asked.body.requested], [201, 'pending', { amount: 900, instalments: 3 }]);
    eq('she is shown it would come back in three equal instalments', asked.body.schedule.map(s => s.amount), [300, 300, 300]);
    eq('starting from the next pay day if it were paid today', [asked.body.preview, asked.body.firstPeriod], [true, thisCycle]);
    eq('a second request while one is open is refused, so a double tap is not two advances',
      (await annie('POST', '/advances/mine', { amount: 900, instalments: 3, reason: 'School fees' })).status, 409);
    eq('nought instalments is refused', (await bea('POST', '/advances/mine', { amount: 500, instalments: 0, reason: 'x' })).status, 400);
    eq('more than twelve is refused', (await bea('POST', '/advances/mine', { amount: 500, instalments: 13, reason: 'x' })).status, 400);
    eq('a part instalment is refused', (await bea('POST', '/advances/mine', { amount: 500, instalments: 2.5, reason: 'x' })).status, 400);
    eq('a zero amount is refused', (await bea('POST', '/advances/mine', { amount: 0, instalments: 1, reason: 'x' })).status, 400);
    eq('a request with no reason is refused', (await bea('POST', '/advances/mine', { amount: 500, instalments: 1, reason: '  ' })).status, 400);
    eq('a login with no pay profile is told so', (await loose('GET', '/advances/mine')).status, 404);
    eq('…and so is the admin, who is not on the payroll', (await boss('GET', '/advances/mine')).status, 404);

    const beaAsked = await bea('POST', '/advances/mine', { amount: 500, instalments: 1, reason: 'Rent' });
    eq('a salaried clerk can ask too', beaAsked.status, 201);
    const musaAsked = await musa('POST', '/advances/mine', { amount: 300, instalments: 2, reason: 'Bike part' });
    eq('so can a rider, through his rider login', musaAsked.status, 201);

    section('each person sees only their own');
    const annieMine = await annie('GET', '/advances/mine');
    eq('she sees her request and nobody else\'s', annieMine.body.requests.map(r => r.id), [asked.body.id]);
    eq('she cannot withdraw somebody else\'s', (await annie('POST', `/advances/mine/${beaAsked.body.id}/withdraw`)).status, 400);
    eq('she cannot see the office list', (await annie('GET', '/advances')).status, 403);
    eq('nor approve her own', (await annie('POST', `/advances/${asked.body.id}/approve`)).status, 403);
    eq('the rider cannot reach the office list either', (await musa('GET', '/advances')).status, 403);
    eq("another company's admin sees none of it", (await otherboss('GET', '/advances')).body, []);
    eq("…and cannot approve it", (await otherboss('POST', `/advances/${asked.body.id}/approve`)).status, 404);
    eq('the admin sees every request', (await boss('GET', '/advances')).body.length, 3);

    section('approving on different terms');
    const approved = await boss('POST', `/advances/${asked.body.id}/approve`, { amount: 800, instalments: 4, note: 'K800 is what we can do' });
    eq('the admin can approve on terms of their own', [approved.body.status, approved.body.agreed, approved.body.termsChanged], ['approved', { amount: 800, instalments: 4 }, true]);
    const seen = (await annie('GET', '/advances/mine')).body.requests[0];
    eq('she sees what was agreed, what she asked for, and why', [seen.requested, seen.agreed, seen.decisionNote], [{ amount: 900, instalments: 3 }, { amount: 800, instalments: 4 }, 'K800 is what we can do']);
    eq('and the new schedule', seen.schedule.map(s => s.amount), [200, 200, 200, 200]);
    eq('approving does not create the loan yet, the money has not left', (await boss('GET', '/payroll/loans')).body.length, 0);
    eq('an approved request can no longer be withdrawn', (await annie('POST', `/advances/mine/${asked.body.id}/withdraw`)).status, 400);
    eq('nor approved twice', (await boss('POST', `/advances/${asked.body.id}/approve`)).status, 400);

    section('paying out starts the repayments on the next pay day');
    eq('a payout date in the future is refused', (await boss('POST', `/advances/${asked.body.id}/pay`, { paidAt: '2099-01-01' })).status, 400);
    const paid = await boss('POST', `/advances/${asked.body.id}/pay`, { paidAt: '2026-10-10', paymentMethod: 'Mobile Money' });
    eq('handed over the day before pay day, the first instalment is that pay day', [paid.body.status, paid.body.firstPeriod], ['paid', '2026-10']);
    eq('paying it twice makes no second loan', (await boss('POST', `/advances/${asked.body.id}/pay`, { paidAt: '2026-10-10' })).status, 400);
    const loans = (await boss('GET', '/payroll/loans')).body;
    eq('it becomes one loan on the payroll, with the agreed terms',
      loans.map(l => [l.name, l.description, l.principal, l.instalmentAmount, l.firstPeriod, l.notes]),
      [['Annie', 'Salary advance', 800, 200, '2026-10', 'School fees']]);

    await boss('POST', `/advances/${beaAsked.body.id}/approve`);
    const beaPaid = await boss('POST', `/advances/${beaAsked.body.id}/pay`, { paidAt: '2026-10-11' });
    eq('handed over on pay day itself, it waits for the next one', beaPaid.body.firstPeriod, '2026-11');
    const octRun = await boss('GET', '/payroll/run?period=2026-10');
    const novRun = await boss('GET', '/payroll/run?period=2026-11');
    eq('nothing comes off the pay day before she had the money', loanLines(slipFor(octRun, seed.beaId)), []);
    eq('the whole K500 comes off the first pay day after', loanLines(slipFor(novRun, seed.beaId)), [-500]);
    eq('her request shows it paid out, with nothing repaid yet', [beaPaid.body.status, beaPaid.body.repaid, beaPaid.body.outstanding], ['paid', 0, 500]);

    section('a finalised cycle is never reached back into');
    await prisma.payRun.create({ data: { period: '2026-11', periodFrom: new Date(2026, 9, 11), periodTo: new Date(2026, 10, 11), companyId: seed.companyId } });
    await boss('POST', `/advances/${musaAsked.body.id}/approve`);
    const musaPaid = await boss('POST', `/advances/${musaAsked.body.id}/pay`, { paidAt: '2026-10-20' });
    eq('money handed over in a cycle already finalised starts on the next open one', musaPaid.body.firstPeriod, '2026-12');
    eq('the rider sees his schedule', (await musa('GET', '/advances/mine')).body.requests[0].schedule.map(s => [s.period, s.amount]), [['2026-12', 150], ['2027-01', 150]]);

    section('declining and withdrawing');
    const again = await annie('POST', '/advances/mine', { amount: 200, instalments: 1, reason: 'Transport' });
    eq('with nothing open, she can ask again', again.status, 201);
    await boss('POST', `/advances/${again.body.id}/decline`, { note: 'Not this month' });
    const declined = (await annie('GET', '/advances/mine')).body.requests.find(r => r.id === again.body.id);
    eq('she sees it declined, and why', [declined.status, declined.decisionNote], ['declined', 'Not this month']);
    eq('a declined request cannot be paid', (await boss('POST', `/advances/${again.body.id}/pay`)).status, 400);
    eq('nor approved after all', (await boss('POST', `/advances/${again.body.id}/approve`)).status, 400);
    const changedMind = await bea('POST', '/advances/mine', { amount: 100, instalments: 1, reason: 'Airtime' });
    eq('she can withdraw her own request while it waits', (await bea('POST', `/advances/mine/${changedMind.body.id}/withdraw`)).status, 200);
    eq('and then ask again', (await bea('POST', '/advances/mine', { amount: 100, instalments: 1, reason: 'Airtime' })).status, 201);
    eq('a paid advance cannot be declined', (await boss('POST', `/advances/${asked.body.id}/decline`)).status, 400);
  },
};
