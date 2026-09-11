const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireAdmin, requireAdminOrInventory } = require('../middleware/auth');
const { getConsultantPayPeriod, payPeriodFromLabel, getEffectivePeriod } = require('../utils/payPeriod');

// Commission is earned only on money actually collected: an unpaid sale contributes nothing,
// and a partially paid sale contributes only the fraction of it that's been paid so far. Since
// commission is always computed live from current Sale state (never persisted per-sale), this
// applies retroactively to every past cycle as soon as amountPaid/paymentStatus reflect reality,
// not just to new sales.
function calcCommission(payType, commissionRate, tierThreshold, tierRate, sales) {
  const rate = parseFloat(commissionRate);
  const tRate = parseFloat(tierRate);
  const threshold = parseFloat(tierThreshold) || 0;

  if (payType === 'revenue_pct') {
    let comm = 0;
    for (const sale of sales) {
      const saleTotal = parseFloat(sale.totalPrice);
      if (saleTotal <= 0) continue;
      const paidAmount = Math.min(parseFloat(sale.amountPaid) || 0, saleTotal);
      if (paidAmount <= 0) continue;
      const r = (threshold > 0 && tRate > 0 && saleTotal > threshold) ? tRate : rate;
      comm += paidAmount * r / 100;
    }
    return Math.round(comm * 100) / 100;
  }

  // per_unit: tiered by cumulative units — first N at base rate, rest at tier rate.
  // Each sale's units are prorated by how much of that sale has actually been paid.
  const th = parseInt(tierThreshold) || 50;
  let effectiveUnits = 0;
  for (const sale of sales) {
    const saleTotal = parseFloat(sale.totalPrice);
    if (saleTotal <= 0) continue;
    const units = sale.items.reduce((q, i) => q + i.qty, 0);
    const paidFraction = Math.min(1, (parseFloat(sale.amountPaid) || 0) / saleTotal);
    effectiveUnits += units * paidFraction;
  }
  const comm = effectiveUnits <= th ? effectiveUnits * rate : (th * rate) + ((effectiveUnits - th) * tRate);
  return Math.round(comm * 100) / 100;
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

// ---- STOCK LOCATIONS (e.g. "My Car") ----
// These are Consultant rows flagged isStockLocation=true — they reuse the mini-stock/transfer
// machinery but earn no commission and are excluded from commission/pay-statement calculations.
// Scoped separately from the main roster so the inventory role never sees the sales-consultant
// list or commission data, only the stock pools it's allowed to dispatch into.
router.get('/stock-locations', requireAdminOrInventory, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const locations = await prisma.consultant.findMany({
      where: { companyId, isStockLocation: true, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(locations);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/stock-locations', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const location = await prisma.consultant.create({
      data: { name, companyId, isStockLocation: true, commissionRate: 0, tierThreshold: 0, tierRate: 0, monthlyAllowance: 0 },
    });
    res.status(201).json({ id: location.id, name: location.name });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- STOCK ALLOCATIONS (admin only) ----
// Where every unit of stock currently sits: warehouse (Product.stock) + every consultant/car
// mini-stock pool. Pulls from the same two tables everything else already deducts from, so
// it's always in sync — no separate ledger to keep consistent.
router.get('/stock-allocations', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;

    const [warehouseProducts, holdings] = await Promise.all([
      prisma.product.findMany({ where: { companyId, stock: { gt: 0 } }, select: { id: true, name: true, sku: true, stock: true }, orderBy: { name: 'asc' } }),
      prisma.consultantStock.findMany({
        where: { companyId, qty: { gt: 0 } },
        include: { consultant: { select: { id: true, name: true, isStockLocation: true, isActive: true } }, product: { select: { id: true, name: true, sku: true } } },
      }),
    ]);

    const warehouseItems = warehouseProducts.map(p => ({ productId: p.id, name: p.name, sku: p.sku, qty: p.stock }));
    const warehouseTotal = warehouseItems.reduce((sum, i) => sum + i.qty, 0);

    const byHolder = new Map();
    for (const h of holdings) {
      if (!h.consultant) continue;
      if (!byHolder.has(h.consultant.id)) {
        byHolder.set(h.consultant.id, {
          id: h.consultant.id,
          name: h.consultant.name,
          type: h.consultant.isStockLocation ? 'car' : 'consultant',
          isActive: h.consultant.isActive,
          items: [],
        });
      }
      byHolder.get(h.consultant.id).items.push({ productId: h.product.id, name: h.product.name, sku: h.product.sku, qty: h.qty });
    }

    const locations = [
      { id: 'warehouse', name: 'Warehouse', type: 'warehouse', totalUnits: warehouseTotal, items: warehouseItems },
      ...Array.from(byHolder.values()).map(h => ({ ...h, totalUnits: h.items.reduce((sum, i) => sum + i.qty, 0) })),
    ];

    const grandTotal = locations.reduce((sum, l) => sum + l.totalUnits, 0);
    res.json({ locations, grandTotal });
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
    if (isCycle) { paymentWhere.periodFrom = { gte: periodFrom }; paymentWhere.periodTo = { lte: periodTo }; }

    const [sales, consultants, payments] = await Promise.all([
      prisma.sale.findMany({ where: saleWhere, include: { consultant: true, items: true } }),
      prisma.consultant.findMany({ where: { companyId, isStockLocation: false } }),
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
      const commissionEarned = calcCommission(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, cSales);

      const cPayments = payments.filter(p => p.consultantId === c.id);
      const commissionPaid = cPayments.filter(p => p.type === 'commission').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const allowancePaid = cPayments.filter(p => p.type === 'allowance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      // Advances are money already given against future commission, so they net out of the balance owed —
      // a consultant advanced more than they've earned will show a negative balance (they owe it back).
      const advancePaid = cPayments.filter(p => p.type === 'advance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const balance = commissionEarned - commissionPaid - advancePaid;

      const baseAllowance = parseFloat(c.monthlyAllowance) || 0;
      const allowanceCap = isCycle ? Math.round(baseAllowance * eff.factor * 100) / 100 : null;
      const allowanceRemaining = allowanceCap !== null ? Math.max(0, allowanceCap - allowancePaid) : null;

      return {
        consultant: { id: c.id, name: c.name, phone: c.phone, payType: c.payType, commissionRate: c.commissionRate, tierThreshold: c.tierThreshold, tierRate: c.tierRate, monthlyAllowance: c.monthlyAllowance, isActive: c.isActive, startDate: c.startDate },
        activeInPeriod,
        prorated: eff.prorated,
        effectiveFrom: eff.effectiveFrom,
        effectiveTo: eff.effectiveTo,
        totalSales, totalProductsSold, totalRevenue,
        commissionEarned, commissionPaid, balance,
        allowancePaid, allowanceCap, allowanceRemaining, advancePaid,
      };
    });

    const totals = {
      totalSales: summary.reduce((s, c) => s + c.totalSales, 0),
      totalRevenue: summary.reduce((s, c) => s + c.totalRevenue, 0),
      totalCommissionEarned: summary.reduce((s, c) => s + c.commissionEarned, 0),
      totalCommissionPaid: summary.reduce((s, c) => s + c.commissionPaid, 0),
      totalAllowancePaid: summary.reduce((s, c) => s + c.allowancePaid, 0),
      totalAdvancePaid: summary.reduce((s, c) => s + c.advancePaid, 0),
      totalBalance: summary.reduce((s, c) => s + c.balance, 0),
    };

    res.json({
      summary, totals,
      period: isCycle ? { from: periodFrom, to: periodTo, label: periodLabel, payDate, payDay } : null,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PAY REVIEW (before /:id, admin only) ----
// Everything worth checking before running a commission payout for a cycle: sales that are
// still unpaid/partially paid (which earn zero/partial commission — see calcCommission) and
// sales that look like double-submit duplicates (same consultant + customer + amount, created
// within a short window of each other). Same period filters as /commission-summary.
router.get('/pay-review', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to, consultantId, period } = req.query;
    const payDay = await getCompanyPayDay(prisma, companyId);

    let periodFrom = null, periodTo = null, periodLabel = null, isCycle = false;
    if (period) {
      ({ periodFrom, periodTo, label: periodLabel } = payPeriodFromLabel(period, payDay));
      isCycle = true;
    } else if (!from && !to) {
      ({ periodFrom, periodTo, label: periodLabel } = getConsultantPayPeriod(new Date(), payDay));
      isCycle = true;
    }

    const where = { companyId, status: { not: 'Cancelled' }, consultantId: { not: null } };
    if (consultantId) where.consultantId = consultantId;
    if (isCycle) {
      where.date = { gte: periodFrom, lt: periodTo };
    } else if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to + 'T23:59:59.999Z');
    }

    const sales = await prisma.sale.findMany({
      where,
      select: {
        id: true, orderNumber: true, date: true, createdAt: true, totalPrice: true, amountPaid: true,
        paymentStatus: true, paymentType: true, customerName: true, customerPhone: true,
        consultantId: true, consultant: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // ---- Unpaid / partially paid sales (earn no / partial commission) ----
    const unpaidSales = sales
      .filter(s => s.paymentStatus === 'Unpaid' || s.paymentStatus === 'Partial')
      .map(s => ({
        id: s.id, orderNumber: s.orderNumber, date: s.date,
        consultantId: s.consultantId, consultantName: s.consultant?.name || null,
        customerName: s.customerName, customerPhone: s.customerPhone,
        paymentType: s.paymentType, paymentStatus: s.paymentStatus,
        totalPrice: s.totalPrice, amountPaid: s.amountPaid,
        balance: Math.round((parseFloat(s.totalPrice) - parseFloat(s.amountPaid)) * 100) / 100,
      }))
      .sort((a, b) => b.balance - a.balance);
    const unpaidTotal = Math.round(unpaidSales.reduce((sum, s) => sum + s.balance, 0) * 100) / 100;

    // ---- Possible duplicates: same consultant + same customer + same amount, created close together ----
    const DUPLICATE_WINDOW_MS = 2 * 60 * 60 * 1000; // covers slow re-submits, not just instant double-clicks
    const groups = new Map();
    for (const s of sales) {
      const key = [s.consultantId, (s.customerPhone || s.customerName || '').trim().toLowerCase(), parseFloat(s.totalPrice).toFixed(2)].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const possibleDuplicates = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      let cluster = [group[0]];
      const flush = () => {
        if (cluster.length > 1) {
          possibleDuplicates.push({
            consultantId: cluster[0].consultantId,
            consultantName: cluster[0].consultant?.name || null,
            customerName: cluster[0].customerName,
            customerPhone: cluster[0].customerPhone,
            totalPrice: cluster[0].totalPrice,
            sales: cluster.map(s => ({ id: s.id, orderNumber: s.orderNumber, date: s.date, createdAt: s.createdAt, amountPaid: s.amountPaid, paymentStatus: s.paymentStatus })),
          });
        }
      };
      for (let i = 1; i < group.length; i++) {
        if (new Date(group[i].createdAt) - new Date(cluster[cluster.length - 1].createdAt) <= DUPLICATE_WINDOW_MS) {
          cluster.push(group[i]);
        } else {
          flush();
          cluster = [group[i]];
        }
      }
      flush();
    }

    res.json({
      period: isCycle ? { from: periodFrom, to: periodTo, label: periodLabel } : null,
      unpaidSales, unpaidCount: unpaidSales.length, unpaidTotal,
      possibleDuplicates,
      duplicateGroupCount: possibleDuplicates.length,
      duplicateSaleCount: possibleDuplicates.reduce((sum, g) => sum + g.sales.length, 0),
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
      paymentsWhere.periodFrom = { gte: cycle.periodFrom }; paymentsWhere.periodTo = { lte: cycle.periodTo };
    }

    const [sales, payments] = await Promise.all([
      prisma.sale.findMany({ where: salesWhere, include: { items: true }, orderBy: { date: 'desc' } }),
      prisma.commissionPayment.findMany({ where: paymentsWhere, orderBy: { createdAt: 'desc' } }),
    ]);

    const totalSales = sales.length;
    const totalProductsSold = sales.reduce((sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0), 0);
    const totalRevenue = sales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
    const commissionEarned = calcCommission(consultant.payType, consultant.commissionRate, consultant.tierThreshold, consultant.tierRate, sales);
    const commissionPaid = payments.filter(p => p.type === 'commission').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const allowancePaid = payments.filter(p => p.type === 'allowance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const advancePaid = payments.filter(p => p.type === 'advance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = commissionEarned - commissionPaid - advancePaid;

    const baseAllowance = parseFloat(consultant.monthlyAllowance) || 0;
    const allowanceCap = periodInfo ? Math.round(baseAllowance * (periodInfo.factor || 0) * 100) / 100 : null;
    const allowanceRemaining = allowanceCap !== null ? Math.max(0, allowanceCap - allowancePaid) : null;

    res.json({
      ...consultant,
      totalSales, totalProductsSold, totalRevenue,
      commissionEarned, commissionPaid, balance,
      allowancePaid, allowanceCap, allowanceRemaining, advancePaid,
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
    const { name, phone, whatsapp, payType, commissionRate, tierThreshold, tierRate, monthlyAllowance, startDate, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const consultant = await prisma.consultant.create({
      data: {
        name, phone: phone || null, whatsapp: whatsapp || null,
        payType: payType || 'per_unit',
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
      ...(raw.payType !== undefined && { payType: raw.payType }),
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
        where: { consultantId: consultant.id, companyId, type: 'allowance', periodFrom: { gte: periodFrom }, periodTo: { lte: periodTo } },
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

// Transfer stock to consultant (admin, or inventory role dispatching to a stock location like "My Car")
router.post('/:id/stock/transfer', requireAdminOrInventory, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    if (req.user.role === 'inventory' && !consultant.isStockLocation) return res.status(403).json({ error: 'Inventory staff can only dispatch to stock locations, not sales consultants' });

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

// Return stock from consultant (admin, or inventory role returning from a stock location)
router.post('/:id/stock/return', requireAdminOrInventory, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    if (req.user.role === 'inventory' && !consultant.isStockLocation) return res.status(403).json({ error: 'Inventory staff can only return stock from stock locations, not sales consultants' });

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
