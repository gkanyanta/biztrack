const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    for (const [key, value] of Object.entries(req.body)) {
      await prisma.setting.upsert({
        where: { companyId_key: { companyId, key } },
        update: { value: String(value) },
        create: { key, value: String(value), companyId }
      });
    }
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
