#!/usr/bin/env node
// One-off backfill: give every past consultant payment the Salaries & Wages expense it should
// always have raised, so net profit finally counts what the business actually paid its people.
//
// Until now, paying a consultant wrote only a CommissionPayment row. Net profit is computed as
// grossProfit − expenses, and expenses come from the Expense table, so every kwacha of past
// commission and allowance was invisible to the P&L. New payments raise their expense inline
// (see server/src/routes/payroll.js); this script covers the history.
//
// Advances are deliberately skipped. An advance is a loan against pay not yet earned — it
// becomes a cost when the pay it anticipates is earned, not when it is handed over.
//
// Safe by default: prints the plan and changes nothing without --apply. Every run that applies
// writes a rollback file first, so the created expenses can be removed exactly.
//
// Idempotent: a payment that already owns an expense is skipped, so re-running adds nothing.
//
// This database is multi-tenant, so --company is required and every query is scoped to it.
//
// Usage:
//   node scripts/backfill-payroll-expenses.js --env=<path> --company=privtech-solutions
//   node scripts/backfill-payroll-expenses.js --env=<path> --company=<slug> --apply
//   node scripts/backfill-payroll-expenses.js --env=<path> --rollback=<file>

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

const CATEGORY = 'Salaries & Wages';
const LABEL = { commission: 'Commission', allowance: 'Communication allowance', bonus: 'Bonus', salary: 'Salary' };
const money = (n) => `K${Number(n).toFixed(2)}`;

function periodLabel(from, to) {
  if (!from || !to) return null;
  const fmt = (d) => new Date(d).toISOString().slice(0, 10);
  return `${fmt(from)} to ${fmt(to)}`;
}

async function rollback(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  console.log(`Rolling back ${data.created.length} expense(s) created on ${data.stamp}\n`);
  let removed = 0;
  for (const row of data.created) {
    // Unlink first so the payment is left exactly as it was found.
    await prisma.commissionPayment.updateMany({ where: { id: row.paymentId }, data: { expenseId: null } });
    const del = await prisma.expense.deleteMany({ where: { id: row.expenseId, companyId: data.companyId } });
    removed += del.count;
  }
  console.log(`Removed ${removed} expense(s) and cleared their links.`);
  await prisma.$disconnect();
}

async function main() {
  if (args.rollback) return rollback(args.rollback);

  if (!args.company) {
    console.error('--company=<slug> is required. This database holds several companies and an\nunscoped backfill would invent expenses in somebody else\'s books.');
    process.exit(1);
  }
  const company = await prisma.company.findUnique({ where: { slug: String(args.company) } });
  if (!company) {
    const all = await prisma.company.findMany({ select: { slug: true, name: true } });
    console.error(`No company with slug "${args.company}". Known: ${all.map(c => c.slug).join(', ')}`);
    process.exit(1);
  }
  const companyId = company.id;
  console.log(`Company: ${company.name} (${company.slug})\n`);

  const payments = await prisma.commissionPayment.findMany({
    where: { companyId, expenseId: null, type: { not: 'advance' } },
    include: { consultant: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const already = await prisma.commissionPayment.count({ where: { companyId, expenseId: { not: null } } });
  const advances = await prisma.commissionPayment.count({ where: { companyId, type: 'advance' } });

  if (payments.length === 0) {
    console.log('Nothing to backfill — every eligible payment already owns an expense.');
    console.log(`(${already} already linked, ${advances} advance(s) deliberately skipped.)`);
    return prisma.$disconnect();
  }

  const byType = {};
  let total = 0;
  for (const p of payments) {
    const amt = parseFloat(p.amount);
    byType[p.type] = (byType[p.type] || 0) + amt;
    total += amt;
  }

  console.log(`${payments.length} payment(s) to backfill, ${money(total)} in total:`);
  for (const [type, amt] of Object.entries(byType)) console.log(`  ${(LABEL[type] || type).padEnd(26)} ${money(amt)}`);
  console.log(`\nSkipped: ${advances} advance(s) (a loan, not a cost), ${already} already linked.`);

  const first = payments[0], last = payments[payments.length - 1];
  console.log(`Dates span ${new Date(first.createdAt).toISOString().slice(0, 10)} to ${new Date(last.createdAt).toISOString().slice(0, 10)}.`);
  console.log(`\nEach becomes an Expense in "${CATEGORY}", dated when the payment was recorded, so it`);
  console.log('lands in the period the money actually went out. Net profit for those periods will fall.');

  if (!args.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to make these changes.');
    return prisma.$disconnect();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const created = [];
  for (const p of payments) {
    const period = periodLabel(p.periodFrom, p.periodTo);
    const name = p.consultant?.name || 'Consultant';
    // One transaction per payment: an expense that is not linked back is worse than a retry.
    await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.create({
        data: {
          date: p.createdAt,
          description: `${LABEL[p.type] || 'Staff payment'}: ${name}${period ? ` (${period})` : ''}`,
          amount: p.amount,
          category: CATEGORY,
          paymentMethod: p.paymentMethod || null,
          notes: p.notes || null,
          companyId,
        },
      });
      await tx.commissionPayment.update({ where: { id: p.id }, data: { expenseId: expense.id } });
      created.push({ paymentId: p.id, expenseId: expense.id, amount: String(p.amount) });
    });
  }

  const file = path.resolve(args.rollbackDir || '.', `payroll-backfill-rollback-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ stamp, companyId, companySlug: company.slug, created }, null, 2));

  console.log(`\nBackfilled ${created.length} payment(s), ${money(total)} now counted as expenses.`);
  console.log(`Rollback file: ${file}`);
  console.log(`To undo: node scripts/backfill-payroll-expenses.js --env=<path> --rollback=${file}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
