const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireAdmin, requireAdminOrInventory } = require('../middleware/auth');

// Delivery runs and the riders who make them.
// A rider only ever sees their own runs — every query in here is scoped by riderId for the
// rider role, the same way consultants are scoped to their own sales.
// (mirrored in api/index.js)

const STATUSES = ['Assigned', 'PickedUp', 'AtCourier', 'Delivered', 'Failed'];

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

// ---- WHO CARRIES IT, AND WHERE IT LEFT FROM ----

// Our own rider costs a fixed wage and bike hire whatever he does. Everyone else is hired for
// the trip, and that fare is a per-order cost, so the two can only be compared by keeping them
// apart. (mirrored in api/index.js)
const DELIVERY_COURIERS = ['rider', 'yango', 'other'];
const isHiredCourier = (courier) => courier !== 'rider';

// Where the goods physically left from. If every line on the order comes out of one consultant's
// own stock then that consultant dispatched it and nobody at the warehouse touched it; anything
// drawn from main stock means it left the warehouse.
function dispatchOriginFor(items) {
  const sources = (items || []).map(i => i.stockSourceConsultantId || null);
  if (!sources.length || sources.some(s => s === null)) return null;
  const first = sources[0];
  return sources.every(s => s === first) ? first : null;
}

// Where we deliver ourselves. Anything else has to go by courier, so this one setting decides
// which flow an order takes — and hardcoding it in the screen meant the answer lived in the
// wrong place and only the screen knew it. Comma separated, because a second town we cover by
// bike should not need a code change either. (mirrored in api/index.js)
async function localDeliveryCities(prisma, companyId) {
  const row = await prisma.setting.findFirst({ where: { companyId, key: 'delivery_local_cities' } });
  const raw = (row?.value || '').trim() || 'Lusaka';
  return raw.split(',').map(c => c.trim()).filter(Boolean);
}

// A town we do not cover ourselves. No town recorded counts as out of town: somebody has to look
// at it, and treating a blank as local would quietly put it on the bike.
function isOutOfTown(city, locals) {
  const here = (city || '').trim().toLowerCase();
  if (!here) return true;
  return !locals.some(l => l.toLowerCase() === here);
}

const deliveryInclude = {
  rider: { select: { id: true, name: true, phone: true, vehicle: true } },
  sale: {
    select: {
      id: true, orderNumber: true, date: true, customerName: true, customerPhone: true,
      customerCity: true, deliveryAddress: true, totalPrice: true, amountPaid: true,
      paymentStatus: true, paymentType: true, status: true,
      // What this drop costs us and what the customer is billed for it.
      shippingCost: true, shippingCharge: true,
      items: { select: { qty: true, product: { select: { name: true } } } },
    },
  },
  dispatchedFromConsultant: { select: { id: true, name: true } },
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
    courier: d.courier,
    courierRef: d.courierRef,
    // A hired courier is paid per trip; the fare rides on the order like any delivery cost.
    courierCost: d.sale ? parseFloat(d.sale.shippingCost || 0) : 0,
    feeBilled: d.sale ? parseFloat(d.sale.shippingCharge || 0) : 0,
    dispatchedFrom: d.dispatchedFromConsultant ? d.dispatchedFromConsultant.name : 'Warehouse',
    dispatchedFromConsultant: d.dispatchedFromConsultant || null,
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

// Whether the office has signed off a rider's completed drop, and so whether he may still
// correct it himself.
//
// He closes a drop on his phone with a cash figure and an outcome, and he sometimes gets one
// wrong — the wrong amount, or marked failed when the customer paid at the second knock. Sending
// him to the office for every slip was needless; what the office actually needs is that nothing
// changes under a figure it has already acted on. Two things count as having acted: the cash was
// posted to the order's ledger, or the day's report was checked. After either, a change on his
// phone would quietly disagree with the books, so it has to come from the office.
//
// Returns a reason to refuse, or null to allow. (mirrored in api/index.js)
async function riderSignOffBlock(prisma, delivery, companyId) {
  if (delivery.cashRemitted) {
    return 'The office has already banked this cash, so only they can change it now';
  }
  const key = localDayKey(delivery.deliveredAt || delivery.failedAt || delivery.assignedAt);
  const checked = await prisma.riderDailyReport.findFirst({
    where: {
      riderId: delivery.riderId, companyId,
      date: new Date(key + 'T00:00:00.000Z'),
      acknowledgedAt: { not: null },
    },
    select: { id: true },
  });
  if (checked) {
    return 'The office has already checked your report for that day, so only they can change it now';
  }
  return null;
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
    const { name, phone, nrc, licenceNo, vehicle, startDate, notes } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Rider name is required' });
    const rider = await prisma.rider.create({
      data: {
        name: String(name).trim(), phone: phone || null, nrc: nrc || null, licenceNo: licenceNo || null,
        vehicle: vehicle || null,
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
      ...(raw.vehicle !== undefined && { vehicle: raw.vehicle || null }),
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
    // ?date= lets him look back at a day he has already worked. Without it this showed today
    // and nothing else, so a day that went unbalanced was gone by morning.
    const day = localDayBounds(req.query.date);
    const isToday = day.key === localDayKey(new Date());

    const [open, todayDone, rider] = await Promise.all([
      // Open runs are open whatever day you ask about — they are work still to do, not history.
      isToday ? prisma.delivery.findMany({
        where: { companyId, riderId: req.user.riderId, status: { in: ['Assigned', 'PickedUp'] } },
        include: deliveryInclude, orderBy: { assignedAt: 'asc' },
      }) : [],
      prisma.delivery.findMany({
        where: {
          companyId, riderId: req.user.riderId, status: { in: ['Delivered', 'Failed'] },
          OR: [
            { deliveredAt: { gte: day.start, lte: day.end } },
            { failedAt: { gte: day.start, lte: day.end } },
          ],
        },
        include: deliveryInclude, orderBy: { updatedAt: 'desc' },
      }),
      prisma.rider.findUnique({ where: { id: req.user.riderId }, select: { id: true, name: true } }),
    ]);

    // Once the office has checked the day's report, his finished drops are theirs to correct.
    const checkedReport = await prisma.riderDailyReport.findFirst({
      where: {
        riderId: req.user.riderId, companyId,
        date: new Date(day.key + 'T00:00:00.000Z'),
        acknowledgedAt: { not: null },
      },
      select: { id: true },
    });
    const dayChecked = !!checkedReport;

    const delivered = todayDone.filter(d => d.status === 'Delivered');
    const cashToday = delivered.reduce((s, d) => s + parseFloat(d.cashCollected), 0);
    const cashUnremitted = delivered.filter(d => !d.cashRemitted).reduce((s, d) => s + parseFloat(d.cashCollected), 0);

    res.json({
      rider,
      date: day.key,
      isToday,
      // Whether he can still fix a mistake on this day's finished drops himself.
      dayChecked,
      open: open.map(shapeDelivery),
      completedToday: todayDone.map(shapeDelivery),
      today: {
        assigned: open.length + todayDone.length,
        delivered: delivered.length,
        failed: todayDone.filter(d => d.status === 'Failed').length,
        outstanding: open.length,
        cashCollected: round2(cashToday),
        cashToRemit: round2(cashUnremitted),
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
      // Collections are carried away by the customer, so they are nobody's run.
      fulfilment: 'delivery',
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
    // Which flow each order takes is decided here rather than in whatever screen is asking.
    const locals = await localDeliveryCities(prisma, req.user.companyId);
    res.json(ordered.map(s => ({
      ...s,
      isReady: s.status === 'Shipped',
      isOutOfTown: isOutOfTown(s.customerCity, locals),
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
    const { riderId, saleIds, notes, courierRef } = req.body;
    const courier = DELIVERY_COURIERS.includes(req.body.courier) ? req.body.courier : 'rider';
    const ids = Array.isArray(saleIds) ? saleIds : (req.body.saleId ? [req.body.saleId] : []);
    if (!ids.length) return res.status(400).json({ error: 'Select at least one order' });
    // A hired courier is not one of our riders, so the two cannot both be set.
    if (isHiredCourier(courier) && riderId) {
      return res.status(400).json({ error: 'A hired courier is not one of our riders — leave the rider blank' });
    }
    let fare = null;
    if (isHiredCourier(courier) && req.body.courierCost !== undefined && req.body.courierCost !== '') {
      fare = parseFloat(req.body.courierCost);
      if (!Number.isFinite(fare) || fare < 0) return res.status(400).json({ error: 'The fare must be zero or more' });
    }
    if (riderId) {
      const rider = await prisma.rider.findFirst({ where: { id: riderId, companyId } });
      if (!rider) return res.status(404).json({ error: 'Rider not found' });
      if (!rider.isActive) return res.status(400).json({ error: 'That rider is inactive' });
    }
    const sales = await prisma.sale.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true, items: { select: { stockSourceConsultantId: true } } },
    });
    if (sales.length !== ids.length) return res.status(400).json({ error: 'One or more orders were not found' });
    const already = await prisma.delivery.findMany({ where: { saleId: { in: ids } }, select: { saleId: true } });
    if (already.length) return res.status(400).json({ error: `${already.length} of those orders already have a delivery` });

    const originBySale = {};
    for (const sale of sales) originBySale[sale.id] = dispatchOriginFor(sale.items);

    await prisma.delivery.createMany({
      data: ids.map(saleId => ({
        saleId, riderId: riderId || null, courier, courierRef: courierRef || null,
        dispatchedFromConsultantId: originBySale[saleId] || null,
        assignedById: req.user.id,
        notes: notes || null, companyId,
      })),
    });
    // The fare is what this trip cost us, and a delivery cost belongs on the order it delivered.
    if (fare !== null) {
      await prisma.sale.updateMany({ where: { id: { in: ids }, companyId }, data: { shippingCost: fare } });
    }
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
    // He may correct his own finished work right up until the office has acted on it.
    if (req.user.role === 'rider' && (delivery.status === 'Delivered' || delivery.status === 'Failed')) {
      const blocked = await riderSignOffBlock(prisma, delivery, companyId);
      if (blocked) return res.status(400).json({ error: blocked });
    }
    if (status === 'Failed' && !String(failureReason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when a delivery fails' });
    }

    const data = { status, ...(notes !== undefined && { notes: notes || null }) };
    const now = new Date();
    if (status === 'PickedUp' && !delivery.pickedUpAt) data.pickedUpAt = now;
    if (status === 'Delivered') {
      // Only stamp the time on a drop that was not already delivered. Correcting the cash on a
      // completed one must not move it to today, or it leaves the day it belongs to.
      if (delivery.status !== 'Delivered' || !delivery.deliveredAt) data.deliveredAt = now;
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
      if (delivery.status !== 'Failed' || !delivery.failedAt) data.failedAt = now;
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
        await tx.orderStatusLog.create({ data: { saleId: delivery.saleId, fromStatus: delivery.sale.status, toStatus: 'Delivered', byUserId: req.user.id, companyId } });
      }
      if (leavingDelivered) {
        if (delivery.cashRemitted) await reverseRemittance(tx, delivery.id, companyId);
        if (delivery.sale?.status === 'Delivered') {
          await tx.sale.update({ where: { id: delivery.saleId }, data: { status: 'Shipped' } });
          await tx.orderStatusLog.create({ data: { saleId: delivery.saleId, fromStatus: 'Delivered', toStatus: 'Shipped', byUserId: req.user.id, companyId } });
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
    const { riderId, courierRef } = req.body;
    const courier = req.body.courier === undefined
      ? delivery.courier
      : (DELIVERY_COURIERS.includes(req.body.courier) ? req.body.courier : delivery.courier);
    if (isHiredCourier(courier) && riderId) {
      return res.status(400).json({ error: 'A hired courier is not one of our riders — leave the rider blank' });
    }
    // The fare for a trip booked now, which belongs on the order as its delivery cost. No rider
    // credit: the office books and pays a courier directly, unlike a parcel one of ours carries
    // to a counter out of his own pocket.
    let handoverFare = null;
    if (isHiredCourier(courier) && req.body.courierCost !== undefined && req.body.courierCost !== '') {
      handoverFare = parseFloat(req.body.courierCost);
      if (!Number.isFinite(handoverFare) || handoverFare < 0) {
        return res.status(400).json({ error: 'The fare must be zero or more' });
      }
    }
    if (riderId) {
      const rider = await prisma.rider.findFirst({ where: { id: riderId, companyId } });
      if (!rider) return res.status(404).json({ error: 'Rider not found' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      if (handoverFare !== null) await shiftSaleShippingCost(tx, delivery.saleId, companyId, handoverFare);
      return tx.delivery.update({ where: { id: delivery.id }, data: {
        riderId: isHiredCourier(courier) ? null : (riderId || null),
        courier,
        // Handing a run to somebody else is a dispatch decision of its own.
        assignedById: req.user.id,
        ...(req.body.courierRef !== undefined && { courierRef: courierRef || null }),
      }, include: deliveryInclude });
    }, { timeout: 20000 });
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

// Zambia sits at UTC+2 all year, and the server runs on UTC. Without saying so, a delivery
// made at half past midnight belongs to the wrong day on every screen that shows one.
const ZM_OFFSET_MS = 2 * 60 * 60 * 1000;
// Which Zambian day a moment falls on.
function localDayKey(d) {
  if (!d) return null;
  return new Date(new Date(d).getTime() + ZM_OFFSET_MS).toISOString().slice(0, 10);
}
// Read a day out of either a plain '2026-10-04' or a full timestamp. Null when it is neither.
function dayKeyFrom(input) {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : localDayKey(parsed);
}

// The UTC instants a Zambian day runs between, so a query asks for the day people mean.
function localDayBounds(dateStr) {
  // Same tolerance as riderDayBounds: a plain day or a full timestamp both mean a day. Falling
  // back to today on a timestamp was worse than failing — the caller asked for Tuesday and
  // silently got today's figures back.
  const key = dayKeyFrom(dateStr) || localDayKey(new Date());
  const start = new Date(new Date(key + 'T00:00:00.000Z').getTime() - ZM_OFFSET_MS);
  return { key, start, end: new Date(start.getTime() + 86400000 - 1) };
}

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
// A day can arrive as a plain '2026-10-04' from a date picker or as a full timestamp, because
// that is what these endpoints hand out and a client that echoes one straight back must not be a
// 500. It used to glue 'T00:00:00+02:00' onto whatever it was given, so a timestamp became an
// unparseable string, every arithmetic step after it was NaN, and the Invalid Date only blew up
// deep inside Prisma as "something went wrong" — which is exactly how it reached the rider.
// A date that cannot be read at all says so, rather than quietly standing in for today.
function riderDayBounds(input) {
  let base = null;
  if (input === undefined || input === null || input === '') {
    base = new Date();
  } else {
    const s = String(input).trim();
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00+02:00') : new Date(s);
    if (!Number.isNaN(parsed.getTime())) base = parsed;
  }
  if (!base) return { valid: false };
  const local = new Date(base.getTime() + 2 * 3600 * 1000);
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - 2 * 3600 * 1000);
  return {
    valid: true, start, end: new Date(start.getTime() + 86400000),
    dateOnly: new Date(Date.UTC(y, m, d)),
  };
}

function requireRider(req, res) {
  if (req.user.role !== 'rider') { res.status(403).json({ error: 'Rider access required' }); return false; }
  return true;
}

// A parcel the rider carries to Platinum is two facts at once: the order now has a delivery cost,
// and the company owes him what he paid. Recording it on the order's shippingCost covers the
// first — gross profit already subtracts that — and the expense row covers the second. Settling
// it therefore raises no further expense; doing so would charge the same kwacha twice.
const RIDER_COURIER_CATEGORIES = ['Platinum courier', 'Other courier'];

// Nudge an order's delivery cost by what the rider paid, never below zero.
async function shiftSaleShippingCost(tx, saleId, companyId, delta) {
  const sale = await tx.sale.findFirst({ where: { id: saleId, companyId }, select: { id: true, shippingCost: true } });
  if (!sale) return null;
  const next = Math.max(0, Math.round((parseFloat(sale.shippingCost || 0) + delta) * 100) / 100);
  await tx.sale.update({ where: { id: sale.id }, data: { shippingCost: next } });
  return next;
}

// ---- RIDER-FACING ----

router.get('/my/account', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    const riderId = req.user.riderId, companyId = req.user.companyId;
    const account = await riderAccount(prisma, riderId, companyId);

    // What the holding figure is actually made of. It was one number, and a rider holding cash
    // from three different days could not see which days, so he could not tell what he had
    // already handed over from what he still owed. Not date-limited: cash he is holding is cash
    // he is holding, however long ago he took it.
    const held = await prisma.delivery.findMany({
      where: { riderId, companyId, status: 'Delivered', cashRemitted: false, cashCollected: { gt: 0 } },
      select: {
        id: true, deliveredAt: true, cashCollected: true,
        sale: { select: { orderNumber: true, customerName: true } },
      },
      orderBy: { deliveredAt: 'desc' }, take: 100,
    });

    // The parcels a courier fee could belong to. This used to be today's runs only, so a fee he
    // forgot to log yesterday had no order to attach it to.
    const recent = await prisma.delivery.findMany({
      where: { riderId, companyId, assignedAt: { gte: new Date(Date.now() - 21 * 86400000) } },
      select: {
        id: true, status: true, assignedAt: true,
        sale: { select: { id: true, orderNumber: true, customerName: true, customerCity: true } },
      },
      orderBy: { assignedAt: 'desc' }, take: 150,
    });

    res.json({
      ...account,
      heldDeliveries: held.map(d => ({
        id: d.id, deliveredAt: d.deliveredAt,
        cashCollected: parseFloat(d.cashCollected),
        orderNumber: d.sale?.orderNumber, customerName: d.sale?.customerName,
      })),
      recentDeliveries: recent.map(d => ({
        id: d.id, status: d.status, assignedAt: d.assignedAt, saleId: d.sale?.id,
        orderNumber: d.sale?.orderNumber, customerName: d.sale?.customerName, customerCity: d.sale?.customerCity,
      })),
    });
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
    // A courier drop-off against a known order is a delivery cost on that order, so it goes
    // there rather than waiting for somebody to decide what it was.
    const onSaleShipping = !!saleId && RIDER_COURIER_CATEGORIES.includes(category);
    const expense = await prisma.$transaction(async (tx) => {
      const created = await tx.riderExpense.create({
        data: {
          riderId: req.user.riderId, category, amount, description: description || null,
          saleId: saleId || null, rechargeable: !!rechargeable, onSaleShipping, companyId,
        },
      });
      if (onSaleShipping) await shiftSaleShippingCost(tx, saleId, companyId, amount);
      return created;
    }, { timeout: 20000 });
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
    await prisma.$transaction(async (tx) => {
      // Taking back the expense has to take its cost off the order too, or the order keeps a
      // delivery cost nobody paid.
      if (expense.onSaleShipping && expense.saleId) {
        await shiftSaleShippingCost(tx, expense.saleId, expense.companyId, -parseFloat(expense.amount));
      }
      await tx.riderExpense.delete({ where: { id: expense.id } });
    }, { timeout: 20000 });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Today's figures, pre-filled from the records so he only has to correct what differs.
router.get('/my/report', async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const prisma = req.app.locals.prisma;
    const bounds = riderDayBounds(req.query.date);
    if (!bounds.valid) return res.status(400).json({ error: 'That is not a date I can read' });
    const { start, end, dateOnly } = bounds;
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
    const bounds = riderDayBounds(req.body.date);
    if (!bounds.valid) return res.status(400).json({ error: 'That is not a date I can read' });
    const { dateOnly, start, end } = bounds;
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
      include: {
        rider: { select: { id: true, name: true } },
        // What the order carries as its delivery cost and what the customer is billed for it,
        // so a courier drop-off can be read as the margin it actually made.
        sale: { select: { id: true, orderNumber: true, customerName: true, shippingCost: true, shippingCharge: true } },
      },
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
      // Already on the order as its shipping cost, so the books carry it and settling only
      // records that the company has accounted for what it owes him.
      if (expense.onSaleShipping) {
        const updated = await prisma.riderExpense.update({
          where: { id: expense.id }, data: { ...data, settledAt: new Date() },
        });
        return res.json(updated);
      }
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

// A rider's whole picture for a stretch of days — what he carried, what cash passed through his
// hands, what he laid out, and what he said about each day.
//
// There was nowhere to see any of this. His own screen showed today and dropped yesterday at
// midnight. The office saw open runs and cash still owed, but a delivery completed with nothing
// to collect simply vanished the moment it was done. So a day that was not balanced on the day
// could not be balanced afterwards: the records were there, and no screen would show them.
// (mirrored in api/index.js)
router.get('/riders/:id/history', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const rider = await prisma.rider.findFirst({
      where: { id: req.params.id, companyId },
      select: { id: true, name: true, vehicle: true, phone: true, isActive: true, userId: true },
    });
    if (!rider) return res.status(404).json({ error: 'Not found' });
    // A daily report is only expected from somebody who files them. The owner's car is in here
    // because he delivers sometimes, and he is not going to send himself a report — counting
    // every one of his drops as a missing report was just noise.
    const linked = rider.userId
      ? await prisma.user.findUnique({ where: { id: rider.userId }, select: { role: true } })
      : null;
    const expectsReports = linked?.role === 'rider';

    // A fortnight back by default: long enough to catch a day nobody balanced, short enough
    // to read. Both ends are Zambian days, not UTC ones.
    const toDay = localDayBounds(req.query.to);
    const from = req.query.from ? localDayBounds(req.query.from).start
                                : localDayBounds(localDayKey(new Date(toDay.start.getTime() - 13 * 86400000))).start;
    const to = toDay.end;

    const [deliveries, reports, expenses] = await Promise.all([
      // Every delivery that touched this window, by when it was assigned or finished, so a run
      // assigned late one night and delivered the next morning shows on both days it belongs to.
      prisma.delivery.findMany({
        where: {
          companyId, riderId: rider.id,
          OR: [
            { assignedAt: { gte: from, lte: to } },
            { deliveredAt: { gte: from, lte: to } },
            { failedAt: { gte: from, lte: to } },
          ],
        },
        include: deliveryInclude,
        orderBy: { assignedAt: 'desc' },
        take: 500,
      }),
      prisma.riderDailyReport.findMany({
        where: { companyId, riderId: rider.id, date: { gte: from, lte: to } },
        orderBy: { date: 'desc' },
      }),
      prisma.riderExpense.findMany({
        where: { companyId, riderId: rider.id, date: { gte: from, lte: to } },
        include: { sale: { select: { orderNumber: true } } },
        orderBy: { date: 'desc' },
      }),
    ]);

    // Grouped by the day the work actually landed on, because balancing is a per-day job.
    const dayOf = localDayKey;
    const days = {};
    const touch = (key) => {
      if (!days[key]) {
        days[key] = {
          date: key, delivered: 0, failed: 0, assigned: 0,
          cashCollected: 0, cashRemitted: 0, cashHeld: 0,
          expenses: 0, report: null, deliveries: [],
        };
      }
      return days[key];
    };

    for (const d of deliveries) {
      const key = dayOf(d.deliveredAt || d.failedAt || d.assignedAt);
      const day = touch(key);
      day.deliveries.push(shapeDelivery(d));
      if (d.status === 'Delivered') {
        day.delivered += 1;
        const cash = parseFloat(d.cashCollected);
        day.cashCollected = round2(day.cashCollected + cash);
        if (d.cashRemitted) day.cashRemitted = round2(day.cashRemitted + cash);
        else day.cashHeld = round2(day.cashHeld + cash);
      } else if (d.status === 'Failed') day.failed += 1;
      else day.assigned += 1;
    }
    for (const e of expenses) {
      const day = touch(dayOf(e.date));
      day.expenses = round2(day.expenses + parseFloat(e.amount));
    }
    for (const r of reports) {
      const day = touch(dayOf(r.date));
      day.report = {
        id: r.id,
        deliveriesCompleted: r.deliveriesCompleted, deliveriesFailed: r.deliveriesFailed,
        cashCollected: parseFloat(r.cashCollected), expensesPaid: parseFloat(r.expensesPaid),
        cashHandedOver: parseFloat(r.cashHandedOver), closingFloat: parseFloat(r.closingFloat),
        submittedAt: r.submittedAt, acknowledgedAt: r.acknowledgedAt,
      };
    }

    // A day is only settled when nothing is still held and his own money is back.
    const list = Object.values(days).sort((a, b) => (a.date < b.date ? 1 : -1)).map(day => ({
      ...day,
      // What the records say against what he said, which is the whole reason to look at a past day.
      variance: day.report ? {
        deliveriesCompleted: day.report.deliveriesCompleted - day.delivered,
        cashCollected: round2(day.report.cashCollected - day.cashCollected),
        expensesPaid: round2(day.report.expensesPaid - day.expenses),
      } : null,
      settled: day.cashHeld === 0 && (!day.report || !!day.report.acknowledgedAt),
    }));

    res.json({
      rider: { ...rider, expectsReports },
      from, to,
      days: list,
      totals: {
        delivered: list.reduce((s, d) => s + d.delivered, 0),
        failed: list.reduce((s, d) => s + d.failed, 0),
        cashCollected: round2(list.reduce((s, d) => s + d.cashCollected, 0)),
        cashRemitted: round2(list.reduce((s, d) => s + d.cashRemitted, 0)),
        cashStillHeld: round2(list.reduce((s, d) => s + d.cashHeld, 0)),
        expenses: round2(list.reduce((s, d) => s + d.expenses, 0)),
        daysUnsettled: list.filter(d => !d.settled).length,
        reportsMissing: expectsReports
          ? list.filter(d => !d.report && (d.delivered > 0 || d.failed > 0)).length
          : 0,
      },
      // Where he stands overall, which is a balance rather than a window figure.
      account: await riderAccount(prisma, rider.id, companyId),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- COURIER RUNS ----
//
// Out-of-town parcels go to Platinum rather than on the bike, and they go in batches: a morning,
// an afternoon and a day-end run. A run is one trip to one courier at one session, so adding a
// parcel finds that session's run rather than creating a trip of its own.
//
// Platinum charges per parcel, because each is going to a different customer in a different town,
// so the fee is entered per parcel at dispatch along with its receipt number. The rider pays those
// fees, so each one both lands on its order as the delivery cost and credits him what he laid out
// — the same two facts a courier drop-off has always been.
//
// And payment comes after dispatch. The receipt is sent to the customer as proof the parcel is on
// its way, and only then do they pay. So dispatching does not finish an order, it starts a debt,
// which is why a dispatched parcel sits in an awaiting-payment list until somebody confirms the
// money arrived. (mirrored in api/index.js)

const COURIER_SLOTS = [
  { key: '09:00', label: 'Morning run', hour: 9 },
  { key: '13:00', label: 'Afternoon run', hour: 13 },
  { key: '16:00', label: 'Day-end run', hour: 16 },
];

// The instant a session falls on, for a given Lusaka date. Stored as UTC like everything else.
function runInstant(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 2, 0, 0, 0));
}

function lusakaDateString(at = new Date()) {
  return new Date(at.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

// Which session a parcel ready now would make. After the last run of the day it is tomorrow's
// first — saying so lets the warehouse tell a customer when their parcel actually leaves.
function nextSlotFrom(at = new Date()) {
  const local = new Date(at.getTime() + 2 * 3600 * 1000);
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  for (const s of COURIER_SLOTS) if (hour < s.hour) return { date: lusakaDateString(at), slot: s.key };
  const tomorrow = new Date(at.getTime() + 24 * 3600 * 1000);
  return { date: lusakaDateString(tomorrow), slot: COURIER_SLOTS[0].key };
}

const runInclude = {
  rider: { select: { id: true, name: true, phone: true, vehicle: true } },
  dispatchedBy: { select: { id: true, name: true, username: true } },
  deliveries: {
    include: {
      sale: {
        select: {
          id: true, orderNumber: true, customerName: true, customerPhone: true, customerCity: true,
          deliveryAddress: true, totalPrice: true, amountPaid: true, paymentStatus: true,
          shippingCost: true, shippingCharge: true,
          consultant: { select: { id: true, name: true } },
          items: { select: { qty: true, product: { select: { name: true } } } },
        },
      },
    },
    orderBy: { assignedAt: 'asc' },
  },
};

function shapeRun(run) {
  const parcels = (run.deliveries || []).map(d => ({
    deliveryId: d.id,
    status: d.status,
    receiptNo: d.courierReceiptNo,
    fee: parseFloat(d.sale?.shippingCost || 0),
    billed: parseFloat(d.sale?.shippingCharge || 0),
    saleId: d.saleId,
    orderNumber: d.sale?.orderNumber,
    customerName: d.sale?.customerName,
    customerPhone: d.sale?.customerPhone,
    town: d.sale?.customerCity,
    address: d.sale?.deliveryAddress,
    consultant: d.sale?.consultant?.name || null,
    orderTotal: parseFloat(d.sale?.totalPrice || 0),
    outstanding: Math.max(0, parseFloat(d.sale?.totalPrice || 0) - parseFloat(d.sale?.amountPaid || 0)),
    paymentStatus: d.sale?.paymentStatus,
    items: (d.sale?.items || []).map(i => ({ name: i.product?.name || 'Item', qty: i.qty })),
  }));
  const slot = COURIER_SLOTS.find(s => s.key === run.slot);
  return {
    id: run.id,
    slot: run.slot,
    slotLabel: slot ? slot.label : run.slot,
    scheduledFor: run.scheduledFor,
    courier: run.courier,
    status: run.status,
    rider: run.rider,
    dispatchedAt: run.dispatchedAt,
    dispatchedBy: run.dispatchedBy,
    notes: run.notes,
    parcels,
    parcelCount: parcels.length,
    towns: [...new Set(parcels.map(p => p.town).filter(Boolean))],
    feesTotal: round2(parcels.reduce((s, p) => s + p.fee, 0)),
    billedTotal: round2(parcels.reduce((s, p) => s + p.billed, 0)),
    outstandingTotal: round2(parcels.reduce((s, p) => s + p.outstanding, 0)),
  };
}

// The day's three sessions, whether or not a run exists for them yet — an empty session is still
// a session, and seeing it is how the warehouse knows what is coming.
router.get('/runs', requireAdminOrInventory, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : lusakaDateString();
    const courier = req.query.courier || 'Platinum';

    const instants = COURIER_SLOTS.map(s => runInstant(date, s.hour));
    const existing = await prisma.courierRun.findMany({
      where: { companyId, courier, scheduledFor: { in: instants } },
      include: runInclude,
    });
    const byInstant = {};
    for (const r of existing) byInstant[r.scheduledFor.toISOString()] = r;

    const sessions = COURIER_SLOTS.map((s, i) => {
      const found = byInstant[instants[i].toISOString()];
      if (found) return shapeRun(found);
      return {
        id: null, slot: s.key, slotLabel: s.label, scheduledFor: instants[i], courier,
        status: 'Open', rider: null, parcels: [], parcelCount: 0, towns: [],
        feesTotal: 0, billedTotal: 0, outstandingTotal: 0,
      };
    });

    res.json({
      date, courier, slots: COURIER_SLOTS, sessions, next: nextSlotFrom(),
      // So the screen can say what it is treating as local rather than assuming.
      localCities: await localDeliveryCities(prisma, companyId),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Put prepared parcels on a session. Creates the run if that session has none yet.
router.post('/runs/parcels', requireAdminOrInventory, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { saleIds, riderId, notes } = req.body;
    const courier = req.body.courier || 'Platinum';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : lusakaDateString();
    const slot = COURIER_SLOTS.find(s => s.key === req.body.slot);
    if (!slot) return res.status(400).json({ error: `Slot must be one of ${COURIER_SLOTS.map(s => s.key).join(', ')}` });

    const ids = Array.isArray(saleIds) ? saleIds : (req.body.saleId ? [req.body.saleId] : []);
    if (!ids.length) return res.status(400).json({ error: 'Select at least one order' });

    const sales = await prisma.sale.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true, items: { select: { stockSourceConsultantId: true } } },
    });
    if (sales.length !== ids.length) return res.status(400).json({ error: 'One or more orders were not found' });
    const already = await prisma.delivery.findMany({ where: { saleId: { in: ids } }, select: { saleId: true } });
    if (already.length) return res.status(400).json({ error: `${already.length} of those orders are already on a run or out for delivery` });

    const scheduledFor = runInstant(date, slot.hour);
    const run = await prisma.courierRun.upsert({
      where: { companyId_scheduledFor_courier: { companyId, scheduledFor, courier } },
      update: { ...(riderId !== undefined && { riderId: riderId || null }), ...(notes !== undefined && { notes: notes || null }) },
      create: { slot: slot.key, scheduledFor, courier, riderId: riderId || null, notes: notes || null, companyId },
    });
    if (run.status !== 'Open') return res.status(400).json({ error: 'That run has already gone out — put these on the next session' });

    const originBySale = {};
    for (const sale of sales) originBySale[sale.id] = dispatchOriginFor(sale.items);

    await prisma.delivery.createMany({
      data: ids.map(saleId => ({
        saleId, courierRunId: run.id, courier: 'other', courierRef: courier,
        riderId: null, dispatchedFromConsultantId: originBySale[saleId] || null,
        assignedById: req.user.id, companyId,
      })),
    });

    const full = await prisma.courierRun.findUnique({ where: { id: run.id }, include: runInclude });
    res.status(201).json(shapeRun(full));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Take a parcel back off a run, while it is still open.
router.delete('/runs/:id/parcels/:deliveryId', requireAdminOrInventory, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const run = await prisma.courierRun.findFirst({ where: { id: req.params.id, companyId } });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'Open') return res.status(400).json({ error: 'That run has already gone out' });
    const parcel = await prisma.delivery.findFirst({ where: { id: req.params.deliveryId, courierRunId: run.id, companyId } });
    if (!parcel) return res.status(404).json({ error: 'That parcel is not on this run' });
    await prisma.delivery.delete({ where: { id: parcel.id } });
    const full = await prisma.courierRun.findUnique({ where: { id: run.id }, include: runInclude });
    res.json(shapeRun(full));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// The run went out. Each parcel carries what Platinum charged for it and the receipt number that
// becomes the customer's proof of dispatch — and the fee both lands on the order and credits the
// rider who paid it.
router.put('/runs/:id/dispatch', requireAdminOrInventory, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const run = await prisma.courierRun.findFirst({
      where: { id: req.params.id, companyId },
      include: { deliveries: { select: { id: true, saleId: true } } },
    });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'Open') return res.status(400).json({ error: 'That run has already gone out' });
    if (!run.deliveries.length) return res.status(400).json({ error: 'There is nothing on this run' });

    const entries = Array.isArray(req.body.parcels) ? req.body.parcels : [];
    const onRun = new Set(run.deliveries.map(d => d.id));
    const byDelivery = {};
    for (const e of entries) {
      if (!onRun.has(e.deliveryId)) return res.status(400).json({ error: 'A parcel in that list is not on this run' });
      const fee = e.fee === undefined || e.fee === '' ? 0 : parseFloat(e.fee);
      if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ error: 'Every fee must be zero or more' });
      byDelivery[e.deliveryId] = { fee, receiptNo: e.receiptNo ? String(e.receiptNo).trim() : null };
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      for (const d of run.deliveries) {
        const entry = byDelivery[d.id] || { fee: 0, receiptNo: null };
        await tx.delivery.update({
          where: { id: d.id },
          // AtCourier, not Delivered: it is with Platinum, not with the customer.
          data: { status: 'AtCourier', pickedUpAt: now, courierReceiptNo: entry.receiptNo },
        });
        if (entry.fee > 0) {
          await shiftSaleShippingCost(tx, d.saleId, companyId, entry.fee);
          // The rider paid it, so the company owes him — the same credit any courier drop earns.
          if (run.riderId) {
            await tx.riderExpense.create({
              data: {
                riderId: run.riderId, category: 'Platinum courier', amount: entry.fee,
                description: `${run.courier} drop on the ${run.slot} run`,
                saleId: d.saleId, rechargeable: true, onSaleShipping: true, companyId,
              },
            });
          }
        }
      }
      await tx.courierRun.update({
        where: { id: run.id },
        data: { status: 'Dispatched', dispatchedAt: now, dispatchedById: req.user.id },
      });
    }, { timeout: 30000 });

    const full = await prisma.courierRun.findUnique({ where: { id: run.id }, include: runInclude });
    res.json(shapeRun(full));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Dispatched and not yet paid for. This is a receivables queue, not a logistics one: the customer
// has the receipt and owes the money, and nothing else in the system was watching for it.
router.get('/awaiting-payment', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const role = req.user.role;
    if (!['admin', 'superadmin', 'inventory', 'consultant'].includes(role)) {
      return res.status(403).json({ error: 'Not available for this role' });
    }
    const where = {
      companyId, status: 'AtCourier',
      sale: { paymentStatus: { not: 'Paid' } },
    };
    // A consultant chases their own customer, so they see their own parcels and no others.
    if (role === 'consultant') where.sale = { ...where.sale, consultantId: req.user.consultantId };

    const parcels = await prisma.delivery.findMany({
      where,
      include: {
        courierRun: { select: { id: true, slot: true, scheduledFor: true, courier: true } },
        sale: {
          select: {
            id: true, orderNumber: true, customerName: true, customerPhone: true, customerCity: true,
            totalPrice: true, amountPaid: true, paymentStatus: true,
            consultant: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { pickedUpAt: 'asc' },
      take: 300,
    });

    const rows = parcels.map(d => {
      const outstanding = round2(Math.max(0, parseFloat(d.sale.totalPrice) - parseFloat(d.sale.amountPaid)));
      const days = d.pickedUpAt ? Math.floor((Date.now() - d.pickedUpAt.getTime()) / 86400000) : null;
      return {
        deliveryId: d.id, saleId: d.sale.id, orderNumber: d.sale.orderNumber,
        customerName: d.sale.customerName, customerPhone: d.sale.customerPhone, town: d.sale.customerCity,
        consultant: d.sale.consultant?.name || null,
        receiptNo: d.courierReceiptNo, courier: d.courierRun?.courier || d.courierRef,
        dispatchedAt: d.pickedUpAt, daysWaiting: days,
        orderTotal: parseFloat(d.sale.totalPrice), paid: parseFloat(d.sale.amountPaid), outstanding,
      };
    });

    res.json({
      parcels: rows,
      total: round2(rows.reduce((s, r) => s + r.outstanding, 0)),
      // The ones worth a phone call rather than a wait.
      overdue: rows.filter(r => (r.daysWaiting || 0) >= 3).length,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// The customer paid against the receipt. Records it as a real payment on the order and closes the
// parcel, because with nobody confirming receipt this is the only ending the order ever gets.
router.put('/:id/payment-received', requireAdminOrInventory, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const parcel = await prisma.delivery.findFirst({
      where: { id: req.params.id, companyId },
      include: { sale: { select: { id: true, totalPrice: true, amountPaid: true, status: true } } },
    });
    if (!parcel) return res.status(404).json({ error: 'Parcel not found' });
    if (parcel.status !== 'AtCourier') return res.status(400).json({ error: 'That parcel has not been dispatched to a courier' });

    const outstanding = round2(parseFloat(parcel.sale.totalPrice) - parseFloat(parcel.sale.amountPaid));
    const amount = req.body.amount === undefined || req.body.amount === '' ? outstanding : parseFloat(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'The amount must be more than zero' });
    if (amount > outstanding + 0.01) return res.status(400).json({ error: `That is more than the ${outstanding.toFixed(2)} outstanding` });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.creditPayment.create({
        data: {
          saleId: parcel.sale.id, amount, paymentMethod: req.body.paymentMethod || 'Mobile Money',
          reference: parcel.courierReceiptNo ? `Against ${parcel.courierRef || 'courier'} receipt ${parcel.courierReceiptNo}` : 'Paid after dispatch',
          notes: 'Customer paid after being sent the courier receipt',
          companyId,
        },
      });
      const newPaid = round2(parseFloat(parcel.sale.amountPaid) + amount);
      const paymentStatus = newPaid >= parseFloat(parcel.sale.totalPrice) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
      await tx.sale.update({ where: { id: parcel.sale.id }, data: { amountPaid: newPaid, paymentStatus } });

      // Paid in full is the end of it. Nobody confirms the customer received the parcel, so
      // payment against the receipt is the closest thing to proof the order completed.
      if (paymentStatus === 'Paid') {
        await tx.delivery.update({ where: { id: parcel.id }, data: { status: 'Delivered', deliveredAt: new Date() } });
        if (['Confirmed', 'Shipped'].includes(parcel.sale.status)) {
          await tx.sale.update({ where: { id: parcel.sale.id }, data: { status: 'Delivered' } });
          await tx.orderStatusLog.create({
            data: { saleId: parcel.sale.id, fromStatus: parcel.sale.status, toStatus: 'Delivered', byUserId: req.user.id, companyId },
          });
        }
      }
      return tx.delivery.findUnique({ where: { id: parcel.id }, include: deliveryInclude });
    }, { timeout: 20000 });

    res.json(shapeDelivery(updated));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- WHO DID WHAT ----

// One feed of the things people do to orders, so an admin can see the warehouse working without
// asking. Built from three sources rather than a separate audit table: the status log already
// records every transition, a delivery already knows when it was assigned, and a sale already
// knows when it was keyed in — all three now name the person responsible.
//
// Rows from before actions were attributed carry no user. They are shown rather than hidden,
// because a gap in the record is itself worth seeing. (mirrored in api/index.js)
router.get('/activity', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const since = new Date(Date.now() - days * 86400000);
    const userId = req.query.userId || null;

    const [assigned, changes, counterSales] = await Promise.all([
      prisma.delivery.findMany({
        where: { companyId, assignedAt: { gte: since }, ...(userId && { assignedById: userId }) },
        select: {
          id: true, assignedAt: true, courier: true, courierRef: true,
          assignedBy: { select: { id: true, name: true, username: true, role: true } },
          rider: { select: { name: true } },
          sale: { select: { id: true, orderNumber: true, customerName: true } },
        },
        orderBy: { assignedAt: 'desc' }, take: 200,
      }),
      prisma.orderStatusLog.findMany({
        where: { companyId, createdAt: { gte: since }, ...(userId && { byUserId: userId }) },
        select: {
          id: true, createdAt: true, fromStatus: true, toStatus: true,
          byUser: { select: { id: true, name: true, username: true, role: true } },
          sale: { select: { id: true, orderNumber: true, customerName: true } },
        },
        orderBy: { createdAt: 'desc' }, take: 300,
      }),
      prisma.sale.findMany({
        where: { companyId, fulfilment: 'collection', createdAt: { gte: since }, ...(userId && { recordedById: userId }) },
        select: {
          id: true, createdAt: true, orderNumber: true, customerName: true, totalPrice: true,
          recordedBy: { select: { id: true, name: true, username: true, role: true } },
          consultant: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' }, take: 200,
      }),
    ]);

    const events = [];
    for (const d of assigned) {
      const carrier = d.courier === 'rider' ? (d.rider?.name || 'nobody yet')
        : (d.courier === 'yango' ? 'Yango' : 'a hired courier');
      events.push({
        at: d.assignedAt, kind: 'assigned', who: d.assignedBy,
        orderNumber: d.sale?.orderNumber, saleId: d.sale?.id, customerName: d.sale?.customerName,
        summary: `Put on a run with ${carrier}`,
        detail: d.courierRef || null,
      });
    }
    for (const c of changes) {
      // The warehouse marking an order packed is the move worth naming plainly.
      const packed = c.fromStatus === 'Confirmed' && c.toStatus === 'Shipped';
      events.push({
        at: c.createdAt, kind: packed ? 'packed' : 'status', who: c.byUser,
        orderNumber: c.sale?.orderNumber, saleId: c.sale?.id, customerName: c.sale?.customerName,
        summary: packed ? 'Marked packed and ready'
          : (c.fromStatus === 'New' ? `Order created as ${c.toStatus}` : `${c.fromStatus} to ${c.toStatus}`),
        detail: null,
      });
    }
    for (const s of counterSales) {
      events.push({
        at: s.createdAt, kind: 'counter-sale', who: s.recordedBy,
        orderNumber: s.orderNumber, saleId: s.id, customerName: s.customerName,
        summary: `Counter sale of ${parseFloat(s.totalPrice).toFixed(2)}`,
        detail: s.consultant?.name ? `credited to ${s.consultant.name}` : 'for the business',
      });
    }

    events.sort((a, b) => new Date(b.at) - new Date(a.at));

    // Who has been active, so the filter can be built without a second call.
    const people = {};
    for (const e of events) {
      if (!e.who) continue;
      people[e.who.id] = people[e.who.id] || { ...e.who, actions: 0 };
      people[e.who.id].actions += 1;
    }

    res.json({
      days,
      events: events.slice(0, 200),
      people: Object.values(people).sort((a, b) => b.actions - a.actions),
      unattributed: events.filter(e => !e.who).length,
    });
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
      select: {
        cashCollected: true, riderId: true, courier: true,
        dispatchedFromConsultantId: true,
        dispatchedFromConsultant: { select: { name: true } },
        sale: { select: { shippingCharge: true, shippingCost: true } },
      },
    });
    const feesBilled = round2(delivered.reduce((s, d) => s + parseFloat(d.sale?.shippingCharge || 0), 0));
    const collected = round2(delivered.reduce((s, d) => s + parseFloat(d.cashCollected), 0));

    // Our own bike and a hired car are priced completely differently — one is a fixed monthly
    // cost whatever it does, the other a fare per trip — so the only honest comparison is to
    // keep them apart and work out what each drop cost under each arrangement.
    const ownDrops = delivered.filter(d => d.courier === 'rider');
    const hiredDrops = delivered.filter(d => d.courier !== 'rider');
    const sumFares = (rows) => round2(rows.reduce((s, d) => s + parseFloat(d.sale?.shippingCost || 0), 0));
    const sumFees = (rows) => round2(rows.reduce((s, d) => s + parseFloat(d.sale?.shippingCharge || 0), 0));
    const hiredFares = sumFares(hiredDrops);

    const byCourier = {};
    for (const d of delivered) {
      const key = d.courier || 'rider';
      byCourier[key] = byCourier[key] || { courier: key, drops: 0, fares: 0, feesBilled: 0 };
      byCourier[key].drops += 1;
      byCourier[key].fares = round2(byCourier[key].fares + parseFloat(d.sale?.shippingCost || 0));
      byCourier[key].feesBilled = round2(byCourier[key].feesBilled + parseFloat(d.sale?.shippingCharge || 0));
    }

    // Where the goods left from, which says how much of this the warehouse actually handled.
    const byOrigin = { warehouse: 0 };
    for (const d of delivered) {
      const key = d.dispatchedFromConsultant?.name || 'warehouse';
      byOrigin[key] = (byOrigin[key] || 0) + 1;
    }

    const expenses = await prisma.riderExpense.findMany({
      where: { companyId, date: { gte: from, lte: to } },
      select: { amount: true, rechargedAmount: true, settledAt: true, rechargeable: true, rechargedAt: true, category: true },
    });
    const laidOut = round2(expenses.reduce((s, e) => s + parseFloat(e.amount), 0));
    const recovered = round2(expenses.reduce((s, e) => s + parseFloat(e.rechargedAmount || 0), 0));
    const borne = round2(laidOut - recovered);
    const byCategory = {};
    for (const e of expenses) byCategory[e.category] = round2((byCategory[e.category] || 0) + parseFloat(e.amount));

    // Hired fares are as real a delivery cost as the bike, and their fees are already counted
    // as income, so leaving them out would show a margin nobody earned.
    const totalCost = round2(fixedInWindow + borne + hiredFares);
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
        hiredCourierFares: hiredFares,
        total: totalCost,
        perDelivery: count ? round2(totalCost / count) : null,
        byCategory: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount })),
        // The question the warehouse asks every time the rider is swamped: send him, or book a car?
          courierSplit: {
          own: {
            drops: ownDrops.length,
              // The fixed cost is the bike and the wage, and it is carried whether he does one drop
              // or twenty, so it all lands on the drops he actually made.
            cost: round2(fixedInWindow + borne),
            costPerDrop: ownDrops.length ? round2((fixedInWindow + borne) / ownDrops.length) : null,
            feesBilled: sumFees(ownDrops),
          },
          hired: {
            drops: hiredDrops.length,
            cost: hiredFares,
            costPerDrop: hiredDrops.length ? round2(hiredFares / hiredDrops.length) : null,
            feesBilled: sumFees(hiredDrops),
          },
          byCourier: Object.values(byCourier).sort((a, b) => b.drops - a.drops),
        },
      },
      income: {
        feesBilled,
        perDelivery: count ? round2(feesBilled / count) : null,
        cashCollectedAtDoors: collected,
      },
      net: round2(feesBilled - totalCost),
      dispatchedFrom: Object.entries(byOrigin)
        .filter(([, n]) => n > 0)
        .map(([where, drops]) => ({ where, drops }))
        .sort((a, b) => b.drops - a.drops),
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
