const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getConsultantPayPeriod, payPeriodFromLabel } = require('../utils/payPeriod');

// Salary advances people ask for themselves. (mirrored in api/index.js)
//
// The person says how much and over how many pay days it comes back. The admin approves it (as
// asked, or on terms of their own), then records handing the money over. That last step creates
// a Loan, which the pay run already deducts instalment by instalment, so an advance needs no
// arithmetic of its own on the payslip.
//
// The first instalment comes from the first pay day after the money was received, never from
// one before it, and never from a cycle that is already finalised. That is why the loan is made
// when the money is paid out rather than when the request is approved: approval can come days
// before the cash does.

const ADVANCE_MAX_INSTALMENTS = 12;
const advance_round2 = (n) => Math.round(n * 100) / 100;
const advance_num = (v) => (v == null ? 0 : parseFloat(v));

function advance_shiftLabel(label, by) {
  const [y, m] = label.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// A date-only string is read as midday local time, so a server running in UTC can't move an
// advance handed over on pay day into the cycle before.
function advance_parseDate(v) {
  if (!v) return new Date();
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function advance_payDay(prisma, companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
  return company?.consultantPayDay || 11;
}

// The cycle whose pay day is the first one after the money was received, moved on past any
// cycle already finalised.
async function advance_firstPeriod(prisma, companyId, receivedAt, payDay) {
  let label = getConsultantPayPeriod(receivedAt, payDay).label;
  const last = await prisma.payRun.findFirst({ where: { companyId }, orderBy: { period: 'desc' }, select: { period: true } });
  if (last && last.period >= label) label = advance_shiftLabel(last.period, 1);
  return label;
}

const advance_instalmentAmount = (amount, instalments) => Math.ceil((amount / instalments) * 100) / 100;

// Each pay day and what comes off on it, the way the pay run will take it.
function advance_schedule(amount, instalmentAmount, firstPeriod, payDay) {
  const out = [];
  let left = advance_round2(amount);
  for (let i = 0; left > 0 && i < 60; i++) {
    const period = advance_shiftLabel(firstPeriod, i);
    const take = advance_round2(Math.min(instalmentAmount, left));
    out.push({ period, payDate: payPeriodFromLabel(period, payDay).payDate, amount: take });
    left = advance_round2(left - take);
  }
  return out;
}

// The pay profile behind a login: a consultant, or a salaried staff member found by their login
// or by the rider profile that login belongs to.
async function advance_personFor(prisma, user) {
  if (user.role === 'admin' || user.role === 'superadmin') return null;
  if (user.consultantId) {
    const c = await prisma.consultant.findFirst({ where: { id: user.consultantId, companyId: user.companyId } });
    return c ? { consultantId: c.id, staffId: null, name: c.name } : null;
  }
  const s = await prisma.staff.findFirst({
    where: { companyId: user.companyId, isActive: true, OR: [{ userId: user.id }, ...(user.riderId ? [{ riderId: user.riderId }] : [])] },
  });
  return s ? { consultantId: null, staffId: s.id, name: s.name } : null;
}

const ADVANCE_INCLUDE = {
  consultant: { select: { name: true } },
  staff: { select: { name: true } },
  loan: { select: { id: true, principal: true, instalmentAmount: true, firstPeriod: true, status: true } },
};

// One request as both sides see it. Until the money is paid out, the schedule is what would
// happen if it were paid today; afterwards it is the loan's.
async function advance_views(prisma, companyId, requests) {
  const payDay = await advance_payDay(prisma, companyId);
  const previewFirst = await advance_firstPeriod(prisma, companyId, new Date(), payDay);
  const loanIds = requests.map(r => r.loanId).filter(Boolean);
  const lines = loanIds.length
    ? await prisma.payslipLine.groupBy({ by: ['loanId'], where: { companyId, loanId: { in: loanIds } }, _sum: { amount: true } })
    : [];
  const repaidBy = new Map(lines.map(l => [l.loanId, Math.abs(advance_num(l._sum.amount))]));

  return requests.map(r => {
    const requested = { amount: advance_num(r.amount), instalments: r.instalments };
    const agreed = r.approvedAmount != null
      ? { amount: advance_num(r.approvedAmount), instalments: r.approvedInstalments }
      : requested;
    const base = {
      id: r.id, status: r.status, kind: r.consultantId ? 'commission' : 'salaried', personId: r.consultantId || r.staffId,
      name: r.consultant?.name || r.staff?.name || '', reason: r.reason, requested, agreed,
      termsChanged: agreed.amount !== requested.amount || agreed.instalments !== requested.instalments,
      decisionNote: r.decisionNote, createdAt: r.createdAt, decidedAt: r.decidedAt, paidAt: r.paidAt, paymentMethod: r.paymentMethod,
    };
    if (r.loan) {
      const principal = advance_num(r.loan.principal);
      const repaid = advance_round2(repaidBy.get(r.loan.id) || 0);
      return {
        ...base, firstPeriod: r.loan.firstPeriod, instalmentAmount: advance_num(r.loan.instalmentAmount),
        schedule: advance_schedule(principal, advance_num(r.loan.instalmentAmount), r.loan.firstPeriod, payDay),
        repaid, outstanding: r.loan.status === 'cancelled' ? 0 : advance_round2(principal - repaid), loanStatus: r.loan.status,
      };
    }
    if (r.status === 'pending' || r.status === 'approved') {
      const per = advance_instalmentAmount(agreed.amount, agreed.instalments);
      return { ...base, firstPeriod: previewFirst, instalmentAmount: per, schedule: advance_schedule(agreed.amount, per, previewFirst, payDay), preview: true };
    }
    return { ...base, firstPeriod: null, schedule: [] };
  });
}

function advance_terms(body) {
  const amount = advance_round2(parseFloat(body.amount));
  const instalments = Number(body.instalments);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'The amount must be more than zero' };
  if (!Number.isInteger(instalments) || instalments < 1 || instalments > ADVANCE_MAX_INSTALMENTS) {
    return { error: `Choose between 1 and ${ADVANCE_MAX_INSTALMENTS} instalments` };
  }
  return { amount, instalments };
}

router.use(authenticate);

// ---- the person's own requests ----

router.get('/mine', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const person = await advance_personFor(prisma, req.user);
    if (!person) return res.status(404).json({ error: 'Your login is not linked to a pay profile. Ask the office to link it.' });
    const requests = await prisma.advanceRequest.findMany({
      where: { companyId: req.user.companyId, consultantId: person.consultantId, staffId: person.staffId },
      include: ADVANCE_INCLUDE, orderBy: { createdAt: 'desc' },
    });
    const payDay = await advance_payDay(prisma, req.user.companyId);
    const nextFirst = await advance_firstPeriod(prisma, req.user.companyId, new Date(), payDay);
    res.json({
      name: person.name, maxInstalments: ADVANCE_MAX_INSTALMENTS,
      nextPayDate: payPeriodFromLabel(nextFirst, payDay).payDate,
      requests: await advance_views(prisma, req.user.companyId, requests),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/mine', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const person = await advance_personFor(prisma, req.user);
    if (!person) return res.status(404).json({ error: 'Your login is not linked to a pay profile. Ask the office to link it.' });
    const terms = advance_terms(req.body);
    if (terms.error) return res.status(400).json({ error: terms.error });
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Say what the advance is for' });
    // One open request at a time keeps a double tap from becoming two advances.
    const open = await prisma.advanceRequest.findFirst({
      where: { companyId, consultantId: person.consultantId, staffId: person.staffId, status: { in: ['pending', 'approved'] } },
    });
    if (open) return res.status(409).json({ error: 'You already have an advance request waiting. Withdraw it or wait for it to be settled first.' });
    const created = await prisma.advanceRequest.create({
      data: { consultantId: person.consultantId, staffId: person.staffId, requestedById: req.user.id, reason, ...terms, companyId },
      include: ADVANCE_INCLUDE,
    });
    res.status(201).json((await advance_views(prisma, companyId, [created]))[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/mine/:id/withdraw', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const person = await advance_personFor(prisma, req.user);
    if (!person) return res.status(404).json({ error: 'Request not found' });
    const done = await prisma.advanceRequest.updateMany({
      where: { id: req.params.id, companyId: req.user.companyId, consultantId: person.consultantId, staffId: person.staffId, status: 'pending' },
      data: { status: 'withdrawn' },
    });
    if (!done.count) return res.status(400).json({ error: 'Only a request still waiting for a decision can be withdrawn' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- the office ----

router.get('/', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const requests = await prisma.advanceRequest.findMany({
      where: { companyId: req.user.companyId }, include: ADVANCE_INCLUDE, orderBy: { createdAt: 'desc' },
    });
    res.json(await advance_views(prisma, req.user.companyId, requests));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const request = await prisma.advanceRequest.findFirst({ where: { id: req.params.id, companyId } });
    if (!request) return res.status(404).json({ error: 'Request not found' });
    const changing = req.body.amount !== undefined || req.body.instalments !== undefined;
    const terms = changing
      ? advance_terms({ amount: req.body.amount ?? request.amount, instalments: req.body.instalments ?? request.instalments })
      : { amount: advance_num(request.amount), instalments: request.instalments };
    if (terms.error) return res.status(400).json({ error: terms.error });
    const done = await prisma.advanceRequest.updateMany({
      where: { id: request.id, companyId, status: 'pending' },
      data: {
        status: 'approved', approvedAmount: terms.amount, approvedInstalments: terms.instalments,
        decisionNote: req.body.note ? String(req.body.note).trim().slice(0, 500) : null, decidedAt: new Date(),
      },
    });
    if (!done.count) return res.status(400).json({ error: 'Only a request waiting for a decision can be approved' });
    const updated = await prisma.advanceRequest.findUnique({ where: { id: request.id }, include: ADVANCE_INCLUDE });
    res.json((await advance_views(prisma, companyId, [updated]))[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/:id/decline', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const done = await prisma.advanceRequest.updateMany({
      where: { id: req.params.id, companyId, status: { in: ['pending', 'approved'] } },
      data: { status: 'declined', decisionNote: req.body.note ? String(req.body.note).trim().slice(0, 500) : null, decidedAt: new Date() },
    });
    if (!done.count) return res.status(400).json({ error: 'Only a request that has not been paid out can be declined' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// The money has been handed over: the loan starts here, repaid from the next pay day on.
router.post('/:id/pay', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const paidAt = advance_parseDate(req.body.paidAt);
    if (!paidAt) return res.status(400).json({ error: 'Give the date the money was handed over' });
    if (paidAt > new Date(Date.now() + 24 * 60 * 60 * 1000)) return res.status(400).json({ error: 'The payout date cannot be in the future' });
    const payDay = await advance_payDay(prisma, companyId);
    const firstPeriod = await advance_firstPeriod(prisma, companyId, paidAt, payDay);

    const result = await prisma.$transaction(async (tx) => {
      // Claiming the request first means a second click finds nothing to pay and makes no loan.
      const claimed = await tx.advanceRequest.updateMany({
        where: { id: req.params.id, companyId, status: 'approved' },
        data: { status: 'paid', paidAt, paymentMethod: req.body.paymentMethod ? String(req.body.paymentMethod).slice(0, 50) : null },
      });
      if (!claimed.count) return null;
      const request = await tx.advanceRequest.findUnique({ where: { id: req.params.id } });
      const amount = advance_num(request.approvedAmount ?? request.amount);
      const instalments = request.approvedInstalments ?? request.instalments;
      const loan = await tx.loan.create({
        data: {
          consultantId: request.consultantId, staffId: request.staffId, description: 'Salary advance',
          principal: amount, instalmentAmount: Math.min(advance_instalmentAmount(amount, instalments), amount), firstPeriod,
          issuedAt: paidAt, notes: request.reason, companyId,
        },
      });
      await tx.advanceRequest.update({ where: { id: request.id }, data: { loanId: loan.id } });
      return request.id;
    });
    if (!result) return res.status(400).json({ error: 'Only an approved request that has not been paid out can be paid' });
    const updated = await prisma.advanceRequest.findUnique({ where: { id: result }, include: ADVANCE_INCLUDE });
    res.json((await advance_views(prisma, companyId, [updated]))[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
