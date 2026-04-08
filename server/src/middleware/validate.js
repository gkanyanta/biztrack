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
  if (req.body.stock !== undefined && (isNaN(req.body.stock) || Number(req.body.stock) < 0)) {
    return res.status(400).json({ error: 'Stock must be a non-negative number' });
  }
  req.body.name = sanitizeString(name, 200);
  if (req.body.description) req.body.description = sanitizeString(req.body.description, 1000);
  if (req.body.category) req.body.category = sanitizeString(req.body.category, 100);
  if (req.body.supplier) req.body.supplier = sanitizeString(req.body.supplier, 200);
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
  if (!description || typeof description !== 'string' || description.length < 1) {
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
  if (req.body.notes) req.body.notes = sanitizeString(req.body.notes, 1000);
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
  if (req.body.city) req.body.city = sanitizeString(req.body.city, 100);
  if (req.body.notes) req.body.notes = sanitizeString(req.body.notes, 1000);
  next();
}

module.exports = {
  sanitizeString,
  validateRegister,
  validateLogin,
  validateProduct,
  validateSale,
  validateExpense,
  validateCustomer
};
