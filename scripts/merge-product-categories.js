#!/usr/bin/env node
// One-off cleanup: collapse the free-text Product.category values that are the same category
// typed differently ("Fridges" / "fridges" / "Fridge" / "firdges") onto one canonical spelling,
// so the storefront can group products into sections that mean something.
//
// Safe by default: prints the plan and changes nothing without --apply. Every run that applies
// writes a rollback file first, so the previous labels can be restored exactly.
//
// Usage:
//   node scripts/merge-product-categories.js --env=<dotenv path>            # dry run
//   node scripts/merge-product-categories.js --env=<path> --apply
//   node scripts/merge-product-categories.js --env=<path> --rollback=<file>
//
// Products whose category isn't in the map below are left alone and listed at the end, so a new
// category never gets silently renamed.

const path = require('path');
const fs = require('fs');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
if (args.env) require('dotenv').config({ path: path.resolve(args.env) });
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Pass --env=<path to a .env file> or export it.');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// key = category as stored, normalised (trimmed, collapsed spaces, lowercased)
const CANONICAL = {
  'tvs': 'TVs',
  'tv': 'TVs',
  'fridges': 'Fridges',
  'fridge': 'Fridges',
  'firdges': 'Fridges',
  'hair products': 'Hair',
  'hair appliances': 'Hair',
  'phones & accessories': 'Phones & Accessories',
  'cellphones & accessories': 'Phones & Accessories',
  'phones & accesories': 'Phones & Accessories',
  'cellphone & accessories': 'Phones & Accessories',
  'phone accesories': 'Phones & Accessories',
  'phone accessories': 'Phones & Accessories',
  'massage guns': 'Massage & Wellness',
  'ems': 'Massage & Wellness',
  'home appliances': 'Home & Kitchen',
  'kitchen products': 'Home & Kitchen',
  'kitchenware': 'Home & Kitchen',
  'kitchen ware': 'Home & Kitchen',
  'kitchen appliances': 'Home & Kitchen',
  'bluetooth speakers': 'Audio',
  'earphones': 'Audio',
  'ear phones': 'Audio',
  'phones and accessories': 'Phones & Accessories',
  'solar products': 'Solar',
  'bags': 'Bags',
  'shavers': 'Shavers',
  'watches': 'Watches',
  'cosmetics': 'Cosmetics',
  'clothing': 'Clothing',
};

// The handful of products with no category at all. Matched on the exact stored name so nothing
// is guessed by pattern: each one is listed here deliberately.
const BY_NAME = {
  'Itel fit020 smart watch': 'Phones & Accessories',
  'Professional Steam Styler': 'Hair',
  'Waer steampod': 'Hair',
};

const norm = c => (c || '').trim().replace(/\s+/g, ' ').toLowerCase();
const pad = (s, n) => String(s).padEnd(n);

async function rollback(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Restoring ${entries.length} products from ${file}`);
  for (const e of entries) {
    await prisma.product.update({ where: { id: e.id }, data: { category: e.from } });
  }
  console.log('Done. Previous categories restored.');
}

async function main() {
  if (args.rollback) return rollback(args.rollback);

  const products = await prisma.product.findMany({
    select: { id: true, name: true, category: true, isActive: true, stock: true },
    orderBy: { name: 'asc' },
  });

  const changes = [];
  const unmapped = new Map();
  const blank = [];
  for (const p of products) {
    const key = norm(p.category);
    if (!key) {
      const named = BY_NAME[p.name];
      if (named) changes.push({ id: p.id, name: p.name, from: p.category, to: named });
      else blank.push(p);
      continue;
    }
    const target = CANONICAL[key];
    if (!target) { unmapped.set(p.category, (unmapped.get(p.category) || 0) + 1); continue; }
    if (target !== p.category) changes.push({ id: p.id, name: p.name, from: p.category, to: target });
  }

  // Show the resulting shape of the catalogue, which is the point of the exercise.
  const after = {};
  for (const p of products) {
    const key = norm(p.category);
    const label = !key ? (BY_NAME[p.name] || '(no category)') : (CANONICAL[key] || p.category);
    after[label] = (after[label] || 0) + 1;
  }

  console.log(`${products.length} products, ${changes.length} to relabel\n`);
  if (changes.length) {
    console.log(`  ${pad('Product', 46)}${pad('From', 28)}To`);
    console.log('  ' + '-'.repeat(92));
    for (const c of changes) console.log(`  ${pad(c.name.slice(0, 44), 46)}${pad(c.from, 28)}${c.to}`);
  }

  console.log(`\nCatalogue after the merge (${Object.keys(after).length} categories):`);
  for (const [c, n] of Object.entries(after).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(c, 28)}${String(n).padStart(4)}`);
  }

  if (unmapped.size) {
    console.log('\nLeft untouched — not in the map:');
    for (const [c, n] of unmapped) console.log(`  ${pad(c, 28)}${String(n).padStart(4)}`);
  }
  if (blank.length) {
    console.log(`\nNo category set (${blank.length}) — these need labelling by hand:`);
    for (const p of blank) console.log(`  ${p.name}${p.stock > 0 ? '' : '   [out of stock]'}`);
  }

  if (!args.apply) {
    console.log('\nDry run — nothing was changed. Re-run with --apply to write.');
    return;
  }
  if (!changes.length) {
    console.log('\nNothing to change.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.resolve(args.rollbackDir || '.', `category-merge-rollback-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(changes, null, 2));
  console.log(`\nRollback file written: ${file}`);

  for (const c of changes) {
    await prisma.product.update({ where: { id: c.id }, data: { category: c.to } });
  }
  console.log(`Applied. ${changes.length} products relabelled.`);
  console.log(`To undo: node scripts/merge-product-categories.js --env=<path> --rollback=${file}`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
