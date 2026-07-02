const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { validateExpense } = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

router.use(authenticate);
router.use(requireAdmin);

const SORT_FIELDS = { date: 'date', description: 'description', category: 'category', amount: 'amount' };

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { category, from, to, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (category) where.category = category;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const orderBy = { [SORT_FIELDS[sortBy] || 'date']: sortDir === 'asc' ? 'asc' : 'desc' };

    const pagination = parsePagination(req.query);
    if (pagination) {
      // Sum/category breakdown must reflect the whole filtered set, not just the current page —
      // these are financial totals, not a per-page display concern.
      const [total, expenses, sumAgg, byCategory] = await Promise.all([
        prisma.expense.count({ where }),
        prisma.expense.findMany({ where, orderBy, skip: pagination.skip, take: pagination.take }),
        prisma.expense.aggregate({ where, _sum: { amount: true } }),
        prisma.expense.groupBy({ by: ['category'], where, _sum: { amount: true } }),
      ]);
      return res.json({
        ...paginatedResponse(expenses, total, pagination),
        sumAmount: sumAgg._sum.amount || 0,
        byCategory: Object.fromEntries(byCategory.map(c => [c.category, c._sum.amount || 0])),
      });
    }
    const expenses = await prisma.expense.findMany({ where, orderBy });
    res.json(expenses);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/', validateExpense, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const data = { ...req.body, companyId };
    if (data.date) data.date = new Date(data.date);
    res.status(201).json(await prisma.expense.create({ data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id', validateExpense, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.expense.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    if (data.date) data.date = new Date(data.date);
    res.json(await prisma.expense.update({ where: { id: req.params.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.expense.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ message: 'Expense deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
