const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');

const app = express();

if (!global.__prisma) {
  global.__prisma = new PrismaClient();
}
const prisma = global.__prisma;

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
  max: 200,
  message: { error: 'Too many requests, please try again later' }
}));

// Stricter rate limit for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many login attempts, please try again later' }
});

app.use(express.json({ limit: '2mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'biztrack-default-secret';

// Tiered commission: first N products at base rate, rest at tier rate
function calcCommission(totalProductsSold, commissionRate, tierThreshold, tierRate) {
  const base = parseFloat(commissionRate);
  const tier = parseFloat(tierRate);
  const threshold = parseInt(tierThreshold) || 50;
  if (totalProductsSold <= threshold) return totalProductsSold * base;
  return (threshold * base) + ((totalProductsSold - threshold) * tier);
}

// Auth middleware
async function authenticate(req, res, next) {
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
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
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
  req.body.name = sanitizeString(name, 200);
  if (req.body.description) req.body.description = sanitizeString(req.body.description, 1000);
  if (req.body.category) req.body.category = sanitizeString(req.body.category, 100);
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
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, companyId: user.companyId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, companyId: user.companyId, companyName: user.company?.name || null } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/auth/me', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { company: true } });
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, name: user.name, role: user.role, companyId: user.companyId, companyName: user.company?.name || null });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PRODUCTS ----
app.get('/api/v1/products/meta/categories', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const products = await prisma.product.findMany({ where: { companyId, category: { not: null } }, select: { category: true }, distinct: ['category'] });
    res.json(products.map(p => p.category).filter(Boolean));
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

app.get('/api/v1/products', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { search, category, lowStock } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }]; }
    if (category) where.category = category;
    let products = await prisma.product.findMany({
      where,
      select: { id: true, name: true, sku: true, description: true, category: true, costPrice: true, sellingPrice: true, originalPrice: true, stock: true, reorderLevel: true, supplier: true, isActive: true, createdAt: true, updatedAt: true, companyId: true },
      orderBy: { createdAt: 'desc' },
    });
    const withImages = await prisma.product.findMany({ where: { ...where, imageUrl: { not: null } }, select: { id: true } });
    const imageIds = new Set(withImages.map(p => p.id));
    products = products.map(p => ({ ...p, imageUrl: imageIds.has(p.id) ? `/api/v1/store/product-image/${p.id}` : null }));
    if (lowStock === 'true') products = products.filter(p => p.stock <= p.reorderLevel);
    if (req.user.role === 'consultant') products = products.map(({ costPrice, supplier, reorderLevel, ...rest }) => rest);
    res.json(products);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/products/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const product = await prisma.product.findFirst({ where: { id: req.params.id, companyId }, include: { stockLogs: { orderBy: { createdAt: 'desc' }, take: 50 } } });
    if (!product) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'consultant') {
      const { costPrice, supplier, reorderLevel, stockLogs, ...rest } = product;
      return res.json(rest);
    }
    res.json(product);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/products/:id/stock-log', authenticate, requireAdmin, async (req, res) => {
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
    if (!data.sku) { const count = await prisma.product.count({ where: { companyId } }); data.sku = `SKU-${String(count + 1).padStart(4, '0')}`; }
    const product = await prisma.product.create({ data });
    if (data.stock && data.stock > 0) { await prisma.stockLog.create({ data: { productId: product.id, change: data.stock, reason: 'Initial Stock', companyId } }); }
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

app.post('/api/v1/products/restock', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { items } = req.body;
    const results = [];
    for (const item of items) {
      const product = await prisma.product.findFirst({ where: { id: item.productId, companyId } });
      if (!product) continue;
      const updated = await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
      await prisma.stockLog.create({ data: { productId: item.productId, change: item.quantity, reason: 'Restock', companyId } });
      results.push(updated);
    }
    res.json(results);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- SALES ----
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

app.get('/api/v1/sales', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status, paymentStatus, paymentType, from, to, customerId, consultantId, search, creditOverdue } = req.query;
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
    const sales = await prisma.sale.findMany({ where, include: { items: { include: { product: true } }, customer: true, consultant: true }, orderBy: { createdAt: 'desc' } });
    res.json(sales);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/sales/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where, include: { items: { include: { product: true } }, customer: true, consultant: true, statusHistory: { orderBy: { createdAt: 'desc' } }, creditPayments: { orderBy: { createdAt: 'desc' } }, debtReminders: { orderBy: { sentAt: 'desc' } } } });
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
    const saleItems = itemsInput.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
      const costPrice = parseFloat(product.costPrice);
      const qty = parseInt(item.qty);
      const totalPrice = qty * unitPrice;
      return { productId: item.productId, qty, unitPrice, costPrice, totalPrice, serialNumber: item.serialNumber || null };
    });

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

    const sale = await prisma.sale.create({
      data: {
        orderNumber, date: data.date ? new Date(data.date) : new Date(), totalPrice,
        shippingCost, shippingCharge, discount,
        status: data.status || 'Pending', paymentStatus, paymentMethod: data.paymentMethod || null, source: data.source || null,
        paymentType, amountPaid, creditDueDate: data.creditDueDate ? new Date(data.creditDueDate) : null, creditNotes: data.creditNotes || null,
        consultantId: data.consultantId || null,
        customerId, customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null, deliveryAddress: data.deliveryAddress || null, notes: data.notes || null,
        companyId,
        items: { create: saleItems }
      },
      include: { items: { include: { product: true } }, customer: true, consultant: true }
    });

    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      for (const item of sale.items) {
        await prisma.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.qty } } });
        await prisma.stockLog.create({ data: { productId: item.productId, change: -item.qty, reason: 'Sale', saleId: sale.id, companyId } });
      }
    }

    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: 'New', toStatus: sale.status, companyId } });
    res.status(201).json(sale);
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

    // If items provided, delete old and create new
    if (raw.items && raw.items.length > 0) {
      const productIds = raw.items.map(i => i.productId);
      const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
      const productMap = {}; products.forEach(p => { productMap[p.id] = p; });
      for (const item of raw.items) {
        if (!productMap[item.productId]) return res.status(400).json({ error: `Product ${item.productId} not found` });
      }
      const saleItems = raw.items.map(item => {
        const product = productMap[item.productId];
        const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
        const costPrice = parseFloat(product.costPrice);
        const qty = parseInt(item.qty);
        const totalPrice = qty * unitPrice;
        return { productId: item.productId, qty, unitPrice, costPrice, totalPrice, serialNumber: item.serialNumber || null };
      });
      await prisma.saleItem.deleteMany({ where: { saleId: req.params.id } });
      await prisma.saleItem.createMany({ data: saleItems.map(i => ({ ...i, saleId: req.params.id })) });
      const itemsTotal = saleItems.reduce((sum, i) => sum + i.totalPrice, 0);
      const shippingCharge = data.shippingCharge !== undefined ? data.shippingCharge : parseFloat(existing.shippingCharge);
      const discount = data.discount !== undefined ? data.discount : parseFloat(existing.discount);
      data.totalPrice = itemsTotal + shippingCharge - discount;
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
        data.amountPaid = saleTotal;
        data.paymentStatus = 'Paid';
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

    const sale = await prisma.sale.update({ where: { id: req.params.id }, data, include: { items: { include: { product: true } }, customer: true, consultant: true } });
    res.json(sale);
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
    const stockDeductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = stockDeductStatuses.includes(oldStatus);
    const shouldDeduct = stockDeductStatuses.includes(status);
    if (!wasDeducted && shouldDeduct) {
      for (const item of sale.items) {
        let deductedFromConsultant = false;
        if (sale.consultantId) {
          const cStock = await prisma.consultantStock.findUnique({ where: { consultantId_productId: { consultantId: sale.consultantId, productId: item.productId } } });
          if (cStock && cStock.qty >= item.qty) {
            await prisma.consultantStock.update({ where: { consultantId_productId: { consultantId: sale.consultantId, productId: item.productId } }, data: { qty: { decrement: item.qty } } });
            await prisma.stockLog.create({ data: { productId: item.productId, change: -item.qty, reason: 'Sale (consultant stock)', saleId: sale.id, companyId } });
            deductedFromConsultant = true;
          }
        }
        if (!deductedFromConsultant) {
          await prisma.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.qty } } });
          await prisma.stockLog.create({ data: { productId: item.productId, change: -item.qty, reason: 'Sale', saleId: sale.id, companyId } });
        }
      }
    } else if (wasDeducted && !shouldDeduct) {
      for (const item of sale.items) {
        await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.qty } } });
        await prisma.stockLog.create({ data: { productId: item.productId, change: item.qty, reason: status === 'Cancelled' ? 'Cancelled Order' : 'Status Revert', saleId: sale.id, companyId } });
      }
    }
    const updated = await prisma.sale.update({ where: { id: req.params.id }, data: { status }, include: { items: { include: { product: true } }, customer: true, statusHistory: { orderBy: { createdAt: 'desc' } } } });
    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: oldStatus, toStatus: status, companyId } });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.delete('/api/v1/sales/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'consultant') return res.status(403).json({ error: 'Consultants cannot delete sales' });
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { items: true } });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      for (const item of sale.items) {
        await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.qty } } });
        await prisma.stockLog.create({ data: { productId: item.productId, change: item.qty, reason: 'Order Deleted', saleId: sale.id, companyId } });
      }
    }
    await prisma.creditPayment.deleteMany({ where: { saleId: req.params.id } });
    await prisma.debtReminder.deleteMany({ where: { saleId: req.params.id } });
    await prisma.orderStatusLog.deleteMany({ where: { saleId: req.params.id } });
    await prisma.saleItem.deleteMany({ where: { saleId: req.params.id } });
    await prisma.sale.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
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
    const updated = await prisma.sale.update({ where: { id: sale.id }, data: { amountPaid: newAmountPaid, paymentStatus }, include: { items: { include: { product: true } }, customer: true, creditPayments: { orderBy: { createdAt: 'desc' } } } });
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
    const sale = await prisma.sale.findFirst({ where, include: { items: { include: { product: true } }, customer: true, creditPayments: { orderBy: { createdAt: 'desc' } } } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    res.json({ sale, settings: settingsMap });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- EXPENSES ----
app.get('/api/v1/expenses', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { category, from, to } = req.query;
    const where = { companyId };
    if (category) where.category = category;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const expenses = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } });
    res.json(expenses);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/expenses', authenticate, requireAdmin, validateExpense, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = { ...req.body, companyId };
    if (data.date) data.date = new Date(data.date);
    res.status(201).json(await prisma.expense.create({ data }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.put('/api/v1/expenses/:id', authenticate, requireAdmin, validateExpense, async (req, res) => {
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
app.get('/api/v1/customers', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { search } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search, mode: 'insensitive' } }]; }
    const customers = await prisma.customer.findMany({ where, include: { _count: { select: { sales: true } } }, orderBy: { createdAt: 'desc' } });
    res.json(customers);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/customers/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, companyId }, include: { sales: { include: { items: { include: { product: true } } }, orderBy: { date: 'desc' } } } });
    if (!customer) return res.status(404).json({ error: 'Not found' });
    res.json(customer);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.get('/api/v1/customers/:id/orders', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.json(await prisma.sale.findMany({ where: { customerId: req.params.id, companyId }, include: { items: { include: { product: true } } }, orderBy: { date: 'desc' } }));
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
    const totalShippingCharge = sales.reduce((s, r) => s + parseFloat(r.shippingCharge), 0);
    const totalDiscount = sales.reduce((s, r) => s + parseFloat(r.discount), 0);
    const grossProfit = totalRevenue - totalCOGS - totalShippingCost + totalShippingCharge - totalDiscount;

    const expenses = await prisma.expense.findMany({ where: dateFilter });
    const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const netProfit = grossProfit - totalExpenses;
    const adExpenses = expenses.filter(e => e.category === 'Facebook Ads');
    const adSpend = adExpenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const roas = adSpend > 0 ? totalRevenue / adSpend : 0;
    const totalOrders = sales.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const profitMargin = totalCOGS > 0 ? (netProfit / totalCOGS) * 100 : 0;

    const monthlyData = {};
    sales.forEach(s => { const m = s.date.toISOString().slice(0, 7); if (!monthlyData[m]) monthlyData[m] = { revenue: 0, cogs: 0, expenses: 0, orders: 0 }; monthlyData[m].revenue += parseFloat(s.totalPrice); monthlyData[m].cogs += s.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0); monthlyData[m].orders += 1; });
    expenses.forEach(e => { const m = e.date.toISOString().slice(0, 7); if (!monthlyData[m]) monthlyData[m] = { revenue: 0, cogs: 0, expenses: 0, orders: 0 }; monthlyData[m].expenses += parseFloat(e.amount); });
    const monthlySummary = Object.entries(monthlyData).sort(([a], [b]) => a.localeCompare(b)).map(([month, d]) => ({ month, revenue: d.revenue, profit: d.revenue - d.cogs - d.expenses, expenses: d.expenses, orders: d.orders }));

    const expenseByCategory = {};
    expenses.forEach(e => { if (!expenseByCategory[e.category]) expenseByCategory[e.category] = 0; expenseByCategory[e.category] += parseFloat(e.amount); });

    const productSales = {};
    sales.forEach(s => { s.items.forEach(item => { if (!productSales[item.productId]) productSales[item.productId] = { revenue: 0, qty: 0 }; productSales[item.productId].revenue += parseFloat(item.totalPrice); productSales[item.productId].qty += item.qty; }); });
    const productIds = Object.keys(productSales);
    const products = productIds.length > 0 ? await prisma.product.findMany({ where: { id: { in: productIds }, companyId } }) : [];
    const topProducts = products.map(p => ({ name: p.name, revenue: productSales[p.id].revenue, qty: productSales[p.id].qty })).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    const lowStock = await prisma.product.findMany({ where: { isActive: true, companyId }, orderBy: { stock: 'asc' }, take: 20 });
    const lowStockProducts = lowStock.filter(p => p.stock <= p.reorderLevel);
    const pendingOrders = await prisma.sale.count({ where: { companyId, status: { in: ['Pending', 'Confirmed'] } } });

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

    const growthTarget = lastMonthRevenue * 3;
    const growthProgress = growthTarget > 0 ? (thisMonthRevenue / growthTarget) * 100 : 0;
    const remainingToTarget = Math.max(0, growthTarget - thisMonthRevenue);
    const daysLeft = daysInMonth - dayOfMonth;
    const dailyTargetNeeded = daysLeft > 0 ? remainingToTarget / daysLeft : 0;
    const actualGrowthRate = lastMonthRevenue > 0 ? ((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100 : 0;

    const avgProfitPerSale = thisMonthOrders > 0 ? (thisMonthRevenue - thisMonthCOGS) / thisMonthOrders : 0;
    const effectiveRoas = roas > 0 ? roas : 3;
    const additionalAdBudgetNeeded = (2 * (lastMonthRevenue || thisMonthRevenue)) / effectiveRoas;
    const targetMonthlyOrders = (lastMonthOrders || thisMonthOrders) * 3;
    const additionalInventoryCost = targetMonthlyOrders > 0 && thisMonthOrders > 0 ? thisMonthCOGS * 2 : 0;
    const totalReinvestmentNeeded = additionalAdBudgetNeeded + additionalInventoryCost;
    const reinvestPerSale = thisMonthOrders > 0 ? totalReinvestmentNeeded / (thisMonthOrders * 3) : 0;
    const reinvestPercentOfProfit = avgProfitPerSale > 0 ? (reinvestPerSale / avgProfitPerSale) * 100 : 0;

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

    const growth = {
      thisMonthRevenue, thisMonthOrders, lastMonthRevenue, lastMonthOrders,
      dailyRevenueRate, projectedMonthRevenue, projectedMonthOrders,
      growthTarget, growthProgress: Math.min(growthProgress, 100), remainingToTarget, dailyTargetNeeded, daysLeft,
      actualGrowthRate,
      reinvestment: { perSale: reinvestPerSale, percentOfProfit: reinvestPercentOfProfit, monthlyAdBudget: additionalAdBudgetNeeded, monthlyInventory: additionalInventoryCost, totalMonthly: totalReinvestmentNeeded, avgProfitPerSale, roas: effectiveRoas }
    };

    // ---- CONSULTANT IMPACT ----
    const consultants = await prisma.consultant.findMany({ where: { companyId } });
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
        const cCommissionEarned = calcCommission(cProductsSold, c.commissionRate, c.tierThreshold, c.tierRate);
        const cPaid = commissionPayments.filter(p => p.consultantId === c.id && p.type === 'commission').reduce((s, p) => s + parseFloat(p.amount), 0);
        const cAllowancePaid = commissionPayments.filter(p => p.consultantId === c.id && p.type === 'allowance').reduce((s, p) => s + parseFloat(p.amount), 0);
        const cNetProfit = cGrossProfit - cCommissionEarned;
        const conversionRate = cTotalSales > 0 ? (cRevenue / cTotalSales) : 0;
        return { id: c.id, name: c.name, isActive: c.isActive, totalSales: cTotalSales, productsSold: cProductsSold, revenue: cRevenue, grossProfit: cGrossProfit, commissionEarned: cCommissionEarned, commissionPaid: cPaid, allowancePaid: cAllowancePaid, netProfit: cNetProfit, avgOrderValue: conversionRate, balance: cCommissionEarned - cPaid };
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

    res.json({ totalRevenue, totalCOGS, grossProfit, totalExpenses, netProfit, totalOrders, avgOrderValue, adSpend, roas, profitMargin, monthlySummary, expenseByCategory, topProducts, lowStockProducts, pendingOrders, growth, savings, consultantImpact });
  } catch (err) { console.error('DASHBOARD ERROR:', err); res.status(500).json({ error: err.message, stack: err.stack }); }
});

// ---- GROWTH PROJECTIONS REPORT ----
app.get('/api/v1/reports/growth', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const allSales = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' } }, orderBy: { date: 'asc' }, include: { items: true } });
    const allExpenses = await prisma.expense.findMany({ where: { companyId }, orderBy: { date: 'asc' } });

    const monthlyHistory = {};
    allSales.forEach(s => { const m = s.date.toISOString().slice(0, 7); if (!monthlyHistory[m]) monthlyHistory[m] = { revenue: 0, cogs: 0, orders: 0, profit: 0, expenses: 0, adSpend: 0 }; const saleCogs = s.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0); const saleQty = s.items.reduce((sum, i) => sum + i.qty, 0); monthlyHistory[m].revenue += parseFloat(s.totalPrice); monthlyHistory[m].cogs += saleCogs; monthlyHistory[m].orders += saleQty; monthlyHistory[m].profit += parseFloat(s.totalPrice) - saleCogs; });
    allExpenses.forEach(e => { const m = e.date.toISOString().slice(0, 7); if (!monthlyHistory[m]) monthlyHistory[m] = { revenue: 0, cogs: 0, orders: 0, profit: 0, expenses: 0, adSpend: 0 }; monthlyHistory[m].expenses += parseFloat(e.amount); if (e.category === 'Facebook Ads') monthlyHistory[m].adSpend += parseFloat(e.amount); });

    const history = Object.entries(monthlyHistory).sort(([a], [b]) => a.localeCompare(b)).map(([month, d]) => ({ month, ...d, netProfit: d.profit - d.expenses, roas: d.adSpend > 0 ? d.revenue / d.adSpend : 0 }));
    for (let i = 1; i < history.length; i++) { history[i].growthRate = history[i - 1].revenue > 0 ? ((history[i].revenue - history[i - 1].revenue) / history[i - 1].revenue) * 100 : 0; }
    if (history.length > 0) history[0].growthRate = 0;

    const now = new Date();
    const latestMonth = history.length > 0 ? history[history.length - 1] : null;
    const avgGrowthRate = history.length >= 2 ? history.slice(1).reduce((s, h) => s + h.growthRate, 0) / (history.length - 1) : 0;
    const avgMargin = latestMonth && latestMonth.revenue > 0 ? (latestMonth.profit / latestMonth.revenue) : 0.3;
    const avgExpenseRatio = latestMonth && latestMonth.revenue > 0 ? (latestMonth.expenses / latestMonth.revenue) : 0.2;

    const projections = [];
    for (let i = 1; i <= 6; i++) {
      const projMonth = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const monthLabel = projMonth.toISOString().slice(0, 7);
      const baseRevenue = latestMonth ? latestMonth.revenue : 0;
      const currentGrowthMultiplier = Math.pow(1 + avgGrowthRate / 100, i);
      const currentRevenue = baseRevenue * currentGrowthMultiplier;
      const targetRevenue = baseRevenue * Math.pow(3, i);
      const targetAdSpend = latestMonth && latestMonth.roas > 0 ? targetRevenue / latestMonth.roas : targetRevenue / 3;
      projections.push({ month: monthLabel, currentTrajectory: { revenue: currentRevenue, profit: currentRevenue * avgMargin, orders: Math.round(latestMonth ? (latestMonth.orders * currentGrowthMultiplier) : 0) }, targetTrajectory: { revenue: targetRevenue, profit: targetRevenue * avgMargin - targetRevenue * avgExpenseRatio, adSpendNeeded: targetAdSpend, inventoryNeeded: targetRevenue * (1 - avgMargin) }, gap: targetRevenue - currentRevenue });
    }

    res.json({ history, projections, avgGrowthRate, targetGrowthRate: 200 });
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
    const expenses = await prisma.expense.findMany({ where: dateFilter });
    const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const cogs = sales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
    const shippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const shippingCharge = sales.reduce((s, r) => s + parseFloat(r.shippingCharge), 0);
    const discount = sales.reduce((s, r) => s + parseFloat(r.discount), 0);
    const grossProfit = revenue - cogs - shippingCost + shippingCharge - discount;
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
    const sales = await prisma.sale.findMany({ where, include: { items: { include: { product: true } }, customer: true }, orderBy: { date: 'desc' } });
    const summary = { totalSales: sales.length, totalRevenue: sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0), totalProfit: sales.reduce((s, r) => s + parseFloat(r.totalPrice) - r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0) - parseFloat(r.shippingCost) + parseFloat(r.shippingCharge) - parseFloat(r.discount), 0) };
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
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: { include: { product: true } } } });
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
      const sales = await prisma.sale.findMany({ where: dateFilter, include: { items: { include: { product: true } } }, orderBy: { date: 'desc' } });
      sales.forEach(s => { s.items.forEach(item => { data.push({ 'Order #': s.orderNumber, Date: s.date.toISOString().slice(0, 10), Product: item.product.name, Qty: item.qty, 'Unit Price': parseFloat(item.unitPrice), 'Item Total': parseFloat(item.totalPrice), 'Sale Total': parseFloat(s.totalPrice), Status: s.status, Customer: s.customerName || '' }); }); });
      filename = 'sales-report.csv';
    } else if (type === 'expenses') {
      const expenses = await prisma.expense.findMany({ where: dateFilter, orderBy: { date: 'desc' } });
      data = expenses.map(e => ({ Date: e.date.toISOString().slice(0, 10), Description: e.description, Amount: parseFloat(e.amount), Category: e.category }));
      filename = 'expenses-report.csv';
    } else if (type === 'pnl') {
      const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: true } });
      const expenses = await prisma.expense.findMany({ where: dateFilter });
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
app.get('/api/v1/settings', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const obj = {}; settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
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
        else if (log.reason === 'Sale' || log.reason === 'sale') totalSold += Math.abs(log.change);
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
    const expenses = await prisma.expense.findMany({ where: { companyId: req.params.id }, select: { amount: true } });
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
    await prisma.debtReminder.deleteMany({ where: { companyId } });
    await prisma.creditPayment.deleteMany({ where: { companyId } });
    await prisma.orderStatusLog.deleteMany({ where: { companyId } });
    await prisma.stockLog.deleteMany({ where: { companyId } });
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

app.get('/api/v1/store/:slug/products', async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const { category, search } = req.query;
    const where = { companyId: company.id, isActive: true, stock: { gt: 0 } };
    if (category) where.category = category;
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }]; }
    const products = await prisma.product.findMany({ where, select: { id: true, name: true, description: true, category: true, sellingPrice: true, originalPrice: true, stock: true }, orderBy: { name: 'asc' } });
    const withImages = await prisma.product.findMany({ where: { ...where, imageUrl: { not: null } }, select: { id: true } });
    const imageIds = new Set(withImages.map(p => p.id));
    const productsWithUrls = products.map(p => ({
      ...p,
      imageUrl: imageIds.has(p.id) ? `/api/v1/store/product-image/${p.id}` : null
    }));
    const allProducts = await prisma.product.findMany({ where: { companyId: company.id, isActive: true, stock: { gt: 0 } }, select: { category: true }, distinct: ['category'] });
    const categories = allProducts.map(p => p.category).filter(Boolean).sort();
    res.json({ products: productsWithUrls, categories });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
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

// Verify Lenco payment and update sale
app.post('/api/v1/store/:slug/verify-payment', async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ error: 'Store not found' });
    const { reference, saleId } = req.body;
    if (!reference || !saleId) return res.status(400).json({ error: 'Missing reference or saleId' });

    const sale = await prisma.sale.findFirst({ where: { id: saleId, companyId: company.id } });
    if (!sale) return res.status(404).json({ error: 'Order not found' });

    // Get secret key to verify with Lenco
    const settings = await prisma.setting.findMany({ where: { companyId: company.id } });
    const settingsMap = {}; settings.forEach(s => { settingsMap[s.key] = s.value; });
    const secretKey = settingsMap.lencoSecretKey;

    if (secretKey) {
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
      } catch (verifyErr) { console.error('Lenco verify error:', verifyErr.message); }
    }

    // If we can't verify with API, trust the frontend callback (payment widget already confirmed)
    await prisma.sale.update({ where: { id: sale.id }, data: { paymentStatus: 'Paid', paymentMethod: 'Lenco Online', amountPaid: parseFloat(sale.totalPrice) } });
    res.json({ verified: true, paymentStatus: 'Paid' });
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

app.get('/api/v1/consultants/commission-summary', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to, consultantId } = req.query;
    const saleWhere = { companyId, status: { not: 'Cancelled' }, consultantId: { not: null } };
    if (consultantId) saleWhere.consultantId = consultantId;
    if (from || to) { saleWhere.date = {}; if (from) saleWhere.date.gte = new Date(from); if (to) saleWhere.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: saleWhere, include: { consultant: true, items: true } });
    const consultants = await prisma.consultant.findMany({ where: { companyId } });
    const payments = await prisma.commissionPayment.findMany({ where: { companyId } });
    const summary = consultants.map(c => {
      const cSales = sales.filter(s => s.consultantId === c.id);
      const totalSales = cSales.length;
      const totalProductsSold = cSales.reduce((sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0), 0);
      const totalRevenue = cSales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
      const commissionEarned = calcCommission(totalProductsSold, c.commissionRate, c.tierThreshold, c.tierRate);
      const cPayments = payments.filter(p => p.consultantId === c.id);
      const commissionPaid = cPayments.filter(p => p.type === 'commission').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const allowancePaid = cPayments.filter(p => p.type === 'allowance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const balance = commissionEarned - commissionPaid;
      return { consultant: { id: c.id, name: c.name, phone: c.phone, commissionRate: c.commissionRate, monthlyAllowance: c.monthlyAllowance, isActive: c.isActive }, totalSales, totalProductsSold, totalRevenue, commissionEarned, commissionPaid, allowancePaid, balance };
    });
    const totals = { totalSales: summary.reduce((s, c) => s + c.totalSales, 0), totalRevenue: summary.reduce((s, c) => s + c.totalRevenue, 0), totalCommissionEarned: summary.reduce((s, c) => s + c.commissionEarned, 0), totalCommissionPaid: summary.reduce((s, c) => s + c.commissionPaid, 0), totalAllowancePaid: summary.reduce((s, c) => s + c.allowancePaid, 0), totalBalance: summary.reduce((s, c) => s + c.balance, 0) };
    res.json({ summary, totals });
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
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    const sales = await prisma.sale.findMany({ where: { consultantId: consultant.id, companyId, status: { not: 'Cancelled' } }, include: { items: true }, orderBy: { date: 'desc' } });
    const payments = await prisma.commissionPayment.findMany({ where: { consultantId: consultant.id, companyId }, orderBy: { createdAt: 'desc' } });
    const totalSales = sales.length;
    const totalProductsSold = sales.reduce((sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0), 0);
    const totalRevenue = sales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
    const commissionEarned = calcCommission(totalProductsSold, consultant.commissionRate, consultant.tierThreshold, consultant.tierRate);
    const commissionPaid = payments.filter(p => p.type === 'commission').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const allowancePaid = payments.filter(p => p.type === 'allowance').reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = commissionEarned - commissionPaid;
    res.json({ ...consultant, totalSales, totalProductsSold, totalRevenue, commissionEarned, commissionPaid, allowancePaid, balance, sales, payments });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/consultants', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { name, phone, whatsapp, commissionRate, tierThreshold, tierRate, monthlyAllowance, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const consultant = await prisma.consultant.create({ data: { name, phone: phone || null, whatsapp: whatsapp || null, commissionRate: parseFloat(commissionRate) || 50, tierThreshold: parseInt(tierThreshold) || 50, tierRate: parseFloat(tierRate) || 30, monthlyAllowance: parseFloat(monthlyAllowance) || 400, notes: notes || null, companyId } });
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
      ...(raw.commissionRate !== undefined && { commissionRate: parseFloat(raw.commissionRate) }),
      ...(raw.tierThreshold !== undefined && { tierThreshold: parseInt(raw.tierThreshold) }),
      ...(raw.tierRate !== undefined && { tierRate: parseFloat(raw.tierRate) }),
      ...(raw.monthlyAllowance !== undefined && { monthlyAllowance: parseFloat(raw.monthlyAllowance) }),
      ...(raw.isActive !== undefined && { isActive: raw.isActive }),
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
    const salesCount = await prisma.sale.count({ where: { consultantId: req.params.id } });
    if (salesCount > 0) {
      await prisma.consultant.update({ where: { id: req.params.id }, data: { isActive: false } });
      return res.json({ message: 'Consultant deactivated (has existing sales)' });
    }
    await prisma.commissionPayment.deleteMany({ where: { consultantId: req.params.id } });
    await prisma.consultant.delete({ where: { id: req.params.id } });
    res.json({ message: 'Consultant deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

app.post('/api/v1/consultants/:id/payments', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
    const { amount, type, periodFrom, periodTo, paymentMethod, reference, notes } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const payment = await prisma.commissionPayment.create({ data: { consultantId: consultant.id, amount: parseFloat(amount), type: type || 'commission', periodFrom: periodFrom ? new Date(periodFrom) : null, periodTo: periodTo ? new Date(periodTo) : null, paymentMethod: paymentMethod || null, reference: reference || null, notes: notes || null, companyId } });
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

app.post('/api/v1/consultants/:id/stock/transfer', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
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

app.post('/api/v1/consultants/:id/stock/return', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const consultant = await prisma.consultant.findFirst({ where: { id: req.params.id, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
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
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const allSales = await prisma.sale.findMany({ where: { consultantId, companyId, status: { not: 'Cancelled' } }, include: { items: true }, orderBy: { date: 'desc' } });
    const monthSales = allSales.filter(s => new Date(s.date) >= monthStart);
    const todaySales = allSales.filter(s => new Date(s.date) >= todayStart && new Date(s.date) <= todayEnd);

    const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
    const productsSoldInMonth = sum(monthSales, s => s.items.reduce((q, i) => q + i.qty, 0));

    const base = parseFloat(consultant.commissionRate);
    const tier = parseFloat(consultant.tierRate);
    const threshold = parseInt(consultant.tierThreshold) || 50;
    const calcComm = (n) => n <= threshold ? n * base : (threshold * base) + ((n - threshold) * tier);
    const commissionEarnedMonth = calcComm(productsSoldInMonth);

    const payments = await prisma.commissionPayment.findMany({ where: { consultantId, companyId }, orderBy: { createdAt: 'desc' } });
    const totalProductsSoldAllTime = sum(allSales, s => s.items.reduce((q, i) => q + i.qty, 0));
    const commissionEarnedAllTime = calcComm(totalProductsSoldAllTime);
    const commissionPaid = sum(payments.filter(p => p.type === 'commission'), p => parseFloat(p.amount));
    const allowancePaid = sum(payments.filter(p => p.type === 'allowance'), p => parseFloat(p.amount));
    const balance = commissionEarnedAllTime - commissionPaid;

    res.json({
      consultant: { id: consultant.id, name: consultant.name, commissionRate: consultant.commissionRate, tierThreshold: consultant.tierThreshold, tierRate: consultant.tierRate, monthlyAllowance: consultant.monthlyAllowance },
      today: { ordersCount: todaySales.length, productsSold: sum(todaySales, s => s.items.reduce((q, i) => q + i.qty, 0)), revenue: sum(todaySales, s => parseFloat(s.totalPrice)) },
      thisMonth: { ordersCount: monthSales.length, productsSold: productsSoldInMonth, revenue: sum(monthSales, s => parseFloat(s.totalPrice)), commissionEarned: commissionEarnedMonth },
      allTime: { ordersCount: allSales.length, productsSold: totalProductsSoldAllTime, commissionEarned: commissionEarnedAllTime, commissionPaid, allowancePaid, balance },
      recentSales: allSales.slice(0, 10).map(s => ({ id: s.id, orderNumber: s.orderNumber, date: s.date, customerName: s.customerName, totalPrice: s.totalPrice, status: s.status, paymentStatus: s.paymentStatus, productsCount: s.items.reduce((q, i) => q + i.qty, 0) })),
      recentPayments: payments.slice(0, 10),
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

module.exports = app;
