const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// List sales
router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, paymentStatus, from, to, customerId, search } = req.query;

    const where = {};
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (customerId) where.customerId = customerId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to + 'T23:59:59.999Z');
    }
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerPhone: { contains: search, mode: 'insensitive' } }
      ];
    }

    const sales = await prisma.sale.findMany({
      where,
      include: { product: true, customer: true },
      orderBy: { createdAt: 'desc' }
    });

    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single sale
router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const sale = await prisma.sale.findUnique({
      where: { id: req.params.id },
      include: {
        product: true,
        customer: true,
        statusHistory: { orderBy: { createdAt: 'desc' } }
      }
    });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    res.json(sale);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create sale
router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = req.body;

    // Get product for cost price snapshot
    const product = await prisma.product.findUnique({ where: { id: data.productId } });
    if (!product) return res.status(400).json({ error: 'Product not found' });

    // Auto-generate order number
    const lastSale = await prisma.sale.findFirst({ orderBy: { createdAt: 'desc' } });
    let nextNum = 1;
    if (lastSale) {
      const match = lastSale.orderNumber.match(/ORD-(\d+)/);
      if (match) nextNum = parseInt(match[1]) + 1;
    }
    const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

    // Auto-create or link customer
    let customerId = data.customerId;
    if (!customerId && data.customerName) {
      // Try to find existing customer by phone
      let customer = null;
      if (data.customerPhone) {
        customer = await prisma.customer.findFirst({
          where: { phone: data.customerPhone }
        });
      }
      if (!customer) {
        customer = await prisma.customer.create({
          data: {
            name: data.customerName,
            phone: data.customerPhone || null,
            city: data.customerCity || null,
            source: data.source || null
          }
        });
      }
      customerId = customer.id;
    }

    // Auto-lookup shipping rate
    let shippingCost = parseFloat(data.shippingCost) || 0;
    if (data.customerCity && !data.shippingCost) {
      const rate = await prisma.shippingRate.findUnique({
        where: { city: data.customerCity }
      });
      if (rate) shippingCost = parseFloat(rate.rate);
    }

    const unitPrice = parseFloat(data.unitPrice) || parseFloat(product.sellingPrice);
    const qty = parseInt(data.qty);
    const totalPrice = qty * unitPrice;

    const sale = await prisma.sale.create({
      data: {
        orderNumber,
        date: data.date ? new Date(data.date) : new Date(),
        productId: data.productId,
        qty,
        unitPrice,
        costPrice: parseFloat(product.costPrice),
        totalPrice,
        shippingCost,
        shippingCharge: parseFloat(data.shippingCharge) || 0,
        discount: parseFloat(data.discount) || 0,
        status: data.status || 'Pending',
        paymentStatus: data.paymentStatus || 'Unpaid',
        paymentMethod: data.paymentMethod || null,
        source: data.source || null,
        customerId,
        customerName: data.customerName || null,
        customerPhone: data.customerPhone || null,
        customerCity: data.customerCity || null,
        deliveryAddress: data.deliveryAddress || null,
        notes: data.notes || null
      },
      include: { product: true, customer: true }
    });

    // If status is Confirmed or beyond, deduct stock
    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      await prisma.product.update({
        where: { id: data.productId },
        data: { stock: { decrement: qty } }
      });
      await prisma.stockLog.create({
        data: {
          productId: data.productId,
          change: -qty,
          reason: 'Sale',
          saleId: sale.id
        }
      });
    }

    // Log initial status
    await prisma.orderStatusLog.create({
      data: {
        saleId: sale.id,
        fromStatus: 'New',
        toStatus: sale.status
      }
    });

    res.status(201).json(sale);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update sale
router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = req.body;

    // Recalculate total if qty or unitPrice changed
    if (data.qty !== undefined || data.unitPrice !== undefined) {
      const existing = await prisma.sale.findUnique({ where: { id: req.params.id } });
      const qty = data.qty !== undefined ? parseInt(data.qty) : existing.qty;
      const unitPrice = data.unitPrice !== undefined ? parseFloat(data.unitPrice) : parseFloat(existing.unitPrice);
      data.totalPrice = qty * unitPrice;
    }

    const sale = await prisma.sale.update({
      where: { id: req.params.id },
      data,
      include: { product: true, customer: true }
    });

    res.json(sale);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update sale status
router.put('/:id/status', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status } = req.body;

    const sale = await prisma.sale.findUnique({ where: { id: req.params.id } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const oldStatus = sale.status;

    // Stock adjustments
    const stockDeductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = stockDeductStatuses.includes(oldStatus);
    const shouldDeduct = stockDeductStatuses.includes(status);

    if (!wasDeducted && shouldDeduct) {
      // Deduct stock
      await prisma.product.update({
        where: { id: sale.productId },
        data: { stock: { decrement: sale.qty } }
      });
      await prisma.stockLog.create({
        data: {
          productId: sale.productId,
          change: -sale.qty,
          reason: 'Sale',
          saleId: sale.id
        }
      });
    } else if (wasDeducted && !shouldDeduct) {
      // Restore stock (cancelled or moved back to pending)
      await prisma.product.update({
        where: { id: sale.productId },
        data: { stock: { increment: sale.qty } }
      });
      await prisma.stockLog.create({
        data: {
          productId: sale.productId,
          change: sale.qty,
          reason: status === 'Cancelled' ? 'Cancelled Order' : 'Status Revert',
          saleId: sale.id
        }
      });
    }

    // Update sale status
    const updated = await prisma.sale.update({
      where: { id: req.params.id },
      data: { status },
      include: { product: true, customer: true, statusHistory: { orderBy: { createdAt: 'desc' } } }
    });

    // Log status change
    await prisma.orderStatusLog.create({
      data: {
        saleId: sale.id,
        fromStatus: oldStatus,
        toStatus: status
      }
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete sale
router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const sale = await prisma.sale.findUnique({ where: { id: req.params.id } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    // Restore stock if it was deducted
    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      await prisma.product.update({
        where: { id: sale.productId },
        data: { stock: { increment: sale.qty } }
      });
      await prisma.stockLog.create({
        data: {
          productId: sale.productId,
          change: sale.qty,
          reason: 'Order Deleted',
          saleId: sale.id
        }
      });
    }

    await prisma.orderStatusLog.deleteMany({ where: { saleId: req.params.id } });
    await prisma.sale.delete({ where: { id: req.params.id } });

    res.json({ message: 'Sale deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
