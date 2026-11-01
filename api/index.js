const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const crypto = require('crypto');

const app = express();

// Vercel sits exactly one proxy hop in front of this function; trusting it lets
// express-rate-limit (and req.ip generally) resolve the real client IP from
// X-Forwarded-For instead of Vercel's internal address for every request.
app.set('trust proxy', 1);

if (!global.__prisma) {
  global.__prisma = new PrismaClient();
}
const prisma = global.__prisma;

// Pagination is opt-in: only kicks in when the caller passes ?page=. Callers that need the
// full unfiltered array (dropdowns, pickers, reports) keep working unchanged.
function parsePagination(query, { defaultPageSize = 25, maxPageSize = 100 } = {}) {
  if (query.page === undefined) return null;
  const page = Math.max(1, parseInt(query.page) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, parseInt(query.pageSize) || defaultPageSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
function paginatedResponse(data, total, pagination) {
  return { data, total, page: pagination.page, pageSize: pagination.pageSize, totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)) };
}

// Security headers
app.use(helmet());

// CORS - restrict to known origins
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://store.privtech.net',
  'http://store.privtech.net',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  credentials: true
}));

// Rate limiting - general
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  // Right for real traffic. A full test run makes thousands of calls across seven suites and
  // two backends, so it raises this rather than the suites being written around the ceiling.
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 200,
  // Product images are read-only and public. Meta's crawler fetches one per catalogue item in a
  // burst from the same few addresses, which would otherwise hit the ceiling and get images rejected.
  skip: (req) => req.method === 'GET' && req.path.startsWith('/api/v1/store/product-image/'),
  message: { error: 'Too many requests, please try again later' }
}));

// Stricter rate limit for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Deliberately low in production. A test run authenticates as several people per suite,
  // so it raises this rather than contorting the tests around it.
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 15,
  message: { error: 'Too many login attempts, please try again later' }
});

app.use(express.json({ limit: '2mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'biztrack-default-secret';

// The slice of a sale that can earn commission. Two rules combine here:
//   1. Only the goods count. The delivery fee billed to the customer (shippingCharge) is
//      pass-through money that pays the courier, so it earns no commission — a K1,000 order
//      with K200 shipping is commissioned as K1,000, not K1,200.
//   2. Only money actually collected counts. A partial payment is prorated across the whole
//      bill, so half-paid means half the goods value is commissionable.
// Returns null for a sale with nothing to commission (zero/negative total).
function commissionableSale(sale) {
  const saleTotal = parseFloat(sale.totalPrice);
  if (!(saleTotal > 0)) return null;
  const goodsTotal = Math.max(0, saleTotal - (parseFloat(sale.shippingCharge) || 0));
  const paidFraction = Math.min(1, Math.max(0, (parseFloat(sale.amountPaid) || 0) / saleTotal));
  return { goodsTotal, paidFraction, collected: goodsTotal * paidFraction };
}

// Commission is always computed live from current Sale state (never persisted per-sale), so
// both rules above apply retroactively to every past cycle as soon as the underlying sale
// data reflects reality — they are not limited to new sales.
function calcCommission(payType, commissionRate, tierThreshold, tierRate, sales) {
  const rate = parseFloat(commissionRate);
  const tRate = parseFloat(tierRate);
  const threshold = parseFloat(tierThreshold) || 0;

  if (payType === 'revenue_pct') {
    let comm = 0;
    for (const sale of sales) {
      const c = commissionableSale(sale);
      if (!c || c.collected <= 0) continue;
      // The tier is judged on the goods value too, so a delivery fee can't push a sale over
      // the threshold and change the rate applied to the whole order.
      const r = (threshold > 0 && tRate > 0 && c.goodsTotal > threshold) ? tRate : rate;
      comm += c.collected * r / 100;
    }
    return Math.round(comm * 100) / 100;
  }

  // per_unit: tiered by cumulative units — first N at base rate, rest at tier rate.
  // Each sale's units are prorated by how much of that sale has actually been paid.
  // Shipping never added units, so this arm is unaffected by the goods-only rule.
  const th = parseInt(tierThreshold) || 50;
  let effectiveUnits = 0;
  for (const sale of sales) {
    const c = commissionableSale(sale);
    if (!c) continue;
    const units = sale.items.reduce((q, i) => q + i.qty, 0);
    effectiveUnits += units * c.paidFraction;
  }
  const comm = effectiveUnits <= th ? effectiveUnits * rate : (th * rate) + ((effectiveUnits - th) * tRate);
  return Math.round(comm * 100) / 100;
}

// Consultant pay period: [payDay current/prev month, payDay next/this month) — half-open.
function getConsultantPayPeriod(refDate, payDay = 11) {
  const d = new Date(refDate);
  const y = d.getFullYear(); const m = d.getMonth(); const day = d.getDate();
  const startsThisMonth = day >= payDay;
  const periodFrom = new Date(y, startsThisMonth ? m : m - 1, payDay, 0, 0, 0, 0);
  const periodTo   = new Date(y, startsThisMonth ? m + 1 : m, payDay, 0, 0, 0, 0);
  const payDate = periodTo;
  const label = `${payDate.getFullYear()}-${String(payDate.getMonth() + 1).padStart(2, '0')}`;
  return { periodFrom, periodTo, payDate, label };
}
function payPeriodFromLabel(label, payDay = 11) {
  const [y, m] = label.split('-').map(Number);
  const periodTo   = new Date(y, m - 1, payDay, 0, 0, 0, 0);
  const periodFrom = new Date(y, m - 2, payDay, 0, 0, 0, 0);
  return { periodFrom, periodTo, payDate: periodTo, label };
}
function getEffectivePeriod(periodFrom, periodTo, startDate) {
  const cycleMs = periodTo - periodFrom;
  if (!startDate) return { effectiveFrom: periodFrom, effectiveTo: periodTo, factor: 1, prorated: false };
  const start = new Date(startDate);
  if (start <= periodFrom) return { effectiveFrom: periodFrom, effectiveTo: periodTo, factor: 1, prorated: false };
  if (start >= periodTo) return null;
  return { effectiveFrom: start, effectiveTo: periodTo, factor: (periodTo - start) / cycleMs, prorated: true };
}
async function getCompanyPayDay(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
  return company?.consultantPayDay || 11;
}

// Auth middleware
async function authenticateRaw(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    if (req.user.role === 'consultant') {
      const consultant = await prisma.consultant.findFirst({ where: { userId: req.user.id, companyId: req.user.companyId }, select: { id: true, isActive: true } });
      if (!consultant) return res.status(403).json({ error: 'No consultant profile linked to this account' });
      if (!consultant.isActive) return res.status(403).json({ error: 'Your consultant account is inactive' });
      req.user.consultantId = consultant.id;
    }
    // Same for riders: resolve Rider.id so every delivery query can be scoped to their own runs
    if (req.user.role === 'rider') {
      const rider = await prisma.rider.findFirst({ where: { userId: req.user.id, companyId: req.user.companyId }, select: { id: true, isActive: true } });
      if (!rider) return res.status(403).json({ error: 'No rider profile linked to this account' });
      if (!rider.isActive) return res.status(403).json({ error: 'Your rider account is inactive' });
      req.user.riderId = rider.id;
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// A rider's world is his own runs and his own money, and that is the whole of it. Listing what
// he may reach — rather than guarding each endpoint he may not — means a new endpoint is closed
// to him by default instead of exposed until somebody remembers. The rider app only ever calls
// these paths. (mirrored in server/src/middleware/auth.js)
const RIDER_ALLOWED_PATHS = [
  /^\/api\/v1\/auth\//,
  /^\/api\/v1\/deliveries\/my(\/|$)/,
  // Moving one of his own deliveries along; the handler scopes it to his riderId.
  /^\/api\/v1\/deliveries\/[^/]+\/status$/,
  // Recording a courier run he took as gone out; the handler refuses any run that is not his.
  /^\/api\/v1\/deliveries\/runs\/[^/]+\/dispatch$/,
  // Asking for a salary advance and following it; the handlers scope it to his own pay profile.
  /^\/api\/v1\/advances\/mine(\/|$)/,
];

function enforceRiderScope(req, res, next) {
  if (req.user?.role !== 'rider') return next();
  const path = (req.originalUrl || '').split('?')[0];
  if (RIDER_ALLOWED_PATHS.some(re => re.test(path))) return next();
  return res.status(403).json({ error: 'Riders can only reach their own runs and their own money' });
}

// Every route in this file authenticates through here, so the boundary cannot be forgotten.
function authenticate(req, res, next) {
  authenticateRaw(req, res, (err) => {
    if (err) return next(err);
    if (res.headersSent) return;
    enforceRiderScope(req, res, next);
  });
}

function requireSuperadmin(req, res, next) {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireAdminOrInventory(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin' && req.user.role !== 'inventory') {
    return res.status(403).json({ error: 'Admin or inventory access required' });
  }
  next();
}

function requireAdminOrPurchasing(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin' && req.user.role !== 'purchasing') {
    return res.status(403).json({ error: 'Admin or purchasing access required' });
  }
  next();
}

// ---- INPUT VALIDATION ----
function sanitizeString(val, maxLength = 500) {
  if (typeof val !== 'string') return val;
  return val.trim().slice(0, maxLength);
}

function validateRegister(req, res, next) {
  const { companyName, username, password, name } = req.body;
  if (!companyName || !username || !password || !name) {
    return res.status(400).json({ error: 'Company name, username, password, and name are required' });
  }
  if (typeof username !== 'string' || username.length < 3 || username.length > 50) {
    return res.status(400).json({ error: 'Username must be 3-50 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be 6-128 characters' });
  }
  if (typeof name !== 'string' || name.length < 1 || name.length > 100) {
    return res.status(400).json({ error: 'Name must be 1-100 characters' });
  }
  if (typeof companyName !== 'string' || companyName.length < 2 || companyName.length > 100) {
    return res.status(400).json({ error: 'Company name must be 2-100 characters' });
  }
  req.body.username = sanitizeString(username, 50);
  req.body.name = sanitizeString(name, 100);
  req.body.companyName = sanitizeString(companyName, 100);
  next();
}

function validateLogin(req, res, next) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid input' });
  }
  next();
}

function validateProduct(req, res, next) {
  const { name, costPrice, sellingPrice } = req.body;
  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 200) {
    return res.status(400).json({ error: 'Product name is required (max 200 characters)' });
  }
  if (costPrice !== undefined && (isNaN(costPrice) || Number(costPrice) < 0)) {
    return res.status(400).json({ error: 'Cost price must be a non-negative number' });
  }
  if (sellingPrice !== undefined && (isNaN(sellingPrice) || Number(sellingPrice) < 0)) {
    return res.status(400).json({ error: 'Selling price must be a non-negative number' });
  }
  if (req.body.originalPrice !== undefined && req.body.originalPrice !== null && req.body.originalPrice !== '' && (isNaN(req.body.originalPrice) || Number(req.body.originalPrice) < 0)) {
    return res.status(400).json({ error: 'Original price must be a non-negative number' });
  }
  if (req.body.groupId !== undefined && req.body.groupId !== null && typeof req.body.groupId !== 'string') {
    return res.status(400).json({ error: 'Invalid product group' });
  }
  req.body.name = sanitizeString(name, 200);
  if (req.body.description) req.body.description = sanitizeString(req.body.description, 1000);
  if (req.body.category) req.body.category = sanitizeString(req.body.category, 100);
  if (req.body.variantLabel) req.body.variantLabel = sanitizeString(req.body.variantLabel, 100);
  if (req.body.brand !== undefined) req.body.brand = typeof req.body.brand === 'string' && req.body.brand.trim() ? sanitizeString(req.body.brand, 100) : null;
  // ZRA Smart Invoice. Whether an item is registered with ZRA is BizTrack's to record, never the form's.
  delete req.body.zraRegisteredAt;
  if (req.body.zraClassCode !== undefined) req.body.zraClassCode = typeof req.body.zraClassCode === 'string' && req.body.zraClassCode.trim() ? sanitizeString(req.body.zraClassCode, 20) : null;
  if (req.body.zraTaxCategory !== undefined) {
    const cat = typeof req.body.zraTaxCategory === 'string' ? req.body.zraTaxCategory.trim() : '';
    if (cat && !['A', 'C1', 'C2', 'C3', 'D', 'E', 'TOT'].includes(cat)) return res.status(400).json({ error: 'Unknown ZRA tax category' });
    req.body.zraTaxCategory = cat || null;
  }
  next();
}

function validateSale(req, res, next) {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  for (const item of items) {
    if (!item.productId || typeof item.productId !== 'string') {
      return res.status(400).json({ error: 'Each item must have a valid productId' });
    }
    if (!item.qty || isNaN(item.qty) || Number(item.qty) < 1) {
      return res.status(400).json({ error: 'Each item must have a quantity of at least 1' });
    }
  }
  if (req.body.customerName) req.body.customerName = sanitizeString(req.body.customerName, 200);
  if (req.body.customerPhone) req.body.customerPhone = sanitizeString(req.body.customerPhone, 30);
  if (req.body.notes) req.body.notes = sanitizeString(req.body.notes, 1000);
  next();
}

function validateQuote(req, res, next) {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  for (const item of items) {
    if (!item.productId || typeof item.productId !== 'string') {
      return res.status(400).json({ error: 'Each item must have a valid productId' });
    }
    if (!item.qty || isNaN(item.qty) || Number(item.qty) < 1) {
      return res.status(400).json({ error: 'Each item must have a quantity of at least 1' });
    }
  }
  if (req.body.discount !== undefined && (isNaN(req.body.discount) || Number(req.body.discount) < 0)) {
    return res.status(400).json({ error: 'Discount must be a non-negative number' });
  }
  if (req.body.customerName) req.body.customerName = sanitizeString(req.body.customerName, 200);
  if (req.body.customerPhone) req.body.customerPhone = sanitizeString(req.body.customerPhone, 30);
  if (req.body.customerCity) req.body.customerCity = sanitizeString(req.body.customerCity, 100);
  if (req.body.notes) req.body.notes = sanitizeString(req.body.notes, 1000);
  next();
}

function validateExpense(req, res, next) {
  const { description, amount, category } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'Description is required' });
  }
  if (amount === undefined || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }
  if (!category || typeof category !== 'string') {
    return res.status(400).json({ error: 'Category is required' });
  }
  req.body.description = sanitizeString(description, 500);
  req.body.category = sanitizeString(category, 100);
  next();
}

function validateCustomer(req, res, next) {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 200) {
    return res.status(400).json({ error: 'Customer name is required (max 200 characters)' });
  }
  req.body.name = sanitizeString(name, 200);
  if (req.body.phone) req.body.phone = sanitizeString(req.body.phone, 30);
  if (req.body.email) req.body.email = sanitizeString(req.body.email, 200);
  next();
}

// ---- AUTH ----
app.post('/api/v1/auth/register', authLimiter, validateRegister, async (req, res) => {
  try {
    const { companyName, username, password, name } = req.body;

    const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const existing = await prisma.company.findUnique({ where: { slug } });
    if (existing) return res.status(400).json({ error: 'A company with a similar name already exists' });

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) return res.status(400).json({ error: 'Username already taken' });

    const company = await prisma.company.create({ data: { name: companyName, slug } });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, password: hashedPassword, name, role: 'admin', companyId: company.id }
    });

    // Create default settings
    const defaults = [
      { key: 'currency', value: 'ZMW', companyId: company.id },
      { key: 'businessName', value: companyName, companyId: company.id },
      { key: 'currencySymbol', value: 'K', companyId: company.id }
    ];
    for (const s of defaults) {
      await prisma.setting.create({ data: s });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, companyId: company.id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, companyId: company.id, companyName: company.name } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/auth/login', authLimiter, validateLogin, async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username }, include: { company: true } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.company && !user.company.isActive) {
      return res.status(403).json({ error: 'Your company account has been suspended. Contact the system administrator.' });
    }
    let consultantId = null;
    if (user.role === 'consultant') {
      const c = await prisma.consultant.findUnique({ where: { userId: user.id }, select: { id: true } });
      consultantId = c?.id || null;
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, companyId: user.companyId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, companyId: user.companyId, companyName: user.company?.name || null, consultantId } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/auth/me', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { company: true } });
    if (!user) return res.status(401).json({ error: 'User not found' });
    let consultantId = null;
    if (user.role === 'consultant') {
      const c = await prisma.consultant.findUnique({ where: { userId: user.id }, select: { id: true } });
      consultantId = c?.id || null;
    }
    res.json({ id: user.id, username: user.username, name: user.name, role: user.role, companyId: user.companyId, companyName: user.company?.name || null, consultantId });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PRODUCTS ----
// What the Meta catalogue feed would publish right now, and every active product it leaves out with
// the reason — the place to look when Commerce Manager shows fewer items than the store.
app.get('/api/v1/products/meta-feed', authenticate, requireAdmin, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { id: req.user.companyId } });
    const settings = await loadFeedSettings(prisma, company.id);
    const origins = metaOrigins(company.slug, req);
    const feed = await buildMetaFeed(prisma, company, settings, origins);
    const token = settings.secret ? `?token=${encodeURIComponent(settings.secret)}` : '';
    res.json({
      enabled: settings.enabled,
      fallbackBrand: settings.fallbackBrand || null,
      feedUrl: `${origins.origin}/api/v1/store/${company.slug}/meta-feed.csv${token}`,
      included: feed.rows.length,
      excluded: feed.excluded,
      outOfStock: feed.rows.filter(r => r.availability === 'out of stock').length,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/products/meta/categories', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const products = await prisma.product.findMany({ where: { companyId, category: { not: null } }, select: { category: true }, distinct: ['category'] });
    res.json(products.map(p => p.category).filter(Boolean));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PRODUCT GROUPS (variant families, e.g. "T-Shirt" grouping Red/Blue/Green) ----
// Registered before /:id so Express doesn't treat "groups" as a product id.
app.get('/api/v1/products/groups', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const groups = await prisma.productGroup.findMany({
      where: { companyId },
      orderBy: { name: 'asc' },
      include: { products: { select: { id: true, name: true, variantLabel: true, sku: true, stock: true, isActive: true } } },
    });
    res.json(groups);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/products/groups', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Group name is required' });
    const group = await prisma.productGroup.create({ data: { name, companyId } });
    res.status(201).json(group);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/products/groups/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.productGroup.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Group not found' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Group name is required' });
    const group = await prisma.productGroup.update({ where: { id: req.params.id }, data: { name } });
    res.json(group);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Diagnostic: list products whose imageUrl is not a valid data URL (broken images)
app.get('/api/v1/products/broken-images', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const products = await prisma.product.findMany({ where: { companyId, imageUrl: { not: null } }, select: { id: true, name: true, sku: true, imageUrl: true } });
    const broken = products.filter(p => !/^data:image\//.test(p.imageUrl)).map(p => ({ id: p.id, name: p.name, sku: p.sku, preview: p.imageUrl?.slice(0, 60) }));
    res.json({ count: broken.length, products: broken });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

const PRODUCT_SELECT_LIST = { id: true, name: true, sku: true, description: true, category: true, brand: true, zraClassCode: true, zraTaxCategory: true, zraRegisteredAt: true, costPrice: true, sellingPrice: true, originalPrice: true, stock: true, reorderLevel: true, supplier: true, isActive: true, createdAt: true, updatedAt: true, companyId: true, groupId: true, variantLabel: true, group: { select: { id: true, name: true } } };
const PRODUCT_SORT_FIELDS = ['name', 'sku', 'category', 'costPrice', 'sellingPrice', 'stock', 'createdAt'];

async function attachProductImages(companyId, products) {
  if (!products.length) return products;
  const withImages = await prisma.product.findMany({ where: { companyId, id: { in: products.map(p => p.id) }, imageUrl: { not: null } }, select: { id: true } });
  const imageIds = new Set(withImages.map(p => p.id));
  return products.map(p => ({ ...p, imageUrl: imageIds.has(p.id) ? `/api/v1/store/product-image/${p.id}` : null }));
}

app.get('/api/v1/products', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { search, category, lowStock, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }]; }
    if (category) where.category = category;

    const pagination = parsePagination(req.query);

    // Plain column sorts with no low-stock filter can be pushed to the DB directly.
    const canPushSort = pagination && sortBy && PRODUCT_SORT_FIELDS.includes(sortBy) && lowStock !== 'true';
    if (canPushSort) {
      const [total, rows] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({ where, select: PRODUCT_SELECT_LIST, orderBy: { [sortBy]: sortDir === 'desc' ? 'desc' : 'asc' }, skip: pagination.skip, take: pagination.take }),
      ]);
      let products = await attachProductImages(companyId, rows);
      if (req.user.role === 'consultant') products = products.map(({ costPrice, supplier, reorderLevel, ...rest }) => rest);
      else if (req.user.role === 'inventory') products = products.map(({ costPrice, supplier, ...rest }) => rest);
      return res.json(paginatedResponse(products, total, pagination));
    }

    // Margin is derived from costPrice/sellingPrice, not a DB column — compute across the
    // whole filtered set, then slice the requested page before responding. Same for lowStock,
    // since Prisma can't compare stock <= reorderLevel (two columns) directly in a where clause.
    let products = await prisma.product.findMany({ where, select: PRODUCT_SELECT_LIST, orderBy: { createdAt: 'desc' } });
    products = await attachProductImages(companyId, products);

    if (sortBy === 'margin') {
      products = products
        .map(p => ({ ...p, _margin: parseFloat(p.sellingPrice) > 0 ? (parseFloat(p.sellingPrice) - parseFloat(p.costPrice)) / parseFloat(p.sellingPrice) : 0 }))
        .sort((a, b) => sortDir === 'desc' ? b._margin - a._margin : a._margin - b._margin)
        .map(({ _margin, ...rest }) => rest);
    }

    if (lowStock === 'true') products = products.filter(p => p.stock <= p.reorderLevel);
    if (req.user.role === 'consultant') products = products.map(({ costPrice, supplier, reorderLevel, ...rest }) => rest);
    else if (req.user.role === 'inventory') products = products.map(({ costPrice, supplier, ...rest }) => rest);

    if (pagination) {
      const total = products.length;
      const pageRows = products.slice(pagination.skip, pagination.skip + pagination.take);
      return res.json(paginatedResponse(pageRows, total, pagination));
    }
    res.json(products);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/products/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const product = await prisma.product.findFirst({ where: { id: req.params.id, companyId }, include: { stockLogs: { orderBy: { createdAt: 'desc' }, take: 50 }, group: true } });
    if (!product) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'consultant') {
      const { costPrice, supplier, reorderLevel, stockLogs, ...rest } = product;
      return res.json(rest);
    }
    if (req.user.role === 'inventory') {
      const { costPrice, supplier, ...rest } = product;
      return res.json(rest);
    }
    res.json(product);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/products/:id/stock-log', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const logs = await prisma.stockLog.findMany({ where: { productId: req.params.id, companyId }, orderBy: { createdAt: 'desc' } });
    res.json(logs);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/products', authenticate, requireAdmin, validateProduct, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = { ...req.body, companyId };
    if (data.groupId) {
      const group = await prisma.productGroup.findFirst({ where: { id: data.groupId, companyId } });
      if (!group) return res.status(400).json({ error: 'Invalid product group' });
    }
    if (!data.sku) { const count = await prisma.product.count({ where: { companyId } }); data.sku = `SKU-${String(count + 1).padStart(4, '0')}`; }
    const product = await prisma.product.create({ data });
    if (data.stock && data.stock > 0) {
      await prisma.stockLog.create({ data: { productId: product.id, change: data.stock, reason: 'Initial Stock', companyId } });
      await prisma.expense.create({ data: { description: `Stock purchase: ${product.name} (${data.stock} units)`, amount: parseFloat(product.costPrice) * data.stock, category: 'Stock Purchase', companyId } });
    }
    res.status(201).json(product);
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'SKU already exists' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/v1/products/:id', authenticate, requireAdmin, validateProduct, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.product.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    // Protect imageUrl from accidental overwrite: only accept data: URLs or null/empty (clear)
    if (data.imageUrl !== undefined && data.imageUrl !== null && data.imageUrl !== '' && !/^data:image\//.test(data.imageUrl)) {
      delete data.imageUrl;
    }
    if (data.groupId) {
      const group = await prisma.productGroup.findFirst({ where: { id: data.groupId, companyId } });
      if (!group) return res.status(400).json({ error: 'Invalid product group' });
    }
    // ZRA knows the item by its code, classification and tax category; change one and it is
    // registered again before it next appears on an invoice.
    if (['sku', 'zraClassCode', 'zraTaxCategory'].some(k => data[k] !== undefined && (data[k] || null) !== (existing[k] || null))) data.zraRegisteredAt = null;
    const stockChange = data.stock !== undefined ? data.stock - existing.stock : 0;
    const product = await prisma.product.update({ where: { id: req.params.id }, data });
    if (stockChange !== 0 && req.body.stock !== undefined) {
      await prisma.stockLog.create({ data: { productId: product.id, change: stockChange, reason: 'Manual Adjustment', companyId } });
    }
    res.json(product);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/products/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const product = await prisma.product.findFirst({ where: { id: req.params.id, companyId } });
    if (!product) return res.status(404).json({ error: 'Not found' });
    await prisma.product.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ message: 'Product deactivated' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/products/restock', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { items } = req.body;
    const results = [];
    for (const item of items) {
      const product = await prisma.product.findFirst({ where: { id: item.productId, companyId } });
      if (!product) continue;
      const updated = await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
      await prisma.stockLog.create({ data: { productId: item.productId, change: item.quantity, reason: 'Restock', companyId } });
      await prisma.expense.create({ data: { description: `Restock: ${product.name} (${item.quantity} units)`, amount: parseFloat(product.costPrice) * item.quantity, category: 'Stock Purchase', companyId } });
      results.push(updated);
    }
    res.json(results);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- Stock source helpers (mirror server/src/routes/sales.js) ----
async function deductStockForItem(db, item, sale, companyId) {
  const sourceId = item.stockSourceConsultantId;
  if (sourceId) {
    const cStock = await db.consultantStock.findUnique({ where: { consultantId_productId: { consultantId: sourceId, productId: item.productId } } });
    if (!cStock || cStock.qty < item.qty) {
      const consultant = await db.consultant.findUnique({ where: { id: sourceId }, select: { name: true } });
      const err = new Error(`${consultant?.name || 'Consultant'} has ${cStock?.qty || 0} units; ${item.qty} needed`);
      err.status = 400;
      throw err;
    }
    await db.consultantStock.update({ where: { consultantId_productId: { consultantId: sourceId, productId: item.productId } }, data: { qty: { decrement: item.qty } } });
    const consultant = await db.consultant.findUnique({ where: { id: sourceId }, select: { name: true } });
    await db.stockLog.create({ data: { productId: item.productId, change: -item.qty, reason: `Sale (from ${consultant?.name || 'consultant'})`, saleId: sale.id, companyId } });
    return;
  }
  if (sale.consultantId) {
    const cStock = await db.consultantStock.findUnique({ where: { consultantId_productId: { consultantId: sale.consultantId, productId: item.productId } } });
    if (cStock && cStock.qty >= item.qty) {
      await db.consultantStock.update({ where: { consultantId_productId: { consultantId: sale.consultantId, productId: item.productId } }, data: { qty: { decrement: item.qty } } });
      await db.stockLog.create({ data: { productId: item.productId, change: -item.qty, reason: 'Sale (consultant stock)', saleId: sale.id, companyId } });
      return;
    }
  }
  await db.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.qty } } });
  await db.stockLog.create({ data: { productId: item.productId, change: -item.qty, reason: 'Sale (from Main)', saleId: sale.id, companyId } });
}

async function refundStockForItem(db, item, sale, companyId, reason) {
  const sourceId = item.stockSourceConsultantId || sale.consultantId || null;
  if (sourceId) {
    await db.consultantStock.upsert({
      where: { consultantId_productId: { consultantId: sourceId, productId: item.productId } },
      update: { qty: { increment: item.qty } },
      create: { consultantId: sourceId, productId: item.productId, qty: item.qty, companyId }
    });
    const consultant = await db.consultant.findUnique({ where: { id: sourceId }, select: { name: true } });
    await db.stockLog.create({ data: { productId: item.productId, change: item.qty, reason: `${reason} (to ${consultant?.name || 'consultant'})`, saleId: sale.id, companyId } });
    return;
  }
  await db.product.update({ where: { id: item.productId }, data: { stock: { increment: item.qty } } });
  await db.stockLog.create({ data: { productId: item.productId, change: item.qty, reason, saleId: sale.id, companyId } });
}

// Whether an edit would change what a ZRA invoice says: the lines, the discount, the delivery
// charge, or the day of the sale. Anything else (notes, payment, contact details) can change.
function saleDay(d) {
  const day = new Date(d);
  return [day.toISOString().slice(0, 10), day.toLocaleDateString('en-CA', { timeZone: 'Africa/Lusaka' })];
}
function changesInvoiceFigures(existing, raw, newSaleItems) {
  const money = (v) => Math.round((parseFloat(v) || 0) * 100);
  if (raw.discount !== undefined && money(raw.discount) !== money(existing.discount)) return true;
  if (raw.shippingCharge !== undefined && money(raw.shippingCharge) !== money(existing.shippingCharge)) return true;
  if (raw.date && !saleDay(existing.date).includes(String(raw.date).slice(0, 10))) return true;
  if (newSaleItems) {
    const lines = (items) => items.map(i => `${i.productId}|${i.qty}|${money(i.unitPrice)}`).sort().join(',');
    if (lines(existing.items) !== lines(newSaleItems)) return true;
  }
  return false;
}

function normalizeItemStockSource(item, user) {
  const src = item.stockSourceConsultantId || null;
  if (user.role === 'consultant' && src && src !== user.consultantId) {
    const err = new Error('Consultants can only sell from their own stock or request Main fulfillment');
    err.status = 403;
    throw err;
  }
  return src;
}

// ---- ZRA SMART INVOICE ----
// ZRA Smart Invoice: reporting a company's sales to the Zambia Revenue Authority through its
// VSDC (the Virtual Sales Data Controller, ZRA's Java service the business runs), and keeping
// what ZRA hands back so it can be printed on the receipt. (mirrored in server/src/utils/zra.js)
//
// Nothing here runs for a company unless the platform superadmin has switched it on. Field names
// follow ZRA's VSDC API specification v1.0.7 and its published sample requests; the code lists
// (payment types, units) are the parts most worth confirming against the sandbox.
//
// The rules that keep the books straight:
//   - A sale is reported once it is Confirmed, Shipped or Delivered — when stock leaves — and
//     never for anything dated before the company's start date.
//   - The invoice record is written in the same transaction as the sale, so nothing is lost if
//     the VSDC cannot be reached. Sending happens afterwards and is retried; the sale never waits
//     on ZRA and never fails because of it.
//   - Once a sale has an invoice, its figures are fixed. Cancelling it sends a credit note.

const ZRA_ISSUED_STATUSES = ['Confirmed', 'Shipped', 'Delivered'];

// The categories BizTrack can report, and the rate each carries. VAT (A) is included in the
// price, so 16% of a K116 sale is K16. Turnover tax is charged on the business's turnover, not
// on the customer, so a TOT invoice carries no tax amount.
const ZRA_TAX_CATEGORIES = { A: 16, C1: 0, C2: 0, C3: 0, D: 0, E: 0, TOT: 0 };

// Every header bucket saveSales expects, with the rates ZRA's sample requests send. The buckets
// BizTrack never fills still have to be present.
const ZRA_HEADER_BUCKETS = { A: 16, B: 16, C1: 0, C2: 0, C3: 0, D: 0, Rvat: 16, E: 0, F: 10, Ipl1: 5, Ipl2: 0, Tl: 1.5, Ecm: 5, Exeeg: 3, Tot: 0 };
const ZRA_BUCKET_FOR = { A: 'A', C1: 'C1', C2: 'C2', C3: 'C3', D: 'D', E: 'E', TOT: 'Tot' };

// pmtTyCd. Confirm against the VSDC's own code list (code/selectCodes) in the sandbox.
const ZRA_PAYMENT_CODES = { cash: '01', credit: '02', card: '05', mobile: '06', bank: '07' };

const ZRA_TIMEOUT_MS = 8000;
const ZRA_LOCK_MS = 60000;
const ZRA_DELIVERY_ITEM_CODE = 'DELIVERY';
const ZRA_REGISTRAR = 'BizTrack';

const zra_r2 = (n) => Math.round(n * 100) / 100;
const zra_r4 = (n) => Math.round(n * 10000) / 10000;

class ZraProblem extends Error {}

// ---- configuration ----

// What still has to be filled in before the switch can go on. An empty list means ready.
function zra_configProblems(c) {
  const p = [];
  if (!c) return ['Smart Invoice has not been set up'];
  if (!c.vsdcUrl) p.push('the VSDC address');
  else { try { zra_endpoint(c.vsdcUrl); } catch (e) { p.push(e.message); } }
  if (!/^\d{10}$/.test(c.tpin || '')) p.push('a 10-digit TPIN');
  if (!/^\d{3}$/.test(c.branchId || '')) p.push('a 3-digit branch ID');
  if (!c.deviceSerial) p.push('the device serial number');
  if (!ZRA_TAX_CATEGORIES.hasOwnProperty(c.defaultTaxCategory || '')) p.push('a default tax category');
  if (!/^[A-Z]{2}$/.test(c.originCountry || '')) p.push('a two-letter country of origin');
  if (!c.initialisedAt) p.push('initialising the device with ZRA');
  return p;
}

// The VSDC address, checked every time it is used, not only when it is saved: BizTrack's server
// makes this request, so only hosts the platform has approved in ZRA_ALLOWED_HOSTS are reachable.
function zra_endpoint(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new ZraProblem('The VSDC address is not a valid web address'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new ZraProblem('The VSDC address must be a plain http(s) address');
  }
  const allowed = (process.env.ZRA_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(u.hostname.toLowerCase())) {
    throw new ZraProblem(`${u.hostname} is not in ZRA_ALLOWED_HOSTS on the server`);
  }
  return u.toString().replace(/\/$/, '');
}

async function zra_post(config, path, body) {
  const url = zra_endpoint(config.vsdcUrl) + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZRA_TIMEOUT_MS);
  let res;
  try {
    // A redirect is refused rather than followed, so the allow-list cannot be stepped around.
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal, redirect: 'manual' });
  } catch (e) {
    return { reached: false, error: e.name === 'AbortError' ? 'The VSDC did not answer in time' : `Could not reach the VSDC (${e.cause?.code || e.message})` };
  } finally { clearTimeout(timer); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) return { reached: false, error: `The VSDC answered HTTP ${res.status}` };
  if (json.resultCd !== '000') return { reached: true, ok: false, code: json.resultCd, error: `ZRA said: ${json.resultMsg || 'refused'} (code ${json.resultCd})`, body: json };
  return { reached: true, ok: true, body: json };
}

// ---- dates, in Zambian time whatever the server's clock is set to ----

function zra_parts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lusaka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return p;
}
const zra_date = (d) => { const p = zra_parts(d); return `${p.year}${p.month}${p.day}`; };
const zra_dateTime = (d) => { const p = zra_parts(d); return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`; };

function zra_paymentCode(sale) {
  if (sale.paymentType === 'Credit') return ZRA_PAYMENT_CODES.credit;
  const m = (sale.paymentMethod || '').toLowerCase();
  if (/mobile|momo|airtel|mtn|zamtel|lenco/.test(m)) return ZRA_PAYMENT_CODES.mobile;
  if (/card|visa|master/.test(m)) return ZRA_PAYMENT_CODES.card;
  if (/bank|transfer|eft/.test(m)) return ZRA_PAYMENT_CODES.bank;
  return ZRA_PAYMENT_CODES.cash;
}

// ---- the invoice ----

// The sale as ZRA lines: one per item, plus delivery when it was charged. A sale-wide discount is
// shared across the lines by value, so the lines always add up to what the customer paid.
function zra_lines(sale, config) {
  const problems = [];
  const lines = (sale.items || []).map(i => {
    const p = i.product || {};
    const category = p.zraTaxCategory || config.defaultTaxCategory;
    if (!p.zraClassCode) problems.push(`${p.name || 'A product'} has no ZRA item classification code`);
    if (!ZRA_TAX_CATEGORIES.hasOwnProperty(category || '')) problems.push(`${p.name || 'A product'} has an unknown tax category`);
    return {
      productId: p.id, code: p.sku, classCode: p.zraClassCode, kind: '2', category,
      name: [p.name, p.variantLabel].filter(Boolean).join(' - ').slice(0, 200),
      qty: i.qty, price: zra_r2(parseFloat(i.unitPrice)), supply: zra_r2(parseFloat(i.unitPrice) * i.qty),
    };
  });
  const delivery = zra_r2(parseFloat(sale.shippingCharge) || 0);
  if (delivery > 0) {
    if (!config.deliveryClassCode) problems.push('Delivery was charged, but no ZRA classification code is set for delivery');
    lines.push({ productId: null, code: ZRA_DELIVERY_ITEM_CODE, classCode: config.deliveryClassCode, kind: '3', category: config.defaultTaxCategory, name: 'Delivery', qty: 1, price: delivery, supply: delivery });
  }
  if (!lines.length) problems.push('The sale has no items');

  const gross = zra_r2(lines.reduce((s, l) => s + l.supply, 0));
  const discount = zra_r2(parseFloat(sale.discount) || 0);
  if (discount < 0 || discount > gross) problems.push('The discount is larger than the sale');
  let left = discount;
  lines.forEach((l, idx) => {
    const share = idx === lines.length - 1 ? left : zra_r2(gross ? (discount * l.supply) / gross : 0);
    l.discount = Math.min(share, l.supply);
    left = zra_r2(left - l.discount);
    l.total = zra_r2(l.supply - l.discount);
    const rate = ZRA_TAX_CATEGORIES[l.category] || 0;
    l.taxable = rate ? zra_r4(l.total / (1 + rate / 100)) : l.total;
    l.tax = rate ? zra_r4(l.total - l.taxable) : 0;
  });
  const total = zra_r2(lines.reduce((s, l) => s + l.total, 0));
  if (!problems.length && Math.abs(total - parseFloat(sale.totalPrice)) > 0.01) {
    problems.push(`The items come to K${total.toFixed(2)} but the sale total is K${parseFloat(sale.totalPrice).toFixed(2)}`);
  }
  return { lines, problems };
}

function zra_salePayload(doc, sale, config, lines, original) {
  const credit = doc.kind === 'credit_note';
  const now = new Date();
  const header = {};
  for (const [bucket, rate] of Object.entries(ZRA_HEADER_BUCKETS)) {
    const mine = lines.filter(l => ZRA_BUCKET_FOR[l.category] === bucket);
    header[`taxblAmt${bucket}`] = zra_r4(mine.reduce((s, l) => s + l.taxable, 0));
    header[`taxRt${bucket}`] = bucket === 'Tot' ? 0 : rate;
    header[`taxAmt${bucket}`] = zra_r4(mine.reduce((s, l) => s + l.tax, 0));
  }
  return {
    tpin: config.tpin, bhfId: config.branchId,
    ...(credit && { orgSdcId: original.sdcId }),
    orgInvcNo: credit ? original.rcptNo : 0,
    cisInvcNo: doc.invoiceNo,
    custTpin: null, custNm: (sale.customerName || 'Customer').slice(0, 60),
    salesTyCd: 'N', rcptTyCd: credit ? 'R' : 'S', pmtTyCd: zra_paymentCode(sale), salesSttsCd: '02',
    cfmDt: zra_dateTime(now), salesDt: zra_date(new Date(sale.date)),
    stockRlsDt: null, cnclReqDt: null, cnclDt: null,
    rfdDt: credit ? zra_dateTime(now) : null, rfdRsnCd: credit ? config.refundReasonCode : null,
    totItemCnt: lines.length,
    ...header,
    totTaxblAmt: zra_r4(lines.reduce((s, l) => s + l.taxable, 0)),
    totTaxAmt: zra_r4(lines.reduce((s, l) => s + l.tax, 0)),
    cashDcRt: 0, cashDcAmt: 0,
    totAmt: zra_r2(lines.reduce((s, l) => s + l.total, 0)),
    prchrAcptcYn: 'N', remark: credit ? `Cancels ${original.invoiceNo}` : '',
    regrId: ZRA_REGISTRAR, regrNm: ZRA_REGISTRAR, modrId: ZRA_REGISTRAR, modrNm: ZRA_REGISTRAR,
    saleCtyCd: '1', lpoNumber: null, currencyTyCd: 'ZMW', exchangeRt: '1',
    destnCountryCd: '', dbtRsnCd: '', invcAdjustReason: '',
    itemList: lines.map((l, idx) => ({
      itemSeq: idx + 1, itemCd: l.code, itemClsCd: l.classCode, itemNm: l.name, bcd: '',
      pkgUnitCd: config.pkgUnitCode, pkg: 0, qtyUnitCd: config.qtyUnitCode, qty: l.qty, prc: l.price, splyAmt: l.supply,
      dcRt: l.supply ? zra_r2((l.discount / l.supply) * 100) : 0, dcAmt: l.discount,
      isrccCd: '', isrccNm: '', isrcRt: 0, isrcAmt: 0,
      vatCatCd: l.category, exciseTxCatCd: null, tlCatCd: null, iplCatCd: null,
      vatTaxblAmt: l.taxable, vatAmt: l.tax,
      exciseTaxblAmt: 0, tlTaxblAmt: 0, iplTaxblAmt: 0, iplAmt: 0, tlAmt: 0, exciseTxAmt: 0,
      totAmt: l.total,
    })),
  };
}

function zra_itemPayload(config, line) {
  return {
    tpin: config.tpin, bhfId: config.branchId,
    itemCd: line.code, itemClsCd: line.classCode, itemTyCd: line.kind, itemNm: line.name, itemStdNm: null,
    orgnNatCd: config.originCountry, pkgUnitCd: config.pkgUnitCode, qtyUnitCd: config.qtyUnitCode,
    vatCatCd: line.category, iplCatCd: null, tlCatCd: null, exciseTxCatCd: null,
    btchNo: null, bcd: null, dftPrc: line.price, manufacturerTpin: null, manufacturerItemCd: null, rrp: null,
    svcChargeYn: 'N', rentalYn: 'N', addInfo: null, sftyQty: 0, isrcAplcbYn: 'N', useYn: 'Y',
    regrNm: ZRA_REGISTRAR, regrId: ZRA_REGISTRAR, modrNm: ZRA_REGISTRAR, modrId: ZRA_REGISTRAR,
  };
}

// ZRA must know an item before it appears on an invoice. Registered once; if ZRA already has
// it (the code was registered before a classification change), it is updated instead.
async function zra_register(config, line) {
  const body = zra_itemPayload(config, line);
  const saved = await zra_post(config, '/items/saveItem', body);
  if (!saved.reached || saved.ok) return saved;
  const updated = await zra_post(config, '/items/updateItem', body);
  return updated.reached && !updated.ok ? saved : updated;
}

// ---- recording, in the sale's own transaction ----

// Called inside the transaction that saved the sale. Writes the invoice when the sale has
// happened, and the credit note when an invoiced sale is cancelled. A credit note is written
// even if Smart Invoice has since been switched off: an invoice ZRA holds must be cancelled.
// Returns whether it wrote anything.
async function zra_recordSale(tx, companyId, saleId) {
  const sale = await tx.sale.findFirst({ where: { id: saleId, companyId }, select: { id: true, status: true, date: true, orderNumber: true, fiscalDocuments: { select: { kind: true } } } });
  if (!sale) return false;
  const has = (k) => sale.fiscalDocuments.some(d => d.kind === k);
  if (sale.status === 'Cancelled') {
    if (has('invoice') && !has('credit_note')) {
      await tx.fiscalDocument.create({ data: { saleId, kind: 'credit_note', invoiceNo: `${sale.orderNumber}-CN`, companyId } });
      return true;
    }
    return false;
  }
  if (!ZRA_ISSUED_STATUSES.includes(sale.status) || has('invoice')) return false;
  const config = await tx.zraConfig.findUnique({ where: { companyId } });
  if (!config?.enabled) return false;
  if (config.startDate && new Date(sale.date) < new Date(config.startDate)) return false;
  await tx.fiscalDocument.create({ data: { saleId, kind: 'invoice', invoiceNo: sale.orderNumber, companyId } });
  return true;
}

// What a change to a sale would do to an invoice ZRA may already hold. Returns the reason to
// refuse it, or null. change: { delete: true } | { figures: true } | { status: 'X' }
async function zra_refuseChange(prisma, companyId, saleId, change) {
  const docs = await prisma.fiscalDocument.findMany({ where: { saleId, companyId }, select: { kind: true } });
  if (!docs.length) return null;
  const credited = docs.some(d => d.kind === 'credit_note');
  if (change.delete) return 'This sale has a ZRA Smart Invoice, so it cannot be deleted. Cancel it instead and BizTrack sends ZRA a credit note.';
  if (change.figures) return 'This sale has a ZRA Smart Invoice, so its items, prices, discount, delivery charge and date are fixed. Cancel it (BizTrack sends a credit note) and record it again.';
  if (change.status !== undefined) {
    if (credited && change.status !== 'Cancelled') return 'ZRA has a credit note cancelling this sale. Record it again as a new sale.';
    if (!credited && change.status !== 'Cancelled' && !ZRA_ISSUED_STATUSES.includes(change.status)) {
      return `This sale has a ZRA Smart Invoice, so it cannot go back to ${change.status}. Cancel it instead and BizTrack sends ZRA a credit note.`;
    }
  }
  return null;
}

// ---- sending ----

async function zra_settle(prisma, doc, data) {
  await prisma.fiscalDocument.update({ where: { id: doc.id }, data: { ...data, lockedUntil: null } });
}

// Sends one invoice or credit note. Never throws: whatever happens is written on the document.
async function zra_send(prisma, docId, { deadline = Date.now() + 20000, includeFailed = true } = {}) {
  const now = new Date();
  const claimed = await prisma.fiscalDocument.updateMany({
    where: { id: docId, status: { in: includeFailed ? ['pending', 'failed'] : ['pending'] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + ZRA_LOCK_MS) },
  });
  if (!claimed.count) return;
  const doc = await prisma.fiscalDocument.findUnique({ where: { id: docId } });
  const tried = { attempts: doc.attempts + 1, lastAttemptAt: new Date() };
  try {
    const config = await prisma.zraConfig.findUnique({ where: { companyId: doc.companyId } });
    if (!config?.enabled) return zra_settle(prisma, doc, {});
    const setup = zra_configProblems(config);
    if (setup.length) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: `Smart Invoice set-up is missing ${setup.join(', ')}` });

    let original = null;
    if (doc.kind === 'credit_note') {
      original = await prisma.fiscalDocument.findFirst({ where: { saleId: doc.saleId, kind: 'invoice' } });
      // The invoice goes first; the credit note waits for it without counting as an attempt.
      if (original?.status !== 'issued') return zra_settle(prisma, doc, { lastError: 'Waiting for the invoice it cancels to be issued' });
      if (!config.refundReasonCode) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: 'Smart Invoice set-up is missing the credit note reason code' });
    }

    const sale = await prisma.sale.findUnique({ where: { id: doc.saleId }, include: { items: { include: { product: true } } } });
    const { lines, problems } = zra_lines(sale, config);
    if (problems.length) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: problems.join('; ') });

    const done = new Set();
    for (const line of lines) {
      const registered = line.productId ? sale.items.find(i => i.productId === line.productId).product.zraRegisteredAt : config.deliveryRegisteredAt;
      if (registered || done.has(line.code)) continue;
      if (Date.now() > deadline) return zra_settle(prisma, doc, {});
      const r = await zra_register(config, line);
      if (!r.reached) return zra_settle(prisma, doc, { ...tried, status: 'pending', lastError: r.error });
      if (!r.ok) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: `Registering ${line.name}: ${r.error}` });
      done.add(line.code);
      if (line.productId) await prisma.product.update({ where: { id: line.productId }, data: { zraRegisteredAt: new Date() } });
      else await prisma.zraConfig.update({ where: { id: config.id }, data: { deliveryRegisteredAt: new Date() } });
    }

    if (Date.now() > deadline) return zra_settle(prisma, doc, {});
    const payload = zra_salePayload(doc, sale, config, lines, original);
    const r = await zra_post(config, '/trnsSales/saveSales', payload);
    if (!r.reached) return zra_settle(prisma, doc, { ...tried, status: 'pending', lastError: r.error, request: payload });
    if (!r.ok) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: r.error, request: payload });
    const d = r.body.data || {};
    const rcptNo = parseInt(d.rcptNo, 10);
    return zra_settle(prisma, doc, {
      ...tried, status: 'issued', lastError: null, request: payload, issuedAt: new Date(),
      rcptNo: Number.isFinite(rcptNo) ? rcptNo : null, sdcId: d.sdcId ?? null, mrcNo: d.mrcNo ?? null,
      intrlData: d.intrlData ?? null, rcptSign: d.rcptSign ?? null, receiptDate: d.vsdcRcptPbctDate ?? null, qrCodeUrl: d.qrCodeUrl ?? null,
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'zra_send_error', docId, message: e.message }));
    return zra_settle(prisma, doc, { ...tried, status: e instanceof ZraProblem ? 'failed' : 'pending', lastError: e instanceof ZraProblem ? e.message : `Unexpected error: ${e.message}` });
  }
}

// Sends what is waiting for a company, oldest first. Without includeFailed only what is merely
// waiting is retried; a refusal stays put until someone has fixed it and asks again.
async function zra_sendWaiting(prisma, companyId, { includeFailed = false, limit = 10, deadline = Date.now() + 20000 } = {}) {
  const docs = await prisma.fiscalDocument.findMany({
    where: { companyId, status: { in: includeFailed ? ['pending', 'failed'] : ['pending'] } },
    orderBy: [{ createdAt: 'asc' }], take: limit, select: { id: true },
  });
  for (const d of docs) {
    if (Date.now() > deadline) break;
    await zra_send(prisma, d.id, { deadline, includeFailed });
  }
}

// After a sale is saved: send its own documents straight away, then a few others that are
// waiting, so a VSDC that was down catches up as soon as the shop is busy again. Never throws.
async function zra_afterSave(prisma, companyId, saleId) {
  try {
    const config = await prisma.zraConfig.findUnique({ where: { companyId }, select: { enabled: true } });
    if (!config?.enabled) return false;
    const mine = await prisma.fiscalDocument.findMany({ where: { saleId, companyId, status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const deadline = Date.now() + 20000;
    for (const d of mine) await zra_send(prisma, d.id, { deadline, includeFailed: false });
    await zra_sendWaiting(prisma, companyId, { limit: 3, deadline });
    return mine.length > 0;
  } catch (e) {
    console.error(JSON.stringify({ event: 'zra_after_save_error', saleId, message: e.message }));
    return false;
  }
}

// What a sale screen or receipt needs to know about its ZRA documents.
const ZRA_DOC_SELECT = { id: true, kind: true, status: true, invoiceNo: true, lastError: true, issuedAt: true, rcptNo: true, sdcId: true, mrcNo: true, intrlData: true, rcptSign: true, receiptDate: true, qrCodeUrl: true };

// ---- SALES ----
// Lightweight poll target for the admin bell icon — only online-store orders, admin-only.
app.get('/api/v1/sales/notifications/new', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const since = req.query.since ? new Date(req.query.since) : new Date(0);
    const where = { companyId, source: 'Online Store', createdAt: { gt: since } };
    const [count, orders] = await Promise.all([
      prisma.sale.count({ where }),
      prisma.sale.findMany({ where, select: { id: true, orderNumber: true, customerName: true, totalPrice: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    res.json({ count, orders });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/sales/credit/summary', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const saleWhere = { companyId, paymentType: 'Credit', paymentStatus: { not: 'Paid' } };
    if (req.user.role === 'consultant') saleWhere.consultantId = req.user.consultantId;
    const creditSales = await prisma.sale.findMany({ where: saleWhere, include: { customer: true } });
    const now = new Date();
    let totalOutstanding = 0, overdueCount = 0, overdueAmount = 0;
    const debtorMap = {};
    creditSales.forEach(s => {
      const balance = parseFloat(s.totalPrice) - parseFloat(s.amountPaid);
      totalOutstanding += balance;
      const isOverdue = s.creditDueDate && new Date(s.creditDueDate) < now;
      if (isOverdue) { overdueCount++; overdueAmount += balance; }
      const key = s.customerId || s.customerName || 'Unknown';
      if (!debtorMap[key]) debtorMap[key] = { customerId: s.customerId, customerName: s.customerName || s.customer?.name || 'Unknown', customerPhone: s.customerPhone || s.customer?.phone, whatsapp: s.customer?.whatsapp, totalOwed: 0, salesCount: 0, oldestDueDate: null };
      debtorMap[key].totalOwed += balance;
      debtorMap[key].salesCount++;
      if (s.creditDueDate && (!debtorMap[key].oldestDueDate || new Date(s.creditDueDate) < new Date(debtorMap[key].oldestDueDate))) debtorMap[key].oldestDueDate = s.creditDueDate;
    });
    const topDebtors = Object.values(debtorMap).sort((a, b) => b.totalOwed - a.totalOwed);
    const paymentWhere = { companyId };
    if (req.user.role === 'consultant') paymentWhere.sale = { consultantId: req.user.consultantId };
    const recentPayments = await prisma.creditPayment.findMany({ where: paymentWhere, orderBy: { createdAt: 'desc' }, take: 10, include: { sale: { select: { orderNumber: true, customerName: true } } } });
    res.json({ totalOutstanding, overdueCount, overdueAmount, topDebtors, recentPayments });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- SALES REPORT (day/week/month, mirrors server/src/routes/sales.js) ----
// The period shape (day/week/month) is entirely a client-side concern — this endpoint just
// takes an inclusive from/to range, so a "day" report is simply from === to.
app.get('/api/v1/sales/reports/daily', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const today = new Date().toISOString().slice(0, 10);
    const from = req.query.from || req.query.date || today;
    const to = req.query.to || from;
    const rangeStart = new Date(from + 'T00:00:00.000Z');
    const rangeEnd = new Date(to + 'T23:59:59.999Z');

    const where = { companyId, date: { gte: rangeStart, lte: rangeEnd }, status: { not: 'Cancelled' } };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    else if (req.query.consultantId) where.consultantId = req.query.consultantId;

    const sales = await prisma.sale.findMany({
      where,
      include: {
        items: { include: { product: { select: { name: true } } } },
        consultant: { select: { id: true, name: true } },
        customer: { select: { name: true, phone: true } },
        paymentNotes: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { paymentNotes: true } },
      },
      orderBy: { date: 'asc' },
    });

    let totalRevenue = 0, paidCount = 0, paidAmount = 0, partialCount = 0, partialOutstanding = 0, unpaidCount = 0, unpaidAmount = 0;
    const orders = sales.map(s => {
      const total = parseFloat(s.totalPrice);
      const amountPaid = parseFloat(s.amountPaid);
      totalRevenue += total;
      if (s.paymentStatus === 'Paid') { paidCount++; paidAmount += total; }
      else if (s.paymentStatus === 'Partial') { partialCount++; partialOutstanding += (total - amountPaid); }
      else { unpaidCount++; unpaidAmount += total; }
      return {
        id: s.id, orderNumber: s.orderNumber, date: s.date,
        customerName: s.customerName || s.customer?.name || 'Unknown', customerPhone: s.customerPhone || s.customer?.phone || null,
        items: s.items.map(i => ({ name: i.product?.name || 'Product', qty: i.qty })),
        totalPrice: total, amountPaid, balance: total - amountPaid,
        paymentType: s.paymentType, paymentStatus: s.paymentStatus,
        consultant: s.consultant, latestNote: s.paymentNotes[0]?.note || null, notesCount: s._count.paymentNotes,
      };
    });

    let consultantInfo = null;
    if (where.consultantId) {
      const c = await prisma.consultant.findFirst({ where: { id: where.consultantId, companyId }, select: { id: true, name: true } });
      consultantInfo = c || null;
    }

    res.json({
      from, to, consultant: consultantInfo, orders,
      summary: {
        totalOrders: orders.length, totalRevenue,
        paidCount, paidAmount, partialCount, partialOutstanding, unpaidCount, unpaidAmount,
        totalOutstanding: partialOutstanding + unpaidAmount,
      },
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

const SALE_INCLUDE = { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, consultant: true,
  // Where the order physically is, so the office can answer "where is it" from the sales list.
  delivery: { select: { id: true, status: true, cashCollected: true, cashRemitted: true, rider: { select: { name: true } } } },
  // ZRA Smart Invoice documents, for companies that have it; an empty list for everyone else.
  fiscalDocuments: { select: ZRA_DOC_SELECT, orderBy: { createdAt: 'asc' } } };
const SALE_SORT_FIELDS = { orderNumber: 'orderNumber', customerName: 'customerName', totalPrice: 'totalPrice', status: 'status', paymentStatus: 'paymentStatus', date: 'date' };
function calcSaleProfit(s) {
  const cogs = (s.items || []).reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0);
  // totalPrice already has the delivery charge added and the discount taken off.
  return parseFloat(s.totalPrice) - cogs - parseFloat(s.shippingCost);
}

app.get('/api/v1/sales', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status, paymentStatus, paymentType, from, to, customerId, consultantId, search, creditOverdue, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (paymentType) where.paymentType = paymentType;
    if (customerId) where.customerId = customerId;
    if (creditOverdue === 'true') { where.paymentType = 'Credit'; where.paymentStatus = { not: 'Paid' }; where.creditDueDate = { lt: new Date() }; }
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    if (search) { where.OR = [{ orderNumber: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } }]; }
    if (consultantId) where.consultantId = consultantId;
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;

    const pagination = parsePagination(req.query);
    if (!pagination) {
      const sales = await prisma.sale.findMany({ where, include: SALE_INCLUDE, orderBy: { createdAt: 'desc' } });
      return res.json(sales);
    }

    if (sortBy === 'profit') {
      const all = await prisma.sale.findMany({ where, include: SALE_INCLUDE, orderBy: { createdAt: 'desc' } });
      all.sort((a, b) => (sortDir === 'asc' ? -1 : 1) * (calcSaleProfit(b) - calcSaleProfit(a)));
      const page = all.slice(pagination.skip, pagination.skip + pagination.take);
      return res.json(paginatedResponse(page, all.length, pagination));
    }

    const orderBy = { [SALE_SORT_FIELDS[sortBy] || 'createdAt']: sortDir === 'asc' ? 'asc' : 'desc' };
    const [total, sales] = await Promise.all([
      prisma.sale.count({ where }),
      prisma.sale.findMany({ where, include: SALE_INCLUDE, orderBy, skip: pagination.skip, take: pagination.take }),
    ]);
    res.json(paginatedResponse(sales, total, pagination));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/sales/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, consultant: true, statusHistory: { orderBy: { createdAt: 'desc' } }, creditPayments: { orderBy: { createdAt: 'desc' } }, debtReminders: { orderBy: { sentAt: 'desc' } }, paymentNotes: { orderBy: { createdAt: 'desc' } }, delivery: { include: { rider: { select: { name: true, phone: true } } } }, fiscalDocuments: SALE_INCLUDE.fiscalDocuments } });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'consultant') {
      sale.items = (sale.items || []).map(({ costPrice, ...rest }) => rest);
    }
    res.json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/sales', authenticate, validateSale, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = req.body;
    if (req.user.role === 'consultant') data.consultantId = req.user.consultantId;
    const itemsInput = data.items || [];
    if (!itemsInput.length) return res.status(400).json({ error: 'At least one item is required' });

    // Validate all products exist
    const productIds = itemsInput.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
    const productMap = {}; products.forEach(p => { productMap[p.id] = p; });
    for (const item of itemsInput) {
      if (!productMap[item.productId]) return res.status(400).json({ error: `Product ${item.productId} not found` });
    }

    // Build sale items
    let saleItems;
    try {
      saleItems = itemsInput.map(item => {
        const product = productMap[item.productId];
        const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
        const costPrice = parseFloat(product.costPrice);
        const qty = parseInt(item.qty);
        const totalPrice = qty * unitPrice;
        const stockSourceConsultantId = normalizeItemStockSource(item, req.user);
        return { productId: item.productId, qty, unitPrice, costPrice, totalPrice, serialNumber: item.serialNumber || null, stockSourceConsultantId };
      });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    // An order whose goods are still in the warehouse cannot be recorded as already gone: nobody
    // has picked it yet. It has to pass through Confirmed so the warehouse sees it, packs it, and
    // a rider takes it out — which is the only way the status history means anything, and the
    // reason 279 of last month's orders never reached the person meant to prepare them.
    // Items sold from a consultant's own carried stock are exempt: the seller already has them.
    const requestedStatus = data.status || 'Pending';
    const fulfilment = data.fulfilment === 'collection' ? 'collection' : 'delivery';
    // A collection is carried away from the counter, so it is genuinely finished on the spot and
    // the rule below does not apply to it. Only something that still has to travel does.
    if (fulfilment === 'delivery' && ['Shipped', 'Delivered'].includes(requestedStatus) && saleItems.some(i => !i.stockSourceConsultantId)) {
      return res.status(400).json({
        error: `This order has items coming from the warehouse, so it cannot be recorded as ${requestedStatus} straight away. `
             + 'Save it as Confirmed — the warehouse marks it packed, and it becomes Delivered when the rider drops it off.',
      });
    }

    const itemsTotal = saleItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const shippingCharge = parseFloat(data.shippingCharge) || 0;
    const discount = parseFloat(data.discount) || 0;
    const totalPrice = itemsTotal + shippingCharge - discount;

    const lastSale = await prisma.sale.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    let nextNum = 1;
    if (lastSale) { const match = lastSale.orderNumber.match(/ORD-(\d+)/); if (match) nextNum = parseInt(match[1]) + 1; }
    const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

    let customerId = data.customerId;
    if (!customerId && data.customerName) {
      let customer = null;
      if (data.customerPhone) customer = await prisma.customer.findFirst({ where: { phone: data.customerPhone, companyId } });
      if (!customer) customer = await prisma.customer.create({ data: { name: data.customerName, phone: data.customerPhone || null, city: data.customerCity || null, source: data.source || null, companyId } });
      customerId = customer.id;
    }

    let shippingCost = parseFloat(data.shippingCost) || 0;
    if (data.customerCity && !data.shippingCost) {
      const rate = await prisma.shippingRate.findFirst({ where: { city: data.customerCity, companyId } });
      if (rate) shippingCost = parseFloat(rate.rate);
    }

    const paymentType = data.paymentType || 'Cash';
    let amountPaid = parseFloat(data.amountPaid) || 0;
    if (paymentType === 'Cash' && (data.paymentStatus === 'Paid' || !data.paymentStatus)) amountPaid = totalPrice;
    let paymentStatus = data.paymentStatus || 'Unpaid';
    if (paymentType === 'Credit') {
      if (amountPaid >= totalPrice) paymentStatus = 'Paid';
      else if (amountPaid > 0) paymentStatus = 'Partial';
      else paymentStatus = 'Unpaid';
    }

    try {
      const sale = await prisma.$transaction(async (tx) => {
        const created = await tx.sale.create({
          data: {
            orderNumber, date: data.date ? new Date(data.date) : new Date(), totalPrice,
            shippingCost, shippingCharge, discount,
            status: requestedStatus, fulfilment, recordedById: req.user.id, paymentStatus, paymentMethod: data.paymentMethod || null, source: data.source || null,
            paymentType, amountPaid, creditDueDate: data.creditDueDate ? new Date(data.creditDueDate) : null, creditNotes: data.creditNotes || null,
            consultantId: data.consultantId || null,
            customerId, customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null, deliveryAddress: data.deliveryAddress || null, notes: data.notes || null,
            companyId,
            items: { create: saleItems }
          },
          include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, consultant: true, fiscalDocuments: SALE_INCLUDE.fiscalDocuments }
        });
        if (['Confirmed', 'Shipped', 'Delivered'].includes(created.status)) {
          for (const item of created.items) {
            await deductStockForItem(tx, item, created, companyId);
          }
        }
        await tx.orderStatusLog.create({ data: { saleId: created.id, fromStatus: 'New', toStatus: created.status, byUserId: req.user.id, companyId } });
        const recorded = await zra_recordSale(tx, companyId, created.id);
        return recorded ? { ...created, recorded } : created;
      }, { timeout: 20000 });
      // The sale is saved whatever ZRA says; this only adds the receipt details when it answers.
      if (sale.recorded) {
        await zra_afterSave(prisma, companyId, sale.id);
        return res.status(201).json(await prisma.sale.findUnique({ where: { id: sale.id }, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, consultant: true, fiscalDocuments: SALE_INCLUDE.fiscalDocuments } }));
      }
      res.status(201).json(sale);
    } catch (e) {
      console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Something went wrong' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/sales/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const raw = req.body;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const existing = await prisma.sale.findFirst({ where, include: { items: true } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'consultant') raw.consultantId = req.user.consultantId;

    const data = {
      shippingCost: raw.shippingCost !== undefined ? parseFloat(raw.shippingCost) || 0 : undefined,
      shippingCharge: raw.shippingCharge !== undefined ? parseFloat(raw.shippingCharge) || 0 : undefined,
      discount: raw.discount !== undefined ? parseFloat(raw.discount) || 0 : undefined,
      ...(raw.date && { date: new Date(raw.date) }),
      ...(raw.paymentMethod !== undefined && { paymentMethod: raw.paymentMethod || null }),
      ...(raw.paymentStatus && { paymentStatus: raw.paymentStatus }),
      ...(raw.source !== undefined && { source: raw.source || null }),
      ...(raw.customerName !== undefined && { customerName: raw.customerName || null }),
      ...(raw.customerPhone !== undefined && { customerPhone: raw.customerPhone || null }),
      ...(raw.customerCity !== undefined && { customerCity: raw.customerCity || null }),
      ...(raw.deliveryAddress !== undefined && { deliveryAddress: raw.deliveryAddress || null }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
      ...(raw.paymentType !== undefined && { paymentType: raw.paymentType }),
      ...(raw.creditDueDate !== undefined && { creditDueDate: raw.creditDueDate ? new Date(raw.creditDueDate) : null }),
      ...(raw.creditNotes !== undefined && { creditNotes: raw.creditNotes || null }),
      ...(raw.consultantId !== undefined && { consultantId: raw.consultantId || null }),
    };
    Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);

    // Build new items (no DB writes yet — validate before touching anything)
    let newSaleItems = null;
    if (raw.items && raw.items.length > 0) {
      const productIds = raw.items.map(i => i.productId);
      const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
      const productMap = {}; products.forEach(p => { productMap[p.id] = p; });
      try {
        newSaleItems = raw.items.map(item => {
          const product = productMap[item.productId];
          if (!product) { const err = new Error(`Product not found: ${item.productId}`); err.status = 400; throw err; }
          const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
          const costPrice = parseFloat(product.costPrice);
          const qty = parseInt(item.qty);
          const totalPrice = qty * unitPrice;
          const stockSourceConsultantId = normalizeItemStockSource(item, req.user);
          return { saleId: req.params.id, productId: item.productId, qty, unitPrice, costPrice, totalPrice, serialNumber: item.serialNumber || null, stockSourceConsultantId };
        });
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
      }
      const itemsTotal = newSaleItems.reduce((sum, i) => sum + i.totalPrice, 0);
      const shippingCharge = data.shippingCharge !== undefined ? data.shippingCharge : parseFloat(existing.shippingCharge);
      const discount = data.discount !== undefined ? data.discount : parseFloat(existing.discount);
      data.totalPrice = itemsTotal + shippingCharge - discount;
    }

    if (changesInvoiceFigures(existing, raw, newSaleItems)) {
      const refusal = await zra_refuseChange(prisma, companyId, existing.id, { figures: true });
      if (refusal) return res.status(409).json({ error: refusal });
    }

    // Recalculate amountPaid and paymentStatus when paymentType changes
    if (raw.paymentType !== undefined) {
      const saleTotal = data.totalPrice || parseFloat(existing.totalPrice);
      if (raw.paymentType === 'Credit') {
        const deposit = raw.amountPaid !== undefined ? parseFloat(raw.amountPaid) || 0 : 0;
        data.amountPaid = deposit;
        if (deposit >= saleTotal) data.paymentStatus = 'Paid';
        else if (deposit > 0) data.paymentStatus = 'Partial';
        else data.paymentStatus = 'Unpaid';
      } else if (raw.paymentType === 'Cash') {
        // Honour the status the user picked (same rule as create): only Paid
        // or a missing status means the full total was collected.
        const status = raw.paymentStatus || 'Paid';
        data.paymentStatus = status;
        if (status === 'Paid') data.amountPaid = saleTotal;
        else if (status === 'Unpaid') data.amountPaid = 0;
        else data.amountPaid = parseFloat(raw.amountPaid) || 0;
      }
    } else if (raw.amountPaid !== undefined) {
      if (existing.paymentType === 'Credit') {
        const deposit = parseFloat(raw.amountPaid) || 0;
        const saleTotal = data.totalPrice || parseFloat(existing.totalPrice);
        data.amountPaid = deposit;
        if (deposit >= saleTotal) data.paymentStatus = 'Paid';
        else if (deposit > 0) data.paymentStatus = 'Partial';
        else data.paymentStatus = 'Unpaid';
      }
    }

    const deductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = deductStatuses.includes(existing.status);

    try {
      const sale = await prisma.$transaction(async (tx) => {
        if (newSaleItems) {
          if (wasDeducted) {
            for (const oldItem of existing.items) {
              await refundStockForItem(tx, oldItem, existing, companyId, 'Edit Revert');
            }
          }
          await tx.saleItem.deleteMany({ where: { saleId: req.params.id } });
          await tx.saleItem.createMany({ data: newSaleItems });
          if (wasDeducted) {
            const saleCtx = { id: req.params.id, consultantId: data.consultantId !== undefined ? data.consultantId : existing.consultantId };
            for (const newItem of newSaleItems) {
              await deductStockForItem(tx, newItem, saleCtx, companyId);
            }
          }
        }
        return tx.sale.update({ where: { id: req.params.id }, data, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, consultant: true, fiscalDocuments: SALE_INCLUDE.fiscalDocuments } });
      }, { timeout: 20000 });
      res.json(sale);
    } catch (e) {
      console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Something went wrong' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/sales/:id/status', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status } = req.body;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where, include: { items: true } });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    const oldStatus = sale.status;
    if (status !== oldStatus) {
      const refusal = await zra_refuseChange(prisma, companyId, sale.id, { status });
      if (refusal) return res.status(409).json({ error: refusal });
    }
    const stockDeductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = stockDeductStatuses.includes(oldStatus);
    const shouldDeduct = stockDeductStatuses.includes(status);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (!wasDeducted && shouldDeduct) {
          for (const item of sale.items) {
            await deductStockForItem(tx, item, sale, companyId);
          }
        } else if (wasDeducted && !shouldDeduct) {
          const reason = status === 'Cancelled' ? 'Cancelled Order' : 'Status Revert';
          for (const item of sale.items) {
            await refundStockForItem(tx, item, sale, companyId, reason);
          }
        }
        const result = await tx.sale.update({ where: { id: req.params.id }, data: { status }, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, statusHistory: { orderBy: { createdAt: 'desc' } }, fiscalDocuments: SALE_INCLUDE.fiscalDocuments } });
        await tx.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: oldStatus, toStatus: status, byUserId: req.user.id, companyId } });
        const recorded = await zra_recordSale(tx, companyId, sale.id);
        return recorded ? { ...result, recorded } : result;
      }, { timeout: 20000 });
      if (updated.recorded) {
        await zra_afterSave(prisma, companyId, sale.id);
        return res.json(await prisma.sale.findUnique({ where: { id: sale.id }, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, statusHistory: { orderBy: { createdAt: 'desc' } }, fiscalDocuments: SALE_INCLUDE.fiscalDocuments } }));
      }
      res.json(updated);
    } catch (e) {
      console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Something went wrong' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Quick binary Paid/Unpaid toggle for Cash-type orders (mirrors server/src/routes/sales.js).
// Credit sales are excluded — they're paid down via the Credit Tracker's CreditPayment
// ledger instead, and toggling here would corrupt that ledger's amountPaid tracking.
// A note can be logged independently of (or alongside) a status change — it's a running
// activity trail, not a field that gets overwritten each time.
app.put('/api/v1/sales/:id/payment', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { paymentStatus, note } = req.body;
    if (paymentStatus !== undefined && !['Paid', 'Unpaid'].includes(paymentStatus)) {
      return res.status(400).json({ error: 'Payment status must be Paid or Unpaid' });
    }
    const trimmedNote = typeof note === 'string' ? note.trim() : '';
    if (paymentStatus === undefined && !trimmedNote) {
      return res.status(400).json({ error: 'Provide a payment status change, a note, or both' });
    }
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    if (paymentStatus !== undefined && sale.paymentType === 'Credit') {
      return res.status(400).json({ error: 'Credit sales are paid down via the Credit Tracker, not this toggle' });
    }

    await prisma.$transaction(async (tx) => {
      if (paymentStatus !== undefined) {
        await tx.sale.update({
          where: { id: sale.id },
          data: { paymentStatus, amountPaid: paymentStatus === 'Paid' ? sale.totalPrice : 0 },
        });
      }
      if (trimmedNote) {
        await tx.paymentNote.create({ data: { saleId: sale.id, note: sanitizeString(trimmedNote, 500), companyId } });
      }
    });

    const updated = await prisma.sale.findFirst({ where: { id: sale.id }, include: { ...SALE_INCLUDE, paymentNotes: { orderBy: { createdAt: 'desc' } } } });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/sales/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'consultant') return res.status(403).json({ error: 'Consultants cannot delete sales' });
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { items: true } });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    const refusal = await zra_refuseChange(prisma, companyId, sale.id, { delete: true });
    if (refusal) return res.status(409).json({ error: refusal });
    try {
      await prisma.$transaction(async (tx) => {
        if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
          for (const item of sale.items) {
            await refundStockForItem(tx, item, sale, companyId, 'Order Deleted');
          }
        }
        await tx.creditPayment.deleteMany({ where: { saleId: req.params.id } });
        await tx.debtReminder.deleteMany({ where: { saleId: req.params.id } });
        await tx.paymentNote.deleteMany({ where: { saleId: req.params.id } });
        await tx.orderStatusLog.deleteMany({ where: { saleId: req.params.id } });
        await tx.saleItem.deleteMany({ where: { saleId: req.params.id } });
        await tx.sale.delete({ where: { id: req.params.id } });
      }, { timeout: 20000 });
      return res.json({ message: 'Sale deleted' });
    } catch (e) {
      console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Something went wrong' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CREDIT PAYMENTS ----
app.post('/api/v1/sales/:id/payments', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    await prisma.creditPayment.create({ data: { saleId: sale.id, amount, paymentMethod: req.body.paymentMethod || null, reference: req.body.reference || null, notes: req.body.notes || null, companyId } });

    const newAmountPaid = parseFloat(sale.amountPaid) + amount;
    const totalPrice = parseFloat(sale.totalPrice);
    const paymentStatus = newAmountPaid >= totalPrice ? 'Paid' : newAmountPaid > 0 ? 'Partial' : 'Unpaid';
    const updated = await prisma.sale.update({ where: { id: sale.id }, data: { amountPaid: newAmountPaid, paymentStatus }, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, creditPayments: { orderBy: { createdAt: 'desc' } } } });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/sales/:id/payments', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (req.user.role === 'consultant') {
      const owned = await prisma.sale.findFirst({ where: { id: req.params.id, companyId, consultantId: req.user.consultantId }, select: { id: true } });
      if (!owned) return res.status(404).json({ error: 'Sale not found' });
    }
    const payments = await prisma.creditPayment.findMany({ where: { saleId: req.params.id, companyId }, orderBy: { createdAt: 'desc' } });
    res.json(payments);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- REMINDERS ----
app.post('/api/v1/sales/:id/reminders', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const reminder = await prisma.debtReminder.create({ data: { saleId: sale.id, channel: req.body.channel, message: req.body.message || null, companyId } });
    res.status(201).json(reminder);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/sales/:id/reminders', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (req.user.role === 'consultant') {
      const owned = await prisma.sale.findFirst({ where: { id: req.params.id, companyId, consultantId: req.user.consultantId }, select: { id: true } });
      if (!owned) return res.status(404).json({ error: 'Sale not found' });
    }
    const reminders = await prisma.debtReminder.findMany({ where: { saleId: req.params.id, companyId }, orderBy: { sentAt: 'desc' } });
    res.json(reminders);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- RECEIPT DATA ----
app.get('/api/v1/sales/:id/receipt', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, creditPayments: { orderBy: { createdAt: 'desc' } }, fiscalDocuments: SALE_INCLUDE.fiscalDocuments } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    res.json({ sale, settings: settingsMap });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- QUOTES ----
// Price quotations consultants can issue on request. No stock or commission impact —
// only "Convert to Sale" creates a real Sale (mirrors server/src/routes/quotes.js).
const quoteInclude = { items: { include: { product: true } }, customer: true, consultant: { select: { id: true, name: true } } };
const QUOTE_OPEN_STATUSES = ['Sent', 'Accepted', 'Declined', 'Expired'];

async function nextQuoteNumber(companyId) {
  const last = await prisma.quote.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
  let n = 1;
  if (last) { const m = last.quoteNumber.match(/QT-(\d+)/); if (m) n = parseInt(m[1]) + 1; }
  return `QT-${String(n).padStart(4, '0')}`;
}

app.get('/api/v1/quotes', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status, search, from, to, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (status) where.status = status;
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    if (search) { where.OR = [{ quoteNumber: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } }, { customerPhone: { contains: search, mode: 'insensitive' } }]; }

    const pagination = parsePagination(req.query);
    if (!pagination) {
      const quotes = await prisma.quote.findMany({ where, include: quoteInclude, orderBy: { createdAt: 'desc' } });
      return res.json(quotes);
    }
    const orderBy = { [['date', 'totalPrice', 'status'].includes(sortBy) ? sortBy : 'createdAt']: sortDir === 'asc' ? 'asc' : 'desc' };
    const [total, quotes] = await Promise.all([
      prisma.quote.count({ where }),
      prisma.quote.findMany({ where, include: quoteInclude, orderBy, skip: pagination.skip, take: pagination.take }),
    ]);
    res.json(paginatedResponse(quotes, total, pagination));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/quotes/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const quote = await prisma.quote.findFirst({ where, include: quoteInclude });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    res.json(quote);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/quotes/:id/pdf-data', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const quote = await prisma.quote.findFirst({ where, include: quoteInclude });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    res.json({ quote, settings: settingsMap });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/quotes', authenticate, validateQuote, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = req.body;
    if (req.user.role === 'consultant') data.consultantId = req.user.consultantId;
    const items = data.items;

    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    for (const item of items) {
      if (!productMap[item.productId]) return res.status(400).json({ error: `Product not found: ${item.productId}` });
    }

    const quoteNumber = await nextQuoteNumber(companyId);

    let customerId = data.customerId;
    if (!customerId && data.customerName) {
      let customer = null;
      if (data.customerPhone) customer = await prisma.customer.findFirst({ where: { phone: data.customerPhone, companyId } });
      if (!customer) customer = await prisma.customer.create({ data: { name: data.customerName, phone: data.customerPhone || null, city: data.customerCity || null, source: data.source || null, companyId } });
      customerId = customer.id;
    }

    const quoteItems = items.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
      const qty = parseInt(item.qty);
      return { productId: item.productId, qty, unitPrice, totalPrice: qty * unitPrice };
    });
    const itemsTotal = quoteItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const discount = parseFloat(data.discount) || 0;
    const shippingCharge = parseFloat(data.shippingCharge) || 0;
    const totalPrice = itemsTotal + shippingCharge - discount;

    let expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    if (!expiresAt) { expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 7); }

    const quote = await prisma.quote.create({
      data: {
        quoteNumber, date: data.date ? new Date(data.date) : new Date(), expiresAt,
        status: 'Sent', shippingCharge, discount, totalPrice, notes: data.notes || null,
        consultantId: data.consultantId || null,
        customerId, customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null,
        companyId,
        items: { create: quoteItems },
      },
      include: quoteInclude,
    });
    res.status(201).json(quote);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/quotes/:id', authenticate, validateQuote, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const existing = await prisma.quote.findFirst({ where });
    if (!existing) return res.status(404).json({ error: 'Quote not found' });
    if (existing.status === 'Converted') return res.status(400).json({ error: 'Cannot edit a quote that has already been converted to a sale' });

    const data = req.body;
    const items = data.items;
    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    for (const item of items) {
      if (!productMap[item.productId]) return res.status(400).json({ error: `Product not found: ${item.productId}` });
    }
    const quoteItems = items.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
      const qty = parseInt(item.qty);
      return { productId: item.productId, qty, unitPrice, totalPrice: qty * unitPrice };
    });
    const itemsTotal = quoteItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const discount = parseFloat(data.discount) || 0;
    const shippingCharge = parseFloat(data.shippingCharge) || 0;
    const totalPrice = itemsTotal + shippingCharge - discount;

    const quote = await prisma.$transaction(async (tx) => {
      await tx.quoteItem.deleteMany({ where: { quoteId: existing.id } });
      return tx.quote.update({
        where: { id: existing.id },
        data: {
          date: data.date ? new Date(data.date) : existing.date,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : existing.expiresAt,
          shippingCharge, discount, totalPrice, notes: data.notes || null,
          customerId: data.customerId || existing.customerId,
          customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null,
          items: { create: quoteItems },
        },
        include: quoteInclude,
      });
    });
    res.json(quote);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/quotes/:id/status', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status } = req.body;
    if (!QUOTE_OPEN_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${QUOTE_OPEN_STATUSES.join(', ')}` });
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const existing = await prisma.quote.findFirst({ where });
    if (!existing) return res.status(404).json({ error: 'Quote not found' });
    if (existing.status === 'Converted') return res.status(400).json({ error: 'This quote has already been converted to a sale' });
    const quote = await prisma.quote.update({ where: { id: existing.id }, data: { status }, include: quoteInclude });
    res.json(quote);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/quotes/:id/convert', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const quote = await prisma.quote.findFirst({ where, include: { items: true } });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    if (quote.status === 'Converted' || quote.convertedSaleId) return res.status(400).json({ error: 'This quote has already been converted to a sale' });

    const productIds = quote.items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    for (const item of quote.items) {
      if (!productMap[item.productId]) return res.status(400).json({ error: 'One of the quoted products no longer exists' });
    }

    const sale = await prisma.$transaction(async (tx) => {
      const lastSale = await tx.sale.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
      let nextNum = 1;
      if (lastSale) { const m = lastSale.orderNumber.match(/ORD-(\d+)/); if (m) nextNum = parseInt(m[1]) + 1; }
      const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

      const saleItems = quote.items.map(item => ({
        productId: item.productId, qty: item.qty, unitPrice: parseFloat(item.unitPrice),
        costPrice: parseFloat(productMap[item.productId].costPrice), totalPrice: parseFloat(item.totalPrice),
      }));

      const created = await tx.sale.create({
        data: {
          orderNumber, date: new Date(), totalPrice: quote.totalPrice,
          shippingCharge: quote.shippingCharge, discount: quote.discount,
          status: 'Pending', paymentStatus: 'Unpaid', paymentType: 'Cash',
          consultantId: quote.consultantId,
          customerId: quote.customerId, customerName: quote.customerName, customerPhone: quote.customerPhone, customerCity: quote.customerCity,
          notes: `Converted from quote ${quote.quoteNumber}`,
          companyId,
          items: { create: saleItems },
        },
      });
      await tx.orderStatusLog.create({ data: { saleId: created.id, fromStatus: 'New', toStatus: 'Pending', byUserId: req.user.id, companyId } });
      await tx.quote.update({ where: { id: quote.id }, data: { status: 'Converted', convertedSaleId: created.id } });
      return created;
    }, { timeout: 20000 });

    res.status(201).json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/quotes/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.quote.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Quote not found' });
    if (existing.status === 'Converted') return res.status(400).json({ error: 'Cannot delete a quote that has been converted to a sale — cancel the sale instead' });
    await prisma.quote.delete({ where: { id: req.params.id } });
    res.json({ message: 'Quote deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- EXPENSES ----
const EXPENSE_SORT_FIELDS = { date: 'date', description: 'description', category: 'category', amount: 'amount' };

app.get('/api/v1/expenses', authenticate, requireAdminOrPurchasing, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { category, from, to, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (category) where.category = category;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const orderBy = { [EXPENSE_SORT_FIELDS[sortBy] || 'date']: sortDir === 'asc' ? 'asc' : 'desc' };

    const pagination = parsePagination(req.query);
    if (pagination) {
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

app.post('/api/v1/expenses', authenticate, requireAdminOrPurchasing, validateExpense, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = { ...req.body, companyId };
    if (data.date) data.date = new Date(data.date);
    res.status(201).json(await prisma.expense.create({ data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/expenses/:id', authenticate, requireAdminOrPurchasing, validateExpense, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.expense.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    if (data.date) data.date = new Date(data.date);
    res.json(await prisma.expense.update({ where: { id: req.params.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/expenses/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.expense.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CUSTOMERS ----
function customerOrderBy(sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  if (sortBy === 'orders') return { sales: { _count: dir } };
  if (['name', 'phone', 'city', 'source'].includes(sortBy)) return { [sortBy]: dir };
  return { createdAt: 'desc' };
}

app.get('/api/v1/customers', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { search, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search, mode: 'insensitive' } }]; }
    const orderBy = customerOrderBy(sortBy, sortDir);

    const pagination = parsePagination(req.query);
    if (pagination) {
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

app.get('/api/v1/customers/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, companyId }, include: { sales: { include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } } }, orderBy: { date: 'desc' } } } });
    if (!customer) return res.status(404).json({ error: 'Not found' });
    res.json(customer);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/customers/:id/orders', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.json(await prisma.sale.findMany({ where: { customerId: req.params.id, companyId }, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } } }, orderBy: { date: 'desc' } }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/customers', authenticate, requireAdmin, validateCustomer, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.status(201).json(await prisma.customer.create({ data: { ...req.body, companyId } }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/customers/:id', authenticate, requireAdmin, validateCustomer, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.customer.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    res.json(await prisma.customer.update({ where: { id: req.params.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/customers/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.customer.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.customer.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- SHIPPING RATES ----
app.get('/api/v1/shipping-rates', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.json(await prisma.shippingRate.findMany({ where: { companyId }, orderBy: { city: 'asc' } }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/shipping-rates', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.status(201).json(await prisma.shippingRate.create({ data: { ...req.body, companyId } }));
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'City already exists' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/v1/shipping-rates/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.shippingRate.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    res.json(await prisma.shippingRate.update({ where: { id: req.params.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/shipping-rates/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.shippingRate.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.shippingRate.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- DASHBOARD ----
// ---- TARGET TRACKER ----
// The dashboard's headline: how the period is going against a target that can be reached.
// A target the admin has set for a period containing today wins. Without one, the target is
// the best of the last three full months plus ten percent, which asks for a record month
// without asking for the impossible. Profit and cash sit beside revenue, because a month
// can sell more and still keep less. (mirrored between api/index.js and
// server/src/routes/dashboard.js)
const TRACKER_UPLIFT = 0.10;
const TRACKER_AD_CATEGORY = 'Facebook Ads';

async function dashboard_targetTracker(prisma, companyId) {
  const now = new Date();
  const monthStart = (back) => new Date(now.getFullYear(), now.getMonth() - back, 1);
  const num = (v) => parseFloat(v || 0) || 0;
  const r2 = (n) => Math.round(n * 100) / 100;

  const activeTargets = await prisma.salesTarget.findMany({ where: { companyId, periodStart: { lte: now }, periodEnd: { gte: now } } });
  // The shortest period containing today is the most specific one.
  activeTargets.sort((a, b) => (a.periodEnd - a.periodStart) - (b.periodEnd - b.periodStart));
  const activeTarget = activeTargets[0] || null;
  const periodStart = activeTarget ? new Date(activeTarget.periodStart) : monthStart(0);
  const periodEnd = activeTarget ? new Date(activeTarget.periodEnd) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const historyFrom = monthStart(3);
  const from = periodStart < historyFrom ? periodStart : historyFrom;
  const [sales, expenses] = await Promise.all([
    prisma.sale.findMany({
      where: { companyId, status: { not: 'Cancelled' }, date: { gte: from, lte: periodEnd } },
      select: { date: true, totalPrice: true, amountPaid: true, shippingCost: true, items: { select: { qty: true, costPrice: true } } },
    }),
    prisma.expense.findMany({
      where: { companyId, category: { not: 'Stock Purchase' }, date: { gte: from, lte: periodEnd } },
      select: { date: true, amount: true, category: true },
    }),
  ]);
  const between = (rows, a, b) => rows.filter(r => new Date(r.date) >= a && new Date(r.date) <= b);
  const revenueOf = (rows) => rows.reduce((s, r) => s + num(r.totalPrice), 0);
  const adsOf = (rows) => rows.filter(e => e.category === TRACKER_AD_CATEGORY).reduce((s, e) => s + num(e.amount), 0);

  // The last three full months, newest first.
  const months = [1, 2, 3].map(back => {
    const a = monthStart(back), b = new Date(monthStart(back - 1).getTime() - 1);
    const rows = between(sales, a, b);
    return {
      month: `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, '0')}`,
      revenue: revenueOf(rows), orders: rows.length, adSpend: adsOf(between(expenses, a, b)),
    };
  });
  const best = months.reduce((top, m) => (m.revenue > top.revenue ? m : top), months[0]);
  const defaultTarget = Math.round((best.revenue * (1 + TRACKER_UPLIFT)) / 1000) * 1000;

  const periodSales = between(sales, periodStart, periodEnd);
  const periodExpenses = between(expenses, periodStart, periodEnd);
  const periodRevenue = revenueOf(periodSales);
  const periodOrders = periodSales.length;
  const thisMonthSales = between(sales, monthStart(0), now);

  const growthTarget = activeTarget ? num(activeTarget.revenueTarget) : defaultTarget;
  const remainingToTarget = Math.max(0, growthTarget - periodRevenue);
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const periodTotalDays = Math.max(1, Math.ceil((periodEnd - periodStart) / MS_PER_DAY));
  const periodDayIdx = Math.min(periodTotalDays, Math.max(1, Math.ceil((now - periodStart) / MS_PER_DAY)));
  const daysLeft = Math.max(0, periodTotalDays - periodDayIdx);
  const dailyRevenueRate = periodRevenue / periodDayIdx;

  const cogs = periodSales.reduce((s, r) => s + r.items.reduce((x, i) => x + num(i.costPrice) * i.qty, 0), 0);
  const deliveryCost = periodSales.reduce((s, r) => s + num(r.shippingCost), 0);
  const grossProfit = periodRevenue - cogs - deliveryCost;
  const expensesTotal = periodExpenses.reduce((s, e) => s + num(e.amount), 0);
  const adSpend = adsOf(periodExpenses);
  const collected = periodSales.reduce((s, r) => s + Math.min(num(r.amountPaid), num(r.totalPrice)), 0);
  // What a kwacha of advertising has brought in lately, to judge this period's spend against.
  const recentAds = months.reduce((s, m) => s + m.adSpend, 0);
  const recentRevenuePerAdKwacha = recentAds > 0 ? months.reduce((s, m) => s + m.revenue, 0) / recentAds : null;

  return {
    thisMonthRevenue: revenueOf(thisMonthSales), thisMonthOrders: thisMonthSales.length,
    lastMonthRevenue: months[0].revenue, lastMonthOrders: months[0].orders,
    periodRevenue, periodOrders, periodStart, periodEnd, periodTotalDays, periodDayIdx,
    activeTarget: activeTarget ? { id: activeTarget.id, label: activeTarget.label, periodStart: activeTarget.periodStart, periodEnd: activeTarget.periodEnd, revenueTarget: activeTarget.revenueTarget, savingsRate: activeTarget.savingsRate } : null,
    targetBasis: activeTarget ? null : { month: best.month, revenue: best.revenue, upliftPercent: TRACKER_UPLIFT * 100 },
    recentMonths: months,
    growthTarget, growthProgress: growthTarget > 0 ? Math.min(100, (periodRevenue / growthTarget) * 100) : 0,
    remainingToTarget, daysLeft, dailyRevenueRate,
    dailyTargetNeeded: daysLeft > 0 ? remainingToTarget / daysLeft : remainingToTarget,
    projectedMonthRevenue: dailyRevenueRate * periodTotalDays,
    projectedMonthOrders: Math.round((periodOrders / periodDayIdx) * periodTotalDays),
    profit: {
      grossProfit: r2(grossProfit), expenses: r2(expensesTotal), netProfit: r2(grossProfit - expensesTotal),
      adSpend: r2(adSpend), wages: r2(periodExpenses.filter(e => e.category === 'Salaries & Wages').reduce((s, e) => s + num(e.amount), 0)),
      collected: r2(collected), unpaid: r2(periodRevenue - collected),
      adShareOfGrossProfit: grossProfit > 0 ? r2((adSpend / grossProfit) * 100) : null,
      revenuePerAdKwacha: adSpend > 0 ? r2(periodRevenue / adSpend) : null,
      recentRevenuePerAdKwacha: recentRevenuePerAdKwacha === null ? null : r2(recentRevenuePerAdKwacha),
      adsToCloseGap: recentRevenuePerAdKwacha && remainingToTarget > 0 ? r2(remainingToTarget / recentRevenuePerAdKwacha) : 0,
    },
  };
}

app.get('/api/v1/dashboard', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }

    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: true } });
    const totalRevenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const totalCOGS = sales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
    const totalShippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    // totalPrice already carries the delivery charge and the discount; only the fare comes off.
    const grossProfit = totalRevenue - totalCOGS - totalShippingCost;

    // 'Stock Purchase' expenses are cash-outflow tracking only — COGS above already
    // accounts for cost of goods at time of sale, so including both would double-count.
    const expenses = await prisma.expense.findMany({ where: { ...dateFilter, category: { not: 'Stock Purchase' } } });
    const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const netProfit = grossProfit - totalExpenses;
    const adExpenses = expenses.filter(e => e.category === 'Facebook Ads');
    const adSpend = adExpenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const roas = adSpend > 0 ? totalRevenue / adSpend : 0;
    const totalOrders = sales.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const profitMargin = totalCOGS > 0 ? (netProfit / totalCOGS) * 100 : 0;

    const monthlyData = {};
    sales.forEach(s => { const m = s.date.toISOString().slice(0, 7); if (!monthlyData[m]) monthlyData[m] = { revenue: 0, cogs: 0, fares: 0, expenses: 0, orders: 0 }; monthlyData[m].revenue += parseFloat(s.totalPrice); monthlyData[m].cogs += s.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0); monthlyData[m].fares += parseFloat(s.shippingCost); monthlyData[m].orders += 1; });
    expenses.forEach(e => { const m = e.date.toISOString().slice(0, 7); if (!monthlyData[m]) monthlyData[m] = { revenue: 0, cogs: 0, fares: 0, expenses: 0, orders: 0 }; monthlyData[m].expenses += parseFloat(e.amount); });
    const monthlySummary = Object.entries(monthlyData).sort(([a], [b]) => a.localeCompare(b)).map(([month, d]) => ({ month, revenue: d.revenue, profit: d.revenue - d.cogs - d.fares - d.expenses, expenses: d.expenses, orders: d.orders }));

    const expenseByCategory = {};
    expenses.forEach(e => { if (!expenseByCategory[e.category]) expenseByCategory[e.category] = 0; expenseByCategory[e.category] += parseFloat(e.amount); });

    const productSales = {};
    sales.forEach(s => { s.items.forEach(item => { if (!productSales[item.productId]) productSales[item.productId] = { revenue: 0, qty: 0 }; productSales[item.productId].revenue += parseFloat(item.totalPrice); productSales[item.productId].qty += item.qty; }); });
    const productIds = Object.keys(productSales);
    const products = productIds.length > 0 ? await prisma.product.findMany({ where: { id: { in: productIds }, companyId } }) : [];
    const topProducts = products.map(p => ({ name: p.name, revenue: productSales[p.id].revenue, qty: productSales[p.id].qty })).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // Velocity-aware restock alert: a static reorderLevel comparison misses fast movers
    // whose reorder level was set too low for how quickly they actually sell.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const [allActiveProducts, velocityRows] = await Promise.all([
      prisma.product.findMany({ where: { isActive: true, companyId }, select: { id: true, name: true, sku: true, stock: true, reorderLevel: true } }),
      prisma.saleItem.groupBy({ by: ['productId'], where: { sale: { companyId, date: { gte: ninetyDaysAgo }, status: { not: 'Cancelled' } } }, _sum: { qty: true } }),
    ]);
    const velocityMap = new Map(velocityRows.map(v => [v.productId, v._sum.qty || 0]));
    const URGENCY_RANK = { out: 0, critical: 1, low: 2, watch: 3 };
    const lowStockProducts = allActiveProducts.map(p => {
      const unitsSold90d = velocityMap.get(p.id) || 0;
      const dailyVelocity = unitsSold90d / 90;
      const daysOfCover = dailyVelocity > 0 ? Math.round(p.stock / dailyVelocity) : null;
      let urgency = null;
      if (p.stock === 0 && unitsSold90d > 0) urgency = 'out';
      else if (p.stock > 0 && daysOfCover !== null && daysOfCover < 7) urgency = 'critical';
      else if (p.stock > 0 && daysOfCover !== null && daysOfCover < 14) urgency = 'low';
      else if (p.stock <= p.reorderLevel) urgency = 'watch';
      return { id: p.id, name: p.name, sku: p.sku, stock: p.stock, reorderLevel: p.reorderLevel, unitsSold90d, daysOfCover, urgency };
    }).filter(p => p.urgency)
      .sort((a, b) => {
        if (URGENCY_RANK[a.urgency] !== URGENCY_RANK[b.urgency]) return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
        // Out-of-stock items all have daysOfCover 0, so rank by past sales volume instead —
        // a product that sold 35 units is a bigger miss than one that sold 1.
        if (a.urgency === 'out') return b.unitsSold90d - a.unitsSold90d;
        return (a.daysOfCover ?? 9999) - (b.daysOfCover ?? 9999) || a.stock - b.stock;
      })
      .slice(0, 20);
    const pendingOrders = await prisma.sale.count({ where: { companyId, status: { in: ['Pending', 'Confirmed'] } } });

    // Cash-type orders sitting unpaid/partial — Credit sales are excluded since they're
    // expected to be outstanding and already tracked via the Credit Tracker's aging view.
    const unpaidCashWhere = { companyId, paymentType: 'Cash', paymentStatus: { in: ['Unpaid', 'Partial'] }, status: { not: 'Cancelled' } };
    const [unpaidCashRows, unpaidCashAgg] = await Promise.all([
      prisma.sale.findMany({
        where: unpaidCashWhere,
        select: { id: true, orderNumber: true, customerName: true, customerPhone: true, totalPrice: true, amountPaid: true, paymentStatus: true, date: true, consultant: { select: { name: true } } },
        orderBy: { date: 'asc' },
        take: 20,
      }),
      prisma.sale.aggregate({ where: unpaidCashWhere, _count: true, _sum: { totalPrice: true, amountPaid: true } }),
    ]);
    const unpaidCashOrders = unpaidCashRows.map(s => ({
      id: s.id, orderNumber: s.orderNumber, customerName: s.customerName || 'Unknown', customerPhone: s.customerPhone,
      balance: parseFloat(s.totalPrice) - parseFloat(s.amountPaid), paymentStatus: s.paymentStatus, date: s.date,
      consultantName: s.consultant?.name || null,
    }));
    const unpaidCashCount = unpaidCashAgg._count;
    const unpaidCashTotal = parseFloat(unpaidCashAgg._sum.totalPrice || 0) - parseFloat(unpaidCashAgg._sum.amountPaid || 0);

    // ---- GROWTH ANALYSIS ----
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const thisMonthSales = sales.filter(s => new Date(s.date) >= thisMonthStart);
    const thisMonthRevenue = thisMonthSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const thisMonthOrders = thisMonthSales.length;
    const thisMonthCOGS = thisMonthSales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);

    const lastMonthSalesData = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, date: { gte: lastMonthStart, lte: lastMonthEnd } }, include: { items: true } });
    const lastMonthRevenue = lastMonthSalesData.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const lastMonthOrders = lastMonthSalesData.length;

    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dailyRevenueRate = dayOfMonth > 0 ? thisMonthRevenue / dayOfMonth : 0;
    const dailyOrderRate = dayOfMonth > 0 ? thisMonthOrders / dayOfMonth : 0;
    const projectedMonthRevenue = dailyRevenueRate * daysInMonth;
    const projectedMonthOrders = Math.round(dailyOrderRate * daysInMonth);

    // ---- DAILY SAVINGS (25% of daily gross profit) ----
    const SAVINGS_RATE = 0.25;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const todaySales = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, date: { gte: todayStart, lte: todayEnd } }, include: { items: true } });
    const todayRevenue = todaySales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const todayCOGS = todaySales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
    const todayShippingCost = todaySales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const todayGrossProfit = todayRevenue - todayCOGS - todayShippingCost;
    const todaySavings = Math.max(0, todayGrossProfit * SAVINGS_RATE);
    const todayReinvest = Math.max(0, todayGrossProfit - todaySavings);

    const thisMonthShippingCost = thisMonthSales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const thisMonthGrossProfit = thisMonthRevenue - thisMonthCOGS - thisMonthShippingCost;
    const thisMonthSavings = Math.max(0, thisMonthGrossProfit * SAVINGS_RATE);

    const savings = {
      rate: SAVINGS_RATE,
      today: { revenue: todayRevenue, grossProfit: todayGrossProfit, savings: todaySavings, reinvest: todayReinvest, orders: todaySales.length },
      thisMonth: { grossProfit: thisMonthGrossProfit, totalSavings: thisMonthSavings, totalReinvest: Math.max(0, thisMonthGrossProfit - thisMonthSavings), daysWithSales: [...new Set(thisMonthSales.map(s => s.date.toISOString().slice(0, 10)))].length },
      avgDailySavings: dayOfMonth > 0 ? thisMonthSavings / dayOfMonth : 0
    };

    const growth = await dashboard_targetTracker(prisma, companyId);

    // ---- CONSULTANT IMPACT ----
    const consultants = await prisma.consultant.findMany({ where: { companyId, isStockLocation: false } });
    let consultantImpact = null;
    if (consultants.length > 0) {
      const consultantSales = thisMonthSales.filter(s => s.consultantId);
      const directSales = thisMonthSales.filter(s => !s.consultantId);
      const consultantRevenue = consultantSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
      const directRevenue = directSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
      const consultantCOGS = consultantSales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
      const consultantGrossProfit = consultantRevenue - consultantCOGS;
      const commissionPayments = await prisma.commissionPayment.findMany({ where: { companyId } });

      const byConsultant = consultants.map(c => {
        const cSales = consultantSales.filter(s => s.consultantId === c.id);
        const cTotalSales = cSales.length;
        const cProductsSold = cSales.reduce((s, r) => s + r.items.reduce((q, i) => q + i.qty, 0), 0);
        const cRevenue = cSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
        const cCOGS = cSales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
        const cGrossProfit = cRevenue - cCOGS;
        const cCommissionEarned = calcCommission(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, cSales);
        const cPaid = commissionPayments.filter(p => p.consultantId === c.id && p.type === 'commission').reduce((s, p) => s + parseFloat(p.amount), 0);
        const cAllowancePaid = commissionPayments.filter(p => p.consultantId === c.id && p.type === 'allowance').reduce((s, p) => s + parseFloat(p.amount), 0);
        const cAdvancePaid = commissionPayments.filter(p => p.consultantId === c.id && p.type === 'advance').reduce((s, p) => s + parseFloat(p.amount), 0);
        const cNetProfit = cGrossProfit - cCommissionEarned;
        const conversionRate = cTotalSales > 0 ? (cRevenue / cTotalSales) : 0;
        return { id: c.id, name: c.name, isActive: c.isActive, totalSales: cTotalSales, productsSold: cProductsSold, revenue: cRevenue, grossProfit: cGrossProfit, commissionEarned: cCommissionEarned, commissionPaid: cPaid, allowancePaid: cAllowancePaid, advancePaid: cAdvancePaid, netProfit: cNetProfit, avgOrderValue: conversionRate, balance: cCommissionEarned - cPaid - cAdvancePaid };
      });

      const totalCommissionEarned = byConsultant.reduce((s, c) => s + c.commissionEarned, 0);
      const totalCommissionCost = totalCommissionEarned + consultants.reduce((s, c) => s + parseFloat(c.monthlyAllowance), 0);

      consultantImpact = {
        totalConsultants: consultants.filter(c => c.isActive).length,
        consultantSalesCount: consultantSales.length,
        directSalesCount: directSales.length,
        consultantRevenue,
        directRevenue,
        consultantGrossProfit,
        totalCommissionEarned,
        totalCommissionCost,
        netProfitAfterCommission: consultantGrossProfit - totalCommissionEarned,
        consultantSharePercent: thisMonthOrders > 0 ? (consultantSales.length / thisMonthOrders) * 100 : 0,
        revenueSharePercent: thisMonthRevenue > 0 ? (consultantRevenue / thisMonthRevenue) * 100 : 0,
        byConsultant,
      };
    }

    res.json({ totalRevenue, totalCOGS, grossProfit, totalExpenses, netProfit, totalOrders, avgOrderValue, adSpend, roas, profitMargin, monthlySummary, expenseByCategory, topProducts, lowStockProducts, pendingOrders, unpaidCashOrders, unpaidCashCount, unpaidCashTotal, growth, savings, consultantImpact });
  } catch (err) { console.error('DASHBOARD ERROR:', err); res.status(500).json({ error: err.message, stack: err.stack }); }
});

// ---- GROWTH PROJECTIONS REPORT ----
app.get('/api/v1/reports/growth', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const allSales = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' } }, orderBy: { date: 'asc' }, include: { items: true } });
    const allExpenses = await prisma.expense.findMany({ where: { companyId, category: { not: 'Stock Purchase' } }, orderBy: { date: 'asc' } });

    const monthlyHistory = {};
    allSales.forEach(s => { const m = s.date.toISOString().slice(0, 7); if (!monthlyHistory[m]) monthlyHistory[m] = { revenue: 0, cogs: 0, orders: 0, profit: 0, expenses: 0, adSpend: 0 }; const saleCogs = s.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0); const saleQty = s.items.reduce((sum, i) => sum + i.qty, 0); monthlyHistory[m].revenue += parseFloat(s.totalPrice); monthlyHistory[m].cogs += saleCogs; monthlyHistory[m].orders += saleQty; monthlyHistory[m].profit += parseFloat(s.totalPrice) - saleCogs; });
    allExpenses.forEach(e => { const m = e.date.toISOString().slice(0, 7); if (!monthlyHistory[m]) monthlyHistory[m] = { revenue: 0, cogs: 0, orders: 0, profit: 0, expenses: 0, adSpend: 0 }; monthlyHistory[m].expenses += parseFloat(e.amount); if (e.category === 'Facebook Ads') monthlyHistory[m].adSpend += parseFloat(e.amount); });

    const history = Object.entries(monthlyHistory).sort(([a], [b]) => a.localeCompare(b)).map(([month, d]) => ({ month, ...d, netProfit: d.profit - d.expenses, roas: d.adSpend > 0 ? d.revenue / d.adSpend : 0 }));
    for (let i = 1; i < history.length; i++) { history[i].growthRate = history[i - 1].revenue > 0 ? ((history[i].revenue - history[i - 1].revenue) / history[i - 1].revenue) * 100 : 0; }
    if (history.length > 0) history[0].growthRate = 0;

    // Projections stand on full months only. The month in progress is a part figure, and
    // using it as the base dragged every line down for the first weeks of each month.
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const full = history.filter(h => h.month < thisMonth);
    const recent = full.slice(-3);
    const total = (rows, fn) => rows.reduce((s, r) => s + fn(r), 0);
    const recentRevenue = total(recent, h => h.revenue);
    const baseRevenue = recent.length ? recentRevenue / recent.length : 0;
    const baseOrders = recent.length ? total(recent, h => h.orders) / recent.length : 0;
    const netMargin = recentRevenue > 0 ? total(recent, h => h.netProfit) / recentRevenue : 0;
    const grossMargin = recentRevenue > 0 ? total(recent, h => h.profit) / recentRevenue : 0.3;
    const recentAds = total(recent, h => h.adSpend);
    const revenuePerAdKwacha = recentAds > 0 ? recentRevenue / recentAds : null;

    // Three lines to plan against: standing still, carrying on as lately, and a stretch.
    // The recent trend is held inside a band so one freak month cannot project a fantasy,
    // which is what compounding a tripling target did.
    const TREND_FLOOR = -20, TREND_CAP = 30, STRETCH_RATE = 10;
    const withGrowth = recent.filter(h => full.indexOf(h) > 0);
    const rawGrowthRate = withGrowth.length ? total(withGrowth, h => h.growthRate) / withGrowth.length : 0;
    const avgGrowthRate = Math.max(TREND_FLOOR, Math.min(TREND_CAP, rawGrowthRate));

    const projections = [];
    for (let i = 1; i <= 6; i++) {
      const projMonth = new Date(now.getFullYear(), now.getMonth() + i - 1, 1);
      const monthLabel = `${projMonth.getFullYear()}-${String(projMonth.getMonth() + 1).padStart(2, '0')}`;
      const trend = Math.pow(1 + avgGrowthRate / 100, i);
      const trendRevenue = baseRevenue * trend;
      const stretchRevenue = baseRevenue * Math.pow(1 + STRETCH_RATE / 100, i);
      projections.push({
        month: monthLabel,
        flat: { revenue: baseRevenue, profit: baseRevenue * netMargin },
        currentTrajectory: { revenue: trendRevenue, profit: trendRevenue * netMargin, orders: Math.round(baseOrders * trend) },
        targetTrajectory: {
          revenue: stretchRevenue, profit: stretchRevenue * netMargin,
          adSpendNeeded: revenuePerAdKwacha ? stretchRevenue / revenuePerAdKwacha : null,
          inventoryNeeded: stretchRevenue * (1 - grossMargin),
        },
        gap: stretchRevenue - trendRevenue,
      });
    }

    res.json({
      history, projections, avgGrowthRate, rawGrowthRate, targetGrowthRate: STRETCH_RATE,
      base: { revenue: baseRevenue, months: recent.map(h => h.month), netMargin },
      currentMonth: thisMonth,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- REPORTS ----
app.get('/api/v1/reports/pnl', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: true } });
    const expenses = await prisma.expense.findMany({ where: { ...dateFilter, category: { not: 'Stock Purchase' } } });
    const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const cogs = sales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
    const shippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const shippingCharge = sales.reduce((s, r) => s + parseFloat(r.shippingCharge), 0);
    const discount = sales.reduce((s, r) => s + parseFloat(r.discount), 0);
    // Revenue is each order's total, which already has the delivery charge added and the discount
    // taken off, so only the fare paid to the rider or courier comes off here.
    const grossProfit = revenue - cogs - shippingCost;
    const expensesByCategory = {}; let totalExpenses = 0;
    expenses.forEach(e => { const a = parseFloat(e.amount); if (!expensesByCategory[e.category]) expensesByCategory[e.category] = 0; expensesByCategory[e.category] += a; totalExpenses += a; });
    const netProfit = grossProfit - totalExpenses;
    res.json({ revenue, cogs, shippingCost, shippingCharge, discount, grossProfit, expensesByCategory, totalExpenses, netProfit, profitMargin: cogs > 0 ? (netProfit / cogs) * 100 : 0 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/reports/sales', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to, productId, customerId, status } = req.query;
    const where = { companyId };
    if (status) where.status = status; if (productId) where.items = { some: { productId } }; if (customerId) where.customerId = customerId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true }, orderBy: { date: 'desc' } });
    const summary = { totalSales: sales.length, totalRevenue: sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0), totalProfit: sales.reduce((s, r) => s + parseFloat(r.totalPrice) - r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0) - parseFloat(r.shippingCost), 0) };
    res.json({ sales, summary });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/reports/expenses', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to, category } = req.query;
    const where = { companyId };
    if (category) where.category = category;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const expenses = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } });
    const byCategory = {}; let total = 0;
    expenses.forEach(e => { const a = parseFloat(e.amount); if (!byCategory[e.category]) byCategory[e.category] = 0; byCategory[e.category] += a; total += a; });
    res.json({ expenses, byCategory, total });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/reports/products', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } } } });
    const productMap = {};
    sales.forEach(s => { s.items.forEach(item => { const pid = item.productId; if (!productMap[pid]) productMap[pid] = { id: pid, name: item.product.name, sku: item.product.sku, revenue: 0, qtySold: 0, profit: 0, orders: 0 }; productMap[pid].revenue += parseFloat(item.totalPrice); productMap[pid].qtySold += item.qty; productMap[pid].profit += parseFloat(item.totalPrice) - (parseFloat(item.costPrice) * item.qty); productMap[pid].orders += 1; }); });
    res.json(Object.values(productMap).sort((a, b) => b.revenue - a.revenue));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/reports/customers', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, customerId: { not: null }, ...dateFilter }, include: { customer: true } });
    const customerMap = {};
    sales.forEach(s => { const cid = s.customerId; if (!cid) return; if (!customerMap[cid]) customerMap[cid] = { id: cid, name: s.customer?.name || s.customerName, phone: s.customer?.phone, city: s.customer?.city, totalSpent: 0, orderCount: 0 }; customerMap[cid].totalSpent += parseFloat(s.totalPrice); customerMap[cid].orderCount += 1; });
    res.json(Object.values(customerMap).sort((a, b) => b.totalSpent - a.totalSpent));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/reports/credit', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const now = new Date();
    const creditSales = await prisma.sale.findMany({ where: { companyId, paymentType: 'Credit', paymentStatus: { not: 'Paid' } }, include: { customer: true, creditPayments: { orderBy: { createdAt: 'desc' } } } });
    const allCreditSales = await prisma.sale.findMany({ where: { companyId, paymentType: 'Credit' }, include: { creditPayments: true } });
    const aging = { current: 0, days30: 0, days60: 0, days90: 0, days90plus: 0 };
    const agingDetails = [];
    creditSales.forEach(s => {
      const balance = parseFloat(s.totalPrice) - parseFloat(s.amountPaid);
      if (balance <= 0) return;
      const dueDate = s.creditDueDate ? new Date(s.creditDueDate) : new Date(s.createdAt);
      const daysOverdue = Math.max(0, Math.floor((now - dueDate) / (1000 * 60 * 60 * 24)));
      let bucket;
      if (daysOverdue <= 0) { aging.current += balance; bucket = 'Current'; }
      else if (daysOverdue <= 30) { aging.days30 += balance; bucket = '1-30 days'; }
      else if (daysOverdue <= 60) { aging.days60 += balance; bucket = '31-60 days'; }
      else if (daysOverdue <= 90) { aging.days90 += balance; bucket = '61-90 days'; }
      else { aging.days90plus += balance; bucket = '90+ days'; }
      agingDetails.push({ id: s.id, orderNumber: s.orderNumber, customerName: s.customerName || s.customer?.name || 'Unknown', customerPhone: s.customerPhone || s.customer?.phone || '', totalPrice: parseFloat(s.totalPrice), amountPaid: parseFloat(s.amountPaid), balance, dueDate: s.creditDueDate, daysOverdue, bucket, lastPayment: s.creditPayments[0]?.createdAt || null });
    });
    const totalCreditIssued = allCreditSales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
    const totalCollected = allCreditSales.reduce((sum, s) => sum + parseFloat(s.amountPaid), 0);
    const collectionRate = totalCreditIssued > 0 ? (totalCollected / totalCreditIssued) * 100 : 0;
    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const recentPayments = await prisma.creditPayment.findMany({ where: { companyId, createdAt: { gte: sixMonthsAgo } }, orderBy: { createdAt: 'asc' } });
    const monthlyCollections = {};
    recentPayments.forEach(p => { const month = p.createdAt.toISOString().slice(0, 7); if (!monthlyCollections[month]) monthlyCollections[month] = 0; monthlyCollections[month] += parseFloat(p.amount); });
    const paymentTrends = Object.entries(monthlyCollections).map(([month, amount]) => ({ month, amount }));
    const totalOutstanding = aging.current + aging.days30 + aging.days60 + aging.days90 + aging.days90plus;
    const overdueTotal = aging.days30 + aging.days60 + aging.days90 + aging.days90plus;
    res.json({ totalOutstanding, overdueTotal, totalCreditIssued, totalCollected, collectionRate, aging, agingDetails: agingDetails.sort((a, b) => b.balance - a.balance), paymentTrends, totalDebtors: creditSales.length });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/reports/inventory', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const now = new Date();
    const products = await prisma.product.findMany({ where: { companyId, isActive: true }, include: { saleItems: { include: { sale: { select: { date: true, status: true } } } } } });
    let totalStockValue = 0, totalPotentialRevenue = 0, totalPotentialProfit = 0;
    const productDetails = [];
    products.forEach(p => {
      const costPrice = parseFloat(p.costPrice);
      const sellingPrice = parseFloat(p.sellingPrice);
      const stockValue = p.stock * costPrice;
      const potentialRevenue = p.stock * sellingPrice;
      const potentialProfit = potentialRevenue - stockValue;
      totalStockValue += stockValue; totalPotentialRevenue += potentialRevenue; totalPotentialProfit += potentialProfit;
      const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const recentSales = p.saleItems.filter(si => si.sale.status !== 'Cancelled' && new Date(si.sale.date) >= ninetyDaysAgo);
      const unitsSold90d = recentSales.reduce((sum, si) => sum + si.qty, 0);
      const allSoldDates = p.saleItems.filter(si => si.sale.status !== 'Cancelled').map(si => new Date(si.sale.date));
      const lastSoldDate = allSoldDates.length > 0 ? new Date(Math.max(...allSoldDates)) : null;
      const daysSinceLastSale = lastSoldDate ? Math.floor((now - lastSoldDate) / (1000 * 60 * 60 * 24)) : null;
      const totalUnitsSold = p.saleItems.filter(si => si.sale.status !== 'Cancelled').reduce((sum, si) => sum + si.qty, 0);
      const avgStock = p.stock > 0 ? p.stock : 1;
      const turnoverRate = (unitsSold90d / avgStock) * 4;
      const isDeadStock = p.stock > 0 && (daysSinceLastSale === null || daysSinceLastSale > 90);
      const isLowStock = p.stock <= p.reorderLevel;
      const margin = costPrice > 0 ? ((sellingPrice - costPrice) / costPrice) * 100 : 0;
      productDetails.push({ id: p.id, name: p.name, sku: p.sku, category: p.category, stock: p.stock, reorderLevel: p.reorderLevel, costPrice, sellingPrice, margin, stockValue, potentialRevenue, potentialProfit, unitsSold90d, totalUnitsSold, turnoverRate, lastSoldDate, daysSinceLastSale, isDeadStock, isLowStock });
    });
    const deadStockItems = productDetails.filter(p => p.isDeadStock);
    const lowStockItems = productDetails.filter(p => p.isLowStock);
    const deadStockValue = deadStockItems.reduce((sum, p) => sum + p.stockValue, 0);
    const categoryBreakdown = {};
    productDetails.forEach(p => { const cat = p.category || 'Uncategorized'; if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { stockValue: 0, potentialRevenue: 0, itemCount: 0, totalStock: 0 }; categoryBreakdown[cat].stockValue += p.stockValue; categoryBreakdown[cat].potentialRevenue += p.potentialRevenue; categoryBreakdown[cat].itemCount += 1; categoryBreakdown[cat].totalStock += p.stock; });
    res.json({ summary: { totalProducts: products.length, totalStockValue, totalPotentialRevenue, totalPotentialProfit, deadStockCount: deadStockItems.length, deadStockValue, lowStockCount: lowStockItems.length }, products: productDetails.sort((a, b) => b.stockValue - a.stockValue), categoryBreakdown: Object.entries(categoryBreakdown).map(([name, data]) => ({ name, ...data })) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/reports/export/csv', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { type, from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    let data = []; let filename = 'export.csv';
    if (type === 'sales') {
      const sales = await prisma.sale.findMany({ where: dateFilter, include: { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } } }, orderBy: { date: 'desc' } });
      sales.forEach(s => { s.items.forEach(item => { data.push({ 'Order #': s.orderNumber, Date: s.date.toISOString().slice(0, 10), Product: item.product.name, Qty: item.qty, 'Unit Price': parseFloat(item.unitPrice), 'Item Total': parseFloat(item.totalPrice), 'Sale Total': parseFloat(s.totalPrice), Status: s.status, Customer: s.customerName || '' }); }); });
      filename = 'sales-report.csv';
    } else if (type === 'expenses') {
      const expenses = await prisma.expense.findMany({ where: dateFilter, orderBy: { date: 'desc' } });
      data = expenses.map(e => ({ Date: e.date.toISOString().slice(0, 10), Description: e.description, Amount: parseFloat(e.amount), Category: e.category }));
      filename = 'expenses-report.csv';
    } else if (type === 'pnl') {
      const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: true } });
      const expenses = await prisma.expense.findMany({ where: { ...dateFilter, category: { not: 'Stock Purchase' } } });
      const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
      const cogs = sales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
      const shippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
      const grossProfit = revenue - cogs - shippingCost;
      const expensesByCategory = {}; let totalExpenses = 0;
      expenses.forEach(e => { const a = parseFloat(e.amount); if (!expensesByCategory[e.category]) expensesByCategory[e.category] = 0; expensesByCategory[e.category] += a; totalExpenses += a; });
      const pnlData = [{ Item: 'Revenue', Amount: revenue }, { Item: 'COGS', Amount: -cogs }, { Item: 'Shipping', Amount: -shippingCost }, { Item: 'Gross Profit', Amount: grossProfit }, ...Object.entries(expensesByCategory).map(([c, a]) => ({ Item: c, Amount: -a })), { Item: 'Total Expenses', Amount: -totalExpenses }, { Item: 'Net Profit', Amount: grossProfit - totalExpenses }];
      const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(pnlData); XLSX.utils.book_append_sheet(wb, ws, 'P&L'); const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=pnl-statement.xlsx');
      return res.send(buf);
    } else if (type === 'credit') {
      const creditSales = await prisma.sale.findMany({ where: { companyId, paymentType: 'Credit', paymentStatus: { not: 'Paid' } }, include: { customer: true } });
      const now = new Date();
      creditSales.forEach(s => {
        const balance = parseFloat(s.totalPrice) - parseFloat(s.amountPaid);
        if (balance <= 0) return;
        const dueDate = s.creditDueDate ? new Date(s.creditDueDate) : new Date(s.createdAt);
        const daysOverdue = Math.max(0, Math.floor((now - dueDate) / (1000 * 60 * 60 * 24)));
        let bucket = 'Current';
        if (daysOverdue > 90) bucket = '90+ days'; else if (daysOverdue > 60) bucket = '61-90 days'; else if (daysOverdue > 30) bucket = '31-60 days'; else if (daysOverdue > 0) bucket = '1-30 days';
        data.push({ 'Order #': s.orderNumber, Customer: s.customerName || s.customer?.name || '', Phone: s.customerPhone || s.customer?.phone || '', Total: parseFloat(s.totalPrice), Paid: parseFloat(s.amountPaid), Balance: balance, 'Due Date': s.creditDueDate ? s.creditDueDate.toISOString().slice(0, 10) : '', 'Days Overdue': daysOverdue, Bucket: bucket });
      });
      filename = 'credit-report.csv';
    } else if (type === 'inventory') {
      const products = await prisma.product.findMany({ where: { companyId, isActive: true }, include: { saleItems: { include: { sale: { select: { date: true, status: true } } } } } });
      const now = new Date(); const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      products.forEach(p => {
        const costPrice = parseFloat(p.costPrice); const sellingPrice = parseFloat(p.sellingPrice);
        const unitsSold90d = p.saleItems.filter(si => si.sale.status !== 'Cancelled' && new Date(si.sale.date) >= ninetyDaysAgo).reduce((sum, si) => sum + si.qty, 0);
        const allSoldDates = p.saleItems.filter(si => si.sale.status !== 'Cancelled').map(si => new Date(si.sale.date));
        const lastSoldDate = allSoldDates.length > 0 ? new Date(Math.max(...allSoldDates)) : null;
        const daysSinceLastSale = lastSoldDate ? Math.floor((now - lastSoldDate) / (1000 * 60 * 60 * 24)) : null;
        const isDeadStock = p.stock > 0 && (daysSinceLastSale === null || daysSinceLastSale > 90);
        const margin = costPrice > 0 ? ((sellingPrice - costPrice) / costPrice) * 100 : 0;
        data.push({ Product: p.name, SKU: p.sku, Category: p.category || '', Stock: p.stock, 'Cost Price': costPrice, 'Selling Price': sellingPrice, 'Stock Value': p.stock * costPrice, 'Potential Revenue': p.stock * sellingPrice, 'Margin %': margin.toFixed(1), 'Sold (90d)': unitsSold90d, 'Last Sold': lastSoldDate ? lastSoldDate.toISOString().slice(0, 10) : 'Never', Status: isDeadStock ? 'Dead Stock' : p.stock <= p.reorderLevel ? 'Low Stock' : 'OK' });
      });
      filename = 'inventory-report.csv';
    }
    if (data.length === 0) return res.status(200).send('No data');
    const headers = Object.keys(data[0]);
    const csv = [headers.join(','), ...data.map(row => headers.map(h => { const v = String(row[h] ?? ''); return v.includes(',') ? `"${v}"` : v; }).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csv);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- SETTINGS ----
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

app.get('/api/v1/settings', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const obj = {}; settings.forEach(s => { obj[s.key] = s.value; });
    res.json(redactSettingsFor(req.user, obj));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- INVENTORY ----
app.get('/api/v1/inventory', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { category, search } = req.query;
    const where = { companyId, isActive: true };
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }
    const products = await prisma.product.findMany({
      where,
      include: { stockLogs: { select: { change: true, reason: true } } },
      orderBy: { name: 'asc' },
    });
    const items = products.map(p => {
      let totalStocked = 0, totalSold = 0;
      p.stockLogs.forEach(log => {
        if (log.change > 0) totalStocked += log.change;
        else if (/^sale\b/i.test(log.reason || '')) totalSold += Math.abs(log.change);
      });
      const costPrice = parseFloat(p.costPrice) || 0;
      const sellingPrice = parseFloat(p.sellingPrice) || 0;
      const currentStock = p.stock;
      return {
        id: p.id, name: p.name, sku: p.sku, category: p.category,
        currentStock, totalStocked, totalSold, costPrice, sellingPrice,
        stockCostValue: currentStock * costPrice, stockSellValue: currentStock * sellingPrice,
        soldCostValue: totalSold * costPrice, soldSellValue: totalSold * sellingPrice,
        potentialProfit: currentStock * (sellingPrice - costPrice),
      };
    });
    const summary = {
      totalProducts: items.length,
      totalItemsInStock: items.reduce((s, i) => s + i.currentStock, 0),
      totalItemsStocked: items.reduce((s, i) => s + i.totalStocked, 0),
      totalItemsSold: items.reduce((s, i) => s + i.totalSold, 0),
      totalStockCostValue: items.reduce((s, i) => s + i.stockCostValue, 0),
      totalStockSellValue: items.reduce((s, i) => s + i.stockSellValue, 0),
      totalSoldCostValue: items.reduce((s, i) => s + i.soldCostValue, 0),
      totalSoldSellValue: items.reduce((s, i) => s + i.soldSellValue, 0),
      totalPotentialProfit: items.reduce((s, i) => s + i.potentialProfit, 0),
    };
    res.json({ items, summary });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/settings', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    for (const [key, value] of Object.entries(req.body)) {
      await prisma.setting.upsert({ where: { companyId_key: { companyId, key } }, update: { value: String(value) }, create: { key, value: String(value), companyId } });
    }
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const obj = {}; settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- SUPERADMIN ----
app.get('/api/v1/superadmin/stats', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const totalCompanies = await prisma.company.count();
    const activeCompanies = await prisma.company.count({ where: { isActive: true } });
    const totalUsers = await prisma.user.count({ where: { role: 'admin' } });
    const newestCompany = await prisma.company.findFirst({ orderBy: { createdAt: 'desc' } });
    const allSales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' } }, include: { items: true } });
    const totalRevenue = allSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const totalCOGS = allSales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
    const totalOrders = allSales.length;
    const revenueByCompany = {};
    allSales.forEach(s => {
      if (!revenueByCompany[s.companyId]) revenueByCompany[s.companyId] = { revenue: 0, orders: 0 };
      revenueByCompany[s.companyId].revenue += parseFloat(s.totalPrice);
      revenueByCompany[s.companyId].orders += 1;
    });
    const companyIds = Object.keys(revenueByCompany);
    const companyNames = companyIds.length > 0 ? await prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }) : [];
    const nameMap = {}; companyNames.forEach(c => { nameMap[c.id] = c.name; });
    const topCompanies = Object.entries(revenueByCompany).map(([id, data]) => ({ id, name: nameMap[id] || 'Unknown', ...data })).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    res.json({ totalCompanies, activeCompanies, totalUsers, newestCompany, totalRevenue, totalCOGS, totalOrders, topCompanies });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/superadmin/companies', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const companies = await prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, products: true, sales: true, customers: true } } },
    });
    res.json(companies);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/superadmin/companies/:id', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({
      where: { id: req.params.id },
      include: {
        users: { select: { id: true, username: true, name: true, role: true, createdAt: true } },
        _count: { select: { products: true, sales: true, customers: true, expenses: true } },
        settings: { select: { key: true, value: true } },
      },
    });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const sales = await prisma.sale.findMany({ where: { companyId: req.params.id, status: { not: 'Cancelled' } }, include: { items: true } });
    const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const cogs = sales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
    const expenses = await prisma.expense.findMany({ where: { companyId: req.params.id, category: { not: 'Stock Purchase' } }, select: { amount: true } });
    const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const settingsObj = {}; company.settings.forEach(s => { settingsObj[s.key] = s.value; });
    res.json({ ...company, settings: settingsObj, metrics: { revenue, cogs, grossProfit: revenue - cogs, totalExpenses, netProfit: revenue - cogs - totalExpenses, totalOrders: sales.length } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/superadmin/companies', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const { companyName, username, password, name } = req.body;
    if (!companyName || !username || !password || !name) return res.status(400).json({ error: 'Company name, username, password, and name are required' });
    const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const existing = await prisma.company.findUnique({ where: { slug } });
    if (existing) return res.status(400).json({ error: 'A company with a similar name already exists' });
    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) return res.status(400).json({ error: 'Username already taken' });
    const company = await prisma.company.create({ data: { name: companyName, slug } });
    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { username, password: hashed, name, role: 'admin', companyId: company.id } });
    const defaults = [{ key: 'currency', value: 'ZMW', companyId: company.id }, { key: 'businessName', value: companyName, companyId: company.id }, { key: 'currencySymbol', value: 'K', companyId: company.id }];
    for (const s of defaults) { await prisma.setting.create({ data: s }); }
    res.status(201).json({ company, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/superadmin/companies/:id', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const { name } = req.body;
    const data = {};
    if (name) data.name = name;
    const company = await prisma.company.update({ where: { id: req.params.id }, data });
    res.json(company);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/superadmin/companies/:id/toggle-status', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const updated = await prisma.company.update({ where: { id: req.params.id }, data: { isActive: !company.isActive } });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/superadmin/companies/:id', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const companyId = req.params.id;
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    await prisma.commissionPayment.deleteMany({ where: { companyId } });
    await prisma.staffPayment.deleteMany({ where: { companyId } });
    await prisma.payslipLine.deleteMany({ where: { companyId } });
    await prisma.payslip.deleteMany({ where: { companyId } });
    await prisma.payRun.deleteMany({ where: { companyId } });
    await prisma.payAdjustment.deleteMany({ where: { companyId } });
    await prisma.loan.deleteMany({ where: { companyId } });
    await prisma.consultantTarget.deleteMany({ where: { companyId } });
    await prisma.staff.deleteMany({ where: { companyId } });
    await prisma.debtReminder.deleteMany({ where: { companyId } });
    await prisma.creditPayment.deleteMany({ where: { companyId } });
    await prisma.orderStatusLog.deleteMany({ where: { companyId } });
    await prisma.stockLog.deleteMany({ where: { companyId } });
    await prisma.fiscalDocument.deleteMany({ where: { companyId } });
    await prisma.zraConfig.deleteMany({ where: { companyId } });
    await prisma.saleItem.deleteMany({ where: { sale: { companyId } } });
    await prisma.sale.deleteMany({ where: { companyId } });
    await prisma.consultant.deleteMany({ where: { companyId } });
    await prisma.product.deleteMany({ where: { companyId } });
    await prisma.customer.deleteMany({ where: { companyId } });
    await prisma.expense.deleteMany({ where: { companyId } });
    await prisma.shippingRate.deleteMany({ where: { companyId } });
    await prisma.setting.deleteMany({ where: { companyId } });
    await prisma.user.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    res.json({ message: `Company "${company.name}" and all data deleted` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- ZRA Smart Invoice, per company ----
// Only the superadmin switches it on and says where the company's VSDC is: that address is
// where BizTrack's server sends requests, so it is not something a company admin may change.
// (mirrored in server/src/routes/superadmin.js)

const ZRA_DEFAULTS = { enabled: false, environment: 'sandbox', vsdcUrl: null, tpin: null, branchId: '000', deviceSerial: null, defaultTaxCategory: null, startDate: null, qtyUnitCode: 'U', pkgUnitCode: 'NT', originCountry: null, deliveryClassCode: null, refundReasonCode: null, initialisedAt: null };

function zraView(config) {
  const c = config || ZRA_DEFAULTS;
  const { id, companyId, createdAt, updatedAt, deliveryRegisteredAt, ...rest } = c;
  return { ...ZRA_DEFAULTS, ...rest, problems: zra_configProblems(config ? c : null), allowedHosts: (process.env.ZRA_ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean) };
}

app.get('/api/v1/superadmin/companies/:id/zra', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(zraView(await prisma.zraConfig.findUnique({ where: { companyId: company.id } })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/superadmin/companies/:id/zra', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const existing = await prisma.zraConfig.findUnique({ where: { companyId: company.id } });
    const b = req.body || {};
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const data = {};
    if (b.environment !== undefined) {
      if (!['sandbox', 'production'].includes(b.environment)) return res.status(400).json({ error: 'Environment must be sandbox or production' });
      data.environment = b.environment;
    }
    if (b.vsdcUrl !== undefined) data.vsdcUrl = text(b.vsdcUrl, 300);
    if (b.tpin !== undefined) {
      data.tpin = text(b.tpin, 10);
      if (data.tpin && !/^\d{10}$/.test(data.tpin)) return res.status(400).json({ error: 'A TPIN is 10 digits' });
    }
    if (b.branchId !== undefined) {
      if (!/^\d{3}$/.test(String(b.branchId || ''))) return res.status(400).json({ error: 'The branch ID is 3 digits, e.g. 000' });
      data.branchId = String(b.branchId);
    }
    if (b.deviceSerial !== undefined) data.deviceSerial = text(b.deviceSerial, 100);
    if (b.defaultTaxCategory !== undefined) {
      data.defaultTaxCategory = text(b.defaultTaxCategory, 5);
      if (data.defaultTaxCategory && !ZRA_TAX_CATEGORIES.hasOwnProperty(data.defaultTaxCategory)) return res.status(400).json({ error: `Tax category must be one of ${Object.keys(ZRA_TAX_CATEGORIES).join(', ')}` });
    }
    if (b.startDate !== undefined) {
      data.startDate = b.startDate ? new Date(`${String(b.startDate).slice(0, 10)}T00:00:00+02:00`) : null;
      if (data.startDate && isNaN(data.startDate)) return res.status(400).json({ error: 'Start date is not a date' });
    }
    if (b.originCountry !== undefined) {
      data.originCountry = text(b.originCountry, 2)?.toUpperCase() || null;
      if (data.originCountry && !/^[A-Z]{2}$/.test(data.originCountry)) return res.status(400).json({ error: 'Country of origin is a two-letter code, e.g. CN' });
    }
    for (const k of ['qtyUnitCode', 'pkgUnitCode']) if (b[k] !== undefined) data[k] = text(b[k], 10) || ZRA_DEFAULTS[k];
    for (const k of ['deliveryClassCode', 'refundReasonCode']) if (b[k] !== undefined) data[k] = text(b[k], 20);

    // Pointing at a different VSDC or taxpayer means starting again with ZRA: the device is
    // initialised afresh, every item is registered afresh, and nothing goes out until then.
    const merged = { ...ZRA_DEFAULTS, ...(existing || {}), ...data };
    const rekeyed = existing && ['vsdcUrl', 'tpin', 'branchId', 'deviceSerial'].some(k => data[k] !== undefined && data[k] !== existing[k]);
    if (rekeyed) {
      data.initialisedAt = null; data.deliveryRegisteredAt = null; merged.initialisedAt = null;
      await prisma.product.updateMany({ where: { companyId: company.id }, data: { zraRegisteredAt: null } });
    }
    if (b.enabled !== undefined) {
      if (b.enabled === true) {
        const problems = zra_configProblems(merged);
        if (problems.length) return res.status(400).json({ error: `Before switching it on, add ${problems.join(', ')}` });
      }
      data.enabled = b.enabled === true;
    } else if (rekeyed) data.enabled = false;

    const saved = await prisma.zraConfig.upsert({ where: { companyId: company.id }, update: data, create: { ...data, companyId: company.id } });
    console.log(JSON.stringify({ event: 'zra_config', companyId: company.id, by: req.user.id, enabled: saved.enabled, environment: saved.environment }));
    res.json(zraView(saved));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// One-time hand-shake with ZRA for this TPIN, branch and device. Also the "test connection".
app.post('/api/v1/superadmin/companies/:id/zra/initialise', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const config = await prisma.zraConfig.findUnique({ where: { companyId: req.params.id } });
    if (!config) return res.status(404).json({ error: 'Save the Smart Invoice settings first' });
    const missing = zra_configProblems(config).filter(p => p !== 'initialising the device with ZRA');
    if (missing.length) return res.status(400).json({ error: `Add ${missing.join(', ')} first` });
    const r = await zra_post(config, '/initializer/selectInitInfo', { tpin: config.tpin, bhfId: config.branchId, dvcSrlNo: config.deviceSerial });
    // 902 is ZRA's "this device is already initialised", which is as good as a fresh one.
    const ok = r.ok || (r.reached && r.code === '902');
    if (!ok) return res.status(502).json({ error: r.error });
    const saved = await prisma.zraConfig.update({ where: { id: config.id }, data: { initialisedAt: new Date() } });
    res.json(zraView(saved));
  } catch (err) {
    if (err.constructor?.name === 'ZraProblem') return res.status(400).json({ error: err.message });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---- ZRA Smart Invoice, the company's own view ----
// Whether it is on, and what has not gone through. (mirrored in server/src/routes/zra.js)
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

app.get('/api/v1/zra/status', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await zra_status(prisma, req.user.companyId));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Try everything that has not gone through, refusals included: whoever presses this has
// presumably fixed what ZRA complained about.
app.post('/api/v1/zra/retry', authenticate, requireAdmin, async (req, res) => {
  try {
    await zra_sendWaiting(prisma, req.user.companyId, { includeFailed: true, limit: 20 });
    res.json(await zra_status(prisma, req.user.companyId));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/zra/documents/:id/retry', authenticate, requireAdmin, async (req, res) => {
  try {
    const doc = await prisma.fiscalDocument.findFirst({ where: { id: req.params.id, companyId: req.user.companyId }, select: { id: true } });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    await zra_send(prisma, doc.id, { includeFailed: true });
    res.json(await zra_status(prisma, req.user.companyId));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});


app.put('/api/v1/superadmin/companies/:id/logo', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const companyId = req.params.id;
    const { logo } = req.body;
    if (!logo && logo !== '') return res.status(400).json({ error: 'Logo data required' });
    await prisma.setting.upsert({ where: { companyId_key: { companyId, key: 'companyLogo' } }, update: { value: logo }, create: { key: 'companyLogo', value: logo, companyId } });
    res.json({ message: 'Logo updated' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/superadmin/companies/:id/users', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const companyId = req.params.id;
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Username, password, and name are required' });
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) return res.status(400).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { username, password: hashed, name, role: 'admin', companyId } });
    res.status(201).json({ id: user.id, username: user.username, name: user.name, role: user.role, createdAt: user.createdAt });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/superadmin/users/:id/reset-password', authenticate, requireSuperadmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot reset superadmin password from here' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.params.id }, data: { password: hashed } });
    res.json({ message: 'Password reset successfully' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PUBLIC STORE ----
app.get('/api/v1/store/:slug/info', async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const settings = await prisma.setting.findMany({ where: { companyId: company.id } });
    const s = {}; settings.forEach(st => { s[st.key] = st.value; });
    const lencoKey = s.lencoPublicKey || s.broadpayPublicKey || null;
    // Send logo as URL reference, not base64 blob
    const hasLogo = !!(s.companyLogo);
    res.json({ name: s.businessName || company.name, slug: company.slug, logo: hasLogo ? `/api/v1/store/${req.params.slug}/logo` : null, phone: s.companyPhone || null, email: s.companyEmail || null, address: s.companyAddress || null, website: s.companyWebsite || null, currency: s.currencySymbol || s.currency || 'K', whatsapp: s.whatsappNumber || null, storeMessage: s.storeMessage || null, paymentEnabled: !!lencoKey, lencoPublicKey: lencoKey });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Serve logo as image with caching
app.get('/api/v1/store/:slug/logo', async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).end();
    const setting = await prisma.setting.findFirst({ where: { companyId: company.id, key: 'companyLogo' } });
    if (!setting?.value) return res.status(404).end();
    const match = setting.value.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(404).end();
    const buffer = Buffer.from(match[2], 'base64');
    res.set({ 'Content-Type': match[1], 'Cache-Control': 'public, max-age=86400', 'Content-Length': buffer.length });
    res.send(buffer);
  } catch { res.status(500).end(); }
});

// Serve product image with caching
app.get('/api/v1/store/product-image/:id', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { imageUrl: true } });
    if (!product?.imageUrl) return res.status(404).end();
    const match = product.imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(404).end();
    const buffer = Buffer.from(match[2], 'base64');
    res.set({ 'Content-Type': match[1], 'Cache-Control': 'public, max-age=86400', 'Content-Length': buffer.length });
    res.send(buffer);
  } catch { res.status(500).end(); }
});

// Group storefront tiles into the sections the store renders as headed rows.
// Categories are keyed on a normalised label so a stray "fridges" or "Fridge " can't split a
// section in two — scripts/merge-product-categories.js fixes the stored spellings, this is the
// safety net for whatever gets typed next. A category holding a single product would be a
// heading with one tile under it, so those fall through into "More" at the end.
// (mirrored in server/src/routes/store.js)
function buildStoreSections(tiles) {
  const norm = c => (c || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const byCat = new Map();
  const loose = [];
  for (const t of tiles) {
    const key = norm(t.category);
    if (!key) { loose.push(t); continue; }
    if (!byCat.has(key)) byCat.set(key, { labels: new Map(), tiles: [] });
    const entry = byCat.get(key);
    const label = t.category.trim();
    entry.labels.set(label, (entry.labels.get(label) || 0) + 1);
    entry.tiles.push(t);
  }
  const sections = [];
  for (const entry of byCat.values()) {
    if (entry.tiles.length < 2) { loose.push(...entry.tiles); continue; }
    const title = [...entry.labels.entries()].sort((a, b) => b[1] - a[1])[0][0];
    sections.push({ title, tiles: entry.tiles });
  }
  // Biggest categories first — that puts the ranges people actually shop for at the top and
  // keeps working as the catalogue changes, unlike a hand-maintained order.
  sections.sort((a, b) => b.tiles.length - a.tiles.length || a.title.localeCompare(b.title));
  if (loose.length) sections.push({ title: 'More', tiles: loose });
  return sections.map(s => ({
    title: s.title,
    // Cheapest first, so a range reads 43" -> 85" instead of jumbling model names.
    productIds: s.tiles.slice().sort((a, b) => parseFloat(a.sellingPrice) - parseFloat(b.sellingPrice)).map(t => t.id),
  }));
}

app.get('/api/v1/store/:slug/products', async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const { category, search } = req.query;
    // No stock filter here — an out-of-stock color variant still needs to appear (as a disabled
    // swatch) if a sibling in its group is in stock. Zero-stock tiles are filtered out after grouping.
    const where = { companyId: company.id, isActive: true };
    if (category) where.category = category;
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }]; }
    const products = await prisma.product.findMany({ where, select: { id: true, name: true, description: true, category: true, sellingPrice: true, originalPrice: true, stock: true, groupId: true, variantLabel: true, group: { select: { id: true, name: true } } } });
    const withImages = await prisma.product.findMany({ where: { ...where, imageUrl: { not: null } }, select: { id: true } });
    const imageIds = new Set(withImages.map(p => p.id));

    // Units sold over the last 90 days, per product — drives the "Popular right now" strip.
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const velocityRows = products.length
      ? await prisma.saleItem.groupBy({
          by: ['productId'],
          where: { productId: { in: products.map(p => p.id) }, sale: { companyId: company.id, date: { gte: since }, status: { not: 'Cancelled' } } },
          _sum: { qty: true },
        })
      : [];
    const velocityMap = new Map(velocityRows.map(v => [v.productId, v._sum.qty || 0]));

    const enriched = products.map(p => ({
      ...p,
      imageUrl: imageIds.has(p.id) ? `/api/v1/store/product-image/${p.id}` : null,
      _velocity: velocityMap.get(p.id) || 0,
    }));

    const byGroup = new Map();
    const ungrouped = [];
    for (const p of enriched) {
      if (p.groupId) {
        if (!byGroup.has(p.groupId)) byGroup.set(p.groupId, []);
        byGroup.get(p.groupId).push(p);
      } else {
        ungrouped.push(p);
      }
    }
    const toVariant = v => ({ id: v.id, variantLabel: v.variantLabel, sellingPrice: v.sellingPrice, originalPrice: v.originalPrice, stock: v.stock, imageUrl: v.imageUrl });
    const groupedTiles = [...byGroup.entries()].map(([groupId, variants]) => {
      variants.sort((a, b) => (a.variantLabel || a.name).localeCompare(b.variantLabel || b.name));
      const primary = variants[0];
      return {
        id: primary.id, groupId, name: primary.group?.name || primary.name, description: primary.description, category: primary.category,
        sellingPrice: primary.sellingPrice, originalPrice: primary.originalPrice,
        stock: variants.reduce((sum, v) => sum + v.stock, 0), imageUrl: primary.imageUrl,
        variants: variants.map(toVariant),
        _velocity: variants.reduce((sum, v) => sum + v._velocity, 0),
      };
    });
    const ungroupedTiles = ungrouped.map(p => ({
      id: p.id, groupId: null, name: p.name, description: p.description, category: p.category,
      sellingPrice: p.sellingPrice, originalPrice: p.originalPrice, stock: p.stock, imageUrl: p.imageUrl,
      variants: [toVariant(p)], _velocity: p._velocity,
    }));
    const inStock = [...ungroupedTiles, ...groupedTiles].filter(t => t.stock > 0);

    // Sections are the default view; a filtered or searched request is a flat result list, so
    // there is nothing to section and the client falls back to its plain grid.
    const sections = (category || search) ? [] : buildStoreSections(inStock);
    const popularIds = inStock
      .filter(t => t._velocity > 0)
      .sort((a, b) => b._velocity - a._velocity)
      .slice(0, 8)
      .map(t => t.id);

    const productsWithUrls = inStock
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ _velocity, ...rest }) => rest);
    // Pills come from the sections themselves so a pill can never point at a heading that
    // isn't on the page.
    const categories = sections.filter(s => s.title !== 'More').map(s => s.title);
    res.json({ products: productsWithUrls, categories, sections, popularIds });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- Meta catalogue feed ----
// The Meta (Facebook / WhatsApp) catalogue feed: one CSV row per sellable product, which Commerce
// Manager fetches on a schedule. (mirrored in server/src/utils/metaFeed.js)
//
// Everything here only reads. A product that is missing something Meta requires is left out and
// reported with the reason, rather than padded with invented data — Meta rejects bad rows anyway,
// and an honest gap is easier to fix from the validation report than a made-up brand is to notice.

const META_FEED_COLUMNS = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand', 'product_type', 'item_group_id', 'sale_price'];

// Stores with their own shopper-facing domain. Mirrors STORE_DOMAINS in client/src/App.jsx; a store
// without one is served at /store/:slug on whichever host the feed was fetched from.
const STORE_ORIGINS = { 'privtech-solutions': 'https://store.privtech.net' };

function metaOrigins(slug, req) {
  if (STORE_ORIGINS[slug]) return { origin: STORE_ORIGINS[slug], storePath: '/' };
  return { origin: `https://${req.get('host')}`, storePath: `/store/${encodeURIComponent(slug)}` };
}

// Settings that switch the feed on and shape it. Opt-in per company, so no other tenant's catalogue
// starts appearing at a public URL because this shipped.
async function loadFeedSettings(prisma, companyId) {
  const rows = await prisma.setting.findMany({ where: { companyId, key: { in: ['metaFeedEnabled', 'metaFeedBrand', 'metaFeedSecret', 'currency'] } } });
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return {
    enabled: s.metaFeedEnabled === 'true',
    fallbackBrand: (s.metaFeedBrand || '').trim(),
    secret: (s.metaFeedSecret || '').trim(),
    currency: /^[A-Z]{3}$/.test(s.currency || '') ? s.currency : 'ZMW',
  };
}

function feedTokenMatches(secret, token) {
  if (!secret) return true;
  const a = crypto.createHash('sha256').update(String(token || '')).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

const plain = (s, max) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (n, currency) => `${Number(n).toFixed(2)} ${currency}`;

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A variant whose own name already carries its label ("T-Shirt Red") keeps it once.
function metaTitle(p) {
  const name = plain(p.name, 200);
  const label = plain(p.variantLabel, 100);
  if (!label || name.toLowerCase().includes(label.toLowerCase())) return name;
  return `${name} - ${label}`.slice(0, 200);
}

// Images are stored as base64 in the row and served by /store/product-image/:id. Meta only accepts
// JPEG or PNG, and only re-downloads an image whose URL changed, so the URL carries the product's
// updatedAt.
function metaImage(p, imageRef, origin) {
  if (!imageRef) return { error: 'no image' };
  const data = imageRef.match(/^data:image\/([\w.+-]+);base64,/i);
  if (data) {
    if (!/^(jpeg|jpg|png)$/i.test(data[1])) return { error: `image is ${data[1]}; Meta accepts JPEG or PNG` };
    return { url: `${origin}/api/v1/store/product-image/${p.id}?v=${new Date(p.updatedAt).getTime()}` };
  }
  if (/^https:\/\/\S+$/i.test(imageRef) && imageRef.length <= 2000) return { url: imageRef };
  return { error: 'image is not a public HTTPS URL' };
}

// Turns the company's active products into feed rows, plus the list of products left out and why.
// Only active products are read; Meta drops anything missing from a scheduled feed, so
// deactivating a product in BizTrack removes it from the catalogue on the next fetch.
async function buildMetaFeed(prisma, company, settings, { origin, storePath }) {
  const products = await prisma.product.findMany({
    where: { companyId: company.id, isActive: true },
    select: { id: true, name: true, sku: true, description: true, category: true, brand: true, sellingPrice: true, originalPrice: true, stock: true, groupId: true, variantLabel: true, updatedAt: true },
    orderBy: [{ groupId: 'asc' }, { name: 'asc' }],
  });
  // Only the first few characters of a base64 image are needed to know its type; pulling the whole
  // thing for every product would move megabytes to write a URL.
  const imageRows = products.length ? await prisma.$queryRaw`
    SELECT "id", CASE WHEN "imageUrl" LIKE 'data:%' THEN left("imageUrl", 40) ELSE "imageUrl" END AS "ref"
    FROM "Product" WHERE "companyId" = ${company.id} AND "isActive" = true AND "imageUrl" IS NOT NULL AND "imageUrl" <> ''` : [];
  const imageRef = new Map(imageRows.map(r => [r.id, r.ref]));

  const rows = [];
  const excluded = [];
  for (const p of products) {
    const errors = [];
    const title = metaTitle(p);
    if (!title) errors.push('no name');
    const description = plain(p.description, 9999);
    if (!description) errors.push('no description');
    const brand = plain(p.brand, 100) || plain(settings.fallbackBrand, 100);
    if (!brand) errors.push('no brand, and no fallback brand set');
    const selling = parseFloat(p.sellingPrice);
    if (!(selling > 0)) errors.push('selling price is not above zero');
    const image = metaImage(p, imageRef.get(p.id), origin);
    if (image.error) errors.push(image.error);
    if (errors.length) { excluded.push({ id: p.id, name: p.name, sku: p.sku, errors }); continue; }

    // A struck-through original price is the full price and the selling price is the sale, which is
    // how the store shows it. Meta requires sale_price to be below price.
    const original = p.originalPrice != null ? parseFloat(p.originalPrice) : null;
    const onSale = original != null && original > selling;
    rows.push({
      id: p.id,
      title,
      description,
      availability: p.stock > 0 ? 'in stock' : 'out of stock',
      condition: 'new',
      price: money(onSale ? original : selling, settings.currency),
      link: `${origin}${storePath}?product=${encodeURIComponent(p.id)}`,
      image_link: image.url,
      brand,
      product_type: plain(p.category, 750),
      item_group_id: p.groupId || '',
      sale_price: onSale ? money(selling, settings.currency) : '',
    });
  }
  const csv = [META_FEED_COLUMNS.join(','), ...rows.map(r => META_FEED_COLUMNS.map(c => csvField(r[c])).join(','))].join('\n') + '\n';
  return { rows, excluded, csv };
}

// Meta catalogue feed, fetched by Commerce Manager on a schedule. Anything short of a real feed is
// a non-200 with no-store: Meta keeps the catalogue it has when a fetch fails, whereas a 200 with
// no rows would empty the Facebook and WhatsApp catalogues after a database blip.
app.get('/api/v1/store/:slug/meta-feed.csv', async (req, res) => {
  const started = Date.now();
  const slug = req.params.slug;
  const log = (level, fields) => console[level](JSON.stringify({ event: 'meta_feed', slug, ms: Date.now() - started, ...fields }));
  const refuse = (status, message, headers = {}) => res.status(status).set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', ...headers }).send(message);
  try {
    const company = await prisma.company.findUnique({ where: { slug } });
    if (!company || !company.isActive) return refuse(404, 'Store not found');
    const settings = await loadFeedSettings(prisma, company.id);
    // Disabled and wrong-token look the same from outside, so the URL can't be probed for which.
    if (!settings.enabled || !feedTokenMatches(settings.secret, req.query.token)) return refuse(404, 'Store not found');
    const feed = await buildMetaFeed(prisma, company, settings, metaOrigins(slug, req));
    if (!feed.rows.length) {
      log('warn', { outcome: 'refused_empty', excluded: feed.excluded.length });
      return refuse(503, 'No products are eligible for the catalogue; refusing to publish an empty feed.', { 'Retry-After': '3600' });
    }
    log('log', { outcome: 'ok', included: feed.rows.length, excluded: feed.excluded.length });
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      // The CDN answers repeat fetches for 15 minutes, so an hourly Meta schedule sees changes
      // within the hour without every fetch reaching the database.
      'Cache-Control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=300',
      'X-Robots-Tag': 'noindex',
    });
    res.send(feed.csv);
  } catch (err) {
    log('error', { outcome: 'error', error: err.message });
    refuse(503, 'Feed temporarily unavailable', { 'Retry-After': '600' });
  }
});

app.post('/api/v1/store/:slug/order', async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const companyId = company.id;
    const data = req.body;
    if (!data.items || !data.items.length) return res.status(400).json({ error: 'Cart is empty' });
    if (!data.customerName) return res.status(400).json({ error: 'Name is required' });
    if (!data.customerPhone) return res.status(400).json({ error: 'Phone number is required' });

    const productIds = data.items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId, isActive: true } });
    const productMap = {}; products.forEach(p => { productMap[p.id] = p; });
    for (const item of data.items) {
      const product = productMap[item.productId];
      if (!product) return res.status(400).json({ error: 'Product not found' });
      if (product.stock < item.qty) return res.status(400).json({ error: `${product.name} only has ${product.stock} in stock` });
    }

    const saleItems = data.items.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(product.sellingPrice);
      const qty = parseInt(item.qty);
      return { productId: item.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice: qty * unitPrice };
    });
    const itemsTotal = saleItems.reduce((sum, i) => sum + i.totalPrice, 0);

    let shippingCost = 0, shippingCharge = 0;
    if (data.customerCity) {
      const rate = await prisma.shippingRate.findFirst({ where: { city: { equals: data.customerCity, mode: 'insensitive' }, companyId } });
      if (rate) { shippingCost = parseFloat(rate.rate); shippingCharge = parseFloat(rate.rate); }
    }
    const totalPrice = itemsTotal + shippingCharge;

    const lastSale = await prisma.sale.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    let nextNum = 1;
    if (lastSale) { const match = lastSale.orderNumber.match(/ORD-(\d+)/); if (match) nextNum = parseInt(match[1]) + 1; }
    const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

    let customerId = null;
    if (data.customerPhone) {
      let customer = await prisma.customer.findFirst({ where: { phone: data.customerPhone, companyId } });
      if (!customer) customer = await prisma.customer.create({ data: { name: data.customerName, phone: data.customerPhone, city: data.customerCity || null, source: 'Online Store', companyId } });
      customerId = customer.id;
    }

    const sale = await prisma.sale.create({
      data: { orderNumber, totalPrice, shippingCost, shippingCharge, status: 'Pending', paymentStatus: 'Unpaid', paymentType: 'Cash', source: 'Online Store', customerId, customerName: data.customerName, customerPhone: data.customerPhone, customerCity: data.customerCity || null, deliveryAddress: data.deliveryAddress || null, notes: data.notes || null, companyId, items: { create: saleItems } }
    });
    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: 'New', toStatus: 'Pending', companyId } });

    res.status(201).json({ orderNumber: sale.orderNumber, saleId: sale.id, total: totalPrice, shippingCharge, message: 'Order placed successfully!' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Verify Lenco payment and update sale.
// Only marks Paid when Lenco's API confirms `status === 'successful'`.
// On any other outcome (no secret key, network error, non-success status), returns
// verified:false with paymentStatus:'Pending' — webhook will reconcile later.
app.post('/api/v1/store/:slug/verify-payment', async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ error: 'Store not found' });
    const { reference, saleId } = req.body;
    if (!reference || !saleId) return res.status(400).json({ error: 'Missing reference or saleId' });

    const sale = await prisma.sale.findFirst({ where: { id: saleId, companyId: company.id } });
    if (!sale) return res.status(404).json({ error: 'Order not found' });

    const settings = await prisma.setting.findMany({ where: { companyId: company.id } });
    const settingsMap = {}; settings.forEach(s => { settingsMap[s.key] = s.value; });
    const secretKey = settingsMap.lencoSecretKey;

    if (!secretKey) {
      // No secret key configured — can't trust the unverified frontend callback. Webhook (if set up) will reconcile.
      console.warn('verify-payment: lencoSecretKey not configured; leaving sale as Pending');
      return res.json({ verified: false, paymentStatus: sale.paymentStatus, reason: 'no-secret-key' });
    }

    try {
      const verifyRes = await fetch(`https://api.lenco.co/access/v2/collections/status/${reference}`, {
        headers: { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/json' }
      });
      const verifyData = await verifyRes.json();
      console.log('Lenco verify response:', JSON.stringify(verifyData));
      if (verifyData.status === true && verifyData.data?.status === 'successful') {
        await prisma.sale.update({ where: { id: sale.id }, data: { paymentStatus: 'Paid', paymentMethod: 'Lenco Online', amountPaid: parseFloat(sale.totalPrice) } });
        return res.json({ verified: true, paymentStatus: 'Paid' });
      }
      // Lenco reachable but didn't confirm success — could be pending, failed, or unknown reference
      return res.json({ verified: false, paymentStatus: sale.paymentStatus, lencoStatus: verifyData.data?.status || 'unknown' });
    } catch (verifyErr) {
      console.error('Lenco verify error:', verifyErr.message);
      // Network/API error — leave sale as Pending; webhook will reconcile if it fires
      return res.json({ verified: false, paymentStatus: sale.paymentStatus, reason: 'verify-error' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Lenco webhook
app.post('/api/v1/store/webhook/lenco', async (req, res) => {
  try {
    const { event, data } = req.body;
    if (event === 'virtual-account.transaction' || event === 'transaction.successful') {
      const reference = data?.reference || data?.transactionReference;
      if (reference) {
        const sale = await prisma.sale.findFirst({ where: { id: reference } });
        if (sale && sale.paymentStatus !== 'Paid') {
          await prisma.sale.update({ where: { id: sale.id }, data: { paymentStatus: 'Paid', paymentMethod: 'Lenco Online', amountPaid: parseFloat(sale.totalPrice) } });
        }
      }
    }
    res.json({ status: 'ok' });
  } catch (err) { console.error('Webhook error:', err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Payment status check
app.get('/api/v1/store/:slug/payment-status/:saleId', async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ error: 'Store not found' });
    const sale = await prisma.sale.findFirst({ where: { id: req.params.saleId, companyId: company.id }, select: { orderNumber: true, totalPrice: true, paymentStatus: true, shippingCharge: true } });
    if (!sale) return res.status(404).json({ error: 'Order not found' });
    res.json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CONSULTANTS ----
app.get('/api/v1/consultants/me', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'consultant') return res.status(403).json({ error: 'Consultant access required' });
    const consultant = await prisma.consultant.findFirst({ where: { id: req.user.consultantId, companyId: req.user.companyId } });
    if (!consultant) return res.status(404).json({ error: 'Not found' });
    res.json(consultant);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/consultants/me/stock', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'consultant') return res.status(403).json({ error: 'Consultant access required' });
    const stock = await prisma.consultantStock.findMany({
      where: { consultantId: req.user.consultantId, companyId: req.user.companyId, qty: { gt: 0 } },
      include: { product: { select: { id: true, name: true, sku: true, sellingPrice: true, imageUrl: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(stock);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/consultants/me/transfers', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'consultant') return res.status(403).json({ error: 'Consultant access required' });
    const transfers = await prisma.stockTransfer.findMany({
      where: { consultantId: req.user.consultantId, companyId: req.user.companyId },
      include: { product: { select: { name: true, sku: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(transfers);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Stock locations (e.g. "My Car") — Consultant rows flagged isStockLocation=true. Reuse the
// mini-stock/transfer machinery but earn no commission and are excluded from commission calcs.
// Just enough to attribute a sale: who the seller could be, by name. Deliberately not the
// full consultant record, which carries commission rates and pay terms the warehouse has no
// business seeing. (mirrored in server/src/routes/consultants.js)
app.get('/api/v1/consultants/names', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const consultants = await prisma.consultant.findMany({
      where: { companyId: req.user.companyId, isActive: true, isStockLocation: false },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(consultants);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/consultants/stock-locations', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const locations = await prisma.consultant.findMany({
      where: { companyId, isStockLocation: true, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(locations);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/consultants/stock-locations', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const location = await prisma.consultant.create({
      data: { name, companyId, isStockLocation: true, commissionRate: 0, tierThreshold: 0, tierRate: 0, monthlyAllowance: 0 },
    });
    res.status(201).json({ id: location.id, name: location.name });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Where every unit of stock currently sits: warehouse (Product.stock) + every consultant/car
// mini-stock pool. Pulls from the same two tables everything else already deducts from.
app.get('/api/v1/consultants/stock-allocations', authenticate, requireAdmin, async (req, res) => {
  try {
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

app.get('/api/v1/consultants/commission-summary', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to, consultantId, period } = req.query;
    const payDay = await getCompanyPayDay(companyId);

    let periodFrom = null, periodTo = null, periodLabel = null, payDate = null, isCycle = false;
    if (period) { ({ periodFrom, periodTo, label: periodLabel, payDate } = payPeriodFromLabel(period, payDay)); isCycle = true; }
    else if (!from && !to) { ({ periodFrom, periodTo, label: periodLabel, payDate } = getConsultantPayPeriod(new Date(), payDay)); isCycle = true; }

    const saleWhere = { companyId, status: { not: 'Cancelled' }, consultantId: { not: null } };
    if (consultantId) saleWhere.consultantId = consultantId;
    if (isCycle) saleWhere.date = { gte: periodFrom, lt: periodTo };
    else if (from || to) { saleWhere.date = {}; if (from) saleWhere.date.gte = new Date(from); if (to) saleWhere.date.lte = new Date(to + 'T23:59:59.999Z'); }

    const paymentWhere = { companyId };
    if (isCycle) { paymentWhere.periodFrom = { gte: periodFrom }; paymentWhere.periodTo = { lte: periodTo }; }

    const [sales, consultants, payments] = await Promise.all([
      prisma.sale.findMany({ where: saleWhere, include: { consultant: true, items: true } }),
      prisma.consultant.findMany({ where: { companyId, isStockLocation: false } }),
      prisma.commissionPayment.findMany({ where: paymentWhere }),
    ]);

    const summary = consultants.map(c => {
      let eff = { factor: 1, prorated: false, effectiveFrom: periodFrom, effectiveTo: periodTo };
      let activeInPeriod = true;
      if (isCycle) { const sliced = getEffectivePeriod(periodFrom, periodTo, c.startDate); if (!sliced) activeInPeriod = false; else eff = sliced; }
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
        activeInPeriod, prorated: eff.prorated, effectiveFrom: eff.effectiveFrom, effectiveTo: eff.effectiveTo,
        totalSales, totalProductsSold, totalRevenue, commissionEarned, commissionPaid, balance,
        allowancePaid, allowanceCap, allowanceRemaining, advancePaid,
      };
    });
    // Once pay runs cover a cycle, the payslip is the answer to what is owed, not the sum above.
    const pay = isCycle ? await payroll_consultantPay(prisma, companyId, periodLabel) : null;
    if (pay) {
      for (const row of summary) {
        row.payslip = pay.slips.get(row.consultant.id) || null;
        row.balance = row.payslip ? row.payslip.balance : 0;
      }
    }

    const totals = { totalSales: summary.reduce((s, c) => s + c.totalSales, 0), totalRevenue: summary.reduce((s, c) => s + c.totalRevenue, 0), totalCommissionEarned: summary.reduce((s, c) => s + c.commissionEarned, 0), totalCommissionPaid: summary.reduce((s, c) => s + c.commissionPaid, 0), totalAllowancePaid: summary.reduce((s, c) => s + c.allowancePaid, 0), totalAdvancePaid: summary.reduce((s, c) => s + c.advancePaid, 0), totalBalance: summary.reduce((s, c) => s + c.balance, 0) };
    res.json({ summary, totals, period: isCycle ? { from: periodFrom, to: periodTo, label: periodLabel, payDate, payDay } : null });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Everything worth checking before running a commission payout for a cycle: sales that are still
// unpaid/partially paid (earn zero/partial commission — see calcCommission) and sales that look
// like double-submit duplicates (same consultant + customer + amount, created close together).
app.get('/api/v1/consultants/pay-review', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to, consultantId, period } = req.query;
    const payDay = await getCompanyPayDay(companyId);

    let periodFrom = null, periodTo = null, periodLabel = null, isCycle = false;
    if (period) { ({ periodFrom, periodTo, label: periodLabel } = payPeriodFromLabel(period, payDay)); isCycle = true; }
    else if (!from && !to) { ({ periodFrom, periodTo, label: periodLabel } = getConsultantPayPeriod(new Date(), payDay)); isCycle = true; }

    const where = { companyId, status: { not: 'Cancelled' }, consultantId: { not: null } };
    if (consultantId) where.consultantId = consultantId;
    if (isCycle) where.date = { gte: periodFrom, lt: periodTo };
    else if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }

    const sales = await prisma.sale.findMany({
      where,
      select: {
        id: true, orderNumber: true, date: true, createdAt: true, totalPrice: true, amountPaid: true,
        paymentStatus: true, paymentType: true, customerName: true, customerPhone: true,
        consultantId: true, consultant: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

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

    const DUPLICATE_WINDOW_MS = 2 * 60 * 60 * 1000;
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
        if (new Date(group[i].createdAt) - new Date(cluster[cluster.length - 1].createdAt) <= DUPLICATE_WINDOW_MS) cluster.push(group[i]);
        else { flush(); cluster = [group[i]]; }
      }
      flush();
    }

    res.json({
      period: isCycle ? { from: periodFrom, to: periodTo, label: periodLabel } : null,
      unpaidSales, unpaidCount: unpaidSales.length, unpaidTotal,
      possibleDuplicates, duplicateGroupCount: possibleDuplicates.length,
      duplicateSaleCount: possibleDuplicates.reduce((sum, g) => sum + g.sales.length, 0),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/consultants', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { active } = req.query;
    const where = { companyId };
    if (active === 'true') where.isActive = true;
    if (active === 'false') where.isActive = false;
    const consultants = await prisma.consultant.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json(consultants);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/consultants/:id', authenticate, async (req, res) => {
  if (req.user.role === 'consultant' && req.params.id !== req.user.consultantId) return res.status(403).json({ error: 'Forbidden' });
  try {
    const companyId = req.user.companyId;
    const { period } = req.query;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    const payDay = await getCompanyPayDay(companyId);
    let periodInfo = null;
    let salesWhere = { consultantId: consultant.id, companyId, status: { not: 'Cancelled' } };
    let paymentsWhere = { consultantId: consultant.id, companyId };

    if (period) {
      const cycle = payPeriodFromLabel(period, payDay);
      const eff = getEffectivePeriod(cycle.periodFrom, cycle.periodTo, consultant.startDate);
      periodInfo = {
        from: cycle.periodFrom, to: cycle.periodTo, label: cycle.label, payDate: cycle.payDate, payDay,
        prorated: eff?.prorated || false, effectiveFrom: eff?.effectiveFrom || null, effectiveTo: eff?.effectiveTo || null,
        factor: eff?.factor ?? 0, activeInPeriod: !!eff,
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
    // Once pay runs cover the cycle, the payslip is the answer to what is owed.
    const pay = period ? await payroll_consultantPay(prisma, companyId, period) : null;
    const payslip = pay ? pay.slips.get(consultant.id) || null : null;
    const balance = pay ? (payslip ? payslip.balance : 0) : commissionEarned - commissionPaid - advancePaid;
    const baseAllowance = parseFloat(consultant.monthlyAllowance) || 0;
    const allowanceCap = periodInfo ? Math.round(baseAllowance * (periodInfo.factor || 0) * 100) / 100 : null;
    const allowanceRemaining = allowanceCap !== null ? Math.max(0, allowanceCap - allowancePaid) : null;

    res.json({
      ...consultant,
      totalSales, totalProductsSold, totalRevenue,
      commissionEarned, commissionPaid, balance,
      allowancePaid, allowanceCap, allowanceRemaining, advancePaid,
      period: periodInfo, payslip, sales, payments,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/consultants', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { name, phone, whatsapp, payType, commissionRate, tierThreshold, tierRate, monthlyAllowance, startDate, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const consultant = await prisma.consultant.create({ data: { name, phone: phone || null, whatsapp: whatsapp || null, payType: payType || 'per_unit', commissionRate: parseFloat(commissionRate) || 50, tierThreshold: parseInt(tierThreshold) || 50, tierRate: parseFloat(tierRate) || 30, monthlyAllowance: parseFloat(monthlyAllowance) || 400, startDate: startDate ? new Date(startDate) : null, notes: notes || null, companyId } });
    res.status(201).json(consultant);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/consultants/:id', authenticate, requireAdmin, async (req, res) => {
  try {
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

app.delete('/api/v1/consultants/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Consultant not found' });
    // Pay history is a record of money, so it keeps the consultant just as their sales do.
    const salesCount = await prisma.sale.count({ where: { consultantId: req.params.id } })
      + await prisma.payslip.count({ where: { consultantId: req.params.id } })
      + await prisma.loan.count({ where: { consultantId: req.params.id } })
      + await prisma.payAdjustment.count({ where: { consultantId: req.params.id } });
    // A target nobody was paid on is not history, so it goes with the consultant.
    if (salesCount === 0) await prisma.consultantTarget.deleteMany({ where: { consultantId: req.params.id } });
    if (salesCount > 0) {
      await prisma.consultant.update({ where: { id: req.params.id }, data: { isActive: false } });
      return res.json({ message: 'Consultant deactivated (has existing sales)' });
    }
    const doomed = await prisma.commissionPayment.findMany({ where: { consultantId: req.params.id }, select: { expenseId: true } });
    await prisma.commissionPayment.deleteMany({ where: { consultantId: req.params.id } });
    const expenseIds = doomed.map(p => p.expenseId).filter(Boolean);
    if (expenseIds.length) await prisma.expense.deleteMany({ where: { id: { in: expenseIds }, companyId: req.user.companyId } });
    await prisma.consultant.delete({ where: { id: req.params.id } });
    res.json({ message: 'Consultant deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/consultants/:id/payments', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    const payDay = await getCompanyPayDay(companyId);
    let { amount, type, periodFrom, periodTo, paymentMethod, reference, notes } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

    if (!periodFrom && !periodTo) {
      const cycle = getConsultantPayPeriod(new Date(), payDay);
      periodFrom = cycle.periodFrom; periodTo = cycle.periodTo;
    } else {
      periodFrom = periodFrom ? new Date(periodFrom) : null;
      periodTo = periodTo ? new Date(periodTo) : null;
    }

    if ((type || 'commission') !== 'allowance') {
      const closed = await payroll_finalisedCycleOf(prisma, companyId, periodFrom, periodTo);
      if (closed) return res.status(400).json({ error: `The ${closed} cycle is finalised. Pay it from its payslip on the Payroll page.` });
    }

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
        return res.status(400).json({ error: `Allowance cap reached. Cap: K${cap.toFixed(2)}${eff.prorated ? ' (prorated)' : ''}. Already paid: K${paidSoFar.toFixed(2)}. Remaining: K${Math.max(0, cap - paidSoFar).toFixed(2)}.` });
      }
    }

    // Commission and allowance are wages, so each raises a Salaries & Wages expense and the
    // payment owns it — deleting the payment takes the cost back out. An advance raises none:
    // it is a loan against pay not yet earned. (see the PAYROLL section above)
    const payment = await prisma.$transaction(async (tx) => {
      const expenseId = await payroll_raiseExpense(tx, {
        name: consultant.name, type: type || 'commission', amount: parseFloat(amount),
        periodFrom, periodTo, paymentMethod, notes, companyId,
      });
      return tx.commissionPayment.create({ data: { consultantId: consultant.id, amount: parseFloat(amount), type: type || 'commission', periodFrom, periodTo, paymentMethod: paymentMethod || null, reference: reference || null, notes: notes || null, expenseId, companyId } });
    }, { timeout: 20000 });
    res.status(201).json(payment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/consultants/:id/payments', authenticate, async (req, res) => {
  if (req.user.role === 'consultant' && req.params.id !== req.user.consultantId) return res.status(403).json({ error: 'Forbidden' });
  try {
    const companyId = req.user.companyId;
    const payments = await prisma.commissionPayment.findMany({ where: { consultantId: req.params.id, companyId }, orderBy: { createdAt: 'desc' } });
    res.json(payments);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CONSULTANT STOCK ----
app.get('/api/v1/consultants/:id/stock', authenticate, async (req, res) => {
  if (req.user.role === 'consultant' && req.params.id !== req.user.consultantId) return res.status(403).json({ error: 'Forbidden' });
  try {
    const companyId = req.user.companyId;
    const stock = await prisma.consultantStock.findMany({ where: { consultantId: req.params.id, companyId, qty: { gt: 0 } }, include: { product: { select: { id: true, name: true, sku: true, sellingPrice: true } } } });
    res.json(stock);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/consultants/:id/stock/transfer', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
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
    await prisma.product.update({ where: { id: productId }, data: { stock: { decrement: quantity } } });
    await prisma.stockLog.create({ data: { productId, change: -quantity, reason: `Transfer to ${consultant.name}`, companyId } });
    await prisma.consultantStock.upsert({ where: { consultantId_productId: { consultantId: consultant.id, productId } }, update: { qty: { increment: quantity } }, create: { consultantId: consultant.id, productId, qty: quantity, companyId } });
    await prisma.stockTransfer.create({ data: { consultantId: consultant.id, productId, qty: quantity, direction: 'to_consultant', notes: notes || null, companyId } });
    res.status(201).json({ message: `${quantity} x ${product.name} transferred to ${consultant.name}` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/consultants/:id/stock/return', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    if (req.user.role === 'inventory' && !consultant.isStockLocation) return res.status(403).json({ error: 'Inventory staff can only return stock from stock locations, not sales consultants' });
    const { productId, qty, notes } = req.body;
    if (!productId || !qty || parseInt(qty) <= 0) return res.status(400).json({ error: 'Product and quantity required' });
    const quantity = parseInt(qty);
    const cStock = await prisma.consultantStock.findUnique({ where: { consultantId_productId: { consultantId: consultant.id, productId } } });
    if (!cStock || cStock.qty < quantity) return res.status(400).json({ error: `Consultant only has ${cStock?.qty || 0} units` });
    await prisma.product.update({ where: { id: productId }, data: { stock: { increment: quantity } } });
    await prisma.stockLog.create({ data: { productId, change: quantity, reason: `Return from ${consultant.name}`, companyId } });
    await prisma.consultantStock.update({ where: { consultantId_productId: { consultantId: consultant.id, productId } }, data: { qty: { decrement: quantity } } });
    await prisma.stockTransfer.create({ data: { consultantId: consultant.id, productId, qty: quantity, direction: 'from_consultant', notes: notes || null, companyId } });
    res.status(201).json({ message: `${quantity} units returned from ${consultant.name}` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/consultants/:id/stock/transfers', authenticate, async (req, res) => {
  if (req.user.role === 'consultant' && req.params.id !== req.user.consultantId) return res.status(403).json({ error: 'Forbidden' });
  try {
    const companyId = req.user.companyId;
    const transfers = await prisma.stockTransfer.findMany({ where: { consultantId: req.params.id, companyId }, include: { product: { select: { name: true, sku: true } } }, orderBy: { createdAt: 'desc' } });
    res.json(transfers);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CONSULTANT DASHBOARD (self) ----
app.get('/api/v1/dashboard/consultant', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'consultant') return res.status(403).json({ error: 'Consultant access required' });
    const companyId = req.user.companyId;
    const consultantId = req.user.consultantId;
    const consultant = await prisma.consultant.findFirst({ where: { id: consultantId, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    const now = new Date();
    const payDay = await getCompanyPayDay(companyId);
    const currentCycle = getConsultantPayPeriod(now, payDay);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const allSales = await prisma.sale.findMany({ where: { consultantId, companyId, status: { not: 'Cancelled' } }, include: { items: true }, orderBy: { date: 'desc' } });
    const cycleSales = allSales.filter(s => { const d = new Date(s.date); return d >= currentCycle.periodFrom && d < currentCycle.periodTo; });
    const todaySales = allSales.filter(s => new Date(s.date) >= todayStart && new Date(s.date) <= todayEnd);

    const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
    const productsSoldInCycle = sum(cycleSales, s => s.items.reduce((q, i) => q + i.qty, 0));
    const revenueInCycle = sum(cycleSales, s => parseFloat(s.totalPrice));
    const commissionEarnedCycle = calcCommission(consultant.payType, consultant.commissionRate, consultant.tierThreshold, consultant.tierRate, cycleSales);

    const payments = await prisma.commissionPayment.findMany({ where: { consultantId, companyId }, orderBy: { createdAt: 'desc' } });
    const totalProductsSoldAllTime = sum(allSales, s => s.items.reduce((q, i) => q + i.qty, 0));
    const revenueAllTime = sum(allSales, s => parseFloat(s.totalPrice));
    const commissionEarnedAllTime = calcCommission(consultant.payType, consultant.commissionRate, consultant.tierThreshold, consultant.tierRate, allSales);
    const commissionPaid = sum(payments.filter(p => p.type === 'commission'), p => parseFloat(p.amount));
    const allowancePaid = sum(payments.filter(p => p.type === 'allowance'), p => parseFloat(p.amount));
    const advancePaid = sum(payments.filter(p => p.type === 'advance'), p => parseFloat(p.amount));
    // What is owed now is the payslip for the cycle to be paid next: its commission and
    // anything brought forward, less loans and recoveries.
    const pay = await payroll_consultantPay(prisma, companyId, null);
    const payslip = pay.slips.get(consultantId) || null;
    const balance = payslip ? payslip.balance : 0;
    // Every cycle that has been closed, so they can keep a copy of what they were paid.
    const payslipHistory = await payroll_payslipHistory(prisma, companyId, consultantId);

    res.json({
      consultant: { id: consultant.id, name: consultant.name, payType: consultant.payType, commissionRate: consultant.commissionRate, tierThreshold: consultant.tierThreshold, tierRate: consultant.tierRate, monthlyAllowance: consultant.monthlyAllowance },
      cycle: { from: currentCycle.periodFrom, to: currentCycle.periodTo, payDate: currentCycle.payDate, label: currentCycle.label },
      today: { ordersCount: todaySales.length, productsSold: sum(todaySales, s => s.items.reduce((q, i) => q + i.qty, 0)), revenue: sum(todaySales, s => parseFloat(s.totalPrice)) },
      thisCycle: { ordersCount: cycleSales.length, productsSold: productsSoldInCycle, revenue: revenueInCycle, commissionEarned: commissionEarnedCycle },
      allTime: { ordersCount: allSales.length, productsSold: totalProductsSoldAllTime, commissionEarned: commissionEarnedAllTime, commissionPaid, allowancePaid, advancePaid, balance },
      recentSales: allSales.slice(0, 10).map(s => ({ id: s.id, orderNumber: s.orderNumber, date: s.date, customerName: s.customerName, totalPrice: s.totalPrice, status: s.status, paymentStatus: s.paymentStatus, productsCount: s.items.reduce((q, i) => q + i.qty, 0) })),
      recentPayments: payments.slice(0, 10),
      payslip, payslipHistory,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PROVISION CONSULTANT LOGIN (admin only) ----
app.post('/api/v1/consultants/:id/login', authenticate, requireAdmin, async (req, res) => {
  try {
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

app.post('/api/v1/consultants/:id/reset-password', authenticate, requireAdmin, async (req, res) => {
  try {
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

app.delete('/api/v1/consultants/:id/login', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant || !consultant.userId) return res.status(404).json({ error: 'No login to revoke' });
    const userId = consultant.userId;
    await prisma.consultant.update({ where: { id: consultant.id }, data: { userId: null } });
    await prisma.user.delete({ where: { id: userId } });
    res.json({ message: 'Login revoked' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- STAFF (non-consultant logins, e.g. inventory/warehouse role) ----
const STAFF_ALLOWED_ROLES = ['inventory', 'purchasing'];

app.get('/api/v1/staff', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const staff = await prisma.user.findMany({
      where: { companyId, role: { in: STAFF_ALLOWED_ROLES } },
      select: { id: true, username: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(staff);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/staff', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { username, password, name, role } = req.body;
    if (!STAFF_ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!username || typeof username !== 'string' || username.length < 3 || username.length > 50) return res.status(400).json({ error: 'Username must be 3-50 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    if (!password || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(400).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { username, password: hashed, name, role, companyId } });
    res.status(201).json({ id: user.id, username: user.username, name: user.name, role: user.role });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/staff/:id/reset-password', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const staffUser = await prisma.user.findFirst({ where: { id: req.params.id, companyId, role: { in: STAFF_ALLOWED_ROLES } } });
    if (!staffUser) return res.status(404).json({ error: 'Staff account not found' });
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hashed = await bcrypt.hash(password, 10);
    await prisma.user.update({ where: { id: staffUser.id }, data: { password: hashed } });
    res.json({ message: 'Password reset' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/staff/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const staffUser = await prisma.user.findFirst({ where: { id: req.params.id, companyId, role: { in: STAFF_ALLOWED_ROLES } } });
    if (!staffUser) return res.status(404).json({ error: 'Staff account not found' });
    await prisma.user.delete({ where: { id: staffUser.id } });
    res.json({ message: 'Staff account removed' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- TARGETS ----
function parseTargetBody(body) {
  const data = {};
  if (body.label !== undefined) data.label = body.label || null;
  if (body.periodStart !== undefined) data.periodStart = new Date(body.periodStart);
  if (body.periodEnd !== undefined) data.periodEnd = new Date(body.periodEnd + (body.periodEnd.length === 10 ? 'T23:59:59.999Z' : ''));
  if (body.revenueTarget !== undefined) data.revenueTarget = body.revenueTarget;
  if (body.savingsRate !== undefined) data.savingsRate = body.savingsRate;
  return data;
}
function validateTarget(data, { partial } = { partial: false }) {
  if (!partial || data.periodStart !== undefined || data.periodEnd !== undefined) {
    if (!data.periodStart || !data.periodEnd || isNaN(data.periodStart) || isNaN(data.periodEnd)) return 'Valid periodStart and periodEnd are required';
    if (data.periodStart >= data.periodEnd) return 'periodStart must be before periodEnd';
  }
  if (!partial || data.revenueTarget !== undefined) {
    const n = parseFloat(data.revenueTarget);
    if (isNaN(n) || n < 0) return 'revenueTarget must be a non-negative number';
  }
  if (data.savingsRate !== undefined) {
    const r = parseFloat(data.savingsRate);
    if (isNaN(r) || r < 0 || r > 1) return 'savingsRate must be between 0 and 1';
  }
  return null;
}

app.get('/api/v1/targets', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const targets = await prisma.salesTarget.findMany({ where: { companyId }, orderBy: { periodStart: 'desc' } });
    res.json(targets);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/targets/active', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const now = new Date();
    const matches = await prisma.salesTarget.findMany({ where: { companyId, periodStart: { lte: now }, periodEnd: { gte: now } } });
    if (!matches.length) return res.json(null);
    matches.sort((a, b) => (a.periodEnd - a.periodStart) - (b.periodEnd - b.periodStart));
    res.json(matches[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/targets', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = parseTargetBody(req.body);
    const err = validateTarget(data);
    if (err) return res.status(400).json({ error: err });
    const target = await prisma.salesTarget.create({ data: { ...data, companyId } });
    res.status(201).json(target);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/targets/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.salesTarget.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = parseTargetBody(req.body);
    const err = validateTarget({ ...existing, ...data }, { partial: true });
    if (err) return res.status(400).json({ error: err });
    const target = await prisma.salesTarget.update({ where: { id: req.params.id }, data });
    res.json(target);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/targets/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.salesTarget.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.salesTarget.delete({ where: { id: req.params.id } });
    res.json({ message: 'Target deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- MONEY SPLITS (monthly revenue allocation report) ----
// Where a month's revenue went, bucket by bucket. (mirrored in server/src/routes/reports.js —
// see there for why staff pay and delivery are counted the way they are)
const MONEY_BUCKETS = {
  stock: ['Stock Purchase', 'Supplier Payments', 'Packaging'],
  ads: ['Facebook Ads', 'WhatsApp Business'],
  staff: ['Salaries & Wages'],
  delivery: ['Delivery Costs', 'Shipping'],
  otherOps: ['Data/Internet', 'Transport', 'Storage', 'Other'],
  ownerDraw: ['Owner Draw'],
  taxReserve: ['Tax Reserve'],
};
const CATEGORY_TO_BUCKET = {};
for (const [bucket, cats] of Object.entries(MONEY_BUCKETS)) {
  for (const c of cats) CATEGORY_TO_BUCKET[c] = bucket;
}
// Staff pay and delivery came later; a company that set its targets before then has none for
// them, which is shown as "no target yet" rather than as being over a target of nothing.
const DEFAULT_MONEY_TARGETS = { stock: 47, ads: 12, staff: 0, delivery: 0, otherOps: 3, ownerDraw: 12, taxReserve: 5, profit: 21 };
const MONEY_SPLIT_COSTS = ['ads', 'staff', 'delivery', 'otherOps', 'ownerDraw', 'taxReserve', 'uncategorized'];
const money_r2 = (n) => Math.round(n * 100) / 100;

// Money splits for a given month: how revenue was allocated vs targets
app.get('/api/v1/reports/money-splits', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { month } = req.query; // YYYY-MM, defaults to the current month in Zambia
    const lusakaNow = new Date(Date.now() + 2 * 3600 * 1000);
    const fallback = `${lusakaNow.getUTCFullYear()}-${String(lusakaNow.getUTCMonth() + 1).padStart(2, '0')}`;
    const [y, m] = (/^\d{4}-\d{2}$/.test(month || '') ? month : fallback).split('-').map(Number);
    // Zambia is UTC+2 all year: the month starts at midnight there, 22:00 the evening before in UTC.
    const start = new Date(Date.UTC(y, m - 1, 1) - 2 * 3600 * 1000);
    const end = new Date(Date.UTC(y, m, 1) - 2 * 3600 * 1000);

    const [sales, expenses, settings] = await Promise.all([
      prisma.sale.findMany({
        where: { companyId, status: { in: ['Confirmed', 'Shipped', 'Delivered'] }, date: { gte: start, lt: end } },
        include: { items: true },
      }),
      prisma.expense.findMany({ where: { companyId, date: { gte: start, lt: end } } }),
      prisma.setting.findMany({ where: { companyId, key: { startsWith: 'alloc_' } } }),
    ]);

    const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const cogs = sales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + parseFloat(i.costPrice) * i.qty, 0), 0);
    const collected = sales.reduce((s, r) => s + Math.min(parseFloat(r.amountPaid), parseFloat(r.totalPrice)), 0);
    const fares = sales.reduce((s, r) => s + parseFloat(r.shippingCost || 0), 0);

    const actual = { stock: 0, ads: 0, staff: 0, delivery: fares, otherOps: 0, ownerDraw: 0, taxReserve: 0, uncategorized: 0 };
    const byCategory = {};
    for (const e of expenses) {
      const amt = parseFloat(e.amount);
      byCategory[e.category] = (byCategory[e.category] || 0) + amt;
      const bucket = CATEGORY_TO_BUCKET[e.category];
      if (bucket) actual[bucket] += amt;
      else actual.uncategorized += amt;
    }
    for (const k of Object.keys(actual)) actual[k] = money_r2(actual[k]);

    const targets = { ...DEFAULT_MONEY_TARGETS };
    const targetsSet = new Set();
    for (const s of settings) {
      const key = s.key.replace(/^alloc_/, '');
      const val = parseFloat(s.value);
      if (!isNaN(val) && targets[key] !== undefined) { targets[key] = val; targetsSet.add(key); }
    }
    const targetAmounts = {};
    for (const k of Object.keys(DEFAULT_MONEY_TARGETS)) targetAmounts[k] = revenue * targets[k] / 100;
    const noTarget = ['staff', 'delivery'].filter(k => !targetsSet.has(k) || !targets[k]);

    // Profit actual (left over after everything else accounted for)
    const spentTotal = actual.stock + MONEY_SPLIT_COSTS.reduce((s, k) => s + actual[k], 0);
    // Use COGS as stock "consumed" proxy (what was actually sold out of stock) for a more accurate profit view
    const profitActual = revenue - cogs - MONEY_SPLIT_COSTS.reduce((s, k) => s + actual[k], 0);

    // Owner owed-back: if draws exceed target, the excess is treated as a loan from the business
    const ownerOwedBack = Math.max(0, actual.ownerDraw - targetAmounts.ownerDraw);

    res.json({
      month: `${y}-${String(m).padStart(2, '0')}`,
      revenue,
      collected: money_r2(collected),
      uncollected: money_r2(revenue - collected),
      cogs,
      targets,
      targetAmounts,
      noTarget,
      actual,
      deliveryBreakdown: { fares: money_r2(fares), carried: money_r2(actual.delivery - fares) },
      byCategory,
      profitActual,
      ownerOwedBack,
      spentTotal,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});


// ---- DELIVERIES & RIDERS ----
// ---- PAYROLL ----
// Mirrored from server/src/routes/payroll.js — see that file for the reasoning.
// Generated by the same transform each time, so the two copies cannot drift apart.
// Payroll — everyone the company pays, in one place.
//
// Two kinds of people sit side by side here. Consultants earn commission on what they sell;
// salaried staff (the inventory clerk, the rider) earn a fixed monthly wage. Both also draw a
// monthly communication allowance, and both can take an advance against pay not yet earned.
// The arithmetic is deliberately the same shape for both so the screen reads as one payroll
// rather than two systems: earned − paid − advanced = what is still owed.
//
// (mirrored in api/index.js)

const PAYROLL_STAFF_PAYMENT_TYPES = ['salary', 'allowance', 'advance', 'bonus'];
const PAYROLL_EXPENSE_CATEGORY = 'Salaries & Wages';

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

// An advance is money lent against pay not yet earned, so it is not yet a cost to the
// business — it becomes one when the salary it anticipates is earned and paid. Everything
// else handed to a person is an expense the moment it leaves.
const payroll_isCost = (type) => type !== 'advance';

const PAYROLL_EXPENSE_LABEL = { salary: 'Salary', allowance: 'Communication allowance', bonus: 'Bonus', commission: 'Commission' };

function payroll_periodLabel(periodFrom, periodTo) {
  if (!periodFrom || !periodTo) return null;
  const f = new Date(periodFrom), t = new Date(periodTo);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${fmt(f)} to ${fmt(t)}`;
}

// Raise the Salaries & Wages expense that a payment represents, and hand back its id so the
// payment owns it. Undoing the payment deletes the expense with it, which is why the link
// exists rather than matching on description later.
async function payroll_raiseExpense(tx, { name, type, amount, periodFrom, periodTo, paymentMethod, notes, companyId }) {
  if (!payroll_isCost(type)) return null;
  const label = PAYROLL_EXPENSE_LABEL[type] || 'Staff payment';
  const period = payroll_periodLabel(periodFrom, periodTo);
  const expense = await tx.expense.create({
    data: {
      description: `${label}: ${name}${period ? ` (${period})` : ''}`,
      amount,
      category: PAYROLL_EXPENSE_CATEGORY,
      paymentMethod: paymentMethod || null,
      notes: notes || null,
      companyId,
    },
  });
  return expense.id;
}

// Remove the expense a payment raised. Safe to call for an advance, which never had one.
async function payroll_dropExpense(tx, expenseId, companyId) {
  if (!expenseId) return;
  await tx.expense.deleteMany({ where: { id: expenseId, companyId } });
}

// What a salaried person has earned across a window: the monthly figure prorated to the slice
// of the cycle they were actually employed for, exactly as a consultant's allowance is.
function payroll_accrue(staff, periodFrom, periodTo, isCycle) {
  if (!isCycle) {
    return { active: true, prorated: false, factor: 1, salaryAccrued: null, allowanceCap: null };
  }
  const eff = getEffectivePeriod(periodFrom, periodTo, staff.startDate);
  if (!eff) return { active: false, prorated: false, factor: 0, salaryAccrued: 0, allowanceCap: 0 };
  return {
    active: true,
    prorated: eff.prorated,
    factor: eff.factor,
    effectiveFrom: eff.effectiveFrom,
    effectiveTo: eff.effectiveTo,
    salaryAccrued: round2(parseFloat(staff.monthlySalary) * eff.factor),
    allowanceCap: round2(parseFloat(staff.monthlyAllowance) * eff.factor),
  };
}

function payroll_sumType(payments, type) {
  return round2(payments.filter(p => p.type === type).reduce((s, p) => s + parseFloat(p.amount), 0));
}

// The pay picture for one salaried person over one window.
function payroll_staffSummary(staff, payments, periodFrom, periodTo, isCycle) {
  const mine = payments.filter(p => p.staffId === staff.id);
  const accrual = payroll_accrue(staff, periodFrom, periodTo, isCycle);

  const salaryPaid = payroll_sumType(mine, 'salary');
  const allowancePaid = payroll_sumType(mine, 'allowance');
  const bonusPaid = payroll_sumType(mine, 'bonus');
  const advancePaid = payroll_sumType(mine, 'advance');

  // Mirrors the consultant balance: earnings minus what has been handed over, with advances
  // netting off because that money is already in their pocket. Negative means they owe it back.
  const balance = accrual.salaryAccrued === null ? null : round2(accrual.salaryAccrued - salaryPaid - advancePaid);
  const allowanceRemaining = accrual.allowanceCap === null ? null : round2(Math.max(0, accrual.allowanceCap - allowancePaid));

  return {
    kind: 'salaried',
    id: staff.id,
    name: staff.name,
    jobTitle: staff.jobTitle,
    phone: staff.phone,
    isActive: staff.isActive,
    startDate: staff.startDate,
    monthlySalary: staff.monthlySalary,
    monthlyAllowance: staff.monthlyAllowance,
    activeInPeriod: accrual.active,
    prorated: accrual.prorated,
    earned: accrual.salaryAccrued,
    paid: salaryPaid,
    bonusPaid,
    advancePaid,
    balance,
    allowanceCap: accrual.allowanceCap,
    allowancePaid,
    allowanceRemaining,
  };
}


// ---- STAFF RECORDS ----

app.get('/api/v1/payroll/staff', authenticate, requireAdmin, async (req, res) => {
  try {
    const where = { companyId: req.user.companyId };
    if (req.query.activeOnly === 'true') where.isActive = true;
    const staff = await prisma.staff.findMany({ where, orderBy: { name: 'asc' } });
    res.json(staff);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// A staff record may only point at a login or rider profile of the same company: the link is
// what decides whose pay an advance request comes out of. Admin and consultant logins have
// their own pay paths, so they are never linked here.
const PAYROLL_LINKABLE_ROLES = ['inventory', 'purchasing', 'rider'];
async function payroll_linkProblem(prisma, companyId, userId, riderId) {
  if (userId) {
    const u = await prisma.user.findFirst({ where: { id: userId, companyId }, select: { role: true } });
    if (!u) return 'That login was not found';
    if (!PAYROLL_LINKABLE_ROLES.includes(u.role)) return 'Only an inventory, purchasing or rider login can be linked to a staff record';
  }
  if (riderId) {
    const r = await prisma.rider.findFirst({ where: { id: riderId, companyId }, select: { id: true } });
    if (!r) return 'That rider was not found';
  }
  return null;
}

app.post('/api/v1/payroll/staff', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, phone, jobTitle, monthlySalary, monthlyAllowance, startDate, notes, userId, riderId } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const salary = monthlySalary === undefined || monthlySalary === '' ? 0 : parseFloat(monthlySalary);
    const allowance = monthlyAllowance === undefined || monthlyAllowance === '' ? 100 : parseFloat(monthlyAllowance);
    if (!Number.isFinite(salary) || salary < 0) return res.status(400).json({ error: 'Monthly salary must be zero or more' });
    if (!Number.isFinite(allowance) || allowance < 0) return res.status(400).json({ error: 'Monthly allowance must be zero or more' });
    const linkProblem = await payroll_linkProblem(prisma, req.user.companyId, userId, riderId);
    if (linkProblem) return res.status(400).json({ error: linkProblem });

    const staff = await prisma.staff.create({
      data: {
        name: String(name).trim(), phone: phone || null, jobTitle: jobTitle || null,
        monthlySalary: salary, monthlyAllowance: allowance,
        startDate: startDate ? new Date(startDate) : null, notes: notes || null,
        userId: userId || null, riderId: riderId || null,
        companyId: req.user.companyId,
      },
    });
    res.status(201).json(staff);
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'That login or rider is already linked to another staff record' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/v1/payroll/staff/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const existing = await prisma.staff.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!existing) return res.status(404).json({ error: 'Staff member not found' });
    const raw = req.body;
    const data = {
      ...(raw.name !== undefined && { name: String(raw.name).trim() }),
      ...(raw.phone !== undefined && { phone: raw.phone || null }),
      ...(raw.jobTitle !== undefined && { jobTitle: raw.jobTitle || null }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
      ...(raw.isActive !== undefined && { isActive: !!raw.isActive }),
      ...(raw.startDate !== undefined && { startDate: raw.startDate ? new Date(raw.startDate) : null }),
      ...(raw.userId !== undefined && { userId: raw.userId || null }),
      ...(raw.riderId !== undefined && { riderId: raw.riderId || null }),
    };
    if (raw.monthlySalary !== undefined) {
      const v = parseFloat(raw.monthlySalary);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Monthly salary must be zero or more' });
      data.monthlySalary = v;
    }
    if (raw.monthlyAllowance !== undefined) {
      const v = parseFloat(raw.monthlyAllowance);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Monthly allowance must be zero or more' });
      data.monthlyAllowance = v;
    }
    const linkProblem = await payroll_linkProblem(prisma, req.user.companyId, data.userId, data.riderId);
    if (linkProblem) return res.status(400).json({ error: linkProblem });
    res.json(await prisma.staff.update({ where: { id: existing.id }, data }));
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'That login or rider is already linked to another staff record' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

// Someone who has been paid is never deleted — their pay history is the record of that money.
app.delete('/api/v1/payroll/staff/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const staff = await prisma.staff.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    const paid = await prisma.staffPayment.count({ where: { staffId: staff.id } })
      + await prisma.payslip.count({ where: { staffId: staff.id } })
      + await prisma.loan.count({ where: { staffId: staff.id } })
      + await prisma.payAdjustment.count({ where: { staffId: staff.id } });
    if (paid > 0) {
      await prisma.staff.update({ where: { id: staff.id }, data: { isActive: false } });
      return res.json({ message: 'Marked inactive (has pay history)' });
    }
    await prisma.staff.delete({ where: { id: staff.id } });
    res.json({ message: 'Staff member removed' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PAYMENTS ----

app.get('/api/v1/payroll/staff/:id/payments', authenticate, requireAdmin, async (req, res) => {
  try {
    const staff = await prisma.staff.findFirst({ where: { id: req.params.id, companyId: req.user.companyId } });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    const payments = await prisma.staffPayment.findMany({ where: { staffId: staff.id }, orderBy: { createdAt: 'desc' } });
    res.json(payments);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/payroll/staff/:id/payments', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const staff = await prisma.staff.findFirst({ where: { id: req.params.id, companyId } });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });

    const { type = 'salary', paymentMethod, reference, notes, period } = req.body;
    if (!PAYROLL_STAFF_PAYMENT_TYPES.includes(type)) {
      return res.status(400).json({ error: `Type must be one of ${PAYROLL_STAFF_PAYMENT_TYPES.join(', ')}` });
    }
    const amount = parseFloat(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
    const cycle = period ? payPeriodFromLabel(period, company?.consultantPayDay || 11) : getConsultantPayPeriod(new Date(), company?.consultantPayDay || 11);
    const periodFrom = req.body.periodFrom ? new Date(req.body.periodFrom) : cycle.periodFrom;
    const periodTo = req.body.periodTo ? new Date(req.body.periodTo) : cycle.periodTo;

    // The communication allowance is capped per cycle exactly as a consultant's is, prorated
    // for anyone who joined mid-cycle.
    if (type === 'salary' || type === 'advance') {
      const closed = await payroll_finalisedCycleOf(prisma, companyId, periodFrom, periodTo);
      if (closed) return res.status(400).json({ error: `The ${closed} cycle is finalised. Pay it from its payslip.` });
    }

    if (type === 'allowance') {
      const eff = getEffectivePeriod(periodFrom, periodTo, staff.startDate);
      if (!eff) return res.status(400).json({ error: 'That person was not employed during this pay cycle' });
      const cap = round2((parseFloat(staff.monthlyAllowance) || 0) * eff.factor);
      const existing = await prisma.staffPayment.aggregate({
        where: { staffId: staff.id, companyId, type: 'allowance', periodFrom: { gte: periodFrom }, periodTo: { lte: periodTo } },
        _sum: { amount: true },
      });
      const paidSoFar = parseFloat(existing._sum.amount || 0);
      if (paidSoFar + amount > cap + 0.01) {
        return res.status(400).json({
          error: `Allowance cap reached. Cap: K${cap.toFixed(2)}${eff.prorated ? ' (prorated)' : ''}. Already paid: K${paidSoFar.toFixed(2)}. Remaining: K${Math.max(0, cap - paidSoFar).toFixed(2)}.`,
        });
      }
    }

    const payment = await prisma.$transaction(async (tx) => {
      const expenseId = await payroll_raiseExpense(tx, {
        name: staff.name, type, amount, periodFrom, periodTo, paymentMethod, notes, companyId,
      });
      return tx.staffPayment.create({
        data: {
          staffId: staff.id, amount, type, periodFrom, periodTo,
          paymentMethod: paymentMethod || null, reference: reference || null, notes: notes || null,
          expenseId, companyId,
        },
      });
    }, { timeout: 20000 });

    res.status(201).json(payment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Undo a payment and the expense it raised together, so a mistyped figure leaves nothing behind.
app.delete('/api/v1/payroll/payments/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const payment = await prisma.staffPayment.findFirst({ where: { id: req.params.id, companyId } });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    await prisma.$transaction(async (tx) => {
      await tx.staffPayment.delete({ where: { id: payment.id } });
      await payroll_dropExpense(tx, payment.expenseId, companyId);
    }, { timeout: 20000 });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- THE PAYROLL VIEW ----

// Everyone the company pays for one cycle: salaried staff and consultants, same shape.
app.get('/api/v1/payroll/summary', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
    const payDay = company?.consultantPayDay || 11;
    const cycle = req.query.period ? payPeriodFromLabel(req.query.period, payDay) : getConsultantPayPeriod(new Date(), payDay);
    const { periodFrom, periodTo, label } = cycle;

    const [staff, staffPayments, consultants, sales, commissionPayments] = await Promise.all([
      prisma.staff.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
      prisma.staffPayment.findMany({ where: { companyId, periodFrom: { gte: periodFrom }, periodTo: { lte: periodTo } } }),
      prisma.consultant.findMany({ where: { companyId, isStockLocation: false }, orderBy: { name: 'asc' } }),
      prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, date: { gte: periodFrom, lt: periodTo } }, include: { items: true } }),
      prisma.commissionPayment.findMany({ where: { companyId, periodFrom: { gte: periodFrom }, periodTo: { lte: periodTo } } }),
    ]);

    const salaried = staff.map(s => payroll_staffSummary(s, staffPayments, periodFrom, periodTo, true));

    const commissioned = consultants.map(c => {
      const eff = getEffectivePeriod(periodFrom, periodTo, c.startDate);
      const activeInPeriod = !!eff;
      const factor = eff ? eff.factor : 0;
      const cSales = sales.filter(s => s.consultantId === c.id && (!eff || !eff.prorated || new Date(s.date) >= eff.effectiveFrom));
      const earned = activeInPeriod ? calcCommission(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, cSales) : 0;

      const mine = commissionPayments.filter(p => p.consultantId === c.id);
      const paid = payroll_sumType(mine, 'commission');
      const allowancePaid = payroll_sumType(mine, 'allowance');
      const advancePaid = payroll_sumType(mine, 'advance');
      const allowanceCap = round2(parseFloat(c.monthlyAllowance) * factor);

      return {
        kind: 'commission',
        id: c.id,
        name: c.name,
        jobTitle: c.payType === 'revenue_pct' ? 'Sales consultant (% of revenue)' : 'Sales consultant (per unit)',
        phone: c.phone,
        isActive: c.isActive,
        startDate: c.startDate,
        monthlySalary: null,
        monthlyAllowance: c.monthlyAllowance,
        activeInPeriod,
        prorated: eff ? eff.prorated : false,
        earned,
        paid,
        bonusPaid: 0,
        advancePaid,
        balance: round2(earned - paid - advancePaid),
        allowanceCap,
        allowancePaid,
        allowanceRemaining: round2(Math.max(0, allowanceCap - allowancePaid)),
      };
    });

    const everyone = [...salaried, ...commissioned];
    const active = everyone.filter(p => p.activeInPeriod);
    const sum = (rows, key) => round2(rows.reduce((s, r) => s + (r[key] || 0), 0));

    res.json({
      period: { label, from: periodFrom, to: periodTo, payDate: cycle.payDate, payDay },
      salaried,
      commissioned,
      totals: {
        headcount: active.length,
        earned: sum(active, 'earned'),
        paid: sum(active, 'paid'),
        allowancePaid: sum(active, 'allowancePaid'),
        bonusPaid: sum(active, 'bonusPaid'),
        advancePaid: sum(active, 'advancePaid'),
        balance: sum(active, 'balance'),
        // What leaving the office this cycle actually cost, advances included — they are real
        // money out of the drawer even though they are not yet an expense.
        cashOut: round2(sum(active, 'paid') + sum(active, 'allowancePaid') + sum(active, 'bonusPaid') + sum(active, 'advancePaid')),
      },
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});


// ---- PAY RUNS ----
//
// A pay run is one cycle's payroll for everyone, worked out as a payslip per person:
//
//   brought forward + earnings − already paid − deductions = net pay
//
// Until a cycle is finalised its run is computed live from the sales, loans and adjustments,
// so nothing can go stale. Finalising writes the payslips down, and from then on that cycle
// never changes. Three things used to move a closed cycle and now land on the next payslip
// instead:
//   - money a customer pays late: each commission line records what the cycle's orders had
//     earned at that moment, and a later run pays only what has been earned beyond it
//   - whatever was left unpaid, or overpaid: carried forward as the opening line
//   - a loan: the instalment is deducted every run until the principal is covered
//
// (mirrored in server/src/routes/payroll.js)

const PAYROLL_ARREARS_LOOKBACK = 12;
const PAYROLL_ADJUSTMENT_KINDS = ['bonus', 'deduction', 'recovery'];
// How many cycles back an unpaid order is still offered for recovery.
const PAYROLL_UNPAID_ORDER_CYCLES = 3;

const payroll_isLabel = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const payroll_num = (v) => parseFloat(v || 0) || 0;
const payroll_personKey = (o) => (o.consultantId ? `c:${o.consultantId}` : `s:${o.staffId}`);

function payroll_shiftLabel(label, by) {
  const [y, m] = label.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function payroll_cycleName(cycle) {
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${fmt(cycle.periodFrom)} – ${fmt(new Date(cycle.periodTo.getTime() - 86400000))}`;
}

// Which cycle a payment made outside a pay run belongs to. Judged on the middle of the period
// it was recorded against, because those periods were typed by hand and are often a day out
// at either end.
function payroll_inCycle(payment, from, to) {
  const at = payment.periodFrom && payment.periodTo
    ? new Date((new Date(payment.periodFrom).getTime() + new Date(payment.periodTo).getTime()) / 2)
    : new Date(payment.createdAt);
  return at >= from && at < to;
}

// What one cycle's orders have earned a consultant as things stand today.
function payroll_entitlement(consultant, sales, cycle) {
  const eff = getEffectivePeriod(cycle.periodFrom, cycle.periodTo, consultant.startDate);
  if (!eff) return { amount: 0, orders: 0 };
  const mine = sales.filter(s => s.consultantId === consultant.id
    && new Date(s.date) >= eff.effectiveFrom && new Date(s.date) < cycle.periodTo);
  return {
    amount: calcCommission(consultant.payType, consultant.commissionRate, consultant.tierThreshold, consultant.tierRate, mine),
    orders: mine.length,
  };
}

// Goods value actually collected on one cycle's orders: the figure commission is paid on, and
// so the figure a consultant's target is measured in. Delivery fees and unpaid money are out.
function payroll_collectedGoods(consultant, sales, cycle) {
  const eff = getEffectivePeriod(cycle.periodFrom, cycle.periodTo, consultant.startDate);
  if (!eff) return 0;
  let collected = 0;
  for (const s of sales) {
    if (s.consultantId !== consultant.id || new Date(s.date) < eff.effectiveFrom || new Date(s.date) >= cycle.periodTo) continue;
    const total = payroll_num(s.totalPrice);
    if (!(total > 0)) continue;
    const goods = Math.max(0, total - payroll_num(s.shippingCharge));
    collected += goods * Math.min(1, Math.max(0, payroll_num(s.amountPaid) / total));
  }
  return round2(collected);
}

// The person a loan or adjustment is for, checked against the company.
async function payroll_resolvePerson(prisma, companyId, { personKind, personId }) {
  if (!personId) return null;
  if (personKind === 'commission') {
    const c = await prisma.consultant.findFirst({ where: { id: personId, companyId } });
    return c ? { consultantId: c.id, staffId: null, name: c.name } : null;
  }
  const s = await prisma.staff.findFirst({ where: { id: personId, companyId } });
  return s ? { consultantId: null, staffId: s.id, name: s.name } : null;
}

// The whole pay run for one cycle: the stored payslips if it is finalised, the live draft if not.
async function payroll_run(prisma, companyId, requestedPeriod) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
  const payDay = company?.consultantPayDay || 11;
  const now = new Date();
  const currentLabel = getConsultantPayPeriod(now, payDay).label;

  const runs = await prisma.payRun.findMany({ where: { companyId }, orderBy: { period: 'asc' } });
  const lastRun = runs.length ? runs[runs.length - 1] : null;
  const nextToFinalise = lastRun ? payroll_shiftLabel(lastRun.period, 1) : null;
  // With nothing asked for, show the cycle that is waiting to be finalised.
  const period = requestedPeriod || (nextToFinalise && nextToFinalise < currentLabel ? nextToFinalise : currentLabel);
  const cycle = payPeriodFromLabel(period, payDay);
  const existing = runs.find(r => r.period === period) || null;
  const lookbackFrom = payPeriodFromLabel(payroll_shiftLabel(period, -PAYROLL_ARREARS_LOOKBACK), payDay).periodFrom;

  const [staff, consultants, loans, adjustments, payslips, lines, cPayments, sPayments, sales] = await Promise.all([
    prisma.staff.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
    prisma.consultant.findMany({ where: { companyId, isStockLocation: false }, orderBy: { name: 'asc' } }),
    prisma.loan.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
    prisma.payAdjustment.findMany({
      where: { companyId },
      include: { sale: { select: { orderNumber: true, paymentStatus: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.payslip.findMany({ where: { companyId }, include: { payRun: { select: { period: true } } } }),
    prisma.payslipLine.findMany({
      where: { companyId },
      include: { payslip: { select: { consultantId: true, staffId: true, payRun: { select: { period: true } } } } },
      orderBy: { sort: 'asc' },
    }),
    prisma.commissionPayment.findMany({ where: { companyId } }),
    prisma.staffPayment.findMany({ where: { companyId } }),
    existing ? [] : prisma.sale.findMany({
      where: { companyId, consultantId: { not: null }, status: { not: 'Cancelled' }, date: { gte: lookbackFrom, lt: cycle.periodTo } },
      select: {
        id: true, orderNumber: true, date: true, totalPrice: true, shippingCharge: true, shippingCost: true,
        amountPaid: true, paymentStatus: true, status: true, customerName: true, consultantId: true,
        items: { select: { qty: true } },
      },
    }),
  ]);

  const targets = existing ? [] : await prisma.consultantTarget.findMany({ where: { companyId, period } });
  const kwacha = (n) => `K${Math.round(n).toLocaleString('en-US')}`;

  const paymentsOf = (slip) => (slip.consultantId ? cPayments : sPayments).filter(p => p.payslipId === slip.id);
  const paidOn = (slip) => round2(paymentsOf(slip).reduce((s, p) => s + payroll_num(p.amount), 0));

  // An adjustment is applied once a finalised line points at it; a recovery is refunded once a
  // refund line does.
  const applied = new Set(lines.filter(l => l.adjustmentId && l.kind !== 'refund').map(l => l.adjustmentId));
  const refunded = new Set(lines.filter(l => l.adjustmentId && l.kind === 'refund').map(l => l.adjustmentId));
  const adjustmentLabel = (a) => `${a.reason || (a.kind === 'bonus' ? 'Bonus' : a.kind === 'recovery' ? 'Recovery' : 'Deduction')}${a.sale ? ` (${a.sale.orderNumber})` : ''}`;
  const refundDue = (a) => a.kind === 'recovery' && a.refundable && applied.has(a.id) && !refunded.has(a.id)
    && ((a.refundPeriod && a.refundPeriod <= period) || a.sale?.paymentStatus === 'Paid');
  // Money taken from someone that goes back to them once the order is paid or the hold is lifted.
  const heldFor = (key) => adjustments
    .filter(a => payroll_personKey(a) === key && a.kind === 'recovery' && a.refundable && applied.has(a.id) && !refunded.has(a.id) && !a.refundPeriod)
    .map(a => ({ id: a.id, label: adjustmentLabel(a), amount: payroll_num(a.amount), period: a.period }));

  const loanDeducted = (loan, beforePeriod) => round2(lines
    .filter(l => l.loanId === loan.id && (!beforePeriod || l.payslip.payRun.period < beforePeriod))
    .reduce((s, l) => s + Math.abs(payroll_num(l.amount)), 0));

  const shape = (base, slipLines) => {
    const sumKinds = (kinds) => round2(slipLines.filter(l => kinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0));
    const earnings = sumKinds(['salary', 'commission', 'arrears', 'bonus', 'refund']);
    const alreadyPaid = round2(-sumKinds(['prepaid', 'advance']));
    const deductions = round2(-sumKinds(['recovery', 'deduction', 'loan']));
    const netPay = round2(base.broughtForward + earnings - alreadyPaid - deductions);
    // The cycle's wage cost not already booked by a payment made during it. Loans and balances
    // carried between cycles are not costs; a recovery gives some of the wage back.
    const wageCost = Math.max(0, round2(earnings + sumKinds(['recovery', 'deduction', 'prepaid'])));
    return { ...base, lines: slipLines, earnings, alreadyPaid, deductions, netPay, wageCost };
  };

  let slips;

  if (existing) {
    slips = payslips.filter(p => p.payRunId === existing.id).map(p => {
      const key = payroll_personKey(p);
      const payments = paymentsOf(p).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const paid = paidOn(p);
      const netPay = payroll_num(p.netPay);
      // Once a later payslip exists, whatever was outstanding here has been carried into it.
      const carried = payslips.some(o => payroll_personKey(o) === key && o.payRun.period > period);
      return {
        id: p.id, kind: p.consultantId ? 'commission' : 'salaried', personId: p.consultantId || p.staffId,
        name: p.name, jobTitle: p.jobTitle,
        lines: lines.filter(l => l.payslipId === p.id).map(l => ({
          kind: l.kind, label: l.label, amount: payroll_num(l.amount), sourcePeriod: l.sourcePeriod, loanId: l.loanId, adjustmentId: l.adjustmentId,
        })),
        broughtForward: payroll_num(p.broughtForward), earnings: payroll_num(p.earnings),
        alreadyPaid: payroll_num(p.alreadyPaid), deductions: payroll_num(p.deductions), netPay,
        paid, outstanding: round2(netPay - paid), carried,
        payments: payments.map(x => ({ id: x.id, amount: payroll_num(x.amount), createdAt: x.createdAt, paymentMethod: x.paymentMethod, reference: x.reference, notes: x.notes })),
        loans: [], unpaidOrders: [], held: heldFor(key),
      };
    });
  } else {
    const priorSlip = (key) => payslips
      .filter(p => payroll_personKey(p) === key && p.payRun.period < period)
      .sort((a, b) => (a.payRun.period < b.payRun.period ? 1 : -1))[0] || null;

    const build = (key, base, earningLines) => {
      const out = [...earningLines];
      const mine = adjustments.filter(a => payroll_personKey(a) === key);

      const prior = priorSlip(key);
      const broughtForward = prior ? round2(payroll_num(prior.netPay) - paidOn(prior)) : 0;

      for (const a of mine.filter(a => a.kind === 'bonus' && a.period <= period && !applied.has(a.id))) {
        out.push({ kind: 'bonus', label: adjustmentLabel(a), amount: payroll_num(a.amount), adjustmentId: a.id });
      }
      for (const a of mine.filter(refundDue)) {
        out.push({ kind: 'refund', label: `Refund: ${adjustmentLabel(a)}`, amount: payroll_num(a.amount), adjustmentId: a.id });
      }

      const direct = (base.kind === 'commission' ? cPayments.filter(p => p.consultantId === base.personId) : sPayments.filter(p => p.staffId === base.personId))
        .filter(p => !p.payslipId && payroll_inCycle(p, cycle.periodFrom, cycle.periodTo));
      const prepaid = round2(direct.filter(p => p.type === 'commission' || p.type === 'salary').reduce((s, p) => s + payroll_num(p.amount), 0));
      const advanced = round2(direct.filter(p => p.type === 'advance').reduce((s, p) => s + payroll_num(p.amount), 0));
      if (prepaid > 0) out.push({ kind: 'prepaid', label: 'Paid during the cycle', amount: -prepaid });
      if (advanced > 0) out.push({ kind: 'advance', label: 'Advance taken during the cycle', amount: -advanced });

      for (const a of mine.filter(a => (a.kind === 'recovery' || a.kind === 'deduction') && a.period <= period && !applied.has(a.id))) {
        out.push({ kind: a.kind, label: adjustmentLabel(a), amount: -payroll_num(a.amount), adjustmentId: a.id, refundable: a.refundable });
      }

      // Loans come last and take only what the pay can cover, so a thin month leaves the rest
      // of the instalment on the loan instead of putting the person in debt for cash.
      let available = Math.max(0, round2(broughtForward + out.reduce((s, l) => s + l.amount, 0)));
      const loanRows = [];
      for (const loan of loans.filter(l => payroll_personKey(l) === key && l.status === 'active' && l.firstPeriod <= period)) {
        const outstanding = round2(payroll_num(loan.principal) - loanDeducted(loan, period));
        if (outstanding <= 0) continue;
        const scheduled = Math.min(payroll_num(loan.instalmentAmount), outstanding);
        const override = mine.find(a => a.kind === 'loan_instalment' && a.loanId === loan.id && a.period === period);
        const taking = round2(override ? Math.min(payroll_num(override.amount), outstanding) : Math.min(scheduled, available));
        available = Math.max(0, round2(available - taking));
        if (taking > 0) out.push({ kind: 'loan', label: `Loan repayment: ${loan.description}`, amount: -taking, loanId: loan.id });
        loanRows.push({
          id: loan.id, description: loan.description, principal: payroll_num(loan.principal), outstanding,
          scheduled: round2(scheduled), taking, edited: !!override, shortBy: override ? 0 : round2(scheduled - taking),
          outstandingAfter: round2(outstanding - taking),
        });
      }

      const slip = shape({ ...base, id: null, broughtForward }, out);
      return { ...slip, paid: 0, outstanding: slip.netPay, carried: false, payments: [], loans: loanRows, held: heldFor(key) };
    };

    const unpaidFrom = payPeriodFromLabel(payroll_shiftLabel(period, -(PAYROLL_UNPAID_ORDER_CYCLES - 1)), payDay).periodFrom;
    const recoveredSales = new Set(adjustments.filter(a => a.kind === 'recovery' && a.saleId).map(a => a.saleId));

    const salaried = staff.map(s => {
      const accrual = payroll_accrue(s, cycle.periodFrom, cycle.periodTo, true);
      const earning = s.isActive && accrual.active
        ? [{ kind: 'salary', label: accrual.prorated ? 'Salary (part cycle)' : 'Salary', amount: accrual.salaryAccrued }]
        : [];
      const slip = build(`s:${s.id}`, { kind: 'salaried', personId: s.id, name: s.name, jobTitle: s.jobTitle || 'Staff' }, earning);
      return { ...slip, unpaidOrders: [], onRun: earning.length > 0 };
    });

    const commissioned = consultants.map(c => {
      const key = `c:${c.id}`;
      const earning = [];
      const now_ = payroll_entitlement(c, sales, cycle);
      const activeNow = c.isActive && !!getEffectivePeriod(cycle.periodFrom, cycle.periodTo, c.startDate);
      if (activeNow || now_.amount > 0) {
        earning.push({
          kind: 'commission', label: `Commission on ${now_.orders} order${now_.orders === 1 ? '' : 's'}`,
          amount: now_.amount, sourcePeriod: period, entitlement: now_.amount,
        });
      }

      // Earlier cycles: pay whatever their orders have earned beyond what was last written down.
      const snapshots = new Map();
      for (const l of lines) {
        if (l.payslip.consultantId !== c.id || !l.sourcePeriod || l.payslip.payRun.period >= period) continue;
        const seen = snapshots.get(l.sourcePeriod);
        if (!seen || seen.runPeriod < l.payslip.payRun.period) snapshots.set(l.sourcePeriod, { runPeriod: l.payslip.payRun.period, entitlement: payroll_num(l.entitlement) });
      }
      const firstPayslip = snapshots.size === 0;
      for (let back = 1; back <= PAYROLL_ARREARS_LOOKBACK; back++) {
        const source = payroll_shiftLabel(period, -back);
        const sourceCycle = payPeriodFromLabel(source, payDay);
        const then = payroll_entitlement(c, sales, sourceCycle);
        if (firstPayslip) {
          // Everything before the first pay run was settled by hand. Write down where each
          // older cycle stood so only what is collected from here on is paid.
          if (then.amount > 0) earning.push({ kind: 'baseline', label: `Settled before pay runs began (${payroll_cycleName(sourceCycle)})`, amount: 0, sourcePeriod: source, entitlement: then.amount });
          continue;
        }
        const delta = round2(then.amount - (snapshots.get(source)?.entitlement || 0));
        if (Math.abs(delta) < 0.01) continue;
        earning.push({
          kind: 'arrears',
          label: delta > 0 ? `Commission on ${payroll_cycleName(sourceCycle)} orders paid since` : `Commission reversed on ${payroll_cycleName(sourceCycle)} orders`,
          amount: delta, sourcePeriod: source, entitlement: then.amount,
        });
      }

      // A target for the cycle pays its bonus once what has been collected reaches it.
      const collected = payroll_collectedGoods(c, sales, cycle);
      const goal = targets.find(t => t.consultantId === c.id) || null;
      let target = null;
      if (goal) {
        const aim = payroll_num(goal.target), flat = payroll_num(goal.bonus), rate = payroll_num(goal.bonusRate);
        const reached = collected >= aim;
        const bonusNow = reached ? round2(flat + ((collected - aim) * rate) / 100) : 0;
        if (bonusNow > 0) earning.push({ kind: 'bonus', label: `Target bonus: ${kwacha(collected)} collected against a target of ${kwacha(aim)}`, amount: bonusNow });
        target = {
          id: goal.id, target: aim, bonus: flat, bonusRate: rate, collected, reached, bonusNow,
          toGo: round2(Math.max(0, aim - collected)), progress: aim > 0 ? Math.min(100, round2((collected / aim) * 100)) : 0,
        };
      }
      // Offered when a target is being set: ten percent above their recent cycles, so it asks
      // for more than usual without asking for their best month ever.
      const recentCycles = [1, 2, 3]
        .map(back => payroll_collectedGoods(c, sales, payPeriodFromLabel(payroll_shiftLabel(period, -back), payDay)))
        .filter(v => v > 0);
      const suggestedTarget = recentCycles.length
        ? Math.round(((recentCycles.reduce((a, b) => a + b, 0) / recentCycles.length) * 1.1) / 1000) * 1000
        : 0;

      const slip = build(key, {
        kind: 'commission', personId: c.id, name: c.name,
        jobTitle: c.payType === 'revenue_pct' ? 'Sales consultant (% of revenue)' : 'Sales consultant (per unit)',
      }, earning);

      const unpaidOrders = sales
        .filter(s => s.consultantId === c.id && s.paymentStatus !== 'Paid' && new Date(s.date) >= unpaidFrom)
        .map(s => {
          const total = payroll_num(s.totalPrice), paid = payroll_num(s.amountPaid);
          const delivery = payroll_num(s.shippingCost);
          return {
            saleId: s.id, orderNumber: s.orderNumber, date: s.date, customerName: s.customerName, status: s.status,
            total, paid, balance: round2(total - paid),
            // Goods came back: the consultant carries what the delivery cost us.
            deliveryCharge: delivery,
            // Goods lost: what the customer still owes, plus any delivery cost the bill did not cover.
            lostCharge: round2(total - paid + Math.max(0, delivery - payroll_num(s.shippingCharge))),
            recovered: recoveredSales.has(s.id),
          };
        })
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      return { ...slip, unpaidOrders, onRun: activeNow, target, collected, suggestedTarget };
    });

    // Someone who has left still gets a payslip while there is anything on it.
    slips = [...salaried, ...commissioned]
      .filter(p => p.onRun || p.broughtForward !== 0 || p.lines.some(l => l.amount !== 0))
      .map(({ onRun, ...p }) => p);
  }

  let blockedReason = null;
  if (!existing) {
    const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (now < cycle.periodTo) blockedReason = `This cycle is still running. It can be finalised from ${fmt(cycle.periodTo)}.`;
    else if (lastRun && lastRun.period > period) blockedReason = 'A later cycle has already been finalised.';
    else if (lastRun && nextToFinalise !== period) blockedReason = `Finalise the ${nextToFinalise} cycle first.`;
  }
  const sum = (key) => round2(slips.reduce((s, p) => s + (p[key] || 0), 0));

  return {
    period: { label: period, from: cycle.periodFrom, to: cycle.periodTo, payDate: cycle.payDate, payDay, name: payroll_cycleName(cycle) },
    status: existing ? 'final' : 'draft',
    runId: existing ? existing.id : null,
    finalisedAt: existing ? existing.finalisedAt : null,
    canFinalise: !existing && !blockedReason,
    blockedReason,
    // Only the newest run can be reopened, and only before any of it has been paid out.
    canReopen: !!existing && lastRun.id === existing.id && slips.every(p => p.paid === 0),
    firstRun: runs.length === 0,
    // Every cycle with payslips on record, so an old one can always be reached.
    finalisedPeriods: runs.map(r => r.period),
    currentPeriod: currentLabel,
    payslips: slips,
    totals: {
      headcount: slips.length,
      broughtForward: sum('broughtForward'), earnings: sum('earnings'), alreadyPaid: sum('alreadyPaid'),
      deductions: sum('deductions'), netPay: sum('netPay'), paid: sum('paid'), outstanding: sum('outstanding'),
    },
  };
}

// What the payroll says each consultant is owed for one cycle, for the screens that used to
// work a balance out for themselves. Null for a cycle from before pay runs began, which is
// still read the old way. With no period it answers for the cycle that is to be paid next.
async function payroll_consultantPay(prisma, companyId, period) {
  if (period) {
    if (!payroll_isLabel(period)) return null;
    const [first, company] = await Promise.all([
      prisma.payRun.findFirst({ where: { companyId }, orderBy: { period: 'asc' }, select: { period: true } }),
      prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } }),
    ]);
    const start = first ? first.period : getConsultantPayPeriod(new Date(), company?.consultantPayDay || 11).label;
    if (period < start) return null;
  }
  const run = await payroll_run(prisma, companyId, period || null);
  const slips = new Map();
  for (const p of run.payslips) {
    if (p.kind !== 'commission') continue;
    slips.set(p.personId, {
      status: run.status, period: run.period.label, periodName: run.period.name,
      broughtForward: p.broughtForward, earnings: p.earnings, alreadyPaid: p.alreadyPaid, deductions: p.deductions,
      netPay: p.netPay, paid: p.paid, outstanding: p.outstanding, carried: p.carried,
      // Still owed to the consultant: the whole net while the cycle is a draft, what is left
      // to pay once it is finalised, and nothing once that has moved to a later payslip.
      balance: run.status === 'draft' ? p.netPay : (p.carried ? 0 : p.outstanding),
      lines: p.lines.filter(l => l.kind !== 'baseline').map(l => ({ kind: l.kind, label: l.label, amount: l.amount })),
      payments: p.payments, loans: p.loans, held: p.held, finalisedAt: run.finalisedAt,
      target: p.target || null,
    });
  }
  return { status: run.status, period: run.period, slips };
}

// Every finalised payslip one consultant has, newest first, in the same shape the screens
// already read. Read straight from what was written down, so an old payslip costs nothing to
// show and is exactly what it was on the day the cycle closed.
async function payroll_payslipHistory(prisma, companyId, consultantId) {
  const payslips = await prisma.payslip.findMany({
    where: { companyId, consultantId },
    include: { payRun: true, lines: { orderBy: { sort: 'asc' } }, commissionPayments: { orderBy: { createdAt: 'asc' } } },
  });
  payslips.sort((a, b) => (a.payRun.period < b.payRun.period ? 1 : -1));
  return payslips.map((p, i) => {
    const netPay = payroll_num(p.netPay);
    const paid = round2(p.commissionPayments.reduce((s, x) => s + payroll_num(x.amount), 0));
    // Anything but the newest has had its balance carried into the payslip after it.
    const carried = i > 0;
    const outstanding = round2(netPay - paid);
    return {
      status: 'final', period: p.payRun.period, finalisedAt: p.payRun.finalisedAt,
      periodName: payroll_cycleName({ periodFrom: p.payRun.periodFrom, periodTo: p.payRun.periodTo }),
      broughtForward: payroll_num(p.broughtForward), earnings: payroll_num(p.earnings), alreadyPaid: payroll_num(p.alreadyPaid),
      deductions: payroll_num(p.deductions), netPay, paid, outstanding, carried, balance: carried ? 0 : outstanding,
      lines: p.lines.filter(l => l.kind !== 'baseline').map(l => ({ kind: l.kind, label: l.label, amount: payroll_num(l.amount) })),
      payments: p.commissionPayments.map(x => ({ id: x.id, amount: payroll_num(x.amount), createdAt: x.createdAt, paymentMethod: x.paymentMethod, reference: x.reference, notes: x.notes })),
      loans: [], held: [],
    };
  });
}

// The finalised cycle a directly recorded payment would fall in, if there is one. That
// cycle's pay is settled on its payslip, so commission, salary or an advance recorded against
// it by hand would never reach anyone's balance.
async function payroll_finalisedCycleOf(prisma, companyId, periodFrom, periodTo) {
  if (!periodFrom || !periodTo) return null;
  const mid = new Date((new Date(periodFrom).getTime() + new Date(periodTo).getTime()) / 2);
  const run = await prisma.payRun.findFirst({ where: { companyId, periodFrom: { lte: mid }, periodTo: { gt: mid } }, select: { period: true } });
  return run ? run.period : null;
}

app.get('/api/v1/payroll/run', authenticate, requireAdmin, async (req, res) => {
  try {
    if (req.query.period && !payroll_isLabel(req.query.period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    res.json(await payroll_run(prisma, req.user.companyId, req.query.period || null));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Write the cycle down. After this its payslips are a record, not a calculation.
app.post('/api/v1/payroll/run/finalise', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (!payroll_isLabel(req.body.period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    const run = await payroll_run(prisma, companyId, req.body.period);
    if (run.status === 'final') return res.status(400).json({ error: 'That cycle is already finalised' });
    if (!run.canFinalise) return res.status(400).json({ error: run.blockedReason });

    const periodText = payroll_periodLabel(run.period.from, run.period.to);
    const created = await prisma.$transaction(async (tx) => {
      const payRun = await tx.payRun.create({
        data: { period: run.period.label, periodFrom: run.period.from, periodTo: run.period.to, companyId },
      });
      for (const slip of run.payslips) {
        let expenseId = null;
        if (slip.wageCost > 0) {
          const expense = await tx.expense.create({
            data: {
              description: `${slip.kind === 'commission' ? 'Commission' : 'Salary'}: ${slip.name} (${periodText})`,
              amount: slip.wageCost, category: PAYROLL_EXPENSE_CATEGORY, companyId,
            },
          });
          expenseId = expense.id;
        }
        const payslip = await tx.payslip.create({
          data: {
            payRunId: payRun.id,
            consultantId: slip.kind === 'commission' ? slip.personId : null,
            staffId: slip.kind === 'salaried' ? slip.personId : null,
            name: slip.name, jobTitle: slip.jobTitle || null,
            broughtForward: slip.broughtForward, earnings: slip.earnings, alreadyPaid: slip.alreadyPaid,
            deductions: slip.deductions, netPay: slip.netPay, expenseId, companyId,
          },
        });
        if (slip.lines.length) {
          await tx.payslipLine.createMany({
            data: slip.lines.map((l, i) => ({
              payslipId: payslip.id, kind: l.kind, label: l.label, amount: l.amount,
              sourcePeriod: l.sourcePeriod || null, entitlement: l.entitlement ?? null,
              loanId: l.loanId || null, adjustmentId: l.adjustmentId || null, sort: i, companyId,
            })),
          });
        }
      }
      return payRun;
    }, { timeout: 20000 });

    res.status(201).json(await payroll_run(prisma, companyId, created.period));
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'That cycle is already finalised' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

// Undo a finalise, for the mistake noticed before anyone has been paid.
app.post('/api/v1/payroll/run/reopen', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (!payroll_isLabel(req.body.period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    const run = await payroll_run(prisma, companyId, req.body.period);
    if (run.status !== 'final') return res.status(400).json({ error: 'That cycle is not finalised' });
    if (!run.canReopen) return res.status(400).json({ error: 'Only the latest cycle can be reopened, and only before any of it is paid. Remove its payments first.' });

    await prisma.$transaction(async (tx) => {
      const slips = await tx.payslip.findMany({ where: { payRunId: run.runId, companyId }, select: { id: true, expenseId: true } });
      await tx.payslip.deleteMany({ where: { id: { in: slips.map(s => s.id) } } });
      const expenseIds = slips.map(s => s.expenseId).filter(Boolean);
      if (expenseIds.length) await tx.expense.deleteMany({ where: { id: { in: expenseIds }, companyId } });
      await tx.payRun.delete({ where: { id: run.runId } });
    }, { timeout: 20000 });

    res.json(await payroll_run(prisma, companyId, req.body.period));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// A finalised payslip with whether it is still the person's newest one. Only the newest can
// take or lose a payment, because an older one's balance already sits on the payslip after it.
async function payroll_openPayslip(prisma, companyId, id) {
  const payslip = await prisma.payslip.findFirst({ where: { id, companyId }, include: { payRun: true } });
  if (!payslip) return { error: 'Payslip not found', status: 404 };
  const later = await prisma.payslip.findFirst({
    where: {
      companyId, payRun: { period: { gt: payslip.payRun.period } },
      ...(payslip.consultantId ? { consultantId: payslip.consultantId } : { staffId: payslip.staffId }),
    },
    include: { payRun: { select: { period: true } } },
  });
  if (later) return { error: `This balance was carried into the ${later.payRun.period} payslip. Settle it there.`, status: 400 };
  return { payslip };
}

// Cash handed over against a payslip. The wage cost was booked at finalise, so this raises no
// expense: it only moves the payslip towards settled.
app.post('/api/v1/payroll/payslips/:id/payments', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const found = await payroll_openPayslip(prisma, companyId, req.params.id);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const { payslip } = found;

    const amount = round2(parseFloat(req.body.amount));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });
    const model = payslip.consultantId ? prisma.commissionPayment : prisma.staffPayment;
    const sofar = await model.aggregate({ where: { payslipId: payslip.id }, _sum: { amount: true } });
    const outstanding = round2(payroll_num(payslip.netPay) - payroll_num(sofar._sum.amount));
    if (outstanding <= 0) return res.status(400).json({ error: 'Nothing is owed on this payslip' });
    if (amount > outstanding + 0.01) return res.status(400).json({ error: `Only K${outstanding.toFixed(2)} is owed on this payslip` });

    const common = {
      amount, periodFrom: payslip.payRun.periodFrom, periodTo: payslip.payRun.periodTo,
      paymentMethod: req.body.paymentMethod || null, reference: req.body.reference || null, notes: req.body.notes || null,
      payslipId: payslip.id, companyId,
    };
    const payment = payslip.consultantId
      ? await prisma.commissionPayment.create({ data: { ...common, consultantId: payslip.consultantId, type: 'commission' } })
      : await prisma.staffPayment.create({ data: { ...common, staffId: payslip.staffId, type: 'salary' } });
    res.status(201).json(payment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/payroll/payslips/:id/payments/:paymentId', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const found = await payroll_openPayslip(prisma, companyId, req.params.id);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const model = found.payslip.consultantId ? prisma.commissionPayment : prisma.staffPayment;
    const removed = await model.deleteMany({ where: { id: req.params.paymentId, payslipId: found.payslip.id, companyId } });
    if (!removed.count) return res.status(404).json({ error: 'Payment not found' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- ADJUSTMENTS: BONUSES, DEDUCTIONS AND RECOVERIES ----

// A cycle that is finalised cannot take anything new; it goes on the next one.
async function payroll_periodIsClosed(prisma, companyId, period) {
  const last = await prisma.payRun.findFirst({ where: { companyId }, orderBy: { period: 'desc' }, select: { period: true } });
  return !!last && last.period >= period;
}

app.post('/api/v1/payroll/adjustments', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { kind, period, reason, saleId } = req.body;
    if (!PAYROLL_ADJUSTMENT_KINDS.includes(kind)) return res.status(400).json({ error: `Kind must be one of ${PAYROLL_ADJUSTMENT_KINDS.join(', ')}` });
    if (!payroll_isLabel(period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    const amount = round2(parseFloat(req.body.amount));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Say what this is for, so the payslip explains itself' });
    const person = await payroll_resolvePerson(prisma, companyId, req.body);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    if (await payroll_periodIsClosed(prisma, companyId, period)) return res.status(400).json({ error: 'That cycle is finalised. Add this to the cycle that is still open.' });
    if (saleId && !(await prisma.sale.findFirst({ where: { id: saleId, companyId }, select: { id: true } }))) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const adjustment = await prisma.payAdjustment.create({
      data: {
        consultantId: person.consultantId, staffId: person.staffId, period, kind, amount,
        reason: String(reason).trim(), saleId: saleId || null,
        refundable: kind === 'recovery' && !!req.body.refundable, companyId,
      },
    });
    res.status(201).json(adjustment);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/payroll/adjustments/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const adjustment = await prisma.payAdjustment.findFirst({ where: { id: req.params.id, companyId } });
    if (!adjustment) return res.status(404).json({ error: 'Not found' });
    const used = await prisma.payslipLine.count({ where: { adjustmentId: adjustment.id, companyId } });
    if (used) return res.status(400).json({ error: 'This is on a finalised payslip and cannot be removed' });
    await prisma.payAdjustment.delete({ where: { id: adjustment.id } });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Give held money back: it is refunded on the pay run for the cycle named. Passing no period
// takes the release back, as long as the refund has not been finalised.
app.post('/api/v1/payroll/adjustments/:id/release', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const adjustment = await prisma.payAdjustment.findFirst({ where: { id: req.params.id, companyId } });
    if (!adjustment || adjustment.kind !== 'recovery') return res.status(404).json({ error: 'Not found' });
    if (!adjustment.refundable) return res.status(400).json({ error: 'This recovery was not marked as refundable' });
    const linesFor = await prisma.payslipLine.findMany({ where: { adjustmentId: adjustment.id, companyId }, select: { kind: true } });
    if (!linesFor.some(l => l.kind !== 'refund')) return res.status(400).json({ error: 'This has not been deducted yet. Remove it instead.' });
    if (linesFor.some(l => l.kind === 'refund')) return res.status(400).json({ error: 'This has already been refunded' });

    const period = req.body.period || null;
    if (period) {
      if (!payroll_isLabel(period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
      if (await payroll_periodIsClosed(prisma, companyId, period)) return res.status(400).json({ error: 'That cycle is finalised. Release it on the cycle that is still open.' });
    }
    res.json(await prisma.payAdjustment.update({ where: { id: adjustment.id }, data: { refundPeriod: period } }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CONSULTANT TARGETS ----

// Set, or change, what a consultant is asked to collect in a cycle and what reaching it pays.
app.put('/api/v1/payroll/targets', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { consultantId, period } = req.body;
    if (!payroll_isLabel(period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    const consultant = await prisma.consultant.findFirst({ where: { id: consultantId || '', companyId, isStockLocation: false } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    const target = round2(parseFloat(req.body.target));
    if (!Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Target must be more than zero' });
    const bonus = req.body.bonus === undefined || req.body.bonus === '' ? 0 : round2(parseFloat(req.body.bonus));
    const bonusRate = req.body.bonusRate === undefined || req.body.bonusRate === '' ? 0 : round2(parseFloat(req.body.bonusRate));
    if (!Number.isFinite(bonus) || bonus < 0) return res.status(400).json({ error: 'Bonus must be zero or more' });
    if (!Number.isFinite(bonusRate) || bonusRate < 0 || bonusRate > 100) return res.status(400).json({ error: 'The share above target must be between 0 and 100 percent' });
    if (await payroll_periodIsClosed(prisma, companyId, period)) return res.status(400).json({ error: 'That cycle is finalised, so its target can no longer change.' });

    const saved = await prisma.consultantTarget.upsert({
      where: { consultantId_period: { consultantId: consultant.id, period } },
      create: { consultantId: consultant.id, period, target, bonus, bonusRate, companyId },
      update: { target, bonus, bonusRate },
    });
    res.json(saved);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/payroll/targets/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const target = await prisma.consultantTarget.findFirst({ where: { id: req.params.id, companyId } });
    if (!target) return res.status(404).json({ error: 'Target not found' });
    if (await payroll_periodIsClosed(prisma, companyId, target.period)) return res.status(400).json({ error: 'That cycle is finalised, so its target can no longer change.' });
    await prisma.consultantTarget.delete({ where: { id: target.id } });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- LOANS ----

// ---- SALARY ADVANCE REQUESTS ----
// Salary advances people ask for themselves. (mirrored in server/src/routes/advances.js)
//
// The person says how much and over how many pay days it comes back. The admin approves it (as
// asked, or on terms of their own), then records handing the money over. That last step creates
// a Loan, which the pay run already deducts instalment by instalment, so an advance needs no
// arithmetic of its own on the payslip.
//
// The first instalment comes from the first pay day after the money was received, never from
// one before it, and never from a cycle that is already finalised. That is why the loan is made
// when the money is paid out rather than when the request is approved: approval can come days
// before the cash does.

const ADVANCE_MAX_INSTALMENTS = 12;
const advance_round2 = (n) => Math.round(n * 100) / 100;
const advance_num = (v) => (v == null ? 0 : parseFloat(v));

function advance_shiftLabel(label, by) {
  const [y, m] = label.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// A date-only string is read as midday local time, so a server running in UTC can't move an
// advance handed over on pay day into the cycle before.
function advance_parseDate(v) {
  if (!v) return new Date();
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function advance_payDay(prisma, companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } });
  return company?.consultantPayDay || 11;
}

// The cycle whose pay day is the first one after the money was received, moved on past any
// cycle already finalised.
async function advance_firstPeriod(prisma, companyId, receivedAt, payDay) {
  let label = getConsultantPayPeriod(receivedAt, payDay).label;
  const last = await prisma.payRun.findFirst({ where: { companyId }, orderBy: { period: 'desc' }, select: { period: true } });
  if (last && last.period >= label) label = advance_shiftLabel(last.period, 1);
  return label;
}

const advance_instalmentAmount = (amount, instalments) => Math.ceil((amount / instalments) * 100) / 100;

// Each pay day and what comes off on it, the way the pay run will take it.
function advance_schedule(amount, instalmentAmount, firstPeriod, payDay) {
  const out = [];
  let left = advance_round2(amount);
  for (let i = 0; left > 0 && i < 60; i++) {
    const period = advance_shiftLabel(firstPeriod, i);
    const take = advance_round2(Math.min(instalmentAmount, left));
    out.push({ period, payDate: payPeriodFromLabel(period, payDay).payDate, amount: take });
    left = advance_round2(left - take);
  }
  return out;
}

// The pay profile behind a login: a consultant, or a salaried staff member found by their login
// or by the rider profile that login belongs to.
async function advance_personFor(prisma, user) {
  if (user.role === 'admin' || user.role === 'superadmin') return null;
  if (user.consultantId) {
    const c = await prisma.consultant.findFirst({ where: { id: user.consultantId, companyId: user.companyId } });
    return c ? { consultantId: c.id, staffId: null, name: c.name } : null;
  }
  const s = await prisma.staff.findFirst({
    where: { companyId: user.companyId, isActive: true, OR: [{ userId: user.id }, ...(user.riderId ? [{ riderId: user.riderId }] : [])] },
  });
  return s ? { consultantId: null, staffId: s.id, name: s.name } : null;
}

const ADVANCE_INCLUDE = {
  consultant: { select: { name: true } },
  staff: { select: { name: true } },
  loan: { select: { id: true, principal: true, instalmentAmount: true, firstPeriod: true, status: true } },
};

// One request as both sides see it. Until the money is paid out, the schedule is what would
// happen if it were paid today; afterwards it is the loan's.
async function advance_views(prisma, companyId, requests) {
  const payDay = await advance_payDay(prisma, companyId);
  const previewFirst = await advance_firstPeriod(prisma, companyId, new Date(), payDay);
  const loanIds = requests.map(r => r.loanId).filter(Boolean);
  const lines = loanIds.length
    ? await prisma.payslipLine.groupBy({ by: ['loanId'], where: { companyId, loanId: { in: loanIds } }, _sum: { amount: true } })
    : [];
  const repaidBy = new Map(lines.map(l => [l.loanId, Math.abs(advance_num(l._sum.amount))]));

  return requests.map(r => {
    const requested = { amount: advance_num(r.amount), instalments: r.instalments };
    const agreed = r.approvedAmount != null
      ? { amount: advance_num(r.approvedAmount), instalments: r.approvedInstalments }
      : requested;
    const base = {
      id: r.id, status: r.status, kind: r.consultantId ? 'commission' : 'salaried', personId: r.consultantId || r.staffId,
      name: r.consultant?.name || r.staff?.name || '', reason: r.reason, requested, agreed,
      termsChanged: agreed.amount !== requested.amount || agreed.instalments !== requested.instalments,
      decisionNote: r.decisionNote, createdAt: r.createdAt, decidedAt: r.decidedAt, paidAt: r.paidAt, paymentMethod: r.paymentMethod,
    };
    if (r.loan) {
      const principal = advance_num(r.loan.principal);
      const repaid = advance_round2(repaidBy.get(r.loan.id) || 0);
      return {
        ...base, firstPeriod: r.loan.firstPeriod, instalmentAmount: advance_num(r.loan.instalmentAmount),
        schedule: advance_schedule(principal, advance_num(r.loan.instalmentAmount), r.loan.firstPeriod, payDay),
        repaid, outstanding: r.loan.status === 'cancelled' ? 0 : advance_round2(principal - repaid), loanStatus: r.loan.status,
      };
    }
    if (r.status === 'pending' || r.status === 'approved') {
      const per = advance_instalmentAmount(agreed.amount, agreed.instalments);
      return { ...base, firstPeriod: previewFirst, instalmentAmount: per, schedule: advance_schedule(agreed.amount, per, previewFirst, payDay), preview: true };
    }
    return { ...base, firstPeriod: null, schedule: [] };
  });
}

function advance_terms(body) {
  const amount = advance_round2(parseFloat(body.amount));
  const instalments = Number(body.instalments);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'The amount must be more than zero' };
  if (!Number.isInteger(instalments) || instalments < 1 || instalments > ADVANCE_MAX_INSTALMENTS) {
    return { error: `Choose between 1 and ${ADVANCE_MAX_INSTALMENTS} instalments` };
  }
  return { amount, instalments };
}

// ---- the person's own requests ----

app.get('/api/v1/advances/mine', authenticate, async (req, res) => {
  try {
    const person = await advance_personFor(prisma, req.user);
    if (!person) return res.status(404).json({ error: 'Your login is not linked to a pay profile. Ask the office to link it.' });
    const requests = await prisma.advanceRequest.findMany({
      where: { companyId: req.user.companyId, consultantId: person.consultantId, staffId: person.staffId },
      include: ADVANCE_INCLUDE, orderBy: { createdAt: 'desc' },
    });
    const payDay = await advance_payDay(prisma, req.user.companyId);
    const nextFirst = await advance_firstPeriod(prisma, req.user.companyId, new Date(), payDay);
    res.json({
      name: person.name, maxInstalments: ADVANCE_MAX_INSTALMENTS,
      nextPayDate: payPeriodFromLabel(nextFirst, payDay).payDate,
      requests: await advance_views(prisma, req.user.companyId, requests),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/advances/mine', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const person = await advance_personFor(prisma, req.user);
    if (!person) return res.status(404).json({ error: 'Your login is not linked to a pay profile. Ask the office to link it.' });
    const terms = advance_terms(req.body);
    if (terms.error) return res.status(400).json({ error: terms.error });
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Say what the advance is for' });
    // One open request at a time keeps a double tap from becoming two advances.
    const open = await prisma.advanceRequest.findFirst({
      where: { companyId, consultantId: person.consultantId, staffId: person.staffId, status: { in: ['pending', 'approved'] } },
    });
    if (open) return res.status(409).json({ error: 'You already have an advance request waiting. Withdraw it or wait for it to be settled first.' });
    const created = await prisma.advanceRequest.create({
      data: { consultantId: person.consultantId, staffId: person.staffId, requestedById: req.user.id, reason, ...terms, companyId },
      include: ADVANCE_INCLUDE,
    });
    res.status(201).json((await advance_views(prisma, companyId, [created]))[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/advances/mine/:id/withdraw', authenticate, async (req, res) => {
  try {
    const person = await advance_personFor(prisma, req.user);
    if (!person) return res.status(404).json({ error: 'Request not found' });
    const done = await prisma.advanceRequest.updateMany({
      where: { id: req.params.id, companyId: req.user.companyId, consultantId: person.consultantId, staffId: person.staffId, status: 'pending' },
      data: { status: 'withdrawn' },
    });
    if (!done.count) return res.status(400).json({ error: 'Only a request still waiting for a decision can be withdrawn' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- the office ----

// How many requests are waiting on the office, for the dashboard alert and the menu badge.
app.get('/api/v1/advances/summary', authenticate, requireAdmin, async (req, res) => {
  try {
    const groups = await prisma.advanceRequest.groupBy({
      by: ['status'], where: { companyId: req.user.companyId, status: { in: ['pending', 'approved'] } }, _count: { _all: true },
    });
    const count = (st) => groups.find(g => g.status === st)?._count._all || 0;
    res.json({ pending: count('pending'), approved: count('approved') });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/advances', authenticate, requireAdmin, async (req, res) => {
  try {
    const requests = await prisma.advanceRequest.findMany({
      where: { companyId: req.user.companyId }, include: ADVANCE_INCLUDE, orderBy: { createdAt: 'desc' },
    });
    res.json(await advance_views(prisma, req.user.companyId, requests));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/advances/:id/approve', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const request = await prisma.advanceRequest.findFirst({ where: { id: req.params.id, companyId } });
    if (!request) return res.status(404).json({ error: 'Request not found' });
    const changing = req.body.amount !== undefined || req.body.instalments !== undefined;
    const terms = changing
      ? advance_terms({ amount: req.body.amount ?? request.amount, instalments: req.body.instalments ?? request.instalments })
      : { amount: advance_num(request.amount), instalments: request.instalments };
    if (terms.error) return res.status(400).json({ error: terms.error });
    const done = await prisma.advanceRequest.updateMany({
      where: { id: request.id, companyId, status: 'pending' },
      data: {
        status: 'approved', approvedAmount: terms.amount, approvedInstalments: terms.instalments,
        decisionNote: req.body.note ? String(req.body.note).trim().slice(0, 500) : null, decidedAt: new Date(),
      },
    });
    if (!done.count) return res.status(400).json({ error: 'Only a request waiting for a decision can be approved' });
    const updated = await prisma.advanceRequest.findUnique({ where: { id: request.id }, include: ADVANCE_INCLUDE });
    res.json((await advance_views(prisma, companyId, [updated]))[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/advances/:id/decline', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const done = await prisma.advanceRequest.updateMany({
      where: { id: req.params.id, companyId, status: { in: ['pending', 'approved'] } },
      data: { status: 'declined', decisionNote: req.body.note ? String(req.body.note).trim().slice(0, 500) : null, decidedAt: new Date() },
    });
    if (!done.count) return res.status(400).json({ error: 'Only a request that has not been paid out can be declined' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// The money has been handed over: the loan starts here, repaid from the next pay day on.
app.post('/api/v1/advances/:id/pay', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const paidAt = advance_parseDate(req.body.paidAt);
    if (!paidAt) return res.status(400).json({ error: 'Give the date the money was handed over' });
    if (paidAt > new Date(Date.now() + 24 * 60 * 60 * 1000)) return res.status(400).json({ error: 'The payout date cannot be in the future' });
    const payDay = await advance_payDay(prisma, companyId);
    const firstPeriod = await advance_firstPeriod(prisma, companyId, paidAt, payDay);

    const result = await prisma.$transaction(async (tx) => {
      // Claiming the request first means a second click finds nothing to pay and makes no loan.
      const claimed = await tx.advanceRequest.updateMany({
        where: { id: req.params.id, companyId, status: 'approved' },
        data: { status: 'paid', paidAt, paymentMethod: req.body.paymentMethod ? String(req.body.paymentMethod).slice(0, 50) : null },
      });
      if (!claimed.count) return null;
      const request = await tx.advanceRequest.findUnique({ where: { id: req.params.id } });
      const amount = advance_num(request.approvedAmount ?? request.amount);
      const instalments = request.approvedInstalments ?? request.instalments;
      const loan = await tx.loan.create({
        data: {
          consultantId: request.consultantId, staffId: request.staffId, description: 'Salary advance',
          principal: amount, instalmentAmount: Math.min(advance_instalmentAmount(amount, instalments), amount), firstPeriod,
          issuedAt: paidAt, notes: request.reason, companyId,
        },
      });
      await tx.advanceRequest.update({ where: { id: request.id }, data: { loanId: loan.id } });
      return request.id;
    });
    if (!result) return res.status(400).json({ error: 'Only an approved request that has not been paid out can be paid' });
    const updated = await prisma.advanceRequest.findUnique({ where: { id: result }, include: ADVANCE_INCLUDE });
    res.json((await advance_views(prisma, companyId, [updated]))[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/payroll/loans', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const [loans, lines] = await Promise.all([
      prisma.loan.findMany({
        where: { companyId }, orderBy: { createdAt: 'desc' },
        include: { consultant: { select: { name: true } }, staff: { select: { name: true } } },
      }),
      prisma.payslipLine.findMany({
        where: { companyId, loanId: { not: null } },
        select: { loanId: true, amount: true, payslip: { select: { payRun: { select: { period: true } } } } },
      }),
    ]);
    res.json(loans.map(loan => {
      const repayments = lines.filter(l => l.loanId === loan.id)
        .map(l => ({ period: l.payslip.payRun.period, amount: Math.abs(payroll_num(l.amount)) }))
        .sort((a, b) => (a.period < b.period ? -1 : 1));
      const repaid = round2(repayments.reduce((s, r) => s + r.amount, 0));
      const principal = payroll_num(loan.principal), instalment = payroll_num(loan.instalmentAmount);
      const outstanding = loan.status === 'cancelled' ? 0 : round2(principal - repaid);
      return {
        id: loan.id, kind: loan.consultantId ? 'commission' : 'salaried', personId: loan.consultantId || loan.staffId,
        name: loan.consultant?.name || loan.staff?.name || '', description: loan.description, notes: loan.notes,
        principal, instalmentAmount: instalment, firstPeriod: loan.firstPeriod, issuedAt: loan.issuedAt, status: loan.status,
        repaid, outstanding, writtenOff: loan.status === 'cancelled' ? round2(principal - repaid) : 0,
        instalmentsLeft: outstanding > 0 && instalment > 0 ? Math.ceil(outstanding / instalment - 0.0001) : 0,
        repayments,
      };
    }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/payroll/loans', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { description, firstPeriod, notes, issuedAt } = req.body;
    if (!description || !String(description).trim()) return res.status(400).json({ error: 'Say what the loan is for' });
    const principal = round2(parseFloat(req.body.principal));
    if (!Number.isFinite(principal) || principal <= 0) return res.status(400).json({ error: 'Loan amount must be more than zero' });
    // The terms can be given either way round: an amount per cycle, or a number of cycles.
    const count = parseInt(req.body.instalments, 10);
    const instalmentAmount = req.body.instalmentAmount !== undefined && req.body.instalmentAmount !== ''
      ? round2(parseFloat(req.body.instalmentAmount))
      : (count > 0 ? Math.ceil((principal / count) * 100) / 100 : NaN);
    if (!Number.isFinite(instalmentAmount) || instalmentAmount <= 0) return res.status(400).json({ error: 'Give the repayment terms: an amount per cycle, or a number of instalments' });
    if (!payroll_isLabel(firstPeriod)) return res.status(400).json({ error: 'Choose the cycle the first instalment comes out of' });
    const person = await payroll_resolvePerson(prisma, companyId, req.body);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    if (await payroll_periodIsClosed(prisma, companyId, firstPeriod)) return res.status(400).json({ error: 'That cycle is finalised. The first instalment must come out of a cycle that is still open.' });

    const loan = await prisma.loan.create({
      data: {
        consultantId: person.consultantId, staffId: person.staffId, description: String(description).trim(),
        principal, instalmentAmount: Math.min(instalmentAmount, principal), firstPeriod,
        issuedAt: issuedAt ? new Date(issuedAt) : new Date(), notes: notes || null, companyId,
      },
    });
    res.status(201).json(loan);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Change the terms from here on. What has already been deducted stays as it was.
app.put('/api/v1/payroll/loans/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const loan = await prisma.loan.findFirst({ where: { id: req.params.id, companyId } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const raw = req.body;
    const data = {
      ...(raw.description !== undefined && { description: String(raw.description).trim() || loan.description }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
    };
    if (raw.status !== undefined) {
      if (!['active', 'cancelled'].includes(raw.status)) return res.status(400).json({ error: 'Status must be active or cancelled' });
      data.status = raw.status;
    }
    if (raw.instalmentAmount !== undefined) {
      const v = round2(parseFloat(raw.instalmentAmount));
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'Instalment must be more than zero' });
      data.instalmentAmount = v;
    }
    const repaid = await prisma.payslipLine.aggregate({ where: { loanId: loan.id, companyId }, _sum: { amount: true } });
    const repaidSoFar = Math.abs(payroll_num(repaid._sum.amount));
    if (raw.principal !== undefined) {
      const v = round2(parseFloat(raw.principal));
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'Loan amount must be more than zero' });
      if (v < repaidSoFar) return res.status(400).json({ error: `K${repaidSoFar.toFixed(2)} has already been repaid, so the loan cannot be less than that` });
      data.principal = v;
    }
    if (raw.firstPeriod !== undefined && raw.firstPeriod !== loan.firstPeriod) {
      if (!payroll_isLabel(raw.firstPeriod)) return res.status(400).json({ error: 'Period must look like 2026-11' });
      if (repaidSoFar > 0) return res.status(400).json({ error: 'Repayment has started, so the first cycle cannot move. Skip a cycle on the pay run instead.' });
      data.firstPeriod = raw.firstPeriod;
    }
    res.json(await prisma.loan.update({ where: { id: loan.id }, data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// A loan nobody has repaid any of was a mistake and can go. One with repayments is history.
app.delete('/api/v1/payroll/loans/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const loan = await prisma.loan.findFirst({ where: { id: req.params.id, companyId } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const used = await prisma.payslipLine.count({ where: { loanId: loan.id, companyId } });
    if (used) return res.status(400).json({ error: 'Repayments have been taken for this loan. Cancel it instead to write off the rest.' });
    await prisma.$transaction([
      prisma.payAdjustment.deleteMany({ where: { loanId: loan.id, companyId } }),
      prisma.loan.delete({ where: { id: loan.id } }),
    ]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// The admin's say over one cycle's instalment: take this much instead of the scheduled
// amount, zero to skip the cycle. Sending no amount goes back to the schedule.
app.put('/api/v1/payroll/loans/:id/instalment', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const loan = await prisma.loan.findFirst({ where: { id: req.params.id, companyId } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const { period } = req.body;
    if (!payroll_isLabel(period)) return res.status(400).json({ error: 'Period must look like 2026-11' });
    if (await payroll_periodIsClosed(prisma, companyId, period)) return res.status(400).json({ error: 'That cycle is finalised' });

    await prisma.payAdjustment.deleteMany({ where: { loanId: loan.id, period, kind: 'loan_instalment', companyId } });
    if (req.body.amount === undefined || req.body.amount === null || req.body.amount === '') return res.json({ scheduled: true });
    const amount = round2(parseFloat(req.body.amount));
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Amount must be zero or more' });
    const override = await prisma.payAdjustment.create({
      data: {
        consultantId: loan.consultantId, staffId: loan.staffId, period, kind: 'loan_instalment', amount,
        reason: amount === 0 ? 'Instalment skipped' : 'Instalment changed', loanId: loan.id, companyId,
      },
    });
    res.json(override);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});


// Delivery runs and the riders who make them.
// A rider only ever sees their own runs — every query in here is scoped by riderId for the
// rider role, the same way consultants are scoped to their own sales.
// (mirrored in server/src/routes/deliveries.js)

const delivery_STATUSES = ['Assigned', 'PickedUp', 'AtCourier', 'Delivered', 'Failed'];

// The company runs one hired bike and one rider, so "what does a delivery cost us" is simply
// the weekly hire plus the monthly wage spread over the deliveries actually made. Kept as
// settings so the figures can move without a deploy.
async function delivery_getDeliveryCostBasis(companyId) {
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
// apart. (mirrored in server/src/routes/deliveries.js)
const delivery_COURIERS = ['rider', 'yango', 'other'];
const delivery_isHiredCourier = (courier) => courier !== 'rider';

// Where the goods physically left from. If every line on the order comes out of one consultant's
// own stock then that consultant dispatched it and nobody at the warehouse touched it; anything
// drawn from main stock means it left the warehouse.
function delivery_dispatchOriginFor(items) {
  const sources = (items || []).map(i => i.stockSourceConsultantId || null);
  if (!sources.length || sources.some(s => s === null)) return null;
  const first = sources[0];
  return sources.every(s => s === first) ? first : null;
}

// Where we deliver ourselves. Anything else has to go by courier, so this one setting decides
// which flow an order takes — and hardcoding it in the screen meant the answer lived in the
// wrong place and only the screen knew it. Comma separated, because a second town we cover by
// bike should not need a code change either. (mirrored in server/src/routes/deliveries.js)
async function delivery_localDeliveryCities(companyId) {
  const row = await prisma.setting.findFirst({ where: { companyId, key: 'delivery_local_cities' } });
  const raw = (row?.value || '').trim() || 'Lusaka';
  return raw.split(',').map(c => c.trim()).filter(Boolean);
}

// A town we do not cover ourselves. No town recorded counts as out of town: somebody has to look
// at it, and treating a blank as local would quietly put it on the bike.
function delivery_isOutOfTown(city, locals) {
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

function delivery_shapeDelivery(d) {
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
// Returns a reason to refuse, or null to allow. (mirrored in server/src/routes/deliveries.js)
async function delivery_riderSignOffBlock(delivery, companyId) {
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
// splitting the two steps. (mirrored in server/src/routes/deliveries.js)
async function delivery_postRemittance(tx, delivery, companyId, riderName) {
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
async function delivery_reverseRemittance(tx, deliveryId, companyId) {
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
const delivery_SALE_DELIVERABLE_FROM = ['Confirmed', 'Shipped'];

// ---- RIDERS ----

app.get('/api/v1/deliveries/riders', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const where = { companyId: req.user.companyId };
    if (req.query.active === 'true') where.isActive = true;
    const riders = await prisma.rider.findMany({ where, orderBy: { name: 'asc' } });
    const withLogin = riders.map(r => ({ ...r, hasLogin: !!r.userId }));
    res.json(withLogin);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/deliveries/riders', authenticate, requireAdmin, async (req, res) => {
  try {
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

app.put('/api/v1/deliveries/riders/:id', authenticate, requireAdmin, async (req, res) => {
  try {
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
app.post('/api/v1/deliveries/riders/:id/login', authenticate, requireAdmin, async (req, res) => {
  try {
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
app.get('/api/v1/deliveries/my/runs', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'rider') return res.status(403).json({ error: 'Rider access required' });
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

    // Courier runs he is taking to Platinum. The parcels on a run carry no rider of their own —
    // the run names him — so the delivery lists above never found them and his page showed no
    // runs at all. A run not yet gone out is still his to take whatever day it was booked for;
    // one that has gone out belongs to the day it was booked.
    const courierRuns = await prisma.courierRun.findMany({
      where: {
        companyId, riderId: req.user.riderId,
        OR: [
          { scheduledFor: { gte: day.start, lte: day.end } },
          ...(isToday ? [{ status: 'Open' }] : []),
        ],
      },
      include: delivery_runInclude, orderBy: { scheduledFor: 'asc' },
    });

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
      open: open.map(delivery_shapeDelivery),
      courierRuns: courierRuns
        .filter(r => r.deliveries.length > 0)
        .map(r => ({ ...delivery_shapeRun(r), overdue: r.status === 'Open' && r.scheduledFor < day.start })),
      completedToday: todayDone.map(delivery_shapeDelivery),
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
app.get('/api/v1/deliveries/unassigned', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
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
    const locals = await delivery_localDeliveryCities(req.user.companyId);
    res.json(ordered.map(s => ({
      ...s,
      isReady: s.status === 'Shipped',
      isOutOfTown: delivery_isOutOfTown(s.customerCity, locals),
      amountToCollect: s.paymentStatus === 'Paid' ? 0 : Math.max(0, parseFloat(s.totalPrice) - parseFloat(s.amountPaid)),
      items: s.items.map(i => ({ name: i.product?.name || 'Product', qty: i.qty })),
    })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/deliveries', authenticate, async (req, res) => {
  try {
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
    res.json(deliveries.map(delivery_shapeDelivery));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Assign one or more orders to a rider in a single call — the screen assigns a day's run at once.
app.post('/api/v1/deliveries', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { riderId, saleIds, notes, courierRef } = req.body;
    const courier = delivery_COURIERS.includes(req.body.courier) ? req.body.courier : 'rider';
    const ids = Array.isArray(saleIds) ? saleIds : (req.body.saleId ? [req.body.saleId] : []);
    if (!ids.length) return res.status(400).json({ error: 'Select at least one order' });
    // A hired courier is not one of our riders, so the two cannot both be set.
    if (delivery_isHiredCourier(courier) && riderId) {
      return res.status(400).json({ error: 'A hired courier is not one of our riders — leave the rider blank' });
    }
    let fare = null;
    if (delivery_isHiredCourier(courier) && req.body.courierCost !== undefined && req.body.courierCost !== '') {
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
    for (const sale of sales) originBySale[sale.id] = delivery_dispatchOriginFor(sale.items);

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
    res.status(201).json(created.map(delivery_shapeDelivery));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Move a delivery along. The rider drives this from their phone; an admin can correct it.
app.put('/api/v1/deliveries/:id/status', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status, recipientName, cashCollected, failureReason, notes } = req.body;
    if (!delivery_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of ${delivery_STATUSES.join(', ')}` });

    const where = { id: req.params.id, companyId };
    if (req.user.role === 'rider') where.riderId = req.user.riderId;
    const delivery = await prisma.delivery.findFirst({ where, include: { sale: { select: { id: true, status: true, totalPrice: true, amountPaid: true, paymentStatus: true } } } });
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    // He may correct his own finished work right up until the office has acted on it.
    if (req.user.role === 'rider' && (delivery.status === 'Delivered' || delivery.status === 'Failed')) {
      const blocked = await delivery_riderSignOffBlock(delivery, companyId);
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
      if (status === 'Delivered' && delivery_SALE_DELIVERABLE_FROM.includes(delivery.sale?.status)) {
        await tx.sale.update({ where: { id: delivery.saleId }, data: { status: 'Delivered' } });
        await tx.orderStatusLog.create({ data: { saleId: delivery.saleId, fromStatus: delivery.sale.status, toStatus: 'Delivered', byUserId: req.user.id, companyId } });
      }
      if (leavingDelivered) {
        if (delivery.cashRemitted) await delivery_reverseRemittance(tx, delivery.id, companyId);
        if (delivery.sale?.status === 'Delivered') {
          await tx.sale.update({ where: { id: delivery.saleId }, data: { status: 'Shipped' } });
          await tx.orderStatusLog.create({ data: { saleId: delivery.saleId, fromStatus: 'Delivered', toStatus: 'Shipped', byUserId: req.user.id, companyId } });
        }
      }
      return tx.delivery.update({ where: { id: delivery.id }, data, include: deliveryInclude });
    }, { timeout: 20000 });
    res.json(delivery_shapeDelivery(updated));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Reassign to a different rider, or park it back in the unassigned pile.
app.put('/api/v1/deliveries/:id/rider', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, companyId } });
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    const { riderId, courierRef } = req.body;
    const courier = req.body.courier === undefined
      ? delivery.courier
      : (delivery_COURIERS.includes(req.body.courier) ? req.body.courier : delivery.courier);
    if (delivery_isHiredCourier(courier) && riderId) {
      return res.status(400).json({ error: 'A hired courier is not one of our riders — leave the rider blank' });
    }
    // The fare for a trip booked now, which belongs on the order as its delivery cost. No rider
    // credit: the office books and pays a courier directly, unlike a parcel one of ours carries
    // to a counter out of his own pocket.
    let handoverFare = null;
    if (delivery_isHiredCourier(courier) && req.body.courierCost !== undefined && req.body.courierCost !== '') {
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
      if (handoverFare !== null) await delivery_shiftSaleShippingCost(tx, delivery.saleId, companyId, handoverFare);
      return tx.delivery.update({ where: { id: delivery.id }, data: {
        riderId: delivery_isHiredCourier(courier) ? null : (riderId || null),
        courier,
        // Handing a run to somebody else is a dispatch decision of its own.
        assignedById: req.user.id,
        ...(req.body.courierRef !== undefined && { courierRef: courierRef || null }),
      }, include: deliveryInclude });
    }, { timeout: 20000 });
    res.json(delivery_shapeDelivery(updated));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Admin confirms the money reached the company. Deliberately admin-only: the rider records
// what they took, the company records what it received, and the gap is the thing worth seeing.
// Confirming is also the moment the cash becomes a payment against the order.
app.put('/api/v1/deliveries/:id/remit', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, companyId }, include: { rider: { select: { name: true } } } });
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    const remitted = req.body.cashRemitted !== false;
    if (remitted && delivery.status !== 'Delivered') {
      return res.status(400).json({ error: 'Only a completed delivery can have its cash confirmed' });
    }
    if (remitted === delivery.cashRemitted) {
      const unchanged = await prisma.delivery.findUnique({ where: { id: delivery.id }, include: deliveryInclude });
      return res.json(delivery_shapeDelivery(unchanged));
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (remitted) await delivery_postRemittance(tx, delivery, companyId, delivery.rider?.name);
      else await delivery_reverseRemittance(tx, delivery.id, companyId);
      return tx.delivery.update({
        where: { id: delivery.id },
        data: { cashRemitted: remitted, cashRemittedAt: remitted ? new Date() : null },
        include: deliveryInclude,
      });
    }, { timeout: 20000 });
    res.json(delivery_shapeDelivery(updated));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/deliveries/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, companyId } });
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    await prisma.$transaction(async (tx) => {
      // Reverse before deleting: the payment's link would otherwise be nulled and leave a
      // delivery payment on an order with no delivery behind it.
      await delivery_reverseRemittance(tx, delivery.id, companyId);
      await tx.delivery.delete({ where: { id: delivery.id } });
    }, { timeout: 20000 });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- RIDER FINANCES ----
// Mirrored from server/src/routes/deliveries.js by a transform — see that file for the
// reasoning. Generated rather than hand-copied so the two copies cannot drift.
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
const delivery_RIDER_COURIER_CATEGORIES = ['Platinum courier', 'Other courier'];

// Which of the rider's expense categories a courier run's fee is. Platinum is the only run courier
// today; any other is booked as 'Other courier'.
function delivery_runFeeCategory(courier) {
  return courier === 'Platinum' ? 'Platinum courier' : 'Other courier';
}

// Nudge an order's delivery cost by what the rider paid, never below zero.
async function delivery_shiftSaleShippingCost(tx, saleId, companyId, delta) {
  const sale = await tx.sale.findFirst({ where: { id: saleId, companyId }, select: { id: true, shippingCost: true } });
  if (!sale) return null;
  const next = Math.max(0, Math.round((parseFloat(sale.shippingCost || 0) + delta) * 100) / 100);
  await tx.sale.update({ where: { id: sale.id }, data: { shippingCost: next } });
  return next;
}

// ---- RIDER-FACING ----

app.get('/api/v1/deliveries/my/account', authenticate,  async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
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

app.get('/api/v1/deliveries/my/expenses', authenticate,  async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const expenses = await prisma.riderExpense.findMany({
      where: { riderId: req.user.riderId, companyId: req.user.companyId },
      include: { sale: { select: { orderNumber: true, customerName: true } } },
      orderBy: { date: 'desc' }, take: 100,
    });
    res.json(expenses);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/deliveries/my/expenses', authenticate,  async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
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
    // A parcel on a courier run has that courier's fee entered on the run, which credits him then.
    // Taking it here as well paid him twice for one parcel. A second leg with another courier is
    // still his to log here.
    if (saleId && delivery_RIDER_COURIER_CATEGORIES.includes(category)) {
      const onRun = await prisma.delivery.findFirst({
        where: { saleId, companyId, courierRunId: { not: null } },
        select: { courierRun: { select: { status: true, courier: true, slot: true } } },
      });
      const run = onRun?.courierRun;
      if (run && category === delivery_runFeeCategory(run.courier)) {
        return res.status(400).json({ error: run.status === 'Open'
          ? `That parcel is on the ${run.slot} ${run.courier} run — enter its fee on the run when you drop it off`
          : `That parcel went on the ${run.slot} ${run.courier} run, and its fee was recorded then` });
      }
    }
    const onSaleShipping = !!saleId && delivery_RIDER_COURIER_CATEGORIES.includes(category);
    const expense = await prisma.$transaction(async (tx) => {
      const created = await tx.riderExpense.create({
        data: {
          riderId: req.user.riderId, category, amount, description: description || null,
          saleId: saleId || null, rechargeable: !!rechargeable, onSaleShipping, companyId,
        },
      });
      if (onSaleShipping) await delivery_shiftSaleShippingCost(tx, saleId, companyId, amount);
      return created;
    }, { timeout: 20000 });
    res.status(201).json(expense);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// He can take back his own mistake, but only while the office has not yet accounted for it.
app.delete('/api/v1/deliveries/my/expenses/:id', authenticate,  async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const expense = await prisma.riderExpense.findFirst({
      where: { id: req.params.id, riderId: req.user.riderId, companyId: req.user.companyId },
    });
    if (!expense) return res.status(404).json({ error: 'Not found' });
    if (expense.settledAt) return res.status(400).json({ error: 'This has already been settled — ask an admin to correct it' });
    await prisma.$transaction(async (tx) => {
      // Taking back the expense has to take its cost off the order too, or the order keeps a
      // delivery cost nobody paid.
      if (expense.onSaleShipping && expense.saleId) {
        await delivery_shiftSaleShippingCost(tx, expense.saleId, expense.companyId, -parseFloat(expense.amount));
      }
      await tx.riderExpense.delete({ where: { id: expense.id } });
    }, { timeout: 20000 });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Today's figures, pre-filled from the records so he only has to correct what differs.
app.get('/api/v1/deliveries/my/report', authenticate,  async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
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

app.post('/api/v1/deliveries/my/report', authenticate,  async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
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

app.get('/api/v1/deliveries/my/reports', authenticate,  async (req, res) => {
  try {
    if (!requireRider(req, res)) return;
    const reports = await prisma.riderDailyReport.findMany({
      where: { riderId: req.user.riderId, companyId: req.user.companyId },
      orderBy: { date: 'desc' }, take: 30,
    });
    res.json(reports);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- ADMIN REVIEW ----

app.get('/api/v1/deliveries/expenses', authenticate, requireAdmin, async (req, res) => {
  try {
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
app.put('/api/v1/deliveries/expenses/:id', authenticate, requireAdmin, async (req, res) => {
  try {
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

app.get('/api/v1/deliveries/reports', authenticate, requireAdmin, async (req, res) => {
  try {
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

app.put('/api/v1/deliveries/reports/:id/acknowledge', authenticate, requireAdmin, async (req, res) => {
  try {
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
// (mirrored in server/src/routes/deliveries.js)
app.get('/api/v1/deliveries/riders/:id/history', authenticate, requireAdmin, async (req, res) => {
  try {
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
      day.deliveries.push(delivery_shapeDelivery(d));
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
// money arrived. (mirrored in server/src/routes/deliveries.js)

const delivery_COURIER_SLOTS = [
  { key: '09:00', label: 'Morning run', hour: 9 },
  { key: '13:00', label: 'Afternoon run', hour: 13 },
  { key: '16:00', label: 'Day-end run', hour: 16 },
];

// The instant a session falls on, for a given Lusaka date. Stored as UTC like everything else.
function delivery_runInstant(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 2, 0, 0, 0));
}

function delivery_lusakaDateString(at = new Date()) {
  return new Date(at.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

// Which session a parcel ready now would make. After the last run of the day it is tomorrow's
// first — saying so lets the warehouse tell a customer when their parcel actually leaves.
function delivery_nextSlotFrom(at = new Date()) {
  const local = new Date(at.getTime() + 2 * 3600 * 1000);
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  for (const s of delivery_COURIER_SLOTS) if (hour < s.hour) return { date: delivery_lusakaDateString(at), slot: s.key };
  const tomorrow = new Date(at.getTime() + 24 * 3600 * 1000);
  return { date: delivery_lusakaDateString(tomorrow), slot: delivery_COURIER_SLOTS[0].key };
}

const delivery_runInclude = {
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

function delivery_shapeRun(run) {
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
  const slot = delivery_COURIER_SLOTS.find(s => s.key === run.slot);
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
app.get('/api/v1/deliveries/runs', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : delivery_lusakaDateString();
    const courier = req.query.courier || 'Platinum';

    const instants = delivery_COURIER_SLOTS.map(s => delivery_runInstant(date, s.hour));
    const existing = await prisma.courierRun.findMany({
      where: { companyId, courier, scheduledFor: { in: instants } },
      include: delivery_runInclude,
    });
    const byInstant = {};
    for (const r of existing) byInstant[r.scheduledFor.toISOString()] = r;

    const sessions = delivery_COURIER_SLOTS.map((s, i) => {
      const found = byInstant[instants[i].toISOString()];
      if (found) return delivery_shapeRun(found);
      return {
        id: null, slot: s.key, slotLabel: s.label, scheduledFor: instants[i], courier,
        status: 'Open', rider: null, parcels: [], parcelCount: 0, towns: [],
        feesTotal: 0, billedTotal: 0, outstandingTotal: 0,
      };
    });

    res.json({
      date, courier, slots: delivery_COURIER_SLOTS, sessions, next: delivery_nextSlotFrom(),
      // So the screen can say what it is treating as local rather than assuming.
      localCities: await delivery_localDeliveryCities(companyId),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Put prepared parcels on a session. Creates the run if that session has none yet.
app.post('/api/v1/deliveries/runs/parcels', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { saleIds, riderId, notes } = req.body;
    const courier = req.body.courier || 'Platinum';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : delivery_lusakaDateString();
    const slot = delivery_COURIER_SLOTS.find(s => s.key === req.body.slot);
    if (!slot) return res.status(400).json({ error: `Slot must be one of ${delivery_COURIER_SLOTS.map(s => s.key).join(', ')}` });

    const ids = Array.isArray(saleIds) ? saleIds : (req.body.saleId ? [req.body.saleId] : []);
    if (!ids.length) return res.status(400).json({ error: 'Select at least one order' });

    const sales = await prisma.sale.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true, items: { select: { stockSourceConsultantId: true } } },
    });
    if (sales.length !== ids.length) return res.status(400).json({ error: 'One or more orders were not found' });
    const already = await prisma.delivery.findMany({ where: { saleId: { in: ids } }, select: { saleId: true } });
    if (already.length) return res.status(400).json({ error: `${already.length} of those orders are already on a run or out for delivery` });

    const scheduledFor = delivery_runInstant(date, slot.hour);
    const run = await prisma.courierRun.upsert({
      where: { companyId_scheduledFor_courier: { companyId, scheduledFor, courier } },
      update: { ...(riderId !== undefined && { riderId: riderId || null }), ...(notes !== undefined && { notes: notes || null }) },
      create: { slot: slot.key, scheduledFor, courier, riderId: riderId || null, notes: notes || null, companyId },
    });
    if (run.status !== 'Open') return res.status(400).json({ error: 'That run has already gone out — put these on the next session' });

    const originBySale = {};
    for (const sale of sales) originBySale[sale.id] = delivery_dispatchOriginFor(sale.items);

    await prisma.delivery.createMany({
      data: ids.map(saleId => ({
        saleId, courierRunId: run.id, courier: 'other', courierRef: courier,
        riderId: null, dispatchedFromConsultantId: originBySale[saleId] || null,
        assignedById: req.user.id, companyId,
      })),
    });

    const full = await prisma.courierRun.findUnique({ where: { id: run.id }, include: delivery_runInclude });
    res.status(201).json(delivery_shapeRun(full));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Take a parcel back off a run, while it is still open.
app.delete('/api/v1/deliveries/runs/:id/parcels/:deliveryId', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const run = await prisma.courierRun.findFirst({ where: { id: req.params.id, companyId } });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'Open') return res.status(400).json({ error: 'That run has already gone out' });
    const parcel = await prisma.delivery.findFirst({ where: { id: req.params.deliveryId, courierRunId: run.id, companyId } });
    if (!parcel) return res.status(404).json({ error: 'That parcel is not on this run' });
    await prisma.delivery.delete({ where: { id: parcel.id } });
    const full = await prisma.courierRun.findUnique({ where: { id: run.id }, include: delivery_runInclude });
    res.json(delivery_shapeRun(full));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// The run went out. Each parcel carries what Platinum charged for it and the receipt number that
// becomes the customer's proof of dispatch — and the fee both lands on the order and credits the
// rider who paid it.
app.put('/api/v1/deliveries/runs/:id/dispatch', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const run = await prisma.courierRun.findFirst({
      where: { id: req.params.id, companyId },
      include: { deliveries: { select: { id: true, saleId: true } } },
    });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    // The rider taking the run holds the receipts and paid the fees, so he can record it going out
    // himself — his own run only. Everyone else outside the office and warehouse is refused.
    const isOffice = ['admin', 'superadmin', 'inventory'].includes(req.user.role);
    const isItsRider = req.user.role === 'rider' && !!req.user.riderId && run.riderId === req.user.riderId;
    if (!isOffice && !isItsRider) {
      return res.status(403).json({ error: req.user.role === 'rider' ? 'That run is not yours' : 'Admin or inventory access required' });
    }
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

    // A fee the rider already logged for one of these parcels under his own money has credited him
    // once; taking it again here would pay him twice. The fee goes in one place, so say where.
    const charged = Object.entries(byDelivery).filter(([, e]) => e.fee > 0).map(([id]) => run.deliveries.find(d => d.id === id).saleId);
    if (charged.length && run.riderId) {
      const already = await prisma.riderExpense.findFirst({
        where: { companyId, riderId: run.riderId, saleId: { in: charged }, category: delivery_runFeeCategory(run.courier) },
        select: { amount: true, sale: { select: { orderNumber: true } } },
      });
      if (already) {
        return res.status(400).json({ error: `${already.sale?.orderNumber || 'One parcel'} already has a courier fee of K${parseFloat(already.amount)} logged under the rider's money — leave its fee blank here` });
      }
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
          await delivery_shiftSaleShippingCost(tx, d.saleId, companyId, entry.fee);
          // The rider paid it, so the company owes him — the same credit any courier drop earns.
          if (run.riderId) {
            await tx.riderExpense.create({
              data: {
                riderId: run.riderId, category: delivery_runFeeCategory(run.courier), amount: entry.fee,
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

    const full = await prisma.courierRun.findUnique({ where: { id: run.id }, include: delivery_runInclude });
    res.json(delivery_shapeRun(full));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Dispatched and not yet paid for. This is a receivables queue, not a logistics one: the customer
// has the receipt and owes the money, and nothing else in the system was watching for it.
app.get('/api/v1/deliveries/awaiting-payment', authenticate,  async (req, res) => {
  try {
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
app.put('/api/v1/deliveries/:id/payment-received', authenticate, requireAdminOrInventory, async (req, res) => {
  try {
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

    res.json(delivery_shapeDelivery(updated));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- WHO DID WHAT ----

// One feed of the things people do to orders, so an admin can see the warehouse working without
// asking. Built from three sources rather than a separate audit table: the status log already
// records every transition, a delivery already knows when it was assigned, and a sale already
// knows when it was keyed in — all three now name the person responsible.
//
// Rows from before actions were attributed carry no user. They are shown rather than hidden,
// because a gap in the record is itself worth seeing. (mirrored in server/src/routes/deliveries.js)
app.get('/api/v1/deliveries/activity', authenticate, requireAdmin, async (req, res) => {
  try {
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
app.get('/api/v1/deliveries/finances', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const to = req.query.to ? new Date(req.query.to + 'T23:59:59.999Z') : new Date();
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00.000Z')
                                : new Date(to.getTime() - 29 * 86400000);
    const days = Math.max(1, Math.round((to - from) / 86400000) + 1);

    const basis = await delivery_getDeliveryCostBasis(companyId);
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

    // Each courier run dispatched is a ride to Platinum on our bike, however many parcels it
    // carried. Nobody is billed for that ride, but it is a delivery the bike did that we would
    // otherwise pay a courier for, so it is credited at the courier fee. (There is one bike and
    // one rider; a run with no rider recorded is still his.)
    const courierTrips = await prisma.courierRun.count({
      where: { companyId, status: 'Dispatched', dispatchedAt: { gte: from, lte: to } },
    });
    const tripValue = basis.feeCharged;
    const tripCredit = round2(courierTrips * tripValue);
    const jobs = count + courierTrips;

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
      courierTrips: { count: courierTrips, value: tripValue, credit: tripCredit },
      // Drops plus courier trips: everything the bike and the couriers did for us.
      jobs,
      perDay: round2(jobs / days),
      cost: {
        riderMonthly, bikeMonthly, fixedMonthly, fixedInWindow,
        riderPaidFromPayroll: staff.length > 0,
        laidOutByRider: laidOut, recoveredFromCustomers: recovered, borneByCompany: borne,
        hiredCourierFares: hiredFares,
        total: totalCost,
        perDelivery: jobs ? round2(totalCost / jobs) : null,
        byCategory: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount })),
        // The question the warehouse asks every time the rider is swamped: send him, or book a car?
          courierSplit: {
          own: {
            drops: ownDrops.length,
            courierTrips,
              // The fixed cost is the bike and the wage, and it is carried whether he does one drop
              // or twenty, so it all lands on the drops and courier trips he actually made.
            cost: round2(fixedInWindow + borne),
            costPerDrop: ownDrops.length + courierTrips ? round2((fixedInWindow + borne) / (ownDrops.length + courierTrips)) : null,
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
      // What the bike earned us, counting its courier trips; cashNet is the money alone.
      net: round2(feesBilled + tripCredit - totalCost),
      cashNet: round2(feesBilled - totalCost),
      dispatchedFrom: Object.entries(byOrigin)
        .filter(([, n]) => n > 0)
        .map(([where, drops]) => ({ where, drops }))
        .sort((a, b) => b.drops - a.drops),
      // The benchmark that started all this: what a courier charged per drop.
      courierFee: basis.feeCharged,
      breakEvenPerDay: basis.feeCharged > 0 ? round2(fixedMonthly / basis.feeCharged / 30.44) : null,
      breakEvenPerMonth: basis.feeCharged > 0 ? round2(fixedMonthly / basis.feeCharged) : null,
      savingVsCourier: round2((basis.feeCharged * jobs) - totalCost),
      riderAccounts: accounts,
      outstanding: {
        awaitingRechargeCount: awaitingRecharge._count,
        awaitingRechargeAmount: round2(parseFloat(awaitingRecharge._sum.amount || 0)),
      },
      categories: RIDER_EXPENSE_CATEGORIES,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PERFORMANCE ----

// Per-rider performance over a window, plus the one number that says whether running a bike
// beats paying couriers: deliveries per working day against the break-even.
app.get('/api/v1/deliveries/performance', authenticate, requireAdmin, async (req, res) => {
  try {
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
      delivery_getDeliveryCostBasis(companyId),
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

module.exports = app;
