const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// ---- LIST CONSULTANTS ----
router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { active } = req.query;
    const where = { companyId };
    if (active === 'true') where.isActive = true;
    if (active === 'false') where.isActive = false;
    const consultants = await prisma.consultant.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json(consultants);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- COMMISSION SUMMARY (before /:id) ----
router.get('/commission-summary', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to, consultantId } = req.query;

    const saleWhere = { companyId, status: { not: 'Cancelled' }, consultantId: { not: null } };
    if (consultantId) saleWhere.consultantId = consultantId;
    if (from || to) { saleWhere.date = {}; if (from) saleWhere.date.gte = new Date(from); if (to) saleWhere.date.lte = new Date(to + 'T23:59:59.999Z'); }

    const sales = await prisma.sale.findMany({ where: saleWhere, include: { consultant: true, items: true } });
    const consultants = await prisma.consultant.findMany({ where: { companyId } });
    const payments = await prisma.commissionPayment.findMany({ where: { companyId } });

    const summary = consultants.map(c => {
      const cSales = sales.filter(s => s.consultantId === c.id);
      const totalSales = cSales.length;
      const totalRevenue = cSales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
      const commissionEarned = totalSales * parseFloat(c.commissionRate);
      const cPayments = payments.filter(p => p.consultantId === c.id);
      const commissionPaid = cPayments.filter(p => p.type === 'commission').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const allowancePaid = cPayments.filter(p => p.type === 'allowance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const balance = commissionEarned - commissionPaid;
      return {
        consultant: { id: c.id, name: c.name, phone: c.phone, commissionRate: c.commissionRate, monthlyAllowance: c.monthlyAllowance, isActive: c.isActive },
        totalSales, totalRevenue, commissionEarned, commissionPaid, allowancePaid, balance
      };
    });

    const totals = {
      totalSales: summary.reduce((s, c) => s + c.totalSales, 0),
      totalRevenue: summary.reduce((s, c) => s + c.totalRevenue, 0),
      totalCommissionEarned: summary.reduce((s, c) => s + c.commissionEarned, 0),
      totalCommissionPaid: summary.reduce((s, c) => s + c.commissionPaid, 0),
      totalAllowancePaid: summary.reduce((s, c) => s + c.allowancePaid, 0),
      totalBalance: summary.reduce((s, c) => s + c.balance, 0),
    };

    res.json({ summary, totals });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- GET SINGLE CONSULTANT ----
router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    // Get their sales and payments
    const sales = await prisma.sale.findMany({
      where: { consultantId: consultant.id, companyId, status: { not: 'Cancelled' } },
      include: { items: true },
      orderBy: { date: 'desc' }
    });
    const payments = await prisma.commissionPayment.findMany({
      where: { consultantId: consultant.id, companyId },
      orderBy: { createdAt: 'desc' }
    });

    const totalSales = sales.length;
    const totalRevenue = sales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
    const commissionEarned = totalSales * parseFloat(consultant.commissionRate);
    const commissionPaid = payments.filter(p => p.type === 'commission').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const allowancePaid = payments.filter(p => p.type === 'allowance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = commissionEarned - commissionPaid;

    res.json({ ...consultant, totalSales, totalRevenue, commissionEarned, commissionPaid, allowancePaid, balance, sales, payments });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CREATE CONSULTANT ----
router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { name, phone, whatsapp, commissionRate, monthlyAllowance, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const consultant = await prisma.consultant.create({
      data: {
        name, phone: phone || null, whatsapp: whatsapp || null,
        commissionRate: parseFloat(commissionRate) || 50,
        monthlyAllowance: parseFloat(monthlyAllowance) || 400,
        notes: notes || null, companyId
      }
    });
    res.status(201).json(consultant);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- UPDATE CONSULTANT ----
router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Consultant not found' });

    const raw = req.body;
    const data = {
      ...(raw.name !== undefined && { name: raw.name }),
      ...(raw.phone !== undefined && { phone: raw.phone || null }),
      ...(raw.whatsapp !== undefined && { whatsapp: raw.whatsapp || null }),
      ...(raw.commissionRate !== undefined && { commissionRate: parseFloat(raw.commissionRate) }),
      ...(raw.monthlyAllowance !== undefined && { monthlyAllowance: parseFloat(raw.monthlyAllowance) }),
      ...(raw.isActive !== undefined && { isActive: raw.isActive }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
    };

    const consultant = await prisma.consultant.update({ where: { id: req.params.id }, data });
    res.json(consultant);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- DELETE CONSULTANT ----
router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Consultant not found' });

    // Check if they have sales - if so, just deactivate
    const salesCount = await prisma.sale.count({ where: { consultantId: req.params.id } });
    if (salesCount > 0) {
      await prisma.consultant.update({ where: { id: req.params.id }, data: { isActive: false } });
      return res.json({ message: 'Consultant deactivated (has existing sales)' });
    }

    await prisma.commissionPayment.deleteMany({ where: { consultantId: req.params.id } });
    await prisma.consultant.delete({ where: { id: req.params.id } });
    res.json({ message: 'Consultant deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- RECORD COMMISSION PAYMENT ----
router.post('/:id/payments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    const { amount, type, periodFrom, periodTo, paymentMethod, reference, notes } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const payment = await prisma.commissionPayment.create({
      data: {
        consultantId: consultant.id,
        amount: parseFloat(amount),
        type: type || 'commission',
        periodFrom: periodFrom ? new Date(periodFrom) : null,
        periodTo: periodTo ? new Date(periodTo) : null,
        paymentMethod: paymentMethod || null,
        reference: reference || null,
        notes: notes || null,
        companyId
      }
    });
    res.status(201).json(payment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- GET PAYMENT HISTORY ----
router.get('/:id/payments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const payments = await prisma.commissionPayment.findMany({
      where: { consultantId: req.params.id, companyId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(payments);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
