const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Delivery runs and the riders who make them.
// A rider only ever sees their own runs — every query in here is scoped by riderId for the
// rider role, the same way consultants are scoped to their own sales.
// (mirrored in api/index.js)

const STATUSES = ['Assigned', 'PickedUp', 'Delivered', 'Failed'];

// The company runs one hired bike and one rider, so "what does a delivery cost us" is simply
// the weekly hire plus the monthly wage spread over the deliveries actually made. Kept as
// settings so the figures can move without a deploy.
async function getDeliveryCostBasis(prisma, companyId) {
  const rows = await prisma.setting.findMany({
    where: { companyId, key: { in: ['delivery_bike_weekly', 'delivery_rider_monthly', 'delivery_fee_charged'] } },
  });
  const get = (k, d) => {
    const v = rows.find(r => r.key === k)?.value;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  };
  const bikeWeekly = get('delivery_bike_weekly', 1200);
  const riderMonthly = get('delivery_rider_monthly', 3000);
  const feeCharged = get('delivery_fee_charged', 50);
  // 52 weeks over 12 months, not 4 weeks — the difference is a month's hire a year.
  const monthlyFixed = (bikeWeekly * 52) / 12 + riderMonthly;
  return { bikeWeekly, riderMonthly, feeCharged, monthlyFixed, breakEvenPerMonth: feeCharged > 0 ? monthlyFixed / feeCharged : null };
}

const deliveryInclude = {
  rider: { select: { id: true, name: true, phone: true } },
  sale: {
    select: {
      id: true, orderNumber: true, date: true, customerName: true, customerPhone: true,
      customerCity: true, deliveryAddress: true, totalPrice: true, amountPaid: true,
      paymentStatus: true, paymentType: true, status: true,
      items: { select: { qty: true, product: { select: { name: true } } } },
    },
  },
  remitPayment: { select: { id: true, amount: true } },
};

function shapeDelivery(d) {
  const balance = d.sale ? parseFloat(d.sale.totalPrice) - parseFloat(d.sale.amountPaid) : 0;
  return {
    id: d.id, status: d.status, attempts: d.attempts,
    assignedAt: d.assignedAt, pickedUpAt: d.pickedUpAt, deliveredAt: d.deliveredAt, failedAt: d.failedAt,
    failureReason: d.failureReason, recipientName: d.recipientName, notes: d.notes,
    cashCollected: d.cashCollected, cashRemitted: d.cashRemitted, cashRemittedAt: d.cashRemittedAt,
    rider: d.rider,
    saleId: d.saleId,
    orderNumber: d.sale?.orderNumber, orderDate: d.sale?.date,
    customerName: d.sale?.customerName, customerPhone: d.sale?.customerPhone,
    customerCity: d.sale?.customerCity, deliveryAddress: d.sale?.deliveryAddress,
    orderTotal: d.sale?.totalPrice, paymentStatus: d.sale?.paymentStatus, paymentType: d.sale?.paymentType,
    orderStatus: d.sale?.status,
    // What the rider should be collecting at the door — nothing if the order is already paid.
    amountToCollect: d.sale?.paymentStatus === 'Paid' ? 0 : Math.max(0, balance),
    // Whether the collected cash has actually reached the order's ledger.
    cashPosted: d.remitPayment ? parseFloat(d.remitPayment.amount) : 0,
    items: (d.sale?.items || []).map(i => ({ name: i.product?.name || 'Product', qty: i.qty })),
  };
}

// ---- CASH AND THE LEDGER ----
// The rider records what he took at the door, and nothing reaches the books until the office
// confirms the money arrived. That confirmation posts a CreditPayment against the order, so
// cash still sitting in a rider's pocket keeps reading as owed — which is the whole point of
// splitting the two steps. (mirrored in api/index.js)
async function postRemittance(tx, delivery, companyId, riderName) {
  const collected = parseFloat(delivery.cashCollected);
  if (!(collected > 0)) return null;
  const sale = await tx.sale.findUnique({ where: { id: delivery.saleId }, select: { id: true, totalPrice: true, amountPaid: true } });
  if (!sale) return null;

  const balance = parseFloat(sale.totalPrice) - parseFloat(sale.amountPaid);
  // Never push an order past its own total. If the rider brought back more than was owed, post
  // what the order can absorb and keep the figure he actually handed over in the note.
  const amount = Math.min(collected, Math.max(0, balance));
  if (!(amount > 0)) return null;

  const payment = await tx.creditPayment.create({
    data: {
      saleId: sale.id, amount, paymentMethod: 'Cash',
      reference: riderName ? `Delivery — ${riderName}` : 'Delivery',
      notes: amount < collected
        ? `Rider handed over ${collected.toFixed(2)} against a balance of ${balance.toFixed(2)}`
        : 'Cash collected on delivery',
      deliveryId: delivery.id, companyId,
    },
  });
  const newAmountPaid = parseFloat(sale.amountPaid) + amount;
  const paymentStatus = newAmountPaid >= parseFloat(sale.totalPrice) ? 'Paid' : newAmountPaid > 0 ? 'Partial' : 'Unpaid';
  await tx.sale.update({ where: { id: sale.id }, data: { amountPaid: newAmountPaid, paymentStatus } });
  return payment;
}

// Undoing a remittance takes exactly the same money back out, so a mis-tick is correctable.
async function reverseRemittance(tx, deliveryId, companyId) {
  const payment = await tx.creditPayment.findFirst({ where: { deliveryId, companyId } });
  if (!payment) return null;
  const sale = await tx.sale.findUnique({ where: { id: payment.saleId }, select: { id: true, totalPrice: true, amountPaid: true } });
  await tx.creditPayment.delete({ where: { id: payment.id } });
  if (sale) {
    const newAmountPaid = Math.max(0, parseFloat(sale.amountPaid) - parseFloat(payment.amount));
    const paymentStatus = newAmountPaid >= parseFloat(sale.totalPrice) ? 'Paid' : newAmountPaid > 0 ? 'Partial' : 'Unpaid';
    await tx.sale.update({ where: { id: sale.id }, data: { amountPaid: newAmountPaid, paymentStatus } });
  }
  return payment;
}

// An order that has been dropped off is delivered, and one that comes back off the bike is not.
// Only ever moved between statuses whose stock has already been taken out, so this never
// silently moves stock: an order still sitting in Pending is left for someone to confirm.
const SALE_DELIVERABLE_FROM = ['Confirmed', 'Shipped'];

router.use(authenticate);

// ---- RIDERS ----

router.get('/riders', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { companyId: req.user.companyId };
    if (req.query.active === 'true') where.isActive = true;
    const riders = await prisma.rider.findMany({ where, orderBy: { name: 'asc' } });
    const withLogin = riders.map(r => ({ ...r, hasLogin: !!r.userId }));
    res.json(withLogin);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/riders', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, phone, nrc, licenceNo, startDate, notes } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Rider name is required' });
    const rider = await prisma.rider.create({
      data: {
        name: String(name).trim(), phone: phone || null, nrc: nrc || null, licenceNo: licenceNo || null,
        startDate: startDate ? new Date(startDate) : null, notes: notes || null,
        companyId: req.user.companyId,
      },
    });
    res.status(201).json(rider);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/riders/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.rider.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!existing) return res.status(404).json({ error: 'Rider not found' });
    const raw = req.body;
    const data = {
      ...(raw.name !== undefined && { name: String(raw.name).trim() }),
      ...(raw.phone !== undefined && { phone: raw.phone || null }),
      ...(raw.nrc !== undefined && { nrc: raw.nrc || null }),
      ...(raw.licenceNo !== undefined && { licenceNo: raw.licenceNo || null }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
      ...(raw.isActive !== undefined && { isActive: !!raw.isActive }),
      ...(raw.startDate !== undefined && { startDate: raw.startDate ? new Date(raw.startDate) : null }),
    };
    res.json(await prisma.rider.update({ where: { id: req.params.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Give a rider a login. Same shape as provisioning a consultant login.
router.post('/riders/:id/login', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const rider = await prisma.rider.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    if (rider.userId) return res.status(400).json({ error: 'Rider already has a login' });
    const { username, password } = req.body;
    if (!username || typeof username !== 'string' || username.length < 3 || username.length > 50) return res.status(400).json({ error: 'Username must be 3-50 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    if (!password || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await prisma.user.findUnique({ where: { username } })) return res.status(400).json({ error: 'Username already taken' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { username, password: hashed, name: rider.name, role: 'rider', companyId: req.user.companyId } });
    await prisma.rider.update({ where: { id: rider.id }, data: { userId: user.id } });
    res.status(201).json({ username, riderId: rider.id, userId: user.id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- THE RIDER'S OWN VIEW ----

// Everything the rider needs on their phone: what is still out, and how today went.
router.get('/my/runs', async (req, res) => {
  try {
    if (req.user.role !== 'rider') return res.status(403).json({ error: 'Rider access required' });
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [open, todayDone, rider] = await Promise.all([
      prisma.delivery.findMany({
        where: { companyId, riderId: req.user.riderId, status: { in: ['Assigned', 'PickedUp'] } },
        include: deliveryInclude, orderBy: { assignedAt: 'asc' },
      }),
      prisma.delivery.findMany({
        where: { companyId, riderId: req.user.riderId, status: { in: ['Delivered', 'Failed'] }, updatedAt: { gte: dayStart } },
        include: deliveryInclude, orderBy: { updatedAt: 'desc' },
      }),
      prisma.rider.findUnique({ where: { id: req.user.riderId }, select: { id: true, name: true } }),
    ]);

    const delivered = todayDone.filter(d => d.status === 'Delivered');
    const cashToday = delivered.reduce((s, d) => s + parseFloat(d.cashCollected), 0);
    const cashUnremitted = delivered.filter(d => !d.cashRemitted).reduce((s, d) => s + parseFloat(d.cashCollected), 0);

    res.json({
      rider,
      open: open.map(shapeDelivery),
      completedToday: todayDone.map(shapeDelivery),
      today: {
        assigned: open.length + todayDone.length,
        delivered: delivered.length,
        failed: todayDone.filter(d => d.status === 'Failed').length,
        outstanding: open.length,
        cashCollected: cashToday,
        cashToRemit: cashUnremitted,
      },
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- ADMIN LIST / ASSIGNMENT ----

// Orders that need a rider: in a deliverable state, no delivery record yet.
router.get('/unassigned', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = {
      companyId: req.user.companyId,
      status: { notIn: ['Cancelled', 'Delivered'] },
      delivery: { is: null },
    };
    if (req.query.city) where.customerCity = { contains: req.query.city, mode: 'insensitive' };
    const sales = await prisma.sale.findMany({
      where,
      select: {
        id: true, orderNumber: true, date: true, customerName: true, customerPhone: true,
        customerCity: true, deliveryAddress: true, totalPrice: true, amountPaid: true, paymentStatus: true, status: true,
        items: { select: { qty: true, product: { select: { name: true } } } },
      },
      orderBy: { date: 'desc' },
      take: 200,
    });
    res.json(sales.map(s => ({
      ...s,
      amountToCollect: s.paymentStatus === 'Paid' ? 0 : Math.max(0, parseFloat(s.totalPrice) - parseFloat(s.amountPaid)),
      items: s.items.map(i => ({ name: i.product?.name || 'Product', qty: i.qty })),
    })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { companyId: req.user.companyId };
    if (req.user.role === 'rider') where.riderId = req.user.riderId;
    else if (req.query.riderId) where.riderId = req.query.riderId;
    if (req.query.status) where.status = req.query.status;
    if (req.query.open === 'true') where.status = { in: ['Assigned', 'PickedUp'] };
    if (req.query.unremitted === 'true') { where.status = 'Delivered'; where.cashRemitted = false; where.cashCollected = { gt: 0 }; }
    // The other half of the cash screen: what has been confirmed, so a mis-tick can be undone.
    if (req.query.remitted === 'true') { where.status = 'Delivered'; where.cashRemitted = true; where.cashCollected = { gt: 0 }; }
    if (req.query.from || req.query.to) {
      where.assignedAt = {};
      if (req.query.from) where.assignedAt.gte = new Date(req.query.from + 'T00:00:00.000Z');
      if (req.query.to) where.assignedAt.lte = new Date(req.query.to + 'T23:59:59.999Z');
    }
    const deliveries = await prisma.delivery.findMany({ where, include: deliveryInclude, orderBy: { assignedAt: 'desc' }, take: 300 });
    res.json(deliveries.map(shapeDelivery));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Assign one or more orders to a rider in a single call — the screen assigns a day's run at once.
router.post('/', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { riderId, saleIds, notes } = req.body;
    const ids = Array.isArray(saleIds) ? saleIds : (req.body.saleId ? [req.body.saleId] : []);
    if (!ids.length) return res.status(400).json({ error: 'Select at least one order' });
    if (riderId) {
      const rider = await prisma.rider.findFirst({ where: { id: riderId, companyId } });
      if (!rider) return res.status(404).json({ error: 'Rider not found' });
      if (!rider.isActive) return res.status(400).json({ error: 'That rider is inactive' });
    }
    const sales = await prisma.sale.findMany({ where: { id: { in: ids }, companyId }, select: { id: true } });
    if (sales.length !== ids.length) return res.status(400).json({ error: 'One or more orders were not found' });
    const already = await prisma.delivery.findMany({ where: { saleId: { in: ids } }, select: { saleId: true } });
    if (already.length) return res.status(400).json({ error: `${already.length} of those orders already have a delivery` });

    await prisma.delivery.createMany({
      data: ids.map(saleId => ({ saleId, riderId: riderId || null, notes: notes || null, companyId })),
    });
    const created = await prisma.delivery.findMany({ where: { saleId: { in: ids } }, include: deliveryInclude });
    res.status(201).json(created.map(shapeDelivery));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Move a delivery along. The rider drives this from their phone; an admin can correct it.
router.put('/:id/status', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status, recipientName, cashCollected, failureReason, notes } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of ${STATUSES.join(', ')}` });

    const where = { id: req.params.id, companyId };
    if (req.user.role === 'rider') where.riderId = req.user.riderId;
    const delivery = await prisma.delivery.findFirst({ where, include: { sale: { select: { id: true, status: true, totalPrice: true, amountPaid: true, paymentStatus: true } } } });
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    if (delivery.status === 'Delivered' && req.user.role === 'rider') {
      return res.status(400).json({ error: 'This delivery is already completed — ask an admin to correct it' });
    }
    if (status === 'Failed' && !String(failureReason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when a delivery fails' });
    }

    const data = { status, ...(notes !== undefined && { notes: notes || null }) };
    const now = new Date();
    if (status === 'PickedUp' && !delivery.pickedUpAt) data.pickedUpAt = now;
    if (status === 'Delivered') {
      data.deliveredAt = now;
      data.failedAt = null;
      data.failureReason = null;
      if (recipientName !== undefined) data.recipientName = recipientName || null;
      if (cashCollected !== undefined) {
        const amount = parseFloat(cashCollected);
        if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Cash collected must be zero or more' });
        data.cashCollected = amount;
      }
    }
    if (status === 'Failed') {
      data.failedAt = now;
      data.failureReason = String(failureReason).trim();
      data.deliveredAt = null;
    }
    // Re-sending a rider after a failure is a second attempt, not a new delivery.
    if (delivery.status === 'Failed' && status === 'Assigned') data.attempts = delivery.attempts + 1;

    const leavingDelivered = delivery.status === 'Delivered' && status !== 'Delivered';
    // Correcting a completed run back off Delivered takes its cash back out of the books too,
    // otherwise the order keeps a payment for a delivery that never happened.
    if (leavingDelivered) {
      data.cashRemitted = false;
      data.cashRemittedAt = null;
      data.deliveredAt = null;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (status === 'Delivered' && SALE_DELIVERABLE_FROM.includes(delivery.sale?.status)) {
        await tx.sale.update({ where: { id: delivery.saleId }, data: { status: 'Delivered' } });
        await tx.orderStatusLog.create({ data: { saleId: delivery.saleId, fromStatus: delivery.sale.status, toStatus: 'Delivered', companyId } });
      }
      if (leavingDelivered) {
        if (delivery.cashRemitted) await reverseRemittance(tx, delivery.id, companyId);
        if (delivery.sale?.status === 'Delivered') {
          await tx.sale.update({ where: { id: delivery.saleId }, data: { status: 'Shipped' } });
          await tx.orderStatusLog.create({ data: { saleId: delivery.saleId, fromStatus: 'Delivered', toStatus: 'Shipped', companyId } });
        }
      }
      return tx.delivery.update({ where: { id: delivery.id }, data, include: deliveryInclude });
    }, { timeout: 20000 });
    res.json(shapeDelivery(updated));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Reassign to a different rider, or park it back in the unassigned pile.
router.put('/:id/rider', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, companyId } });
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    const { riderId } = req.body;
    if (riderId) {
      const rider = await prisma.rider.findFirst({ where: { id: riderId, companyId } });
      if (!rider) return res.status(404).json({ error: 'Rider not found' });
    }
    const updated = await prisma.delivery.update({ where: { id: delivery.id }, data: { riderId: riderId || null }, include: deliveryInclude });
    res.json(shapeDelivery(updated));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Admin confirms the money reached the company. Deliberately admin-only: the rider records
// what they took, the company records what it received, and the gap is the thing worth seeing.
// Confirming is also the moment the cash becomes a payment against the order.
router.put('/:id/remit', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, companyId }, include: { rider: { select: { name: true } } } });
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    const remitted = req.body.cashRemitted !== false;
    if (remitted && delivery.status !== 'Delivered') {
      return res.status(400).json({ error: 'Only a completed delivery can have its cash confirmed' });
    }
    if (remitted === delivery.cashRemitted) {
      const unchanged = await prisma.delivery.findUnique({ where: { id: delivery.id }, include: deliveryInclude });
      return res.json(shapeDelivery(unchanged));
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (remitted) await postRemittance(tx, delivery, companyId, delivery.rider?.name);
      else await reverseRemittance(tx, delivery.id, companyId);
      return tx.delivery.update({
        where: { id: delivery.id },
        data: { cashRemitted: remitted, cashRemittedAt: remitted ? new Date() : null },
        include: deliveryInclude,
      });
    }, { timeout: 20000 });
    res.json(shapeDelivery(updated));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, companyId } });
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    await prisma.$transaction(async (tx) => {
      // Reverse before deleting: the payment's link would otherwise be nulled and leave a
      // delivery payment on an order with no delivery behind it.
      await reverseRemittance(tx, delivery.id, companyId);
      await tx.delivery.delete({ where: { id: delivery.id } });
    }, { timeout: 20000 });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PERFORMANCE ----

// Per-rider performance over a window, plus the one number that says whether running a bike
// beats paying couriers: deliveries per working day against the break-even.
router.get('/performance', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const to = req.query.to ? new Date(req.query.to + 'T23:59:59.999Z') : new Date();
    const from = req.query.from
      ? new Date(req.query.from + 'T00:00:00.000Z')
      : new Date(to.getFullYear(), to.getMonth(), to.getDate() - 29);

    const [deliveries, riders, basis] = await Promise.all([
      prisma.delivery.findMany({
        where: { companyId, assignedAt: { gte: from, lte: to } },
        select: {
          id: true, riderId: true, status: true, assignedAt: true, pickedUpAt: true, deliveredAt: true,
          attempts: true, cashCollected: true, cashRemitted: true, failureReason: true,
        },
      }),
      prisma.rider.findMany({ where: { companyId }, select: { id: true, name: true, isActive: true } }),
      getDeliveryCostBasis(prisma, companyId),
    ]);

    const activeDays = new Set(deliveries.map(d => d.assignedAt.toISOString().slice(0, 10))).size;
    const summarise = (rows) => {
      const delivered = rows.filter(d => d.status === 'Delivered');
      const failed = rows.filter(d => d.status === 'Failed');
      const times = delivered
        .filter(d => d.deliveredAt && d.assignedAt)
        .map(d => (new Date(d.deliveredAt) - new Date(d.assignedAt)) / 60000);
      const cash = delivered.reduce((s, d) => s + parseFloat(d.cashCollected), 0);
      const unremitted = delivered.filter(d => !d.cashRemitted).reduce((s, d) => s + parseFloat(d.cashCollected), 0);
      return {
        assigned: rows.length,
        delivered: delivered.length,
        failed: failed.length,
        outstanding: rows.filter(d => d.status === 'Assigned' || d.status === 'PickedUp').length,
        // Judged on runs that actually finished — a delivery still out on the bike is not a failure.
        successRate: (delivered.length + failed.length) ? (delivered.length / (delivered.length + failed.length)) * 100 : null,
        secondAttempts: rows.filter(d => d.attempts > 1).length,
        avgMinutesToDeliver: times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null,
        cashCollected: cash,
        cashOutstanding: unremitted,
      };
    };

    const overall = summarise(deliveries);
    const perDay = activeDays > 0 ? overall.delivered / activeDays : 0;
    // The bike and rider cost a fixed amount per month, so the share falling in this window is
    // prorated by its length — otherwise a one-week report divides a whole month's cost by a
    // week's deliveries and reports a cost four times too high.
    // `to` is already the end of its day and `from` the start of its, so the span rounds to the
    // number of calendar days covered — no +1, which would double-count a single-day window.
    const windowDays = Math.max(1, Math.round((to - from) / 86400000));
    const fixedCostInWindow = (basis.monthlyFixed * windowDays) / 30;
    const costPerDelivery = overall.delivered > 0 ? fixedCostInWindow / overall.delivered : null;

    const byRider = riders
      .map(r => ({ rider: r, ...summarise(deliveries.filter(d => d.riderId === r.id)) }))
      .filter(r => r.assigned > 0 || r.rider.isActive);

    const failureReasons = {};
    for (const d of deliveries.filter(x => x.status === 'Failed' && x.failureReason)) {
      const key = d.failureReason.trim();
      failureReasons[key] = (failureReasons[key] || 0) + 1;
    }

    res.json({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      activeDays,
      windowDays,
      overall,
      perDay,
      fixedCostInWindow,
      costPerDelivery,
      basis,
      // Below break-even the bike costs more than paying per delivery would have.
      breakEvenPerDay: basis.breakEvenPerMonth ? basis.breakEvenPerMonth / 30 : null,
      byRider,
      failureReasons: Object.entries(failureReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
