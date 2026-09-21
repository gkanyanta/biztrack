const jwt = require('jsonwebtoken');

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    // For consultant role, resolve their Consultant.id so route handlers can scope queries
    if (decoded.role === 'consultant') {
      const prisma = req.app.locals.prisma;
      const consultant = await prisma.consultant.findFirst({ where: { userId: decoded.id, companyId: decoded.companyId }, select: { id: true, isActive: true } });
      if (!consultant) return res.status(403).json({ error: 'No consultant profile linked to this account' });
      if (!consultant.isActive) return res.status(403).json({ error: 'Your consultant account is inactive' });
      req.user.consultantId = consultant.id;
    }
    // Same for riders: resolve Rider.id so every delivery query can be scoped to their own runs
    if (decoded.role === 'rider') {
      const prisma = req.app.locals.prisma;
      const rider = await prisma.rider.findFirst({ where: { userId: decoded.id, companyId: decoded.companyId }, select: { id: true, isActive: true } });
      if (!rider) return res.status(403).json({ error: 'No rider profile linked to this account' });
      if (!rider.isActive) return res.status(403).json({ error: 'Your rider account is inactive' });
      req.user.riderId = rider.id;
    }
    next();
  } catch (err) {
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

module.exports = { authenticate, requireSuperadmin, requireAdmin, requireAdminOrInventory, requireAdminOrPurchasing };
