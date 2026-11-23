const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getConsultantPayPeriod } = require('../utils/payPeriod');
const { payrollInternals: { payroll_run } } = require('./payroll');

router.use(authenticate);

// The sales team at a glance, for the sales supervisor and the office: this pay cycle's orders
// and collections per consultant against their targets, orders still to go out, unpaid orders
// and open order queries. No pay, cost or profit: a supervisor sees what the team sells, not
// what anyone earns. (mirrored in api/index.js and server/src/routes/team.js)
const TEAM_UNPAID_DAYS = 90;

async function team_view(prisma, user) {
  const companyId = user.companyId;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
  const cycle = getConsultantPayPeriod(new Date(), company?.consultantPayDay || 11);
  const unpaidFrom = new Date(Date.now() - TEAM_UNPAID_DAYS * 864e5);
  const saleSelect = {
    id: true, orderNumber: true, date: true, status: true, paymentStatus: true, totalPrice: true, amountPaid: true,
    customerName: true, customerPhone: true, customerCity: true, deliveryAddress: true, notes: true, consultantId: true,
  };
  const [consultants, cycleSales, toGoOut, unpaid, queries, run] = await Promise.all([
    prisma.consultant.findMany({ where: { companyId, isActive: true, isStockLocation: false }, select: { id: true, name: true, isSupervisor: true }, orderBy: { name: 'asc' } }),
    prisma.sale.findMany({ where: { companyId, consultantId: { not: null }, status: { not: 'Cancelled' }, date: { gte: cycle.periodFrom, lt: cycle.periodTo } }, select: { consultantId: true, totalPrice: true, amountPaid: true } }),
    prisma.sale.findMany({ where: { companyId, status: { in: ['Pending', 'Confirmed'] } }, select: saleSelect, orderBy: { date: 'asc' }, take: 200 }),
    prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, paymentStatus: { not: 'Paid' }, date: { gte: unpaidFrom } }, select: saleSelect, orderBy: { date: 'asc' }, take: 200 }),
    prisma.orderQuery.findMany({ where: { companyId, status: { not: 'closed' } }, select: { consultantId: true, status: true } }),
    // The targets as the payslip measures them: goods value collected this cycle.
    payroll_run(prisma, companyId, cycle.label),
  ]);
  const names = Object.fromEntries(consultants.map(c => [c.id, c.name]));
  const money = (n) => Math.round(n * 100) / 100;
  const balance = (s) => money(parseFloat(s.totalPrice) - parseFloat(s.amountPaid));
  const order = (s) => ({
    id: s.id, orderNumber: s.orderNumber, date: s.date, status: s.status, paymentStatus: s.paymentStatus,
    total: money(parseFloat(s.totalPrice)), balance: balance(s),
    customerName: s.customerName, customerPhone: s.customerPhone, customerCity: s.customerCity, deliveryAddress: s.deliveryAddress, notes: s.notes,
    consultant: s.consultantId ? { id: s.consultantId, name: names[s.consultantId] || 'Former consultant' } : null,
  });
  const slips = new Map(run.payslips.filter(x => x.kind === 'commission').map(x => [x.personId, x]));
  const rows = consultants.map(c => {
    const mine = cycleSales.filter(s => s.consultantId === c.id);
    const t = slips.get(c.id)?.target || null;
    return {
      id: c.id, name: c.name, isSupervisor: c.isSupervisor,
      orders: mine.length,
      sales: money(mine.reduce((a, s) => a + parseFloat(s.totalPrice), 0)),
      collected: money(mine.reduce((a, s) => a + Math.min(parseFloat(s.amountPaid), parseFloat(s.totalPrice)), 0)),
      target: t ? { target: t.target, collected: t.collected, progress: t.progress, reached: t.reached, toGo: t.toGo } : null,
      toGoOut: toGoOut.filter(s => s.consultantId === c.id).length,
      unpaid: { count: unpaid.filter(s => s.consultantId === c.id).length, balance: money(unpaid.filter(s => s.consultantId === c.id).reduce((a, s) => a + balance(s), 0)) },
      openQueries: queries.filter(q => q.consultantId === c.id).length,
    };
  });
  return {
    cycle: { label: cycle.label, from: cycle.periodFrom, to: cycle.periodTo, payDate: cycle.payDate },
    consultants: rows,
    toGoOut: toGoOut.map(order),
    unpaid: unpaid.map(order),
  };
}

router.get('/', async (req, res) => {
  try {
    const user = req.user;
    if (!(user.role === 'admin' || (user.role === 'consultant' && user.isSupervisor))) {
      return res.status(403).json({ error: 'Only the office or the sales supervisor can see the team' });
    }
    res.json(await team_view(req.app.locals.prisma, user));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
