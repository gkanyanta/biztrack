const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { zra_configProblems, zra_send, zra_sendWaiting } = require('../utils/zra');

// A company's own view of ZRA Smart Invoice: whether it is on, and what has not gone through.
// Turning it on and pointing it at a VSDC is the superadmin's job (routes/superadmin.js).
router.use(authenticate);
router.use(requireAdmin);

async function zra_status(prisma, companyId) {
  const config = await prisma.zraConfig.findUnique({ where: { companyId } });
  const grouped = await prisma.fiscalDocument.groupBy({ by: ['status'], where: { companyId }, _count: { _all: true } });
  const counts = { pending: 0, failed: 0, issued: 0 };
  grouped.forEach(g => { counts[g.status] = g._count._all; });
  const attention = await prisma.fiscalDocument.findMany({
    where: { companyId, OR: [{ status: 'failed' }, { status: 'pending', attempts: { gt: 0 } }, { status: 'pending', lastError: { not: null } }] },
    orderBy: { createdAt: 'asc' }, take: 50,
    select: { id: true, kind: true, status: true, invoiceNo: true, attempts: true, lastError: true, lastAttemptAt: true,
              sale: { select: { id: true, orderNumber: true, customerName: true, totalPrice: true, date: true } } },
  });
  const unmapped = config?.enabled ? await prisma.product.count({ where: { companyId, isActive: true, zraClassCode: null } }) : 0;
  return {
    enabled: !!config?.enabled,
    environment: config?.environment || null,
    defaultTaxCategory: config?.defaultTaxCategory || null,
    startDate: config?.startDate || null,
    setupProblems: config?.enabled ? zra_configProblems(config) : [],
    counts, attention, unmappedProducts: unmapped,
  };
}

router.get('/status', async (req, res) => {
  try {
    res.json(await zra_status(req.app.locals.prisma, req.user.companyId));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Try everything that has not gone through, refusals included: whoever presses this has
// presumably fixed what ZRA complained about.
router.post('/retry', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    await zra_sendWaiting(prisma, req.user.companyId, { includeFailed: true, limit: 20 });
    res.json(await zra_status(prisma, req.user.companyId));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/documents/:id/retry', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const doc = await prisma.fiscalDocument.findFirst({ where: { id: req.params.id, companyId: req.user.companyId }, select: { id: true } });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    await zra_send(prisma, doc.id, { includeFailed: true });
    res.json(await zra_status(prisma, req.user.companyId));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
