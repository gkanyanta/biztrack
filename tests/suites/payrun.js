// Pay runs, loans and recoveries
//
// A cycle is finalised into payslips that never change afterwards. Everything that used to
// reach back into a closed cycle — a customer paying late, an unpaid balance, a loan — has to
// arrive on the next payslip instead, and this is what holds that in place.

const { loginAs } = require('../lib/harness');

module.exports = {
  name: 'Pay runs, loans and recoveries',
  seed: 'payrun',
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    const api = await loginAs(base, 'boss');
    const { beaId, annieId, oldUnpaidId, creditId, returnedId, L0, L1, L2, L3 } = seed;
    const wages = () => prisma.expense.findMany({ where: { category: 'Salaries & Wages' }, orderBy: { amount: 'asc' } });
    const run = async (period) => (await api('GET', `/payroll/run${period ? `?period=${period}` : ''}`)).body;
    const slip = (r, name) => r.payslips.find(p => p.name === name);
    const line = (s, kind) => s.lines.filter(l => l.kind === kind);

    section('a cycle before it is finalised');
    let r = await run();
    eq('with no runs yet, the current cycle is shown', r.period.label, L0);
    eq('and it cannot be finalised while it is running', [r.status, r.canFinalise], ['draft', false]);

    r = await run(L2);
    let annie = slip(r, 'Annie'), bea = slip(r, 'Beatrice Kunda');
    eq('a closed cycle can be finalised', r.canFinalise, true);
    eq('commission counts only what customers have paid', line(annie, 'commission')[0].amount, 75);
    eq('salary is the monthly wage', bea.netPay, 2500);
    const baseline = line(annie, 'baseline').find(l => l.sourcePeriod === L3);
    eq('the cycle before pay runs began is noted, not paid again', [baseline.amount, annie.netPay], [0, 75]);
    const returnedOrder = annie.unpaidOrders.find(o => o.orderNumber === 'ORD-S3');
    eq('an unpaid order offers the delivery cost and the full loss', [returnedOrder.deliveryCharge, returnedOrder.lostCharge], [60, 860]);

    const onConsultantsPage = async (period) => (await api('GET', `/consultants/commission-summary?period=${period}`)).body.summary.find(x => x.consultant.name === 'Annie');
    eq('the Consultants page reads a cycle from before pay runs the old way', !!(await onConsultantsPage(L3)).payslip, false);
    eq('and shows the draft payslip for the cycle running now', [(await onConsultantsPage(L0)).payslip.status, (await onConsultantsPage(L0)).balance], ['draft', 10]);

    section('recoveries, bonuses and held money');
    const person = { personKind: 'commission', personId: annieId };
    const noReason = await api('POST', '/payroll/adjustments', { ...person, period: L2, kind: 'recovery', amount: 60 });
    eq('a deduction has to say what it is for', noReason.status, 400);
    const recovery = await api('POST', '/payroll/adjustments', { ...person, period: L2, kind: 'recovery', amount: 60, reason: 'Delivery cost, goods returned', saleId: returnedId });
    eq('delivery cost recovered for goods that came back', recovery.status, 201);
    await api('POST', '/payroll/adjustments', { ...person, period: L2, kind: 'bonus', amount: 100, reason: 'Top seller' });
    const hold = (await api('POST', '/payroll/adjustments', { ...person, period: L2, kind: 'recovery', amount: 20, reason: 'Laptop bags not produced', refundable: true })).body;
    const credited = (await api('POST', '/payroll/adjustments', { ...person, period: L2, kind: 'recovery', amount: 30, reason: 'Held until the customer pays', saleId: creditId, refundable: true })).body;
    annie = slip(await run(L2), 'Annie');
    eq('earnings and deductions are kept apart', [annie.earnings, annie.deductions, annie.netPay], [175, 110, 65]);

    section('a loan is repaid on its terms');
    const loan = await api('POST', '/payroll/loans', { ...person, description: 'Phone', principal: 100, instalments: 2, firstPeriod: L2 });
    eq('loan accepted', loan.status, 201);
    eq('two instalments of half each', Number(loan.body.instalmentAmount), 50);
    annie = slip(await run(L2), 'Annie');
    eq('the instalment comes off without being asked', [annie.loans[0].taking, annie.netPay], [50, 15]);

    await api('PUT', `/payroll/loans/${loan.body.id}/instalment`, { period: L2, amount: 10 });
    annie = slip(await run(L2), 'Annie');
    eq('unless the admin changes it for the cycle', [annie.loans[0].taking, annie.loans[0].edited, annie.netPay], [10, true, 55]);
    await api('PUT', `/payroll/loans/${loan.body.id}/instalment`, { period: L2, amount: 0 });
    eq('or skips it', slip(await run(L2), 'Annie').netPay, 65);
    await api('PUT', `/payroll/loans/${loan.body.id}/instalment`, { period: L2 });
    eq('and it goes back to the schedule when the edit is cleared', slip(await run(L2), 'Annie').netPay, 15);

    const bigLoan = await api('POST', '/payroll/loans', { ...person, description: 'Laptop', principal: 900, instalmentAmount: 300, firstPeriod: L2 });
    annie = slip(await run(L2), 'Annie');
    const laptop = annie.loans.find(l => l.description === 'Laptop');
    eq('a loan takes only what the pay can cover', [laptop.taking, laptop.shortBy, annie.netPay], [15, 285, 0]);
    eq('a loan nobody has repaid can be removed', (await api('DELETE', `/payroll/loans/${bigLoan.body.id}`)).status, 200);

    section('an advance during the cycle comes off the payslip');
    await api('POST', `/payroll/staff/${beaId}/payments`, { amount: 300, type: 'advance', period: L2 });
    bea = slip(await run(L2), 'Beatrice Kunda');
    eq('already in her pocket, so the net pay is less', [bea.alreadyPaid, bea.netPay], [300, 2200]);

    section('finalising');
    eq('a running cycle is refused', (await api('POST', '/payroll/run/finalise', { period: L0 })).status, 400);
    const fin = await api('POST', '/payroll/run/finalise', { period: L2 });
    eq('the closed cycle is finalised', [fin.status, fin.body.status], [201, 'final']);
    eq('and cannot be finalised twice', (await api('POST', '/payroll/run/finalise', { period: L2 })).status, 400);
    let w = await wages();
    // Annie: 175 earned less 110 recovered. Beatrice: her salary, the advance being a loan and not a second cost.
    eq('the wage cost is booked once, when the cycle closes', w.map(e => Number(e.amount)), [65, 2500]);
    eq('nothing new can be added to a finalised cycle', (await api('POST', '/payroll/adjustments', { ...person, period: L2, kind: 'bonus', amount: 5, reason: 'Late' })).status, 400);
    eq('and what is on it cannot be removed', (await api('DELETE', `/payroll/adjustments/${hold.id}`)).status, 400);

    section('every screen gives the payslip\'s answer');
    let seen = await onConsultantsPage(L2);
    eq('the Consultants page owes what the payslip owes, not earned less paid', [seen.payslip.status, seen.balance], ['final', 15]);
    eq('an advance cannot be recorded against the closed cycle', (await api('POST', `/payroll/staff/${beaId}/payments`, { amount: 50, type: 'advance', period: L2 })).status, 400);
    eq('nor commission paid around its payslip', (await api('POST', `/consultants/${annieId}/payments`, { amount: 5, type: 'commission', periodFrom: seed.L2From, periodTo: seed.L2To })).status, 400);
    eq('an allowance still can be, it is not part of the payslip', (await api('POST', `/consultants/${annieId}/payments`, { amount: 5, type: 'allowance', periodFrom: seed.L2From, periodTo: seed.L2To })).status, 201);

    section('a finalised cycle does not move');
    await prisma.sale.update({ where: { id: creditId }, data: { amountPaid: 2000, paymentStatus: 'Paid' } });
    await prisma.sale.update({ where: { id: oldUnpaidId }, data: { amountPaid: 1000, paymentStatus: 'Paid' } });
    r = await run(L2);
    eq('customers paying late leaves the old payslip alone', slip(r, 'Annie').netPay, 15);

    section('paying a payslip');
    const beaSlip = slip(r, 'Beatrice Kunda');
    eq('more than is owed is refused', (await api('POST', `/payroll/payslips/${beaSlip.id}/payments`, { amount: 2500 })).status, 400);
    eq('part of it is accepted', (await api('POST', `/payroll/payslips/${beaSlip.id}/payments`, { amount: 2000, paymentMethod: 'Cash' })).status, 201);
    eq('and raises no expense of its own', (await wages()).length, 3);
    eq('leaving the rest outstanding', slip(await run(L2), 'Beatrice Kunda').outstanding, 200);

    section('the next cycle picks up everything left behind');
    r = await run();
    eq('the cycle waiting to be finalised is shown first', r.period.label, L1);
    await api('POST', `/payroll/adjustments/${hold.id}/release`, { period: L1 });
    r = await run(L1);
    annie = slip(r, 'Annie'); bea = slip(r, 'Beatrice Kunda');
    eq('what was not paid is brought forward', [bea.broughtForward, bea.netPay], [200, 2700]);
    eq('so is the consultant\'s unpaid net', annie.broughtForward, 15);
    const arrears = line(annie, 'arrears');
    eq('commission on the credit order arrives now it is paid', arrears.find(l => l.sourcePeriod === L2).amount, 75);
    eq('and on the order from before pay runs began', arrears.find(l => l.sourcePeriod === L3).amount, 50);
    eq('money held against an order goes back when it is paid, and a hold when it is released',
       line(annie, 'refund').map(l => l.amount).sort((a, b) => a - b), [20, 30]);
    eq('the second instalment clears the loan', [annie.loans[0].taking, annie.loans[0].outstandingAfter], [50, 0]);
    // 15 brought forward + 30 commission + 75 + 50 late + 30 + 20 refunded − 50 loan.
    eq('and it all adds up', annie.netPay, 170);

    eq('the next cycle is finalised', (await api('POST', '/payroll/run/finalise', { period: L1 })).status, 201);
    const oldSlip = slip(await run(L2), 'Annie');
    const late = await api('POST', `/payroll/payslips/${oldSlip.id}/payments`, { amount: 15 });
    eq('an old payslip can no longer be paid, its balance has moved on', [late.status, late.body.error.includes(L1)], [400, true]);
    const loans = (await api('GET', '/payroll/loans')).body;
    eq('the loan shows as repaid over two cycles', [loans[0].repaid, loans[0].outstanding, loans[0].repayments.length], [100, 0, 2]);

    eq('the old cycle now shows nothing owed, it was carried', (await onConsultantsPage(L2)).balance, 0);
    const detail = (await api('GET', `/consultants/${annieId}?period=${L1}`)).body;
    eq('and the consultant\'s own detail carries the new payslip', [detail.payslip.netPay, detail.balance], [170, 170]);

    section('reopening');
    eq('only the latest cycle can be reopened', (await api('POST', '/payroll/run/reopen', { period: L2 })).status, 400);
    const reopened = await api('POST', '/payroll/run/reopen', { period: L1 });
    eq('the latest one goes back to a draft', [reopened.status, reopened.body.status], [200, 'draft']);
    eq('taking its wage cost with it', (await wages()).length, 3);
    await api('POST', '/payroll/run/finalise', { period: L1 });
    r = await run(L1);
    eq('and finalises the same again', slip(r, 'Annie').netPay, 170);
    await api('POST', `/payroll/payslips/${slip(r, 'Annie').id}/payments`, { amount: 170 });
    eq('but not once someone has been paid from it', (await api('POST', '/payroll/run/reopen', { period: L1 })).status, 400);

    section('what the consultant sees');
    const mine = (await (await loginAs(base, 'annie'))('GET', '/dashboard/consultant')).body;
    eq('every finalised payslip, newest first', mine.payslipHistory.map(p => p.period), [L1, L2]);
    eq('each as it was closed', mine.payslipHistory.map(p => p.netPay), [170, 15]);
    eq('the older one carried forward, the newer one paid', mine.payslipHistory.map(p => [p.carried, p.outstanding]), [[false, 0], [true, 15]]);
    eq('with the lines that explain it', mine.payslipHistory[0].lines.some(l => l.kind === 'loan'), true);
    eq('and the payslip so far for the cycle running now', [mine.payslip.status, mine.allTime.balance], ['draft', 10]);
    eq('the pay run lists every finalised cycle to pick from', (await run(L0)).finalisedPeriods, [L2, L1]);

    section('the cycle after that starts clean');
    annie = slip(await run(L0), 'Annie');
    eq('nothing brought forward, no late commission, no loan', [annie.broughtForward, line(annie, 'arrears').length, annie.loans.length], [0, 0, 0]);
    near('just this cycle\'s commission', annie.netPay, 10, 0.01);
  },
};
