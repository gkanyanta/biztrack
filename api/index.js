const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();

// Reuse prisma client across serverless invocations
let prisma;
if (!global.__prisma) {
  global.__prisma = new PrismaClient();
}
prisma = global.__prisma;

app.use(cors());
app.use(express.json());

app.locals.prisma = prisma;

// Routes
app.use('/api/v1/auth', require('../server/src/routes/auth'));
app.use('/api/v1/products', require('../server/src/routes/products'));
app.use('/api/v1/sales', require('../server/src/routes/sales'));
app.use('/api/v1/expenses', require('../server/src/routes/expenses'));
app.use('/api/v1/customers', require('../server/src/routes/customers'));
app.use('/api/v1/shipping-rates', require('../server/src/routes/shippingRates'));
app.use('/api/v1/dashboard', require('../server/src/routes/dashboard'));
app.use('/api/v1/reports', require('../server/src/routes/reports'));
app.use('/api/v1/settings', require('../server/src/routes/settings'));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong', message: err.message });
});

module.exports = app;
