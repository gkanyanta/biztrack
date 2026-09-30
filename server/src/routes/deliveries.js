const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireAdmin, requireAdminOrInventory } = require('../middleware/auth');

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

router.get('/riders', requireAdminOrInventory, async (req, res) => {
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
router.get('/unassigned', requireAdminOrInventory, async (req, res) => {
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
      // Generous, because the ordering below matters more than the cut-off: an order somebody has
      // physically packed must not fall off the end of the list behind months of older ones.
      take: 500,
    });
    // Shipped means the warehouse has picked and packed it, so it is the one genuinely ready to
    // go on the bike. Those come first; everything else keeps newest-first.
    const ready = (s) => (s.status === 'Shipped' ? 0 : 1);
    const ordered = sales.slice().sort((a, b) => ready(a) - ready(b) || new Date(b.date) - new Date(a.date));
    res.json(ordered.map(s => ({
      ...s,
      isReady: s.status === 'Shipped',
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
router.post('/', requireAdminOrInventory, async (req, res) => {
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
router.put('/:id/rider', requireAdminOrInventory, async (req, res) => {
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

// ---- THE RIDER'S OWN MONEY ----
//
// The rider both collects and spends. He takes cash at doors, and he lays out his own money for
// things like a Platinum courier fee on an out-of-town parcel. Settlement is net: at the end of a
// run he hands over what he collected minus what he laid out, so one balance describes the whole
// relationship —
//
//   holding    = cash collected on deliveries the office has not yet confirmed
//   owedToRider = expenses he has paid that have not yet been accounted for
//   netDue     = holding - owedToRider, which is what should physically change hands
//
// A negative netDue means the company owes him. (mirrored in api/index.js)

const round2 = (n) => Math.round(n * 100) / 100;

const RIDER_EXPENSE_CATEGORIES = ['Platinum courier', 'Other courier', 'Fuel', 'Airtime', 'Bike repair', 'Parking', 'Other'];
const DELIVERY_COST_CATEGORY = 'Delivery Costs';

async function riderAccount(prisma, riderId, companyId) {
  const [held, owed] = await Promise.all([
    prisma.delivery.aggregate({
      where: { riderId, companyId, status: 'Delivered', cashRemitted: false },
      _sum: { cashCollected: true },
    }),
    prisma.riderExpense.aggregate({
      where: { riderId, companyId, settledAt: null },
      _sum: { amount: true },
    }),
  ]);
  const holding = round2(parseFloat(held._sum.cashCollected || 0));
  const owedToRider = round2(parseFloat(owed._sum.amount || 0));
  return { holding, owedToRider, netDue: round2(holding - owedToRider) };
}

// What the records say about one rider's day, to sit beside what he says about it.
async function riderDayActuals(prisma, riderId, companyId, dayStart, dayEnd) {
  const [done, failed] = await Promise.all([
    prisma.delivery.findMany({
      where: { riderId, companyId, status: 'Delivered', deliveredAt: { gte: dayStart, lt: dayEnd } },
      select: { cashCollected: true },
    }),
    prisma.delivery.findMany({
      where: { riderId, companyId, status: 'Failed', failedAt: { gte: dayStart, lt: dayEnd } },
      select: { failureReason: true },
    }),
  ]);
  const expenses = await prisma.riderExpense.findMany({
    where: { riderId, companyId, date: { gte: dayStart, lt: dayEnd } },
    select: { amount: true, category: true },
  });
  const reasons = {};
  for (const f of failed) { const r = f.failureReason || 'Not given'; reasons[r] = (reasons[r] || 0) + 1; }
  return {
    deliveriesCompleted: done.length,
    deliveriesFailed: failed.length,
    cashCollected: round2(done.reduce((s, d) => s + parseFloat(d.cashCollected), 0)),
    expensesPaid: round2(expenses.reduce((s, e) => s + parseFloat(e.amount), 0)),
    failureReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
  };
}

// A calendar day in Lusaka, expressed as the UTC instants that bound it.
function riderDayBounds(dateStr) {
  const base = dateStr ? new Date(dateStr + 'T00:00:00+02:00') : new Date();
  const local = new Date(base.getTime() + 2 * 3600 * 1000);
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - 2 * 3600 * 1000);
  return { start, end: new Date(start.getTime() + 86400000), dateOnly: new Date(Date.UTC(y, m, d)) };
}

function requireRider(req, res) {
  if (req.user.role !== 'rider') { res.status(403).json({ error: 'Rider access required' }); return false; }
  return true;
}

// ---- RIDER-FACING ----

router.get('/my/account', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    res.json(await riderAccount(prisma, req.user.riderId, req.user.companyId));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/my/expenses', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    const expenses = await prisma.riderExpense.findMany({
      where: { riderId: req.user.riderId, companyId: req.user.companyId },
      include: { sale: { select: { orderNumber: true, customerName: true } } },
      orderBy: { date: 'desc' }, take: 100,
    });
    res.json(expenses);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/my/expenses', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { category, description, saleId, rechargeable } = req.body;
    if (!RIDER_EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Category must be one of ${RIDER_EXPENSE_CATEGORIES.join(', ')}` });
    }
    const amount = parseFloat(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });
    if (saleId) {
      const owned = await prisma.sale.findFirst({ where: { id: saleId, companyId }, select: { id: true } });
      if (!owned) return res.status(400).json({ error: 'That order was not found' });
    }
    const expense = await prisma.riderExpense.create({
      data: {
        riderId: req.user.riderId, category, amount, description: description || null,
        saleId: saleId || null, rechargeable: !!rechargeable, companyId,
      },
    });
    res.status(201).json(expense);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// He can take back his own mistake, but only while the office has not yet accounted for it.
router.delete('/my/expenses/:id', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    const expense = await prisma.riderExpense.findFirst({
      where: { id: req.params.id, riderId: req.user.riderId, companyId: req.user.companyId },
    });
    if (!expense) return res.status(404).json({ error: 'Not found' });
    if (expense.settledAt) return res.status(400).json({ error: 'This has already been settled — ask an admin to correct it' });
    await prisma.riderExpense.delete({ where: { id: expense.id } });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Today's figures, pre-filled from the records so he only has to correct what differs.
router.get('/my/report', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    const { start, end, dateOnly } = riderDayBounds(req.query.date);
    const actuals = await riderDayActuals(prisma, req.user.riderId, req.user.companyId, start, end);
    const existing = await prisma.riderDailyReport.findUnique({
      where: { riderId_date: { riderId: req.user.riderId, date: dateOnly } },
    });
    res.json({ date: dateOnly, actuals, report: existing, account: await riderAccount(prisma, req.user.riderId, req.user.companyId) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/my/report', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { dateOnly, start, end } = riderDayBounds(req.body.date);
    const num = (v, fallback = 0) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const actuals = await riderDayActuals(prisma, req.user.riderId, companyId, start, end);
    const data = {
      deliveriesCompleted: parseInt(req.body.deliveriesCompleted, 10) >= 0 ? parseInt(req.body.deliveriesCompleted, 10) : actuals.deliveriesCompleted,
      deliveriesFailed: parseInt(req.body.deliveriesFailed, 10) >= 0 ? parseInt(req.body.deliveriesFailed, 10) : actuals.deliveriesFailed,
      cashCollected: num(req.body.cashCollected, actuals.cashCollected),
      expensesPaid: num(req.body.expensesPaid, actuals.expensesPaid),
      cashHandedOver: num(req.body.cashHandedOver),
      closingFloat: num(req.body.closingFloat),
    };
    // Re-submitting the same day corrects it rather than making a second report.
    const report = await prisma.riderDailyReport.upsert({
      where: { riderId_date: { riderId: req.user.riderId, date: dateOnly } },
      update: { ...data, submittedAt: new Date(), acknowledgedAt: null },
      create: { ...data, riderId: req.user.riderId, date: dateOnly, companyId },
    });
    res.status(201).json(report);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/my/reports', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    const reports = await prisma.riderDailyReport.findMany({
      where: { riderId: req.user.riderId, companyId: req.user.companyId },
      orderBy: { date: 'desc' }, take: 30,
    });
    res.json(reports);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- ADMIN REVIEW ----

router.get('/expenses', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { companyId: req.user.companyId };
    if (req.query.riderId) where.riderId = req.query.riderId;
    if (req.query.unsettled === 'true') where.settledAt = null;
    if (req.query.awaitingRecharge === 'true') { where.rechargeable = true; where.rechargedAt = null; }
    if (req.query.from || req.query.to) {
      where.date = {};
      if (req.query.from) where.date.gte = new Date(req.query.from + 'T00:00:00.000Z');
      if (req.query.to) where.date.lte = new Date(req.query.to + 'T23:59:59.999Z');
    }
    const expenses = await prisma.riderExpense.findMany({
      where,
      include: { rider: { select: { id: true, name: true } }, sale: { select: { id: true, orderNumber: true, customerName: true } } },
      orderBy: { date: 'desc' }, take: 300,
    });
    res.json(expenses);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Settling says what the money was. Either the company carried it, in which case it becomes a
// real expense, or it went on to a customer, in which case it does not — billing it twice is
// exactly what a single explicit choice here prevents. A partial recharge splits the difference.
router.put('/expenses/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const expense = await prisma.riderExpense.findFirst({
      where: { id: req.params.id, companyId },
      include: { rider: { select: { name: true } }, sale: { select: { orderNumber: true } } },
    });
    if (!expense) return res.status(404).json({ error: 'Not found' });

    const raw = req.body;
    if (raw.unsettle === true) {
      const updated = await prisma.$transaction(async (tx) => {
        if (expense.expenseId) await tx.expense.deleteMany({ where: { id: expense.expenseId, companyId } });
        return tx.riderExpense.update({
          where: { id: expense.id },
          data: { settledAt: null, rechargedAt: null, rechargedAmount: null, expenseId: null },
        });
      }, { timeout: 20000 });
      return res.json(updated);
    }

    const data = {
      ...(raw.category !== undefined && RIDER_EXPENSE_CATEGORIES.includes(raw.category) && { category: raw.category }),
      ...(raw.description !== undefined && { description: raw.description || null }),
      ...(raw.rechargeable !== undefined && { rechargeable: !!raw.rechargeable }),
      ...(raw.saleId !== undefined && { saleId: raw.saleId || null }),
    };
    if (raw.amount !== undefined) {
      const v = parseFloat(raw.amount);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });
      data.amount = v;
    }

    if (raw.settle === true) {
      if (expense.settledAt) return res.status(400).json({ error: 'Already settled' });
      const outcome = raw.outcome === 'recharged' ? 'recharged' : 'company_cost';
      const amount = data.amount !== undefined ? data.amount : parseFloat(expense.amount);
      let recharged = 0;
      if (outcome === 'recharged') {
        recharged = raw.rechargedAmount === undefined ? amount : parseFloat(raw.rechargedAmount);
        if (!Number.isFinite(recharged) || recharged < 0) return res.status(400).json({ error: 'Recharged amount must be zero or more' });
        data.rechargedAt = new Date();
        data.rechargedAmount = recharged;
      }
      // Only the part the customer is not paying for is a cost to the business.
      const borne = round2(amount - recharged);
      const updated = await prisma.$transaction(async (tx) => {
        let expenseId = null;
        if (borne > 0) {
          const created = await tx.expense.create({
            data: {
              description: `Delivery cost: ${expense.category}${expense.rider?.name ? ` — ${expense.rider.name}` : ''}` +
                           (expense.sale?.orderNumber ? ` (${expense.sale.orderNumber})` : ''),
              amount: borne, category: DELIVERY_COST_CATEGORY,
              notes: recharged > 0 ? `${amount.toFixed(2)} paid, ${recharged.toFixed(2)} recharged to the customer` : (expense.description || null),
              companyId,
            },
          });
          expenseId = created.id;
        }
        return tx.riderExpense.update({ where: { id: expense.id }, data: { ...data, settledAt: new Date(), expenseId } });
      }, { timeout: 20000 });
      return res.json(updated);
    }

    res.json(await prisma.riderExpense.update({ where: { id: expense.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/reports', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const where = { companyId };
    if (req.query.riderId) where.riderId = req.query.riderId;
    if (req.query.unacknowledged === 'true') where.acknowledgedAt = null;
    const reports = await prisma.riderDailyReport.findMany({
      where, include: { rider: { select: { id: true, name: true } } },
      orderBy: { date: 'desc' }, take: 60,
    });
    // Every report carries the system's own version of the same day beside it.
    const withActuals = [];
    for (const r of reports) {
      const iso = r.date.toISOString().slice(0, 10);
      const { start, end } = riderDayBounds(iso);
      const actuals = await riderDayActuals(prisma, r.riderId, companyId, start, end);
      withActuals.push({
        ...r,
        actuals,
        variance: {
          deliveriesCompleted: r.deliveriesCompleted - actuals.deliveriesCompleted,
          cashCollected: round2(parseFloat(r.cashCollected) - actuals.cashCollected),
          expensesPaid: round2(parseFloat(r.expensesPaid) - actuals.expensesPaid),
          // What he says he handed over against what he says he took, less what he says he spent.
          unaccounted: round2(parseFloat(r.cashCollected) - parseFloat(r.expensesPaid) - parseFloat(r.cashHandedOver) - parseFloat(r.closingFloat)),
        },
      });
    }
    res.json(withActuals);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/reports/:id/acknowledge', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const report = await prisma.riderDailyReport.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!report) return res.status(404).json({ error: 'Not found' });
    const ack = req.body.acknowledged !== false;
    res.json(await prisma.riderDailyReport.update({
      where: { id: report.id }, data: { acknowledgedAt: ack ? new Date() : null },
    }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- DELIVERY FINANCES (the Shipping page dashboard) ----

// Does running our own bike pay? Fixed cost is the rider's wage plus the bike hire, prorated to
// the window asked for; against it sits the delivery fees actually billed on orders that went
// out on the bike, less what the rider laid out that the company ended up carrying.
router.get('/finances', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const to = req.query.to ? new Date(req.query.to + 'T23:59:59.999Z') : new Date();
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00.000Z')
                                : new Date(to.getTime() - 29 * 86400000);
    const days = Math.max(1, Math.round((to - from) / 86400000) + 1);

    const basis = await getDeliveryCostBasis(prisma, companyId);
    // The rider's wage is whatever payroll says it is; the setting is only a fallback for a
    // company that has not put its rider on payroll yet.
    const riders = await prisma.rider.findMany({ where: { companyId }, select: { id: true, name: true, isActive: true } });
    const staff = await prisma.staff.findMany({
      where: { companyId, riderId: { in: riders.map(r => r.id) } },
      select: { riderId: true, monthlySalary: true, monthlyAllowance: true, name: true },
    });
    const payrollMonthly = round2(staff.reduce((s, m) => s + parseFloat(m.monthlySalary) + parseFloat(m.monthlyAllowance), 0));
    const riderMonthly = staff.length ? payrollMonthly : basis.riderMonthly;
    const bikeMonthly = round2((basis.bikeWeekly * 52) / 12);
    const fixedMonthly = round2(riderMonthly + bikeMonthly);
    const fixedInWindow = round2(fixedMonthly * (days / 30.44));

    const delivered = await prisma.delivery.findMany({
      where: { companyId, status: 'Delivered', deliveredAt: { gte: from, lte: to } },
      select: { cashCollected: true, riderId: true, sale: { select: { shippingCharge: true, shippingCost: true } } },
    });
    const feesBilled = round2(delivered.reduce((s, d) => s + parseFloat(d.sale?.shippingCharge || 0), 0));
    const collected = round2(delivered.reduce((s, d) => s + parseFloat(d.cashCollected), 0));

    const expenses = await prisma.riderExpense.findMany({
      where: { companyId, date: { gte: from, lte: to } },
      select: { amount: true, rechargedAmount: true, settledAt: true, rechargeable: true, rechargedAt: true, category: true },
    });
    const laidOut = round2(expenses.reduce((s, e) => s + parseFloat(e.amount), 0));
    const recovered = round2(expenses.reduce((s, e) => s + parseFloat(e.rechargedAmount || 0), 0));
    const borne = round2(laidOut - recovered);
    const byCategory = {};
    for (const e of expenses) byCategory[e.category] = round2((byCategory[e.category] || 0) + parseFloat(e.amount));

    const totalCost = round2(fixedInWindow + borne);
    const count = delivered.length;

    // Where the rider stands right now, which is a balance and not a window figure.
    const accounts = [];
    for (const r of riders) {
      if (!r.isActive) continue;
      accounts.push({ riderId: r.id, name: r.name, ...(await riderAccount(prisma, r.id, companyId)) });
    }
    const awaitingRecharge = await prisma.riderExpense.aggregate({
      where: { companyId, rechargeable: true, rechargedAt: null }, _sum: { amount: true }, _count: true,
    });

    res.json({
      from, to, days,
      deliveries: count,
      perDay: round2(count / days),
      cost: {
        riderMonthly, bikeMonthly, fixedMonthly, fixedInWindow,
        riderPaidFromPayroll: staff.length > 0,
        laidOutByRider: laidOut, recoveredFromCustomers: recovered, borneByCompany: borne,
        total: totalCost,
        perDelivery: count ? round2(totalCost / count) : null,
        byCategory: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount })),
      },
      income: {
        feesBilled,
        perDelivery: count ? round2(feesBilled / count) : null,
        cashCollectedAtDoors: collected,
      },
      net: round2(feesBilled - totalCost),
      // The benchmark that started all this: what a courier charged per drop.
      courierFee: basis.feeCharged,
      breakEvenPerDay: basis.feeCharged > 0 ? round2(fixedMonthly / basis.feeCharged / 30.44) : null,
      breakEvenPerMonth: basis.feeCharged > 0 ? round2(fixedMonthly / basis.feeCharged) : null,
      savingVsCourier: round2((basis.feeCharged * count) - totalCost),
      riderAccounts: accounts,
      outstanding: {
        awaitingRechargeCount: awaitingRecharge._count,
        awaitingRechargeAmount: round2(parseFloat(awaitingRecharge._sum.amount || 0)),
      },
      categories: RIDER_EXPENSE_CATEGORIES,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
module.exports.riderFinanceInternals = { RIDER_EXPENSE_CATEGORIES, DELIVERY_COST_CATEGORY, riderAccount, riderDayActuals, riderDayBounds };
