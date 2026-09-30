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

// A rider's world is his own runs and his own money, and that is the whole of it. Listing what
// he may reach — rather than guarding each endpoint he may not — means a new endpoint is closed
// to him by default instead of exposed until somebody remembers. The rider app only ever calls
// these paths. (mirrored in api/index.js)
const RIDER_ALLOWED_PATHS = [
  /^\/api\/v1\/auth\//,
  /^\/api\/v1\/deliveries\/my(\/|$)/,
  // Moving one of his own deliveries along; the handler scopes it to his riderId.
  /^\/api\/v1\/deliveries\/[^/]+\/status$/,
];

function enforceRiderScope(req, res, next) {
  if (req.user?.role !== 'rider') return next();
  const path = (req.originalUrl || '').split('?')[0];
  if (RIDER_ALLOWED_PATHS.some(re => re.test(path))) return next();
  return res.status(403).json({ error: 'Riders can only reach their own runs and their own money' });
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

// Wrap authenticate so every authenticated route enforces the rider's boundary, whether or not
// the route remembered to ask for it.
function authenticateAndScope(req, res, next) {
  authenticate(req, res, (err) => {
    if (err) return next(err);
    if (res.headersSent) return;
    enforceRiderScope(req, res, next);
  });
}

module.exports = { authenticate: authenticateAndScope, requireSuperadmin, requireAdmin, requireAdminOrInventory, requireAdminOrPurchasing, enforceRiderScope, RIDER_ALLOWED_PATHS };
