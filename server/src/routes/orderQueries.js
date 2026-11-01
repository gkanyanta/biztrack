const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { sanitizeString } = require('../middleware/validate');

// The office asking a consultant what is happening with an order, usually one still unpaid, and
// the consultant answering. (mirrored in api/index.js)
//
// One thread per order at a time. It is addressed to the order's consultant, and nobody else but
// the office can read or answer it. Its status says whose turn it is: "open" waits on the
// consultant, "answered" waits on the office. The office closes it when it has what it needs, and
// writing on a closed thread opens it again.

const OQ_MAX_MESSAGE = 1000;
const OQ_IS_OFFICE = (user) => user.role === 'admin' || user.role === 'superadmin';

const OQ_INCLUDE = {
  consultant: { select: { id: true, name: true } },
  sale: {
    select: {
      id: true, orderNumber: true, date: true, customerName: true, totalPrice: true, amountPaid: true,
      paymentStatus: true, paymentType: true, status: true, customer: { select: { name: true } },
    },
  },
  messages: { orderBy: { createdAt: 'asc' } },
};

function oq_view(q) {
  const total = parseFloat(q.sale.totalPrice);
  const paid = parseFloat(q.sale.amountPaid);
  const last = q.messages[q.messages.length - 1] || null;
  return {
    id: q.id, status: q.status, saleId: q.saleId, consultant: q.consultant,
    createdAt: q.createdAt, updatedAt: q.updatedAt, closedAt: q.closedAt,
    order: {
      id: q.sale.id, orderNumber: q.sale.orderNumber, date: q.sale.date,
      customerName: q.sale.customerName || q.sale.customer?.name || 'Unknown',
      totalPrice: total, amountPaid: paid, balance: Math.round((total - paid) * 100) / 100,
      paymentStatus: q.sale.paymentStatus, paymentType: q.sale.paymentType, status: q.sale.status,
    },
    messages: q.messages.map(m => ({ id: m.id, authorName: m.authorName, authorRole: m.authorRole, message: m.message, createdAt: m.createdAt })),
    lastMessage: last ? { authorName: last.authorName, authorRole: last.authorRole, message: last.message, createdAt: last.createdAt } : null,
  };
}

// Who may see a thread: the office, or the consultant it is addressed to. Anyone else is shown
// nothing, as though it did not exist.
function oq_scope(user) {
  if (OQ_IS_OFFICE(user)) return { companyId: user.companyId };
  if (user.role === 'consultant' && user.consultantId) return { companyId: user.companyId, consultantId: user.consultantId };
  return null;
}

function oq_message(body) {
  const text = sanitizeString(String(body?.message || '').trim(), OQ_MAX_MESSAGE);
  return text ? { text } : { error: 'Write a message' };
}

async function oq_author(prisma, user) {
  const u = await prisma.user.findFirst({ where: { id: user.id, companyId: user.companyId }, select: { name: true, username: true } });
  return { authorId: user.id, authorName: u?.name || u?.username || 'Unknown', authorRole: OQ_IS_OFFICE(user) ? 'admin' : 'consultant' };
}

router.use(authenticate);

// How many threads wait on whoever is asking, for the menu badge and the dashboard alert.
router.get('/summary', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const scope = oq_scope(req.user);
    if (!scope) return res.status(403).json({ error: 'Not available for your role' });
    const groups = await prisma.orderQuery.groupBy({ by: ['status'], where: { ...scope, status: { in: ['open', 'answered'] } }, _count: { _all: true } });
    const count = (st) => groups.find(g => g.status === st)?._count._all || 0;
    const office = OQ_IS_OFFICE(req.user);
    res.json({ waitingOnYou: office ? count('answered') : count('open'), waitingOnThem: office ? count('open') : count('answered') });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// status: open | answered | closed | active (open and answered, the default) | all
router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const scope = oq_scope(req.user);
    if (!scope) return res.status(403).json({ error: 'Not available for your role' });
    const status = req.query.status || 'active';
    const where = { ...scope };
    if (status === 'active') where.status = { in: ['open', 'answered'] };
    else if (['open', 'answered', 'closed'].includes(status)) where.status = status;
    if (req.query.saleId) where.saleId = String(req.query.saleId);
    const queries = await prisma.orderQuery.findMany({ where, include: OQ_INCLUDE, orderBy: { updatedAt: 'desc' }, take: 200 });
    res.json(queries.map(oq_view));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// The office asks about an order. If the order already has a thread that is not closed, the
// question goes on the end of it rather than starting a second one.
router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!OQ_IS_OFFICE(req.user)) return res.status(403).json({ error: 'Only the office can raise a query' });
    const companyId = req.user.companyId;
    const msg = oq_message(req.body);
    if (msg.error) return res.status(400).json({ error: msg.error });
    const sale = await prisma.sale.findFirst({ where: { id: String(req.body.saleId || ''), companyId }, select: { id: true, consultantId: true } });
    if (!sale) return res.status(404).json({ error: 'Order not found' });
    if (!sale.consultantId) return res.status(400).json({ error: 'This order has no consultant to ask' });
    const author = await oq_author(prisma, req.user);

    const query = await prisma.$transaction(async (tx) => {
      const existing = await tx.orderQuery.findFirst({ where: { companyId, saleId: sale.id, status: { not: 'closed' } } });
      const q = existing
        ? await tx.orderQuery.update({ where: { id: existing.id }, data: { status: 'open' } })
        : await tx.orderQuery.create({ data: { saleId: sale.id, consultantId: sale.consultantId, raisedById: req.user.id, companyId } });
      await tx.orderQueryMessage.create({ data: { queryId: q.id, ...author, message: msg.text } });
      return tx.orderQuery.findUnique({ where: { id: q.id }, include: OQ_INCLUDE });
    });
    res.status(201).json(oq_view(query));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// A reply. From the consultant it hands the turn to the office; from the office, back to the
// consultant, reopening the thread if it had been closed.
router.post('/:id/messages', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const scope = oq_scope(req.user);
    if (!scope) return res.status(403).json({ error: 'Not available for your role' });
    const msg = oq_message(req.body);
    if (msg.error) return res.status(400).json({ error: msg.error });
    const existing = await prisma.orderQuery.findFirst({ where: { id: req.params.id, ...scope } });
    if (!existing) return res.status(404).json({ error: 'Query not found' });
    const office = OQ_IS_OFFICE(req.user);
    if (!office && existing.status === 'closed') return res.status(400).json({ error: 'This query has been closed' });
    const author = await oq_author(prisma, req.user);
    const query = await prisma.$transaction(async (tx) => {
      await tx.orderQueryMessage.create({ data: { queryId: existing.id, ...author, message: msg.text } });
      await tx.orderQuery.update({ where: { id: existing.id }, data: { status: office ? 'open' : 'answered', closedAt: null } });
      return tx.orderQuery.findUnique({ where: { id: existing.id }, include: OQ_INCLUDE });
    });
    res.json(oq_view(query));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/:id/close', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!OQ_IS_OFFICE(req.user)) return res.status(403).json({ error: 'Only the office can close a query' });
    const done = await prisma.orderQuery.updateMany({
      where: { id: req.params.id, companyId: req.user.companyId, status: { not: 'closed' } },
      data: { status: 'closed', closedAt: new Date() },
    });
    if (!done.count) return res.status(404).json({ error: 'No open query to close' });
    const query = await prisma.orderQuery.findUnique({ where: { id: req.params.id }, include: OQ_INCLUDE });
    res.json(oq_view(query));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
