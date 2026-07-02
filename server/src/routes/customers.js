const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { validateCustomer } = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

router.use(authenticate);
router.use(requireAdmin);

function customerOrderBy(sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  if (sortBy === 'orders') return { sales: { _count: dir } };
  if (['name', 'phone', 'city', 'source'].includes(sortBy)) return { [sortBy]: dir };
  return { createdAt: 'desc' };
}

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { search, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search, mode: 'insensitive' } }, { city: { contains: search, mode: 'insensitive' } }]; }
    const orderBy = customerOrderBy(sortBy, sortDir);

    const pagination = parsePagination(req.query);
    if (pagination) {
      // repeatCustomers is company-wide (not scoped to the current search/page) — it's a stat,
      // not a filtered list, so it stays stable as you page/search rather than needing a full fetch.
      const [total, customers, repeatGroups] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.findMany({ where, include: { _count: { select: { sales: true } } }, orderBy, skip: pagination.skip, take: pagination.take }),
        prisma.sale.groupBy({ by: ['customerId'], where: { companyId, customerId: { not: null } }, _count: { customerId: true } }),
      ]);
      const repeatCustomers = repeatGroups.filter(g => g._count.customerId > 1).length;
      return res.json({ ...paginatedResponse(customers, total, pagination), repeatCustomers });
    }
    const customers = await prisma.customer.findMany({ where, include: { _count: { select: { sales: true } } }, orderBy });
    res.json(customers);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, companyId }, include: { sales: { include: { product: true }, orderBy: { date: 'desc' } } } });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id/orders', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    res.json(await prisma.sale.findMany({ where: { customerId: req.params.id, companyId }, include: { product: true }, orderBy: { date: 'desc' } }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/', validateCustomer, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    res.status(201).json(await prisma.customer.create({ data: { ...req.body, companyId } }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id', validateCustomer, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.customer.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    res.json(await prisma.customer.update({ where: { id: req.params.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.customer.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.customer.delete({ where: { id: req.params.id } });
    res.json({ message: 'Customer deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
