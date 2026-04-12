const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

// Security headers
app.use(helmet());

// CORS - restrict to known origins
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// Rate limiting - general
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
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

// Make prisma available to routes
app.locals.prisma = prisma;

// Routes
app.use('/api/v1/auth', authLimiter, require('./routes/auth'));
app.use('/api/v1/products', require('./routes/products'));
app.use('/api/v1/sales', require('./routes/sales'));
app.use('/api/v1/expenses', require('./routes/expenses'));
app.use('/api/v1/customers', require('./routes/customers'));
app.use('/api/v1/shipping-rates', require('./routes/shippingRates'));
app.use('/api/v1/dashboard', require('./routes/dashboard'));
app.use('/api/v1/reports', require('./routes/reports'));
app.use('/api/v1/settings', require('./routes/settings'));
app.use('/api/v1/inventory', require('./routes/inventory'));
app.use('/api/v1/store', require('./routes/store'));
app.use('/api/v1/consultants', require('./routes/consultants'));
app.use('/api/v1/superadmin', require('./routes/superadmin'));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`BizTrack server running on port ${PORT}`);
});

module.exports = app;
