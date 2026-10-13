const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getConsultantPayPeriod, payPeriodFromLabel, getEffectivePeriod } = require('../utils/payPeriod');
const { calcCommission } = require('../utils/commission');

// Payroll — everyone the company pays, in one place.
//
// Two kinds of people sit side by side here. Consultants earn commission on what they sell;
// salaried staff (the inventory clerk, the rider) earn a fixed monthly wage. Both also draw a
// monthly communication allowance, and both can take an advance against pay not yet earned.
// The arithmetic is deliberately the same shape for both so the screen reads as one payroll
// rather than two systems: earned − paid − advanced = what is still owed.
//
// (mirrored in api/index.js)

const PAYROLL_STAFF_PAYMENT_TYPES = ['salary', 'allowance', 'advance', 'bonus'];
const PAYROLL_EXPENSE_CATEGORY = 'Salaries & Wages';

const round2 = (n) => Math.round(n * 100) / 100;

// An advance is money lent against pay not yet earned, so it is not yet a cost to the
// business — it becomes one when the salary it anticipates is earned and paid. Everything
// else handed to a person is an expense the moment it leaves.
const payroll_isCost = (type) => type !== 'advance';

const PAYROLL_EXPENSE_LABEL = { salary: 'Salary', allowance: 'Communication allowance', bonus: 'Bonus', commission: 'Commission' };

function payroll_periodLabel(periodFrom, periodTo) {
  if (!periodFrom || !periodTo) return null;
  const f = new Date(periodFrom), t = new Date(periodTo);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${fmt(f)} to ${fmt(t)}`;
}

// Raise the Salaries & Wages expense that a payment represents, and hand back its id so the
// payment owns it. Undoing the payment deletes the expense with it, which is why the link
// exists rather than matching on description later.
async function payroll_raiseExpense(tx, { name, type, amount, periodFrom, periodTo, paymentMethod, notes, companyId }) {
  if (!payroll_isCost(type)) return null;
  const label = PAYROLL_EXPENSE_LABEL[type] || 'Staff payment';
  const period = payroll_periodLabel(periodFrom, periodTo);
  const expense = await tx.expense.create({
    data: {
      description: `${label}: ${name}${period ? ` (${period})` : ''}`,
      amount,
      category: PAYROLL_EXPENSE_CATEGORY,
      paymentMethod: paymentMethod || null,
      notes: notes || null,
      companyId,
    },
  });
  return expense.id;
}

// Remove the expense a payment raised. Safe to call for an advance, which never had one.
async function payroll_dropExpense(tx, expenseId, companyId) {
  if (!expenseId) return;
  await tx.expense.deleteMany({ where: { id: expenseId, companyId } });
}

// What a salaried person has earned across a window: the monthly figure prorated to the slice
// of the cycle they were actually employed for, exactly as a consultant's allowance is.
function payroll_accrue(staff, periodFrom, periodTo, isCycle) {
  if (!isCycle) {
    return { active: true, prorated: false, factor: 1, salaryAccrued: null, allowanceCap: null };
  }
  const eff = getEffectivePeriod(periodFrom, periodTo, staff.startDate);
  if (!eff) return { active: false, prorated: false, factor: 0, salaryAccrued: 0, allowanceCap: 0 };
  return {
    active: true,
    prorated: eff.prorated,
    factor: eff.factor,
    effectiveFrom: eff.effectiveFrom,
    effectiveTo: eff.effectiveTo,
    salaryAccrued: round2(parseFloat(staff.monthlySalary) * eff.factor),
    allowanceCap: round2(parseFloat(staff.monthlyAllowance) * eff.factor),
  };
}

function payroll_sumType(payments, type) {
  return round2(payments.filter(p => p.type === type).reduce((s, p) => s + parseFloat(p.amount), 0));
}

// The pay picture for one salaried person over one window.
function payroll_staffSummary(staff, payments, periodFrom, periodTo, isCycle) {
  const mine = payments.filter(p => p.staffId === staff.id);
  const accrual = payroll_accrue(staff, periodFrom, periodTo, isCycle);

  const salaryPaid = payroll_sumType(mine, 'salary');
  const allowancePaid = payroll_sumType(mine, 'allowance');
  const bonusPaid = payroll_sumType(mine, 'bonus');
  const advancePaid = payroll_sumType(mine, 'advance');

  // Mirrors the consultant balance: earnings minus what has been handed over, with advances
  // netting off because that money is already in their pocket. Negative means they owe it back.
  const balance = accrual.salaryAccrued === null ? null : round2(accrual.salaryAccrued - salaryPaid - advancePaid);
  const allowanceRemaining = accrual.allowanceCap === null ? null : round2(Math.max(0, accrual.allowanceCap - allowancePaid));

  return {
    kind: 'salaried',
    id: staff.id,
    name: staff.name,
    jobTitle: staff.jobTitle,
    phone: staff.phone,
    isActive: staff.isActive,
    startDate: staff.startDate,
    monthlySalary: staff.monthlySalary,
    monthlyAllowance: staff.monthlyAllowance,
    activeInPeriod: accrual.active,
    prorated: accrual.prorated,
    earned: accrual.salaryAccrued,
    paid: salaryPaid,
    bonusPaid,
    advancePaid,
    balance,
    allowanceCap: accrual.allowanceCap,
    allowancePaid,
    allowanceRemaining,
  };
}

router.use(authenticate);
router.use(requireAdmin);

// ---- STAFF RECORDS ----

router.get('/staff', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { companyId: req.user.companyId };
    if (req.query.activeOnly === 'true') where.isActive = true;
    const staff = await prisma.staff.findMany({ where, orderBy: { name: 'asc' } });
    res.json(staff);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/staff', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, phone, jobTitle, monthlySalary, monthlyAllowance, startDate, notes, userId, riderId } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const salary = monthlySalary === undefined || monthlySalary === '' ? 0 : parseFloat(monthlySalary);
    const allowance = monthlyAllowance === undefined || monthlyAllowance === '' ? 100 : parseFloat(monthlyAllowance);
    if (!Number.isFinite(salary) || salary < 0) return res.status(400).json({ error: 'Monthly salary must be zero or more' });
    if (!Number.isFinite(allowance) || allowance < 0) return res.status(400).json({ error: 'Monthly allowance must be zero or more' });

    const staff = await prisma.staff.create({
      data: {
        name: String(name).trim(), phone: phone || null, jobTitle: jobTitle || null,
        monthlySalary: salary, monthlyAllowance: allowance,
        startDate: startDate ? new Date(startDate) : null, notes: notes || null,
        userId: userId || null, riderId: riderId || null,
        companyId: req.user.companyId,
      },
    });
    res.status(201).json(staff);
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'That login or rider is already linked to another staff record' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

router.put('/staff/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.staff.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!existing) return res.status(404).json({ error: 'Staff member not found' });
    const raw = req.body;
    const data = {
      ...(raw.name !== undefined && { name: String(raw.name).trim() }),
      ...(raw.phone !== undefined && { phone: raw.phone || null }),
      ...(raw.jobTitle !== undefined && { jobTitle: raw.jobTitle || null }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
      ...(raw.isActive !== undefined && { isActive: !!raw.isActive }),
      ...(raw.startDate !== undefined && { startDate: raw.startDate ? new Date(raw.startDate) : null }),
      ...(raw.userId !== undefined && { userId: raw.userId || null }),
      ...(raw.riderId !== undefined && { riderId: raw.riderId || null }),
    };
    if (raw.monthlySalary !== undefined) {
      const v = parseFloat(raw.monthlySalary);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Monthly salary must be zero or more' });
      data.monthlySalary = v;
    }
    if (raw.monthlyAllowance !== undefined) {
      const v = parseFloat(raw.monthlyAllowance);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Monthly allowance must be zero or more' });
      data.monthlyAllowance = v;
    }
    res.json(await prisma.staff.update({ where: { id: existing.id }, data }));
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'That login or rider is already linked to another staff record' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

// Someone who has been paid is never deleted — their pay history is the record of that money.
router.delete('/staff/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const staff = await prisma.staff.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    const paid = await prisma.staffPayment.count({ where: { staffId: staff.id } })
      + await prisma.payslip.count({ where: { staffId: staff.id } })
      + await prisma.loan.count({ where: { staffId: staff.id } })
      + await prisma.payAdjustment.count({ where: { staffId: staff.id } });
    if (paid > 0) {
      await prisma.staff.update({ where: { id: staff.id }, data: { isActive: false } });
      return res.json({ message: 'Marked inactive (has pay history)' });
    }
    await prisma.staff.delete({ where: { id: staff.id } });
    res.json({ message: 'Staff member removed' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PAYMENTS ----

router.get('/staff/:id/payments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const staff = await prisma.staff.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    const payments = await prisma.staffPayment.findMany({ where: { staffId: staff.id }, orderBy: { createdAt: 'desc' } });
    res.json(payments);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/staff/:id/payments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const staff = await prisma.staff.findFirst({ where: { id: req.params.id, companyId } });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });

    const { type = 'salary', paymentMethod, reference, notes, period } = req.body;
    if (!PAYROLL_STAFF_PAYMENT_TYPES.includes(type)) {
      return res.status(400).json({ error: `Type must be one of ${PAYROLL_STAFF_PAYMENT_TYPES.join(', ')}` });
    }
    const amount = parseFloat(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
    const cycle = period ? payPeriodFromLabel(period, company?.consultantPayDay || 11) : getConsultantPayPeriod(new Date(), company?.consultantPayDay || 11);
    const periodFrom = req.body.periodFrom ? new Date(req.body.periodFrom) : cycle.periodFrom;
    const periodTo = req.body.periodTo ? new Date(req.body.periodTo) : cycle.periodTo;

    // The communication allowance is capped per cycle exactly as a consultant's is, prorated
    // for anyone who joined mid-cycle.
    if (type === 'salary' || type === 'advance') {
      const closed = await payroll_finalisedCycleOf(prisma, companyId, periodFrom, periodTo);
      if (closed) return res.status(400).json({ error: `The ${closed} cycle is finalised. Pay it from its payslip.` });
    }

    if (type === 'allowance') {
      const eff = getEffectivePeriod(periodFrom, periodTo, staff.startDate);
      if (!eff) return res.status(400).json({ error: 'That person was not employed during this pay cycle' });
      const cap = round2((parseFloat(staff.monthlyAllowance) || 0) * eff.factor);
      const existing = await prisma.staffPayment.aggregate({
        where: { staffId: staff.id, companyId, type: 'allowance', periodFrom: { gte: periodFrom }, periodTo: { lte: periodTo } },
        _sum: { amount: true },
      });
      const paidSoFar = parseFloat(existing._sum.amount || 0);
      if (paidSoFar + amount > cap + 0.01) {
        return res.status(400).json({
          error: `Allowance cap reached. Cap: K${cap.toFixed(2)}${eff.prorated ? ' (prorated)' : ''}. Already paid: K${paidSoFar.toFixed(2)}. Remaining: K${Math.max(0, cap - paidSoFar).toFixed(2)}.`,
        });
      }
    }

    const payment = await prisma.$transaction(async (tx) => {
      const expenseId = await payroll_raiseExpense(tx, {
        name: staff.name, type, amount, periodFrom, periodTo, paymentMethod, notes, companyId,
      });
      return tx.staffPayment.create({
        data: {
          staffId: staff.id, amount, type, periodFrom, periodTo,
          paymentMethod: paymentMethod || null, reference: reference || null, notes: notes || null,
          expenseId, companyId,
        },
      });
    }, { timeout: 20000 });

    res.status(201).json(payment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Undo a payment and the expense it raised together, so a mistyped figure leaves nothing behind.
router.delete('/payments/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const payment = await prisma.staffPayment.findFirst({ where: { id: req.params.id, companyId } });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    await prisma.$transaction(async (tx) => {
      await tx.staffPayment.delete({ where: { id: payment.id } });
      await payroll_dropExpense(tx, payment.expenseId, companyId);
    }, { timeout: 20000 });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- THE PAYROLL VIEW ----

// Everyone the company pays for one cycle: salaried staff and consultants, same shape.
router.get('/summary', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
    const payDay = company?.consultantPayDay || 11;
    const cycle = req.query.period ? payPeriodFromLabel(req.query.period, payDay) : getConsultantPayPeriod(new Date(), payDay);
    const { periodFrom, periodTo, label } = cycle;

    const [staff, staffPayments, consultants, sales, commissionPayments] = await Promise.all([
      prisma.staff.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
      prisma.staffPayment.findMany({ where: { companyId, periodFrom: { gte: periodFrom }, periodTo: { lte: periodTo } } }),
      prisma.consultant.findMany({ where: { companyId, isStockLocation: false }, orderBy: { name: 'asc' } }),
      prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, date: { gte: periodFrom, lt: periodTo } }, include: { items: true } }),
      prisma.commissionPayment.findMany({ where: { companyId, periodFrom: { gte: periodFrom }, periodTo: { lte: periodTo } } }),
    ]);

    const salaried = staff.map(s => payroll_staffSummary(s, staffPayments, periodFrom, periodTo, true));

    const commissioned = consultants.map(c => {
      const eff = getEffectivePeriod(periodFrom, periodTo, c.startDate);
      const activeInPeriod = !!eff;
      const factor = eff ? eff.factor : 0;
      const cSales = sales.filter(s => s.consultantId === c.id && (!eff || !eff.prorated || new Date(s.date) >= eff.effectiveFrom));
      const earned = activeInPeriod ? calcCommission(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, cSales) : 0;

      const mine = commissionPayments.filter(p => p.consultantId === c.id);
      const paid = payroll_sumType(mine, 'commission');
      const allowancePaid = payroll_sumType(mine, 'allowance');
      const advancePaid = payroll_sumType(mine, 'advance');
      const allowanceCap = round2(parseFloat(c.monthlyAllowance) * factor);

      return {
        kind: 'commission',
        id: c.id,
        name: c.name,
        jobTitle: c.payType === 'revenue_pct' ? 'Sales consultant (% of revenue)' : 'Sales consultant (per unit)',
        phone: c.phone,
        isActive: c.isActive,
        startDate: c.startDate,
        monthlySalary: null,
        monthlyAllowance: c.monthlyAllowance,
        activeInPeriod,
        prorated: eff ? eff.prorated : false,
        earned,
        paid,
        bonusPaid: 0,
        advancePaid,
        balance: round2(earned - paid - advancePaid),
        allowanceCap,
        allowancePaid,
        allowanceRemaining: round2(Math.max(0, allowanceCap - allowancePaid)),
      };
    });

    const everyone = [...salaried, ...commissioned];
    const active = everyone.filter(p => p.activeInPeriod);
    const sum = (rows, key) => round2(rows.reduce((s, r) => s + (r[key] || 0), 0));

    res.json({
      period: { label, from: periodFrom, to: periodTo, payDate: cycle.payDate, payDay },
      salaried,
      commissioned,
      totals: {
        headcount: active.length,
        earned: sum(active, 'earned'),
        paid: sum(active, 'paid'),
        allowancePaid: sum(active, 'allowancePaid'),
        bonusPaid: sum(active, 'bonusPaid'),
        advancePaid: sum(active, 'advancePaid'),
        balance: sum(active, 'balance'),
        // What leaving the office this cycle actually cost, advances included — they are real
        // money out of the drawer even though they are not yet an expense.
        cashOut: round2(sum(active, 'paid') + sum(active, 'allowancePaid') + sum(active, 'bonusPaid') + sum(active, 'advancePaid')),
      },
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PAY RUNS ----
//
// A pay run is one cycle's payroll for everyone, worked out as a payslip per person:
//
//   brought forward + earnings − already paid − deductions = net pay
//
// Until a cycle is finalised its run is computed live from the sales, loans and adjustments,
// so nothing can go stale. Finalising writes the payslips down, and from then on that cycle
// never changes. Three things used to move a closed cycle and now land on the next payslip
// instead:
//   - money a customer pays late: each commission line records what the cycle's orders had
//     earned at that moment, and a later run pays only what has been earned beyond it
//   - whatever was left unpaid, or overpaid: carried forward as the opening line
//   - a loan: the instalment is deducted every run until the principal is covered
//
// (mirrored in api/index.js)

const PAYROLL_ARREARS_LOOKBACK = 12;
const PAYROLL_ADJUSTMENT_KINDS = ['bonus', 'deduction', 'recovery'];
// How many cycles back an unpaid order is still offered for recovery.
const PAYROLL_UNPAID_ORDER_CYCLES = 3;

const payroll_isLabel = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const payroll_num = (v) => parseFloat(v || 0) || 0;
const payroll_personKey = (o) => (o.consultantId ? `c:${o.consultantId}` : `s:${o.staffId}`);

function payroll_shiftLabel(label, by) {
  const [y, m] = label.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function payroll_cycleName(cycle) {
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${fmt(cycle.periodFrom)} – ${fmt(new Date(cycle.periodTo.getTime() - 86400000))}`;
}

// Which cycle a payment made outside a pay run belongs to. Judged on the middle of the period
// it was recorded against, because those periods were typed by hand and are often a day out
// at either end.
function payroll_inCycle(payment, from, to) {
  const at = payment.periodFrom && payment.periodTo
    ? new Date((new Date(payment.periodFrom).getTime() + new Date(payment.periodTo).getTime()) / 2)
    : new Date(payment.createdAt);
  return at >= from && at < to;
}

// What one cycle's orders have earned a consultant as things stand today.
function payroll_entitlement(consultant, sales, cycle) {
  const eff = getEffectivePeriod(cycle.periodFrom, cycle.periodTo, consultant.startDate);
  if (!eff) return { amount: 0, orders: 0 };
  const mine = sales.filter(s => s.consultantId === consultant.id
    && new Date(s.date) >= eff.effectiveFrom && new Date(s.date) < cycle.periodTo);
  return {
    amount: calcCommission(consultant.payType, consultant.commissionRate, consultant.tierThreshold, consultant.tierRate, mine),
    orders: mine.length,
  };
}

// Goods value actually collected on one cycle's orders: the figure commission is paid on, and
// so the figure a consultant's target is measured in. Delivery fees and unpaid money are out.
function payroll_collectedGoods(consultant, sales, cycle) {
  const eff = getEffectivePeriod(cycle.periodFrom, cycle.periodTo, consultant.startDate);
  if (!eff) return 0;
  let collected = 0;
  for (const s of sales) {
    if (s.consultantId !== consultant.id || new Date(s.date) < eff.effectiveFrom || new Date(s.date) >= cycle.periodTo) continue;
    const total = payroll_num(s.totalPrice);
    if (!(total > 0)) continue;
    const goods = Math.max(0, total - payroll_num(s.shippingCharge));
    collected += goods * Math.min(1, Math.max(0, payroll_num(s.amountPaid) / total));
  }
  return round2(collected);
}

// The person a loan or adjustment is for, checked against the company.
async function payroll_resolvePerson(prisma, companyId, { personKind, personId }) {
  if (!personId) return null;
  if (personKind === 'commission') {
    const c = await prisma.consultant.findFirst({ where: { id: personId, companyId } });
    return c ? { consultantId: c.id, staffId: null, name: c.name } : null;
  }
  const s = await prisma.staff.findFirst({ where: { id: personId, companyId } });
  return s ? { consultantId: null, staffId: s.id, name: s.name } : null;
}

// The whole pay run for one cycle: the stored payslips if it is finalised, the live draft if not.
async function payroll_run(prisma, companyId, requestedPeriod) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
  const payDay = company?.consultantPayDay || 11;
  const now = new Date();
  const currentLabel = getConsultantPayPeriod(now, payDay).label;

  const runs = await prisma.payRun.findMany({ where: { companyId }, orderBy: { period: 'asc' } });
  const lastRun = runs.length ? runs[runs.length - 1] : null;
  const nextToFinalise = lastRun ? payroll_shiftLabel(lastRun.period, 1) : null;
  // With nothing asked for, show the cycle that is waiting to be finalised.
  const period = requestedPeriod || (nextToFinalise && nextToFinalise < currentLabel ? nextToFinalise : currentLabel);
  const cycle = payPeriodFromLabel(period, payDay);
  const existing = runs.find(r => r.period === period) || null;
  const lookbackFrom = payPeriodFromLabel(payroll_shiftLabel(period, -PAYROLL_ARREARS_LOOKBACK), payDay).periodFrom;

  const [staff, consultants, loans, adjustments, payslips, lines, cPayments, sPayments, sales] = await Promise.all([
    prisma.staff.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
    prisma.consultant.findMany({ where: { companyId, isStockLocation: false }, orderBy: { name: 'asc' } }),
    prisma.loan.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
    prisma.payAdjustment.findMany({
      where: { companyId },
      include: { sale: { select: { orderNumber: true, paymentStatus: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.payslip.findMany({ where: { companyId }, include: { payRun: { select: { period: true } } } }),
    prisma.payslipLine.findMany({
      where: { companyId },
      include: { payslip: { select: { consultantId: true, staffId: true, payRun: { select: { period: true } } } } },
      orderBy: { sort: 'asc' },
    }),
    prisma.commissionPayment.findMany({ where: { companyId } }),
    prisma.staffPayment.findMany({ where: { companyId } }),
    existing ? [] : prisma.sale.findMany({
      where: { companyId, consultantId: { not: null }, status: { not: 'Cancelled' }, date: { gte: lookbackFrom, lt: cycle.periodTo } },
      select: {
        id: true, orderNumber: true, date: true, totalPrice: true, shippingCharge: true, shippingCost: true,
        amountPaid: true, paymentStatus: true, status: true, customerName: true, consultantId: true,
        items: { select: { qty: true } },
      },
    }),
  ]);

  const targets = existing ? [] : await prisma.consultantTarget.findMany({ where: { companyId, period } });
  const kwacha = (n) => `K${Math.round(n).toLocaleString('en-US')}`;

  const paymentsOf = (slip) => (slip.consultantId ? cPayments : sPayments).filter(p => p.payslipId === slip.id);
  const paidOn = (slip) => round2(paymentsOf(slip).reduce((s, p) => s + payroll_num(p.amount), 0));

  // An adjustment is applied once a finalised line points at it; a recovery is refunded once a
  // refund line does.
  const applied = new Set(lines.filter(l => l.adjustmentId && l.kind !== 'refund').map(l => l.adjustmentId));
  const refunded = new Set(lines.filter(l => l.adjustmentId && l.kind === 'refund').map(l => l.adjustmentId));
  const adjustmentLabel = (a) => `${a.reason || (a.kind === 'bonus' ? 'Bonus' : a.kind === 'recovery' ? 'Recovery' : 'Deduction')}${a.sale ? ` (${a.sale.orderNumber})` : ''}`;
  const refundDue = (a) => a.kind === 'recovery' && a.refundable && applied.has(a.id) && !refunded.has(a.id)
    && ((a.refundPeriod && a.refundPeriod <= period) || a.sale?.paymentStatus === 'Paid');
  // Money taken from someone that goes back to them once the order is paid or the hold is lifted.
  const heldFor = (key) => adjustments
    .filter(a => payroll_personKey(a) === key && a.kind === 'recovery' && a.refundable && applied.has(a.id) && !refunded.has(a.id) && !a.refundPeriod)
    .map(a => ({ id: a.id, label: adjustmentLabel(a), amount: payroll_num(a.amount), period: a.period }));

  const loanDeducted = (loan, beforePeriod) => round2(lines
    .filter(l => l.loanId === loan.id && (!beforePeriod || l.payslip.payRun.period < beforePeriod))
    .reduce((s, l) => s + Math.abs(payroll_num(l.amount)), 0));

  const shape = (base, slipLines) => {
    const sumKinds = (kinds) => round2(slipLines.filter(l => kinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0));
    const earnings = sumKinds(['salary', 'commission', 'arrears', 'bonus', 'refund']);
    const alreadyPaid = round2(-sumKinds(['prepaid', 'advance']));
    const deductions = round2(-sumKinds(['recovery', 'deduction', 'loan']));
    const netPay = round2(base.broughtForward + earnings - alreadyPaid - deductions);
    // The cycle's wage cost not already booked by a payment made during it. Loans and balances
    // carried between cycles are not costs; a recovery gives some of the wage back.
    const wageCost = Math.max(0, round2(earnings + sumKinds(['recovery', 'deduction', 'prepaid'])));
    return { ...base, lines: slipLines, earnings, alreadyPaid, deductions, netPay, wageCost };
  };

  let slips;

  if (existing) {
    slips = payslips.filter(p => p.payRunId === existing.id).map(p => {
      const key = payroll_personKey(p);
      const payments = paymentsOf(p).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const paid = paidOn(p);
      const netPay = payroll_num(p.netPay);
      // Once a later payslip exists, whatever was outstanding here has been carried into it.
      const carried = payslips.some(o => payroll_personKey(o) === key && o.payRun.period > period);
      return {
        id: p.id, kind: p.consultantId ? 'commission' : 'salaried', personId: p.consultantId || p.staffId,
        name: p.name, jobTitle: p.jobTitle,
        lines: lines.filter(l => l.payslipId === p.id).map(l => ({
          kind: l.kind, label: l.label, amount: payroll_num(l.amount), sourcePeriod: l.sourcePeriod, loanId: l.loanId, adjustmentId: l.adjustmentId,
        })),
        broughtForward: payroll_num(p.broughtForward), earnings: payroll_num(p.earnings),
        alreadyPaid: payroll_num(p.alreadyPaid), deductions: payroll_num(p.deductions), netPay,
        paid, outstanding: round2(netPay - paid), carried,
        payments: payments.map(x => ({ id: x.id, amount: payroll_num(x.amount), createdAt: x.createdAt, paymentMethod: x.paymentMethod, reference: x.reference, notes: x.notes })),
        loans: [], unpaidOrders: [], held: heldFor(key),
      };
    });
  } else {
    const priorSlip = (key) => payslips
      .filter(p => payroll_personKey(p) === key && p.payRun.period < period)
      .sort((a, b) => (a.payRun.period < b.payRun.period ? 1 : -1))[0] || null;

    const build = (key, base, earningLines) => {
      const out = [...earningLines];
      const mine = adjustments.filter(a => payroll_personKey(a) === key);

      const prior = priorSlip(key);
      const broughtForward = prior ? round2(payroll_num(prior.netPay) - paidOn(prior)) : 0;

      for (const a of mine.filter(a => a.kind === 'bonus' && a.period <= period && !applied.has(a.id))) {
        out.push({ kind: 'bonus', label: adjustmentLabel(a), amount: payroll_num(a.amount), adjustmentId: a.id });
      }
      for (const a of mine.filter(refundDue)) {
        out.push({ kind: 'refund', label: `Refund: ${adjustmentLabel(a)}`, amount: payroll_num(a.amount), adjustmentId: a.id });
      }

      const direct = (base.kind === 'commission' ? cPayments.filter(p => p.consultantId === base.personId) : sPayments.filter(p => p.staffId === base.personId))
        .filter(p => !p.payslipId && payroll_inCycle(p, cycle.periodFrom, cycle.periodTo));
      const prepaid = round2(direct.filter(p => p.type === 'commission' || p.type === 'salary').reduce((s, p) => s + payroll_num(p.amount), 0));
      const advanced = round2(direct.filter(p => p.type === 'advance').reduce((s, p) => s + payroll_num(p.amount), 0));
      if (prepaid > 0) out.push({ kind: 'prepaid', label: 'Paid during the cycle', amount: -prepaid });
      if (advanced > 0) out.push({ kind: 'advance', label: 'Advance taken during the cycle', amount: -advanced });

      for (const a of mine.filter(a => (a.kind === 'recovery' || a.kind === 'deduction') && a.period <= period && !applied.has(a.id))) {
        out.push({ kind: a.kind, label: adjustmentLabel(a), amount: -payroll_num(a.amount), adjustmentId: a.id, refundable: a.refundable });
      }

      // Loans come last and take only what the pay can cover, so a thin month leaves the rest
      // of the instalment on the loan instead of putting the person in debt for cash.
      let available = Math.max(0, round2(broughtForward + out.reduce((s, l) => s + l.amount, 0)));
      const loanRows = [];
      for (const loan of loans.filter(l => payroll_personKey(l) === key && l.status === 'active' && l.firstPeriod <= period)) {
        const outstanding = round2(payroll_num(loan.principal) - loanDeducted(loan, period));
        if (outstanding <= 0) continue;
        const scheduled = Math.min(payroll_num(loan.instalmentAmount), outstanding);
        const override = mine.find(a => a.kind === 'loan_instalment' && a.loanId === loan.id && a.period === period);
        const taking = round2(override ? Math.min(payroll_num(override.amount), outstanding) : Math.min(scheduled, available));
        available = Math.max(0, round2(available - taking));
        if (taking > 0) out.push({ kind: 'loan', label: `Loan repayment: ${loan.description}`, amount: -taking, loanId: loan.id });
        loanRows.push({
          id: loan.id, description: loan.description, principal: payroll_num(loan.principal), outstanding,
          scheduled: round2(scheduled), taking, edited: !!override, shortBy: override ? 0 : round2(scheduled - taking),
          outstandingAfter: round2(outstanding - taking),
        });
      }

      const slip = shape({ ...base, id: null, broughtForward }, out);
      return { ...slip, paid: 0, outstanding: slip.netPay, carried: false, payments: [], loans: loanRows, held: heldFor(key) };
    };

    const unpaidFrom = payPeriodFromLabel(payroll_shiftLabel(period, -(PAYROLL_UNPAID_ORDER_CYCLES - 1)), payDay).periodFrom;
    const recoveredSales = new Set(adjustments.filter(a => a.kind === 'recovery' && a.saleId).map(a => a.saleId));

    const salaried = staff.map(s => {
      const accrual = payroll_accrue(s, cycle.periodFrom, cycle.periodTo, true);
      const earning = s.isActive && accrual.active
        ? [{ kind: 'salary', label: accrual.prorated ? 'Salary (part cycle)' : 'Salary', amount: accrual.salaryAccrued }]
        : [];
      const slip = build(`s:${s.id}`, { kind: 'salaried', personId: s.id, name: s.name, jobTitle: s.jobTitle || 'Staff' }, earning);
      return { ...slip, unpaidOrders: [], onRun: earning.length > 0 };
    });

    const commissioned = consultants.map(c => {
      const key = `c:${c.id}`;
      const earning = [];
      const now_ = payroll_entitlement(c, sales, cycle);
      const activeNow = c.isActive && !!getEffectivePeriod(cycle.periodFrom, cycle.periodTo, c.startDate);
      if (activeNow || now_.amount > 0) {
        earning.push({
          kind: 'commission', label: `Commission on ${now_.orders} order${now_.orders === 1 ? '' : 's'}`,
          amount: now_.amount, sourcePeriod: period, entitlement: now_.amount,
        });
      }

      // Earlier cycles: pay whatever their orders have earned beyond what was last written down.
      const snapshots = new Map();
      for (const l of lines) {
        if (l.payslip.consultantId !== c.id || !l.sourcePeriod || l.payslip.payRun.period >= period) continue;
        const seen = snapshots.get(l.sourcePeriod);
        if (!seen || seen.runPeriod < l.payslip.payRun.period) snapshots.set(l.sourcePeriod, { runPeriod: l.payslip.payRun.period, entitlement: payroll_num(l.entitlement) });
      }
      const firstPayslip = snapshots.size === 0;
      for (let back = 1; back <= PAYROLL_ARREARS_LOOKBACK; back++) {
        const source = payroll_shiftLabel(period, -back);
        const sourceCycle = payPeriodFromLabel(source, payDay);
        const then = payroll_entitlement(c, sales, sourceCycle);
        if (firstPayslip) {
          // Everything before the first pay run was settled by hand. Write down where each
          // older cycle stood so only what is collected from here on is paid.
          if (then.amount > 0) earning.push({ kind: 'baseline', label: `Settled before pay runs began (${payroll_cycleName(sourceCycle)})`, amount: 0, sourcePeriod: source, entitlement: then.amount });
          continue;
        }
        const delta = round2(then.amount - (snapshots.get(source)?.entitlement || 0));
        if (Math.abs(delta) < 0.01) continue;
        earning.push({
          kind: 'arrears',
          label: delta > 0 ? `Commission on ${payroll_cycleName(sourceCycle)} orders paid since` : `Commission reversed on ${payroll_cycleName(sourceCycle)} orders`,
          amount: delta, sourcePeriod: source, entitlement: then.amount,
        });
      }

      // A target for the cycle pays its bonus once what has been collected reaches it.
      const collected = payroll_collectedGoods(c, sales, cycle);
      const goal = targets.find(t => t.consultantId === c.id) || null;
      let target = null;
      if (goal) {
        const aim = payroll_num(goal.target), flat = payroll_num(goal.bonus), rate = payroll_num(goal.bonusRate);
        const reached = collected >= aim;
        const bonusNow = reached ? round2(flat + ((collected - aim) * rate) / 100) : 0;
        if (bonusNow > 0) earning.push({ kind: 'bonus', label: `Target bonus: ${kwacha(collected)} collected against a target of ${kwacha(aim)}`, amount: bonusNow });
        target = {
          id: goal.id, target: aim, bonus: flat, bonusRate: rate, collected, reached, bonusNow,
          toGo: round2(Math.max(0, aim - collected)), progress: aim > 0 ? Math.min(100, round2((collected / aim) * 100)) : 0,
        };
      }
      // Offered when a target is being set: ten percent above their recent cycles, so it asks
      // for more than usual without asking for their best month ever.
      const recentCycles = [1, 2, 3]
        .map(back => payroll_collectedGoods(c, sales, payPeriodFromLabel(payroll_shiftLabel(period, -back), payDay)))
        .filter(v => v > 0);
      const suggestedTarget = recentCycles.length
        ? Math.round(((recentCycles.reduce((a, b) => a + b, 0) / recentCycles.length) * 1.1) / 1000) * 1000
        : 0;

      const slip = build(key, {
        kind: 'commission', personId: c.id, name: c.name,
        jobTitle: c.payType === 'revenue_pct' ? 'Sales consultant (% of revenue)' : 'Sales consultant (per unit)',
      }, earning);

      const unpaidOrders = sales
        .filter(s => s.consultantId === c.id && s.paymentStatus !== 'Paid' && new Date(s.date) >= unpaidFrom)
        .map(s => {
          const total = payroll_num(s.totalPrice), paid = payroll_num(s.amountPaid);
          const delivery = payroll_num(s.shippingCost);
          return {
            saleId: s.id, orderNumber: s.orderNumber, date: s.date, customerName: s.customerName, status: s.status,
            total, paid, balance: round2(total - paid),
            // Goods came back: the consultant carries what the delivery cost us.
            deliveryCharge: delivery,
            // Goods lost: what the customer still owes, plus any delivery cost the bill did not cover.
            lostCharge: round2(total - paid + Math.max(0, delivery - payroll_num(s.shippingCharge))),
            recovered: recoveredSales.has(s.id),
          };
        })
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      return { ...slip, unpaidOrders, onRun: activeNow, target, collected, suggestedTarget };
    });

    // Someone who has left still gets a payslip while there is anything on it.
    slips = [...salaried, ...commissioned]
      .filter(p => p.onRun || p.broughtForward !== 0 || p.lines.some(l => l.amount !== 0))
      .map(({ onRun, ...p }) => p);
  }

  let blockedReason = null;
  if (!existing) {
    const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (now < cycle.periodTo) blockedReason = `This cycle is still running. It can be finalised from ${fmt(cycle.periodTo)}.`;
    else if (lastRun && lastRun.period > period) blockedReason = 'A later cycle has already been finalised.';
    else if (lastRun && nextToFinalise !== period) blockedReason = `Finalise the ${nextToFinalise} cycle first.`;
  }
  const sum = (key) => round2(slips.reduce((s, p) => s + (p[key] || 0), 0));

  return {
    period: { label: period, from: cycle.periodFrom, to: cycle.periodTo, payDate: cycle.payDate, payDay, name: payroll_cycleName(cycle) },
    status: existing ? 'final' : 'draft',
    runId: existing ? existing.id : null,
    finalisedAt: existing ? existing.finalisedAt : null,
    canFinalise: !existing && !blockedReason,
    blockedReason,
    // Only the newest run can be reopened, and only before any of it has been paid out.
    canReopen: !!existing && lastRun.id === existing.id && slips.every(p => p.paid === 0),
    firstRun: runs.length === 0,
    // Every cycle with payslips on record, so an old one can always be reached.
    finalisedPeriods: runs.map(r => r.period),
    currentPeriod: currentLabel,
    payslips: slips,
    totals: {
      headcount: slips.length,
      broughtForward: sum('broughtForward'), earnings: sum('earnings'), alreadyPaid: sum('alreadyPaid'),
      deductions: sum('deductions'), netPay: sum('netPay'), paid: sum('paid'), outstanding: sum('outstanding'),
    },
  };
}

// What the payroll says each consultant is owed for one cycle, for the screens that used to
// work a balance out for themselves. Null for a cycle from before pay runs began, which is
// still read the old way. With no period it answers for the cycle that is to be paid next.
async function payroll_consultantPay(prisma, companyId, period) {
  if (period) {
    if (!payroll_isLabel(period)) return null;
    const [first, company] = await Promise.all([
      prisma.payRun.findFirst({ where: { companyId }, orderBy: { period: 'asc' }, select: { period: true } }),
      prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } }),
    ]);
    const start = first ? first.period : getConsultantPayPeriod(new Date(), company?.consultantPayDay || 11).label;
    if (period < start) return null;
  }
  const run = await payroll_run(prisma, companyId, period || null);
  const slips = new Map();
  for (const p of run.payslips) {
    if (p.kind !== 'commission') continue;
    slips.set(p.personId, {
      status: run.status, period: run.period.label, periodName: run.period.name,
      broughtForward: p.broughtForward, earnings: p.earnings, alreadyPaid: p.alreadyPaid, deductions: p.deductions,
      netPay: p.netPay, paid: p.paid, outstanding: p.outstanding, carried: p.carried,
      // Still owed to the consultant: the whole net while the cycle is a draft, what is left
      // to pay once it is finalised, and nothing once that has moved to a later payslip.
      balance: run.status === 'draft' ? p.netPay : (p.carried ? 0 : p.outstanding),
      lines: p.lines.filter(l => l.kind !== 'baseline').map(l => ({ kind: l.kind, label: l.label, amount: l.amount })),
      payments: p.payments, loans: p.loans, held: p.held, finalisedAt: run.finalisedAt,
      target: p.target || null,
    });
  }
  return { status: run.status, period: run.period, slips };
}

// Every finalised payslip one consultant has, newest first, in the same shape the screens
// already read. Read straight from what was written down, so an old payslip costs nothing to
// show and is exactly what it was on the day the cycle closed.
async function payroll_payslipHistory(prisma, companyId, consultantId) {
  const payslips = await prisma.payslip.findMany({
    where: { companyId, consultantId },
    include: { payRun: true, lines: { orderBy: { sort: 'asc' } }, commissionPayments: { orderBy: { createdAt: 'asc' } } },
  });
  payslips.sort((a, b) => (a.payRun.period < b.payRun.period ? 1 : -1));
  return payslips.map((p, i) => {
    const netPay = payroll_num(p.netPay);
    const paid = round2(p.commissionPayments.reduce((s, x) => s + payroll_num(x.amount), 0));
    // Anything but the newest has had its balance carried into the payslip after it.
    const carried = i > 0;
    const outstanding = round2(netPay - paid);
    return {
      status: 'final', period: p.payRun.period, finalisedAt: p.payRun.finalisedAt,
      periodName: payroll_cycleName({ periodFrom: p.payRun.periodFrom, periodTo: p.payRun.periodTo }),
      broughtForward: payroll_num(p.broughtForward), earnings: payroll_num(p.earnings), alreadyPaid: payroll_num(p.alreadyPaid),
      deductions: payroll_num(p.deductions), netPay, paid, outstanding, carried, balance: carried ? 0 : outstanding,
      lines: p.lines.filter(l => l.kind !== 'baseline').map(l => ({ kind: l.kind, label: l.label, amount: payroll_num(l.amount) })),
      payments: p.commissionPayments.map(x => ({ id: x.id, amount: payroll_num(x.amount), createdAt: x.createdAt, paymentMethod: x.paymentMethod, reference: x.reference, notes: x.notes })),
      loans: [], held: [],
    };
  });
}

// The finalised cycle a directly recorded payment would fall in, if there is one. That
// cycle's pay is settled on its payslip, so commission, salary or an advance recorded against
// it by hand would never reach anyone's balance.
async function payroll_finalisedCycleOf(prisma, companyId, periodFrom, periodTo) {
  if (!periodFrom || !periodTo) return null;
  const mid = new Date((new Date(periodFrom).getTime() + new Date(periodTo).getTime()) / 2);
  const run = await prisma.payRun.findFirst({ where: { companyId, periodFrom: { lte: mid }, periodTo: { gt: mid } }, select: { period: true } });
  return run ? run.period : null;
}

router.get('/run', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    if (req.query.period && !payroll_isLabel(req.query.period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    res.json(await payroll_run(prisma, req.user.companyId, req.query.period || null));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Write the cycle down. After this its payslips are a record, not a calculation.
router.post('/run/finalise', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    if (!payroll_isLabel(req.body.period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    const run = await payroll_run(prisma, companyId, req.body.period);
    if (run.status === 'final') return res.status(400).json({ error: 'That cycle is already finalised' });
    if (!run.canFinalise) return res.status(400).json({ error: run.blockedReason });

    const periodText = payroll_periodLabel(run.period.from, run.period.to);
    const created = await prisma.$transaction(async (tx) => {
      const payRun = await tx.payRun.create({
        data: { period: run.period.label, periodFrom: run.period.from, periodTo: run.period.to, companyId },
      });
      for (const slip of run.payslips) {
        let expenseId = null;
        if (slip.wageCost > 0) {
          const expense = await tx.expense.create({
            data: {
              description: `${slip.kind === 'commission' ? 'Commission' : 'Salary'}: ${slip.name} (${periodText})`,
              amount: slip.wageCost, category: PAYROLL_EXPENSE_CATEGORY, companyId,
            },
          });
          expenseId = expense.id;
        }
        const payslip = await tx.payslip.create({
          data: {
            payRunId: payRun.id,
            consultantId: slip.kind === 'commission' ? slip.personId : null,
            staffId: slip.kind === 'salaried' ? slip.personId : null,
            name: slip.name, jobTitle: slip.jobTitle || null,
            broughtForward: slip.broughtForward, earnings: slip.earnings, alreadyPaid: slip.alreadyPaid,
            deductions: slip.deductions, netPay: slip.netPay, expenseId, companyId,
          },
        });
        if (slip.lines.length) {
          await tx.payslipLine.createMany({
            data: slip.lines.map((l, i) => ({
              payslipId: payslip.id, kind: l.kind, label: l.label, amount: l.amount,
              sourcePeriod: l.sourcePeriod || null, entitlement: l.entitlement ?? null,
              loanId: l.loanId || null, adjustmentId: l.adjustmentId || null, sort: i, companyId,
            })),
          });
        }
      }
      return payRun;
    }, { timeout: 20000 });

    res.status(201).json(await payroll_run(prisma, companyId, created.period));
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'That cycle is already finalised' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

// Undo a finalise, for the mistake noticed before anyone has been paid.
router.post('/run/reopen', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    if (!payroll_isLabel(req.body.period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    const run = await payroll_run(prisma, companyId, req.body.period);
    if (run.status !== 'final') return res.status(400).json({ error: 'That cycle is not finalised' });
    if (!run.canReopen) return res.status(400).json({ error: 'Only the latest cycle can be reopened, and only before any of it is paid. Remove its payments first.' });

    await prisma.$transaction(async (tx) => {
      const slips = await tx.payslip.findMany({ where: { payRunId: run.runId, companyId }, select: { id: true, expenseId: true } });
      await tx.payslip.deleteMany({ where: { id: { in: slips.map(s => s.id) } } });
      const expenseIds = slips.map(s => s.expenseId).filter(Boolean);
      if (expenseIds.length) await tx.expense.deleteMany({ where: { id: { in: expenseIds }, companyId } });
      await tx.payRun.delete({ where: { id: run.runId } });
    }, { timeout: 20000 });

    res.json(await payroll_run(prisma, companyId, req.body.period));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// A finalised payslip with whether it is still the person's newest one. Only the newest can
// take or lose a payment, because an older one's balance already sits on the payslip after it.
async function payroll_openPayslip(prisma, companyId, id) {
  const payslip = await prisma.payslip.findFirst({ where: { id, companyId }, include: { payRun: true } });
  if (!payslip) return { error: 'Payslip not found', status: 404 };
  const later = await prisma.payslip.findFirst({
    where: {
      companyId, payRun: { period: { gt: payslip.payRun.period } },
      ...(payslip.consultantId ? { consultantId: payslip.consultantId } : { staffId: payslip.staffId }),
    },
    include: { payRun: { select: { period: true } } },
  });
  if (later) return { error: `This balance was carried into the ${later.payRun.period} payslip. Settle it there.`, status: 400 };
  return { payslip };
}

// Cash handed over against a payslip. The wage cost was booked at finalise, so this raises no
// expense: it only moves the payslip towards settled.
router.post('/payslips/:id/payments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const found = await payroll_openPayslip(prisma, companyId, req.params.id);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const { payslip } = found;

    const amount = round2(parseFloat(req.body.amount));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });
    const model = payslip.consultantId ? prisma.commissionPayment : prisma.staffPayment;
    const sofar = await model.aggregate({ where: { payslipId: payslip.id }, _sum: { amount: true } });
    const outstanding = round2(payroll_num(payslip.netPay) - payroll_num(sofar._sum.amount));
    if (outstanding <= 0) return res.status(400).json({ error: 'Nothing is owed on this payslip' });
    if (amount > outstanding + 0.01) return res.status(400).json({ error: `Only K${outstanding.toFixed(2)} is owed on this payslip` });

    const common = {
      amount, periodFrom: payslip.payRun.periodFrom, periodTo: payslip.payRun.periodTo,
      paymentMethod: req.body.paymentMethod || null, reference: req.body.reference || null, notes: req.body.notes || null,
      payslipId: payslip.id, companyId,
    };
    const payment = payslip.consultantId
      ? await prisma.commissionPayment.create({ data: { ...common, consultantId: payslip.consultantId, type: 'commission' } })
      : await prisma.staffPayment.create({ data: { ...common, staffId: payslip.staffId, type: 'salary' } });
    res.status(201).json(payment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/payslips/:id/payments/:paymentId', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const found = await payroll_openPayslip(prisma, companyId, req.params.id);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const model = found.payslip.consultantId ? prisma.commissionPayment : prisma.staffPayment;
    const removed = await model.deleteMany({ where: { id: req.params.paymentId, payslipId: found.payslip.id, companyId } });
    if (!removed.count) return res.status(404).json({ error: 'Payment not found' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- ADJUSTMENTS: BONUSES, DEDUCTIONS AND RECOVERIES ----

// A cycle that is finalised cannot take anything new; it goes on the next one.
async function payroll_periodIsClosed(prisma, companyId, period) {
  const last = await prisma.payRun.findFirst({ where: { companyId }, orderBy: { period: 'desc' }, select: { period: true } });
  return !!last && last.period >= period;
}

router.post('/adjustments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { kind, period, reason, saleId } = req.body;
    if (!PAYROLL_ADJUSTMENT_KINDS.includes(kind)) return res.status(400).json({ error: `Kind must be one of ${PAYROLL_ADJUSTMENT_KINDS.join(', ')}` });
    if (!payroll_isLabel(period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    const amount = round2(parseFloat(req.body.amount));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Say what this is for, so the payslip explains itself' });
    const person = await payroll_resolvePerson(prisma, companyId, req.body);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    if (await payroll_periodIsClosed(prisma, companyId, period)) return res.status(400).json({ error: 'That cycle is finalised. Add this to the cycle that is still open.' });
    if (saleId && !(await prisma.sale.findFirst({ where: { id: saleId, companyId }, select: { id: true } }))) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const adjustment = await prisma.payAdjustment.create({
      data: {
        consultantId: person.consultantId, staffId: person.staffId, period, kind, amount,
        reason: String(reason).trim(), saleId: saleId || null,
        refundable: kind === 'recovery' && !!req.body.refundable, companyId,
      },
    });
    res.status(201).json(adjustment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/adjustments/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const adjustment = await prisma.payAdjustment.findFirst({ where: { id: req.params.id, companyId } });
    if (!adjustment) return res.status(404).json({ error: 'Not found' });
    const used = await prisma.payslipLine.count({ where: { adjustmentId: adjustment.id, companyId } });
    if (used) return res.status(400).json({ error: 'This is on a finalised payslip and cannot be removed' });
    await prisma.payAdjustment.delete({ where: { id: adjustment.id } });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Give held money back: it is refunded on the pay run for the cycle named. Passing no period
// takes the release back, as long as the refund has not been finalised.
router.post('/adjustments/:id/release', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const adjustment = await prisma.payAdjustment.findFirst({ where: { id: req.params.id, companyId } });
    if (!adjustment || adjustment.kind !== 'recovery') return res.status(404).json({ error: 'Not found' });
    if (!adjustment.refundable) return res.status(400).json({ error: 'This recovery was not marked as refundable' });
    const linesFor = await prisma.payslipLine.findMany({ where: { adjustmentId: adjustment.id, companyId }, select: { kind: true } });
    if (!linesFor.some(l => l.kind !== 'refund')) return res.status(400).json({ error: 'This has not been deducted yet. Remove it instead.' });
    if (linesFor.some(l => l.kind === 'refund')) return res.status(400).json({ error: 'This has already been refunded' });

    const period = req.body.period || null;
    if (period) {
      if (!payroll_isLabel(period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
      if (await payroll_periodIsClosed(prisma, companyId, period)) return res.status(400).json({ error: 'That cycle is finalised. Release it on the cycle that is still open.' });
    }
    res.json(await prisma.payAdjustment.update({ where: { id: adjustment.id }, data: { refundPeriod: period } }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CONSULTANT TARGETS ----

// Set, or change, what a consultant is asked to collect in a cycle and what reaching it pays.
router.put('/targets', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { consultantId, period } = req.body;
    if (!payroll_isLabel(period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    const consultant = await prisma.consultant.findFirst({ where: { id: consultantId || '', companyId, isStockLocation: false } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    const target = round2(parseFloat(req.body.target));
    if (!Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Target must be more than zero' });
    const bonus = req.body.bonus === undefined || req.body.bonus === '' ? 0 : round2(parseFloat(req.body.bonus));
    const bonusRate = req.body.bonusRate === undefined || req.body.bonusRate === '' ? 0 : round2(parseFloat(req.body.bonusRate));
    if (!Number.isFinite(bonus) || bonus < 0) return res.status(400).json({ error: 'Bonus must be zero or more' });
    if (!Number.isFinite(bonusRate) || bonusRate < 0 || bonusRate > 100) return res.status(400).json({ error: 'The share above target must be between 0 and 100 percent' });
    if (await payroll_periodIsClosed(prisma, companyId, period)) return res.status(400).json({ error: 'That cycle is finalised, so its target can no longer change.' });

    const saved = await prisma.consultantTarget.upsert({
      where: { consultantId_period: { consultantId: consultant.id, period } },
      create: { consultantId: consultant.id, period, target, bonus, bonusRate, companyId },
      update: { target, bonus, bonusRate },
    });
    res.json(saved);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/targets/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const target = await prisma.consultantTarget.findFirst({ where: { id: req.params.id, companyId } });
    if (!target) return res.status(404).json({ error: 'Target not found' });
    if (await payroll_periodIsClosed(prisma, companyId, target.period)) return res.status(400).json({ error: 'That cycle is finalised, so its target can no longer change.' });
    await prisma.consultantTarget.delete({ where: { id: target.id } });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- LOANS ----

router.get('/loans', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const [loans, lines] = await Promise.all([
      prisma.loan.findMany({
        where: { companyId }, orderBy: { createdAt: 'desc' },
        include: { consultant: { select: { name: true } }, staff: { select: { name: true } } },
      }),
      prisma.payslipLine.findMany({
        where: { companyId, loanId: { not: null } },
        select: { loanId: true, amount: true, payslip: { select: { payRun: { select: { period: true } } } } },
      }),
    ]);
    res.json(loans.map(loan => {
      const repayments = lines.filter(l => l.loanId === loan.id)
        .map(l => ({ period: l.payslip.payRun.period, amount: Math.abs(payroll_num(l.amount)) }))
        .sort((a, b) => (a.period < b.period ? -1 : 1));
      const repaid = round2(repayments.reduce((s, r) => s + r.amount, 0));
      const principal = payroll_num(loan.principal), instalment = payroll_num(loan.instalmentAmount);
      const outstanding = loan.status === 'cancelled' ? 0 : round2(principal - repaid);
      return {
        id: loan.id, kind: loan.consultantId ? 'commission' : 'salaried', personId: loan.consultantId || loan.staffId,
        name: loan.consultant?.name || loan.staff?.name || '', description: loan.description, notes: loan.notes,
        principal, instalmentAmount: instalment, firstPeriod: loan.firstPeriod, issuedAt: loan.issuedAt, status: loan.status,
        repaid, outstanding, writtenOff: loan.status === 'cancelled' ? round2(principal - repaid) : 0,
        instalmentsLeft: outstanding > 0 && instalment > 0 ? Math.ceil(outstanding / instalment - 0.0001) : 0,
        repayments,
      };
    }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/loans', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { description, firstPeriod, notes, issuedAt } = req.body;
    if (!description || !String(description).trim()) return res.status(400).json({ error: 'Say what the loan is for' });
    const principal = round2(parseFloat(req.body.principal));
    if (!Number.isFinite(principal) || principal <= 0) return res.status(400).json({ error: 'Loan amount must be more than zero' });
    // The terms can be given either way round: an amount per cycle, or a number of cycles.
    const count = parseInt(req.body.instalments, 10);
    const instalmentAmount = req.body.instalmentAmount !== undefined && req.body.instalmentAmount !== ''
      ? round2(parseFloat(req.body.instalmentAmount))
      : (count > 0 ? Math.ceil((principal / count) * 100) / 100 : NaN);
    if (!Number.isFinite(instalmentAmount) || instalmentAmount <= 0) return res.status(400).json({ error: 'Give the repayment terms: an amount per cycle, or a number of instalments' });
    if (!payroll_isLabel(firstPeriod)) return res.status(400).json({ error: 'Choose the cycle the first instalment comes out of' });
    const person = await payroll_resolvePerson(prisma, companyId, req.body);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    if (await payroll_periodIsClosed(prisma, companyId, firstPeriod)) return res.status(400).json({ error: 'That cycle is finalised. The first instalment must come out of a cycle that is still open.' });

    const loan = await prisma.loan.create({
      data: {
        consultantId: person.consultantId, staffId: person.staffId, description: String(description).trim(),
        principal, instalmentAmount: Math.min(instalmentAmount, principal), firstPeriod,
        issuedAt: issuedAt ? new Date(issuedAt) : new Date(), notes: notes || null, companyId,
      },
    });
    res.status(201).json(loan);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Change the terms from here on. What has already been deducted stays as it was.
router.put('/loans/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const loan = await prisma.loan.findFirst({ where: { id: req.params.id, companyId } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const raw = req.body;
    const data = {
      ...(raw.description !== undefined && { description: String(raw.description).trim() || loan.description }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
    };
    if (raw.status !== undefined) {
      if (!['active', 'cancelled'].includes(raw.status)) return res.status(400).json({ error: 'Status must be active or cancelled' });
      data.status = raw.status;
    }
    if (raw.instalmentAmount !== undefined) {
      const v = round2(parseFloat(raw.instalmentAmount));
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'Instalment must be more than zero' });
      data.instalmentAmount = v;
    }
    const repaid = await prisma.payslipLine.aggregate({ where: { loanId: loan.id, companyId }, _sum: { amount: true } });
    const repaidSoFar = Math.abs(payroll_num(repaid._sum.amount));
    if (raw.principal !== undefined) {
      const v = round2(parseFloat(raw.principal));
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'Loan amount must be more than zero' });
      if (v < repaidSoFar) return res.status(400).json({ error: `K${repaidSoFar.toFixed(2)} has already been repaid, so the loan cannot be less than that` });
      data.principal = v;
    }
    if (raw.firstPeriod !== undefined && raw.firstPeriod !== loan.firstPeriod) {
      if (!payroll_isLabel(raw.firstPeriod)) return res.status(400).json({ error: 'Period must look like 2026-11' });
      if (repaidSoFar > 0) return res.status(400).json({ error: 'Repayment has started, so the first cycle cannot move. Skip a cycle on the pay run instead.' });
      data.firstPeriod = raw.firstPeriod;
    }
    res.json(await prisma.loan.update({ where: { id: loan.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// A loan nobody has repaid any of was a mistake and can go. One with repayments is history.
router.delete('/loans/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const loan = await prisma.loan.findFirst({ where: { id: req.params.id, companyId } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const used = await prisma.payslipLine.count({ where: { loanId: loan.id, companyId } });
    if (used) return res.status(400).json({ error: 'Repayments have been taken for this loan. Cancel it instead to write off the rest.' });
    await prisma.$transaction([
      prisma.payAdjustment.deleteMany({ where: { loanId: loan.id, companyId } }),
      prisma.loan.delete({ where: { id: loan.id } }),
    ]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// The admin's say over one cycle's instalment: take this much instead of the scheduled
// amount, zero to skip the cycle. Sending no amount goes back to the schedule.
router.put('/loans/:id/instalment', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const loan = await prisma.loan.findFirst({ where: { id: req.params.id, companyId } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const { period } = req.body;
    if (!payroll_isLabel(period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    if (await payroll_periodIsClosed(prisma, companyId, period)) return res.status(400).json({ error: 'That cycle is finalised' });

    await prisma.payAdjustment.deleteMany({ where: { loanId: loan.id, period, kind: 'loan_instalment', companyId } });
    if (req.body.amount === undefined || req.body.amount === null || req.body.amount === '') return res.json({ scheduled: true });
    const amount = round2(parseFloat(req.body.amount));
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Amount must be zero or more' });
    const override = await prisma.payAdjustment.create({
      data: {
        consultantId: loan.consultantId, staffId: loan.staffId, period, kind: 'loan_instalment', amount,
        reason: amount === 0 ? 'Instalment skipped' : 'Instalment changed', loanId: loan.id, companyId,
      },
    });
    res.json(override);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
module.exports.payrollInternals = {
  PAYROLL_EXPENSE_CATEGORY, PAYROLL_STAFF_PAYMENT_TYPES,
  payroll_isCost, payroll_raiseExpense, payroll_dropExpense, payroll_accrue, payroll_staffSummary,
  payroll_run, payroll_consultantPay, payroll_finalisedCycleOf, payroll_payslipHistory,
};
