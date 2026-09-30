const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');

router.use(authenticate);

// Settings are read by every role — a consultant needs the business name and currency for a
// receipt — but a secret is not part of that. Anything whose key looks like a secret is withheld
// from everyone but an admin, so the payment gateway key never leaves on a consultant's or a
// rider's token. lencoPublicKey is deliberately untouched: it is public by design.
const SETTING_SECRET_PATTERN = /secret/i;

function redactSettingsFor(user, obj) {
  if (user.role === 'admin' || user.role === 'superadmin') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!SETTING_SECRET_PATTERN.test(k)) out[k] = v;
  }
  return out;
}

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json(redactSettingsFor(req.user, obj));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/', requireAdmin, async (req, res) => {
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
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
