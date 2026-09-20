#!/usr/bin/env node
// Shipping-commission audit.
//
// Until Sep 2026, commission was calculated on Sale.totalPrice, which is
// `itemsTotal + shippingCharge - discount` — so the delivery fee billed to the customer
// earned commission just like goods did. That was changed to a goods-only base
// (see utils/commission.js and api/index.js:calcCommission).
//
// This script quantifies what that cost: for every consultant sale in a window it recomputes
// commission under both the old and the new rule and reports the difference, per consultant
// and per pay cycle, with per-sale detail.
//
// Both rules are deliberately inlined below rather than imported, so this audit keeps
// reproducing history correctly even as the live commission code evolves.
//
// Usage:
//   node scripts/shipping-commission-audit.js                 # last 3 pay cycles
//   node scripts/shipping-commission-audit.js --months=6
//   node scripts/shipping-commission-audit.js --from=2026-06-01 --to=2026-09-20
//   node scripts/shipping-commission-audit.js --csv=audit.csv  # per-sale detail to CSV
//
// Reads DATABASE_URL from the environment (or a --env=<path> dotenv file).

const path = require('path');
const fs = require('fs');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

if (args.env) require('dotenv').config({ path: path.resolve(args.env) });
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Pass --env=<path to a .env file> or export it.');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const money = n => 'K' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

// ---- OLD rule (pre-change): commission on totalPrice, shipping included ----
function calcCommissionOld(payType, commissionRate, tierThreshold, tierRate, sales) {
  const rate = parseFloat(commissionRate), tRate = parseFloat(tierRate);
  const threshold = parseFloat(tierThreshold) || 0;
  if (payType === 'revenue_pct') {
    let comm = 0;
    for (const sale of sales) {
      const saleTotal = parseFloat(sale.totalPrice);
      if (saleTotal <= 0) continue;
      const paidAmount = Math.min(parseFloat(sale.amountPaid) || 0, saleTotal);
      if (paidAmount <= 0) continue;
      const r = (threshold > 0 && tRate > 0 && saleTotal > threshold) ? tRate : rate;
      comm += paidAmount * r / 100;
    }
    return Math.round(comm * 100) / 100;
  }
  const th = parseInt(tierThreshold) || 50;
  let units = 0;
  for (const sale of sales) {
    const saleTotal = parseFloat(sale.totalPrice);
    if (saleTotal <= 0) continue;
    const n = sale.items.reduce((q, i) => q + i.qty, 0);
    units += n * Math.min(1, (parseFloat(sale.amountPaid) || 0) / saleTotal);
  }
  const comm = units <= th ? units * rate : (th * rate) + ((units - th) * tRate);
  return Math.round(comm * 100) / 100;
}

// ---- NEW rule: commission on the goods portion only ----
function commissionableSale(sale) {
  const saleTotal = parseFloat(sale.totalPrice);
  if (!(saleTotal > 0)) return null;
  const goodsTotal = Math.max(0, saleTotal - (parseFloat(sale.shippingCharge) || 0));
  const paidFraction = Math.min(1, Math.max(0, (parseFloat(sale.amountPaid) || 0) / saleTotal));
  return { goodsTotal, paidFraction, collected: goodsTotal * paidFraction };
}
function calcCommissionNew(payType, commissionRate, tierThreshold, tierRate, sales) {
  const rate = parseFloat(commissionRate), tRate = parseFloat(tierRate);
  const threshold = parseFloat(tierThreshold) || 0;
  if (payType === 'revenue_pct') {
    let comm = 0;
    for (const sale of sales) {
      const c = commissionableSale(sale);
      if (!c || c.collected <= 0) continue;
      const r = (threshold > 0 && tRate > 0 && c.goodsTotal > threshold) ? tRate : rate;
      comm += c.collected * r / 100;
    }
    return Math.round(comm * 100) / 100;
  }
  const th = parseInt(tierThreshold) || 50;
  let units = 0;
  for (const sale of sales) {
    const c = commissionableSale(sale);
    if (!c) continue;
    units += sale.items.reduce((q, i) => q + i.qty, 0) * c.paidFraction;
  }
  const comm = units <= th ? units * rate : (th * rate) + ((units - th) * tRate);
  return Math.round(comm * 100) / 100;
}

// Pay cycle label for a date, matching the app's [payDay, payDay) half-open periods.
function cycleLabel(date, payDay) {
  const d = new Date(date);
  const y = d.getFullYear(), m = d.getMonth();
  const start = d.getDate() >= payDay ? new Date(y, m, payDay) : new Date(y, m - 1, payDay);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, payDay);
  const f = x => x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return { key: start.toISOString().slice(0, 10), label: `${f(start)} – ${f(new Date(end - 86400000))} ${end.getFullYear()}` };
}

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true, consultantPayDay: true } });

  let from, to;
  if (args.from || args.to) {
    from = new Date((args.from || '1970-01-01') + 'T00:00:00.000Z');
    to = new Date((args.to || new Date().toISOString().slice(0, 10)) + 'T23:59:59.999Z');
  } else {
    const months = parseInt(args.months) || 3;
    to = new Date();
    from = new Date(to.getFullYear(), to.getMonth() - months, to.getDate());
  }

  console.log('='.repeat(96));
  console.log('SHIPPING COMMISSION AUDIT');
  console.log(`Window: ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`);
  console.log('Difference = commission that was paid on delivery fees under the old rule.');
  console.log('='.repeat(96));

  const csvRows = [];
  let grandDiff = 0;

  for (const company of companies) {
    const payDay = company.consultantPayDay || 11;
    const consultants = await prisma.consultant.findMany({
      where: { companyId: company.id, isStockLocation: false },
      select: { id: true, name: true, payType: true, commissionRate: true, tierThreshold: true, tierRate: true, isActive: true },
    });
    if (!consultants.length) continue;

    const sales = await prisma.sale.findMany({
      where: { companyId: company.id, status: { not: 'Cancelled' }, consultantId: { not: null }, date: { gte: from, lte: to } },
      include: { items: { select: { qty: true } } },
      orderBy: { date: 'asc' },
    });

    console.log(`\nCOMPANY: ${company.name}   (pay day ${payDay}, ${sales.length} consultant sales in window)`);

    for (const c of consultants) {
      const cSales = sales.filter(s => s.consultantId === c.id);
      if (!cSales.length) continue;

      // Group by pay cycle, because commission is settled per cycle.
      const cycles = new Map();
      for (const s of cSales) {
        const { key, label } = cycleLabel(s.date, payDay);
        if (!cycles.has(key)) cycles.set(key, { label, sales: [] });
        cycles.get(key).sales.push(s);
      }

      const oldTotal = calcCommissionOld(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, cSales);
      const newTotal = calcCommissionNew(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, cSales);
      const diff = Math.round((oldTotal - newTotal) * 100) / 100;
      grandDiff += diff;

      const rateDesc = c.payType === 'revenue_pct'
        ? `${parseFloat(c.commissionRate)}% of revenue` + (parseFloat(c.tierRate) > 0 ? ` (${parseFloat(c.tierRate)}% above K${Number(c.tierThreshold).toLocaleString()})` : '')
        : `K${parseFloat(c.commissionRate)}/item (first ${c.tierThreshold}, then K${parseFloat(c.tierRate)})`;

      console.log('\n' + '-'.repeat(96));
      console.log(`${c.name}${c.isActive ? '' : '  [inactive]'}   ${rateDesc}`);
      console.log('-'.repeat(96));
      console.log(`  ${pad('Pay cycle', 26)}${padl('Orders', 7)}${padl('Shipping billed', 18)}${padl('Old comm', 13)}${padl('New comm', 13)}${padl('Overpaid', 13)}`);

      for (const [, cy] of [...cycles.entries()].sort()) {
        const o = calcCommissionOld(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, cy.sales);
        const n = calcCommissionNew(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, cy.sales);
        const ship = cy.sales.reduce((s, x) => s + (parseFloat(x.shippingCharge) || 0), 0);
        console.log(`  ${pad(cy.label, 26)}${padl(cy.sales.length, 7)}${padl(money(ship), 18)}${padl(money(o), 13)}${padl(money(n), 13)}${padl(money(o - n), 13)}`);
      }
      console.log(`  ${pad('TOTAL', 26)}${padl(cSales.length, 7)}${padl(money(cSales.reduce((s, x) => s + (parseFloat(x.shippingCharge) || 0), 0)), 18)}${padl(money(oldTotal), 13)}${padl(money(newTotal), 13)}${padl(money(diff), 13)}`);

      // Per-sale detail for the orders that actually carried a delivery fee.
      const withShipping = cSales.filter(s => (parseFloat(s.shippingCharge) || 0) > 0);
      if (withShipping.length) {
        console.log(`\n  Orders with a delivery fee (${withShipping.length} of ${cSales.length}):`);
        console.log(`    ${pad('Order', 12)}${pad('Date', 12)}${padl('Sale total', 13)}${padl('Shipping', 11)}${padl('Paid', 12)}${padl('Overpaid', 11)}  Payment`);
        for (const s of withShipping) {
          const o = calcCommissionOld(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, [s]);
          const n = calcCommissionNew(c.payType, c.commissionRate, c.tierThreshold, c.tierRate, [s]);
          console.log(`    ${pad(s.orderNumber, 12)}${pad(s.date.toISOString().slice(0, 10), 12)}${padl(money(s.totalPrice), 13)}${padl(money(s.shippingCharge), 11)}${padl(money(s.amountPaid), 12)}${padl(money(o - n), 11)}  ${s.paymentStatus}`);
          csvRows.push({
            Consultant: c.name, Order: s.orderNumber, Date: s.date.toISOString().slice(0, 10),
            'Sale total': parseFloat(s.totalPrice), 'Shipping charged': parseFloat(s.shippingCharge),
            'Amount paid': parseFloat(s.amountPaid), 'Payment status': s.paymentStatus,
            'Commission (old)': o, 'Commission (new)': n, Overpaid: Math.round((o - n) * 100) / 100,
          });
        }
      }

      // What was actually disbursed in the window, for reconciliation.
      const paid = await prisma.commissionPayment.aggregate({
        where: { consultantId: c.id, type: 'commission', createdAt: { gte: from, lte: to } },
        _sum: { amount: true },
      });
      console.log(`\n  Commission actually paid out in this window: ${money(parseFloat(paid._sum.amount) || 0)}`);
    }
  }

  console.log('\n' + '='.repeat(96));
  console.log(`TOTAL COMMISSION PAID ON SHIPPING ACROSS ALL CONSULTANTS: ${money(grandDiff)}`);
  console.log('='.repeat(96));

  if (args.csv) {
    const headers = Object.keys(csvRows[0] || { Consultant: '' });
    const csv = [headers.join(','), ...csvRows.map(r => headers.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(','))].join('\n');
    fs.writeFileSync(args.csv, csv);
    console.log(`\nPer-sale detail written to ${args.csv} (${csvRows.length} rows)`);
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
