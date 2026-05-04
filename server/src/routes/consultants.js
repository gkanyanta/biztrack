const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getConsultantPayPeriod, payPeriodFromLabel, getEffectivePeriod } = require('../utils/payPeriod');

// Tiered commission: first N products at base rate, rest at tier rate.
// Tier threshold is FLAT — does not prorate on partial cycles.
function calcCommission(totalProductsSold, commissionRate, tierThreshold, tierRate) {
  const base = parseFloat(commissionRate);
  const tier = parseFloat(tierRate);
  const threshold = parseInt(tierThreshold) || 50;
  if (totalProductsSold <= threshold) return totalProductsSold * base;
  return (threshold * base) + ((totalProductsSold - threshold) * tier);
}

async function getCompanyPayDay(prisma, companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
  return company?.consultantPayDay || 11;
}

router.use(authenticate);

// ---- CONSULTANT SELF (for logged-in consultant) ----
router.get('/me', async (req, res) => {
  try {
    if (req.user.role !== 'consultant') return res.status(403).json({ error: 'Consultant access required' });
    const prisma = req.app.locals.prisma;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.user.consultantId, companyId: req.user.companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    res.json(consultant);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/me/stock', async (req, res) => {
  try {
    if (req.user.role !== 'consultant') return res.status(403).json({ error: 'Consultant access required' });
    const prisma = req.app.locals.prisma;
    const stock = await prisma.consultantStock.findMany({
      where: { consultantId: req.user.consultantId, companyId: req.user.companyId, qty: { gt: 0 } },
      include: { product: { select: { id: true, name: true, sku: true, sellingPrice: true, imageUrl: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(stock);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/me/transfers', async (req, res) => {
  try {
    if (req.user.role !== 'consultant') return res.status(403).json({ error: 'Consultant access required' });
    const prisma = req.app.locals.prisma;
    const transfers = await prisma.stockTransfer.findMany({
      where: { consultantId: req.user.consultantId, companyId: req.user.companyId },
      include: { product: { select: { name: true, sku: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(transfers);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- LIST CONSULTANTS (admin only) ----
router.get('/', requireAdmin, async (req, res) => {
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

// ---- COMMISSION SUMMARY (before /:id, admin only) ----
// Filters: ?period=YYYY-MM (cycle closing month) | ?from=&to= (free range) | neither = current open cycle
router.get('/commission-summary', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to, consultantId, period } = req.query;
    const payDay = await getCompanyPayDay(prisma, companyId);

    let periodFrom = null, periodTo = null, periodLabel = null, payDate = null, isCycle = false;
    if (period) {
      ({ periodFrom, periodTo, label: periodLabel, payDate } = payPeriodFromLabel(period, payDay));
      isCycle = true;
    } else if (!from && !to) {
      ({ periodFrom, periodTo, label: periodLabel, payDate } = getConsultantPayPeriod(new Date(), payDay));
      isCycle = true;
    }

    const saleWhere = { companyId, status: { not: 'Cancelled' }, consultantId: { not: null } };
    if (consultantId) saleWhere.consultantId = consultantId;
    if (isCycle) {
      saleWhere.date = { gte: periodFrom, lt: periodTo };
    } else if (from || to) {
      saleWhere.date = {};
      if (from) saleWhere.date.gte = new Date(from);
      if (to) saleWhere.date.lte = new Date(to + 'T23:59:59.999Z');
    }

    const paymentWhere = { companyId };
    if (isCycle) paymentWhere.createdAt = { gte: periodFrom, lt: periodTo };

    const [sales, consultants, payments] = await Promise.all([
      prisma.sale.findMany({ where: saleWhere, include: { consultant: true, items: true } }),
      prisma.consultant.findMany({ where: { companyId } }),
      prisma.commissionPayment.findMany({ where: paymentWhere }),
    ]);

    const summary = consultants.map(c => {
      // Effective slice (proration anchor on startDate)
      let eff = { factor: 1, prorated: false, effectiveFrom: periodFrom, effectiveTo: periodTo };
      let activeInPeriod = true;
      if (isCycle) {
        const sliced = getEffectivePeriod(periodFrom, periodTo, c.startDate);
        if (!sliced) activeInPeriod = false;
        else eff = sliced;
      }

      // Filter sales to effective slice (only matters when prorated and cycle mode)
      const cSales = sales.filter(s => {
        if (s.consultantId !== c.id) return false;
        if (eff.prorated) return new Date(s.date) >= eff.effectiveFrom;
        return true;
      });

      const totalSales = cSales.length;
      const totalProductsSold = cSales.reduce((sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0), 0);
      const totalRevenue = cSales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
      const commissionEarned = calcCommission(totalProductsSold, c.commissionRate, c.tierThreshold, c.tierRate);

      const cPayments = payments.filter(p => p.consultantId === c.id);
      const commissionPaid = cPayments.filter(p => p.type === 'commission').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const allowancePaid = cPayments.filter(p => p.type === 'allowance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const balance = commissionEarned - commissionPaid;

      const baseAllowance = parseFloat(c.monthlyAllowance) || 0;
      const allowanceCap = isCycle ? Math.round(baseAllowance * eff.factor * 100) / 100 : null;
      const allowanceRemaining = allowanceCap !== null ? Math.max(0, allowanceCap - allowancePaid) : null;

      return {
        consultant: { id: c.id, name: c.name, phone: c.phone, commissionRate: c.commissionRate, monthlyAllowance: c.monthlyAllowance, isActive: c.isActive, startDate: c.startDate },
        activeInPeriod,
        prorated: eff.prorated,
        effectiveFrom: eff.effectiveFrom,
        effectiveTo: eff.effectiveTo,
        totalSales, totalProductsSold, totalRevenue,
        commissionEarned, commissionPaid, balance,
        allowancePaid, allowanceCap, allowanceRemaining,
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

    res.json({
      summary, totals,
      period: isCycle ? { from: periodFrom, to: periodTo, label: periodLabel, payDate, payDay } : null,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- GET SINGLE CONSULTANT (admin, or consultant self) ----
// ?period=YYYY-MM scopes sales/payments to that pay cycle. Otherwise lifetime totals.
router.get('/:id', async (req, res) => {
  try {
    if (req.user.role === 'consultant' && req.params.id !== req.user.consultantId) return res.status(403).json({ error: 'Forbidden' });
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { period } = req.query;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    const payDay = await getCompanyPayDay(prisma, companyId);
    let periodInfo = null;
    let salesWhere = { consultantId: consultant.id, companyId, status: { not: 'Cancelled' } };
    let paymentsWhere = { consultantId: consultant.id, companyId };

    if (period) {
      const cycle = payPeriodFromLabel(period, payDay);
      const eff = getEffectivePeriod(cycle.periodFrom, cycle.periodTo, consultant.startDate);
      periodInfo = {
        from: cycle.periodFrom, to: cycle.periodTo, label: cycle.label, payDate: cycle.payDate, payDay,
        prorated: eff?.prorated || false,
        effectiveFrom: eff?.effectiveFrom || null,
        effectiveTo: eff?.effectiveTo || null,
        factor: eff?.factor ?? 0,
        activeInPeriod: !!eff,
      };
      const fromDate = eff?.effectiveFrom || cycle.periodFrom;
      salesWhere.date = { gte: fromDate, lt: cycle.periodTo };
      paymentsWhere.createdAt = { gte: cycle.periodFrom, lt: cycle.periodTo };
    }

    const [sales, payments] = await Promise.all([
      prisma.sale.findMany({ where: salesWhere, include: { items: true }, orderBy: { date: 'desc' } }),
      prisma.commissionPayment.findMany({ where: paymentsWhere, orderBy: { createdAt: 'desc' } }),
    ]);

    const totalSales = sales.length;
    const totalProductsSold = sales.reduce((sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0), 0);
    const totalRevenue = sales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
    const commissionEarned = calcCommission(totalProductsSold, consultant.commissionRate, consultant.tierThreshold, consultant.tierRate);
    const commissionPaid = payments.filter(p => p.type === 'commission').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const allowancePaid = payments.filter(p => p.type === 'allowance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = commissionEarned - commissionPaid;

    const baseAllowance = parseFloat(consultant.monthlyAllowance) || 0;
    const allowanceCap = periodInfo ? Math.round(baseAllowance * (periodInfo.factor || 0) * 100) / 100 : null;
    const allowanceRemaining = allowanceCap !== null ? Math.max(0, allowanceCap - allowancePaid) : null;

    res.json({
      ...consultant,
      totalSales, totalProductsSold, totalRevenue,
      commissionEarned, commissionPaid, balance,
      allowancePaid, allowanceCap, allowanceRemaining,
      period: periodInfo,
      sales, payments,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CREATE CONSULTANT ----
router.post('/', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { name, phone, whatsapp, commissionRate, tierThreshold, tierRate, monthlyAllowance, startDate, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const consultant = await prisma.consultant.create({
      data: {
        name, phone: phone || null, whatsapp: whatsapp || null,
        commissionRate: parseFloat(commissionRate) || 50,
        tierThreshold: parseInt(tierThreshold) || 50,
        tierRate: parseFloat(tierRate) || 30,
        monthlyAllowance: parseFloat(monthlyAllowance) || 400,
        startDate: startDate ? new Date(startDate) : null,
        notes: notes || null, companyId
      }
    });
    res.status(201).json(consultant);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- UPDATE CONSULTANT ----
router.put('/:id', requireAdmin, async (req, res) => {
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
      ...(raw.tierThreshold !== undefined && { tierThreshold: parseInt(raw.tierThreshold) }),
      ...(raw.tierRate !== undefined && { tierRate: parseFloat(raw.tierRate) }),
      ...(raw.monthlyAllowance !== undefined && { monthlyAllowance: parseFloat(raw.monthlyAllowance) }),
      ...(raw.isActive !== undefined && { isActive: raw.isActive }),
      ...(raw.startDate !== undefined && { startDate: raw.startDate ? new Date(raw.startDate) : null }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
    };

    const consultant = await prisma.consultant.update({ where: { id: req.params.id }, data });
    res.json(consultant);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- DELETE CONSULTANT ----
router.delete('/:id', requireAdmin, async (req, res) => {
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
// Auto-fills periodFrom/periodTo to the current open cycle if not provided.
// For type='allowance', enforces a per-cycle cap of (monthlyAllowance × proration factor).
router.post('/:id/payments', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    const payDay = await getCompanyPayDay(prisma, companyId);
    let { amount, type, periodFrom, periodTo, paymentMethod, reference, notes } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // Auto-fill cycle bounds if missing
    if (!periodFrom && !periodTo) {
      const cycle = getConsultantPayPeriod(new Date(), payDay);
      periodFrom = cycle.periodFrom;
      periodTo = cycle.periodTo;
    } else {
      periodFrom = periodFrom ? new Date(periodFrom) : null;
      periodTo = periodTo ? new Date(periodTo) : null;
    }

    // Enforce allowance cap (prorated by startDate)
    if ((type || 'commission') === 'allowance' && periodFrom && periodTo) {
      const eff = getEffectivePeriod(periodFrom, periodTo, consultant.startDate);
      if (!eff) return res.status(400).json({ error: 'Consultant was not active during this pay cycle' });
      const baseAllowance = parseFloat(consultant.monthlyAllowance) || 0;
      const cap = Math.round(baseAllowance * eff.factor * 100) / 100;
      const existing = await prisma.commissionPayment.aggregate({
        where: { consultantId: consultant.id, companyId, type: 'allowance', createdAt: { gte: periodFrom, lt: periodTo } },
        _sum: { amount: true },
      });
      const paidSoFar = parseFloat(existing._sum.amount || 0);
      if (paidSoFar + parseFloat(amount) > cap + 0.01) {
        return res.status(400).json({
          error: `Allowance cap reached. Cap: K${cap.toFixed(2)}${eff.prorated ? ' (prorated)' : ''}. Already paid: K${paidSoFar.toFixed(2)}. Remaining: K${Math.max(0, cap - paidSoFar).toFixed(2)}.`
        });
      }
    }

    const payment = await prisma.commissionPayment.create({
      data: {
        consultantId: consultant.id,
        amount: parseFloat(amount),
        type: type || 'commission',
        periodFrom, periodTo,
        paymentMethod: paymentMethod || null,
        reference: reference || null,
        notes: notes || null,
        companyId
      }
    });
    res.status(201).json(payment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- GET PAYMENT HISTORY (admin, or consultant self) ----
router.get('/:id/payments', async (req, res) => {
  if (req.user.role === 'consultant' && req.params.id !== req.user.consultantId) return res.status(403).json({ error: 'Forbidden' });
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

// ---- CONSULTANT STOCK (admin, or consultant self) ----
router.get('/:id/stock', async (req, res) => {
  try {
    if (req.user.role === 'consultant' && req.params.id !== req.user.consultantId) return res.status(403).json({ error: 'Forbidden' });
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const stock = await prisma.consultantStock.findMany({
      where: { consultantId: req.params.id, companyId, qty: { gt: 0 } },
      include: { product: { select: { id: true, name: true, sku: true, sellingPrice: true, imageUrl: true } } }
    });
    res.json(stock);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Transfer stock to consultant (admin only)
router.post('/:id/stock/transfer', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    const { productId, qty, notes } = req.body;
    if (!productId || !qty || parseInt(qty) <= 0) return res.status(400).json({ error: 'Product and quantity required' });
    const quantity = parseInt(qty);

    const product = await prisma.product.findFirst({ where: { id: productId, companyId } });
    if (!product) return res.status(400).json({ error: 'Product not found' });
    if (product.stock < quantity) return res.status(400).json({ error: `Only ${product.stock} in main stock` });

    // Deduct from main stock
    await prisma.product.update({ where: { id: productId }, data: { stock: { decrement: quantity } } });
    await prisma.stockLog.create({ data: { productId, change: -quantity, reason: `Transfer to ${consultant.name}`, companyId } });

    // Add to consultant stock
    await prisma.consultantStock.upsert({
      where: { consultantId_productId: { consultantId: consultant.id, productId } },
      update: { qty: { increment: quantity } },
      create: { consultantId: consultant.id, productId, qty: quantity, companyId }
    });

    // Log the transfer
    await prisma.stockTransfer.create({
      data: { consultantId: consultant.id, productId, qty: quantity, direction: 'to_consultant', notes: notes || null, companyId }
    });

    res.status(201).json({ message: `${quantity} x ${product.name} transferred to ${consultant.name}` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Return stock from consultant (admin only)
router.post('/:id/stock/return', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    const { productId, qty, notes } = req.body;
    if (!productId || !qty || parseInt(qty) <= 0) return res.status(400).json({ error: 'Product and quantity required' });
    const quantity = parseInt(qty);

    const cStock = await prisma.consultantStock.findUnique({ where: { consultantId_productId: { consultantId: consultant.id, productId } } });
    if (!cStock || cStock.qty < quantity) return res.status(400).json({ error: `Consultant only has ${cStock?.qty || 0} units` });

    // Return to main stock
    await prisma.product.update({ where: { id: productId }, data: { stock: { increment: quantity } } });
    await prisma.stockLog.create({ data: { productId, change: quantity, reason: `Return from ${consultant.name}`, companyId } });

    // Deduct from consultant stock
    await prisma.consultantStock.update({
      where: { consultantId_productId: { consultantId: consultant.id, productId } },
      data: { qty: { decrement: quantity } }
    });

    await prisma.stockTransfer.create({
      data: { consultantId: consultant.id, productId, qty: quantity, direction: 'from_consultant', notes: notes || null, companyId }
    });

    res.status(201).json({ message: `${quantity} units returned from ${consultant.name}` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Transfer history (admin, or consultant self)
router.get('/:id/stock/transfers', async (req, res) => {
  try {
    if (req.user.role === 'consultant' && req.params.id !== req.user.consultantId) return res.status(403).json({ error: 'Forbidden' });
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const transfers = await prisma.stockTransfer.findMany({
      where: { consultantId: req.params.id, companyId },
      include: { product: { select: { name: true, sku: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(transfers);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CREATE LOGIN FOR CONSULTANT (admin only) ----
router.post('/:id/login', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    if (consultant.userId) return res.status(400).json({ error: 'Consultant already has a login' });

    const { username, password } = req.body;
    if (!username || typeof username !== 'string' || username.length < 3 || username.length > 50) return res.status(400).json({ error: 'Username must be 3-50 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    if (!password || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(400).json({ error: 'Username already taken' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { username, password: hashed, name: consultant.name, role: 'consultant', companyId } });
    await prisma.consultant.update({ where: { id: consultant.id }, data: { userId: user.id } });
    res.status(201).json({ username, consultantId: consultant.id, userId: user.id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Reset consultant password (admin only)
router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant || !consultant.userId) return res.status(404).json({ error: 'Consultant login not found' });
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hashed = await bcrypt.hash(password, 10);
    await prisma.user.update({ where: { id: consultant.userId }, data: { password: hashed } });
    res.json({ message: 'Password reset' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Revoke consultant login (admin only)
router.delete('/:id/login', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant || !consultant.userId) return res.status(404).json({ error: 'No login to revoke' });
    const userId = consultant.userId;
    await prisma.consultant.update({ where: { id: consultant.id }, data: { userId: null } });
    await prisma.user.delete({ where: { id: userId } });
    res.json({ message: 'Login revoked' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
