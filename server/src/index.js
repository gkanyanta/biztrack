const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Make prisma available to routes
app.locals.prisma = prisma;

// Routes
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/products', require('./routes/products'));
app.use('/api/v1/sales', require('./routes/sales'));
app.use('/api/v1/expenses', require('./routes/expenses'));
app.use('/api/v1/customers', require('./routes/customers'));
app.use('/api/v1/shipping-rates', require('./routes/shippingRates'));
app.use('/api/v1/dashboard', require('./routes/dashboard'));
app.use('/api/v1/reports', require('./routes/reports'));
app.use('/api/v1/settings', require('./routes/settings'));
app.use('/api/v1/inventory', require('./routes/inventory'));
app.use('/api/v1/superadmin', require('./routes/superadmin'));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong', message: err.message });
});

app.listen(PORT, () => {
  console.log(`BizTrack server running on port ${PORT}`);
});

module.exports = app;
