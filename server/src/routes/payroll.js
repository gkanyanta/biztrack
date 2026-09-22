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
    const paid = await prisma.staffPayment.count({ where: { staffId: staff.id } });
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
      prisma.sale.findMany({ where: { companyId, date: { gte: periodFrom, lt: periodTo } }, include: { items: true } }),
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

module.exports = router;
module.exports.payrollInternals = {
  PAYROLL_EXPENSE_CATEGORY, PAYROLL_STAFF_PAYMENT_TYPES,
  payroll_isCost, payroll_raiseExpense, payroll_dropExpense, payroll_accrue, payroll_staffSummary,
};
