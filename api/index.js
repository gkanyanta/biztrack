const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');

const app = express();

if (!global.__prisma) {
  global.__prisma = new PrismaClient();
}
const prisma = global.__prisma;

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'biztrack-default-secret';

// Auth middleware
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---- AUTH ----
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { companyName, username, password, name } = req.body;
    if (!companyName || !username || !password || !name) {
      return res.status(400).json({ error: 'Company name, username, password, and name are required' });
    }

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username }, include: { company: true } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, companyId: user.companyId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, companyId: user.companyId, companyName: user.company.name } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/auth/me', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { company: true } });
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, name: user.name, role: user.role, companyId: user.companyId, companyName: user.company.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PRODUCTS ----
app.get('/api/v1/products/meta/categories', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const products = await prisma.product.findMany({ where: { companyId, category: { not: null } }, select: { category: true }, distinct: ['category'] });
    res.json(products.map(p => p.category).filter(Boolean));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/products', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { search, category, lowStock } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }]; }
    if (category) where.category = category;
    let products = await prisma.product.findMany({ where, orderBy: { createdAt: 'desc' } });
    if (lowStock === 'true') products = products.filter(p => p.stock <= p.reorderLevel);
    res.json(products);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/products/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const product = await prisma.product.findFirst({ where: { id: req.params.id, companyId }, include: { stockLogs: { orderBy: { createdAt: 'desc' }, take: 50 } } });
    if (!product) return res.status(404).json({ error: 'Not found' });
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/products/:id/stock-log', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const logs = await prisma.stockLog.findMany({ where: { productId: req.params.id, companyId }, orderBy: { createdAt: 'desc' } });
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/products', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = { ...req.body, companyId };
    if (!data.sku) { const count = await prisma.product.count({ where: { companyId } }); data.sku = `SKU-${String(count + 1).padStart(4, '0')}`; }
    const product = await prisma.product.create({ data });
    if (data.stock && data.stock > 0) { await prisma.stockLog.create({ data: { productId: product.id, change: data.stock, reason: 'Initial Stock', companyId } }); }
    res.status(201).json(product);
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'SKU already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/v1/products/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.product.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    const stockChange = data.stock !== undefined ? data.stock - existing.stock : 0;
    const product = await prisma.product.update({ where: { id: req.params.id }, data });
    if (stockChange !== 0 && req.body.stock !== undefined) {
      await prisma.stockLog.create({ data: { productId: product.id, change: stockChange, reason: 'Manual Adjustment', companyId } });
    }
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/v1/products/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const product = await prisma.product.findFirst({ where: { id: req.params.id, companyId } });
    if (!product) return res.status(404).json({ error: 'Not found' });
    await prisma.product.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ message: 'Product deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/products/restock', authenticate, async (req, res) => {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- SALES ----
app.get('/api/v1/sales/credit/summary', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const creditSales = await prisma.sale.findMany({ where: { companyId, paymentType: 'Credit', paymentStatus: { not: 'Paid' } }, include: { customer: true } });
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
    const recentPayments = await prisma.creditPayment.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 10, include: { sale: { select: { orderNumber: true, customerName: true } } } });
    res.json({ totalOutstanding, overdueCount, overdueAmount, topDebtors, recentPayments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/sales', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status, paymentStatus, paymentType, from, to, customerId, search, creditOverdue } = req.query;
    const where = { companyId };
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (paymentType) where.paymentType = paymentType;
    if (customerId) where.customerId = customerId;
    if (creditOverdue === 'true') { where.paymentType = 'Credit'; where.paymentStatus = { not: 'Paid' }; where.creditDueDate = { lt: new Date() }; }
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    if (search) { where.OR = [{ orderNumber: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } }]; }
    const sales = await prisma.sale.findMany({ where, include: { product: true, customer: true }, orderBy: { createdAt: 'desc' } });
    res.json(sales);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/sales/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { product: true, customer: true, statusHistory: { orderBy: { createdAt: 'desc' } }, creditPayments: { orderBy: { createdAt: 'desc' } }, debtReminders: { orderBy: { sentAt: 'desc' } } } });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    res.json(sale);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/sales', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = req.body;
    const product = await prisma.product.findFirst({ where: { id: data.productId, companyId } });
    if (!product) return res.status(400).json({ error: 'Product not found' });

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

    const unitPrice = parseFloat(data.unitPrice) || parseFloat(product.sellingPrice);
    const qty = parseInt(data.qty);
    const totalPrice = qty * unitPrice;

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
        orderNumber, date: data.date ? new Date(data.date) : new Date(), productId: data.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice,
        shippingCost, shippingCharge: parseFloat(data.shippingCharge) || 0, discount: parseFloat(data.discount) || 0,
        status: data.status || 'Pending', paymentStatus, paymentMethod: data.paymentMethod || null, source: data.source || null,
        paymentType, amountPaid, creditDueDate: data.creditDueDate ? new Date(data.creditDueDate) : null, creditNotes: data.creditNotes || null,
        customerId, customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null, deliveryAddress: data.deliveryAddress || null, notes: data.notes || null,
        companyId
      },
      include: { product: true, customer: true }
    });

    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      await prisma.product.update({ where: { id: data.productId }, data: { stock: { decrement: qty } } });
      await prisma.stockLog.create({ data: { productId: data.productId, change: -qty, reason: 'Sale', saleId: sale.id, companyId } });
    }

    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: 'New', toStatus: sale.status, companyId } });
    res.status(201).json(sale);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/v1/sales/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const raw = req.body;
    const existing = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const qty = raw.qty !== undefined ? parseInt(raw.qty) : existing.qty;
    const unitPrice = raw.unitPrice !== undefined ? parseFloat(raw.unitPrice) : parseFloat(existing.unitPrice);

    const data = {
      ...(raw.productId && { productId: raw.productId }),
      qty, unitPrice, totalPrice: qty * unitPrice,
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
    };
    Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);

    // Recalculate amountPaid and paymentStatus when paymentType changes
    if (raw.paymentType !== undefined) {
      const existing = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
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
      const existing = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
      if (existing.paymentType === 'Credit') {
        const deposit = parseFloat(raw.amountPaid) || 0;
        const saleTotal = data.totalPrice || parseFloat(existing.totalPrice);
        data.amountPaid = deposit;
        if (deposit >= saleTotal) data.paymentStatus = 'Paid';
        else if (deposit > 0) data.paymentStatus = 'Partial';
        else data.paymentStatus = 'Unpaid';
      }
    }

    const sale = await prisma.sale.update({ where: { id: req.params.id }, data, include: { product: true, customer: true } });
    res.json(sale);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/v1/sales/:id/status', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status } = req.body;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    const oldStatus = sale.status;
    const stockDeductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = stockDeductStatuses.includes(oldStatus);
    const shouldDeduct = stockDeductStatuses.includes(status);
    if (!wasDeducted && shouldDeduct) {
      await prisma.product.update({ where: { id: sale.productId }, data: { stock: { decrement: sale.qty } } });
      await prisma.stockLog.create({ data: { productId: sale.productId, change: -sale.qty, reason: 'Sale', saleId: sale.id, companyId } });
    } else if (wasDeducted && !shouldDeduct) {
      await prisma.product.update({ where: { id: sale.productId }, data: { stock: { increment: sale.qty } } });
      await prisma.stockLog.create({ data: { productId: sale.productId, change: sale.qty, reason: status === 'Cancelled' ? 'Cancelled Order' : 'Status Revert', saleId: sale.id, companyId } });
    }
    const updated = await prisma.sale.update({ where: { id: req.params.id }, data: { status }, include: { product: true, customer: true, statusHistory: { orderBy: { createdAt: 'desc' } } } });
    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: oldStatus, toStatus: status, companyId } });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/v1/sales/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      await prisma.product.update({ where: { id: sale.productId }, data: { stock: { increment: sale.qty } } });
      await prisma.stockLog.create({ data: { productId: sale.productId, change: sale.qty, reason: 'Order Deleted', saleId: sale.id, companyId } });
    }
    await prisma.creditPayment.deleteMany({ where: { saleId: req.params.id } });
    await prisma.debtReminder.deleteMany({ where: { saleId: req.params.id } });
    await prisma.orderStatusLog.deleteMany({ where: { saleId: req.params.id } });
    await prisma.sale.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- CREDIT PAYMENTS ----
app.post('/api/v1/sales/:id/payments', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    await prisma.creditPayment.create({ data: { saleId: sale.id, amount, paymentMethod: req.body.paymentMethod || null, reference: req.body.reference || null, notes: req.body.notes || null, companyId } });

    const newAmountPaid = parseFloat(sale.amountPaid) + amount;
    const totalPrice = parseFloat(sale.totalPrice);
    const paymentStatus = newAmountPaid >= totalPrice ? 'Paid' : newAmountPaid > 0 ? 'Partial' : 'Unpaid';
    const updated = await prisma.sale.update({ where: { id: sale.id }, data: { amountPaid: newAmountPaid, paymentStatus }, include: { product: true, customer: true, creditPayments: { orderBy: { createdAt: 'desc' } } } });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/sales/:id/payments', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const payments = await prisma.creditPayment.findMany({ where: { saleId: req.params.id, companyId }, orderBy: { createdAt: 'desc' } });
    res.json(payments);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- REMINDERS ----
app.post('/api/v1/sales/:id/reminders', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const reminder = await prisma.debtReminder.create({ data: { saleId: sale.id, channel: req.body.channel, message: req.body.message || null, companyId } });
    res.status(201).json(reminder);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/sales/:id/reminders', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const reminders = await prisma.debtReminder.findMany({ where: { saleId: req.params.id, companyId }, orderBy: { sentAt: 'desc' } });
    res.json(reminders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- RECEIPT DATA ----
app.get('/api/v1/sales/:id/receipt', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { product: true, customer: true, creditPayments: { orderBy: { createdAt: 'desc' } } } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    res.json({ sale, settings: settingsMap });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- EXPENSES ----
app.get('/api/v1/expenses', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { category, from, to } = req.query;
    const where = { companyId };
    if (category) where.category = category;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const expenses = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } });
    res.json(expenses);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/expenses', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const data = { ...req.body, companyId };
    if (data.date) data.date = new Date(data.date);
    res.status(201).json(await prisma.expense.create({ data }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/v1/expenses/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.expense.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    if (data.date) data.date = new Date(data.date);
    res.json(await prisma.expense.update({ where: { id: req.params.id }, data }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/v1/expenses/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.expense.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- CUSTOMERS ----
app.get('/api/v1/customers', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { search } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search, mode: 'insensitive' } }]; }
    const customers = await prisma.customer.findMany({ where, include: { _count: { select: { sales: true } } }, orderBy: { createdAt: 'desc' } });
    res.json(customers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/customers/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, companyId }, include: { sales: { include: { product: true }, orderBy: { date: 'desc' } } } });
    if (!customer) return res.status(404).json({ error: 'Not found' });
    res.json(customer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/customers/:id/orders', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.json(await prisma.sale.findMany({ where: { customerId: req.params.id, companyId }, include: { product: true }, orderBy: { date: 'desc' } }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/customers', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.status(201).json(await prisma.customer.create({ data: { ...req.body, companyId } }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/v1/customers/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.customer.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    res.json(await prisma.customer.update({ where: { id: req.params.id }, data }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/v1/customers/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.customer.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.customer.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- SHIPPING RATES ----
app.get('/api/v1/shipping-rates', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.json(await prisma.shippingRate.findMany({ where: { companyId }, orderBy: { city: 'asc' } }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/shipping-rates', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    res.status(201).json(await prisma.shippingRate.create({ data: { ...req.body, companyId } }));
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'City already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/v1/shipping-rates/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.shippingRate.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    res.json(await prisma.shippingRate.update({ where: { id: req.params.id }, data }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/v1/shipping-rates/:id', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const existing = await prisma.shippingRate.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.shippingRate.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- DASHBOARD ----
app.get('/api/v1/dashboard', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }

    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter } });
    const totalRevenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const totalCOGS = sales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
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
    sales.forEach(s => { const m = s.date.toISOString().slice(0, 7); if (!monthlyData[m]) monthlyData[m] = { revenue: 0, cogs: 0, expenses: 0, orders: 0 }; monthlyData[m].revenue += parseFloat(s.totalPrice); monthlyData[m].cogs += parseFloat(s.costPrice) * s.qty; monthlyData[m].orders += 1; });
    expenses.forEach(e => { const m = e.date.toISOString().slice(0, 7); if (!monthlyData[m]) monthlyData[m] = { revenue: 0, cogs: 0, expenses: 0, orders: 0 }; monthlyData[m].expenses += parseFloat(e.amount); });
    const monthlySummary = Object.entries(monthlyData).sort(([a], [b]) => a.localeCompare(b)).map(([month, d]) => ({ month, revenue: d.revenue, profit: d.revenue - d.cogs - d.expenses, expenses: d.expenses, orders: d.orders }));

    const expenseByCategory = {};
    expenses.forEach(e => { if (!expenseByCategory[e.category]) expenseByCategory[e.category] = 0; expenseByCategory[e.category] += parseFloat(e.amount); });

    const productSales = {};
    sales.forEach(s => { if (!productSales[s.productId]) productSales[s.productId] = { revenue: 0, qty: 0 }; productSales[s.productId].revenue += parseFloat(s.totalPrice); productSales[s.productId].qty += s.qty; });
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
    const thisMonthCOGS = thisMonthSales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);

    const lastMonthSalesData = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, date: { gte: lastMonthStart, lte: lastMonthEnd } } });
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
    const todaySales = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, date: { gte: todayStart, lte: todayEnd } } });
    const todayRevenue = todaySales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const todayCOGS = todaySales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
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

    res.json({ totalRevenue, totalCOGS, grossProfit, totalExpenses, netProfit, totalOrders, avgOrderValue, adSpend, roas, profitMargin, monthlySummary, expenseByCategory, topProducts, lowStockProducts, pendingOrders, growth, savings });
  } catch (err) { console.error('DASHBOARD ERROR:', err); res.status(500).json({ error: err.message, stack: err.stack }); }
});

// ---- GROWTH PROJECTIONS REPORT ----
app.get('/api/v1/reports/growth', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const allSales = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' } }, orderBy: { date: 'asc' } });
    const allExpenses = await prisma.expense.findMany({ where: { companyId }, orderBy: { date: 'asc' } });

    const monthlyHistory = {};
    allSales.forEach(s => { const m = s.date.toISOString().slice(0, 7); if (!monthlyHistory[m]) monthlyHistory[m] = { revenue: 0, cogs: 0, orders: 0, profit: 0, expenses: 0, adSpend: 0 }; monthlyHistory[m].revenue += parseFloat(s.totalPrice); monthlyHistory[m].cogs += parseFloat(s.costPrice) * s.qty; monthlyHistory[m].orders += s.qty; monthlyHistory[m].profit += parseFloat(s.totalPrice) - (parseFloat(s.costPrice) * s.qty); });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- REPORTS ----
app.get('/api/v1/reports/pnl', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter } });
    const expenses = await prisma.expense.findMany({ where: dateFilter });
    const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const cogs = sales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
    const shippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const shippingCharge = sales.reduce((s, r) => s + parseFloat(r.shippingCharge), 0);
    const discount = sales.reduce((s, r) => s + parseFloat(r.discount), 0);
    const grossProfit = revenue - cogs - shippingCost + shippingCharge - discount;
    const expensesByCategory = {}; let totalExpenses = 0;
    expenses.forEach(e => { const a = parseFloat(e.amount); if (!expensesByCategory[e.category]) expensesByCategory[e.category] = 0; expensesByCategory[e.category] += a; totalExpenses += a; });
    const netProfit = grossProfit - totalExpenses;
    res.json({ revenue, cogs, shippingCost, shippingCharge, discount, grossProfit, expensesByCategory, totalExpenses, netProfit, profitMargin: cogs > 0 ? (netProfit / cogs) * 100 : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/reports/sales', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to, productId, customerId, status } = req.query;
    const where = { companyId };
    if (status) where.status = status; if (productId) where.productId = productId; if (customerId) where.customerId = customerId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where, include: { product: true, customer: true }, orderBy: { date: 'desc' } });
    const summary = { totalSales: sales.length, totalRevenue: sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0), totalProfit: sales.reduce((s, r) => s + parseFloat(r.totalPrice) - (parseFloat(r.costPrice) * r.qty) - parseFloat(r.shippingCost) + parseFloat(r.shippingCharge) - parseFloat(r.discount), 0) };
    res.json({ sales, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/reports/expenses', authenticate, async (req, res) => {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/reports/products', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { product: true } });
    const productMap = {};
    sales.forEach(s => { const pid = s.productId; if (!productMap[pid]) productMap[pid] = { id: pid, name: s.product.name, sku: s.product.sku, revenue: 0, qtySold: 0, profit: 0, orders: 0 }; productMap[pid].revenue += parseFloat(s.totalPrice); productMap[pid].qtySold += s.qty; productMap[pid].profit += parseFloat(s.totalPrice) - (parseFloat(s.costPrice) * s.qty); productMap[pid].orders += 1; });
    res.json(Object.values(productMap).sort((a, b) => b.revenue - a.revenue));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/reports/customers', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, customerId: { not: null }, ...dateFilter }, include: { customer: true } });
    const customerMap = {};
    sales.forEach(s => { const cid = s.customerId; if (!cid) return; if (!customerMap[cid]) customerMap[cid] = { id: cid, name: s.customer?.name || s.customerName, phone: s.customer?.phone, city: s.customer?.city, totalSpent: 0, orderCount: 0 }; customerMap[cid].totalSpent += parseFloat(s.totalPrice); customerMap[cid].orderCount += 1; });
    res.json(Object.values(customerMap).sort((a, b) => b.totalSpent - a.totalSpent));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/reports/export/csv', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { type, from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    let data = []; let filename = 'export.csv';
    if (type === 'sales') {
      const sales = await prisma.sale.findMany({ where: dateFilter, include: { product: true }, orderBy: { date: 'desc' } });
      data = sales.map(s => ({ 'Order #': s.orderNumber, Date: s.date.toISOString().slice(0, 10), Product: s.product.name, Qty: s.qty, 'Unit Price': parseFloat(s.unitPrice), Total: parseFloat(s.totalPrice), Status: s.status, Customer: s.customerName || '' }));
      filename = 'sales-report.csv';
    } else if (type === 'expenses') {
      const expenses = await prisma.expense.findMany({ where: dateFilter, orderBy: { date: 'desc' } });
      data = expenses.map(e => ({ Date: e.date.toISOString().slice(0, 10), Description: e.description, Amount: parseFloat(e.amount), Category: e.category }));
      filename = 'expenses-report.csv';
    } else if (type === 'pnl') {
      const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter } });
      const expenses = await prisma.expense.findMany({ where: dateFilter });
      const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
      const cogs = sales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
      const shippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
      const grossProfit = revenue - cogs - shippingCost;
      const expensesByCategory = {}; let totalExpenses = 0;
      expenses.forEach(e => { const a = parseFloat(e.amount); if (!expensesByCategory[e.category]) expensesByCategory[e.category] = 0; expensesByCategory[e.category] += a; totalExpenses += a; });
      const pnlData = [{ Item: 'Revenue', Amount: revenue }, { Item: 'COGS', Amount: -cogs }, { Item: 'Shipping', Amount: -shippingCost }, { Item: 'Gross Profit', Amount: grossProfit }, ...Object.entries(expensesByCategory).map(([c, a]) => ({ Item: c, Amount: -a })), { Item: 'Total Expenses', Amount: -totalExpenses }, { Item: 'Net Profit', Amount: grossProfit - totalExpenses }];
      const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(pnlData); XLSX.utils.book_append_sheet(wb, ws, 'P&L'); const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=pnl-statement.xlsx');
      return res.send(buf);
    }
    if (data.length === 0) return res.status(200).send('No data');
    const headers = Object.keys(data[0]);
    const csv = [headers.join(','), ...data.map(row => headers.map(h => { const v = String(row[h] ?? ''); return v.includes(',') ? `"${v}"` : v; }).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- SETTINGS ----
app.get('/api/v1/settings', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const obj = {}; settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- INVENTORY ----
app.get('/api/v1/inventory', authenticate, async (req, res) => {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/v1/settings', authenticate, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    for (const [key, value] of Object.entries(req.body)) {
      await prisma.setting.upsert({ where: { companyId_key: { companyId, key } }, update: { value: String(value) }, create: { key, value: String(value), companyId } });
    }
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const obj = {}; settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = app;
