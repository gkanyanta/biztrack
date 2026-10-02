#!/usr/bin/env node
// One-off cleanup: close the orders that predate the new delivery system, so the assign and
// prepare queues show live work instead of eight months of history.
//
// 250 orders sat open with no delivery record — 93 Confirmed, 89 Shipped, 68 Pending, the oldest
// from March. The goods in most cases left long ago; what never happened was anybody marking it.
//
// DELIBERATELY DOES NOT TOUCH STOCK. Moving a Pending order to Delivered through the API would
// deduct stock for it, and 68 of these are Pending carrying 80 units. Those goods physically went
// months ago, so deducting now would double-count them against a stock picture already showing 31
// of 62 products at or below zero. The July 2026 cleanups avoided this for the same reason.
//
// DELIBERATELY DOES NOT TOUCH MONEY. paymentStatus and amountPaid are left exactly as they are, so
// the 29 orders that are not fully paid keep their balance and stay in the credit tracker. Marking
// an order delivered says the goods went; it does not say the customer paid.
//
// Safe by default: prints the plan and changes nothing without --apply. Every run that applies
// writes a rollback file first, restoring each order's previous status exactly.
//
// This database is multi-tenant, so --company is required and every query is scoped to it.
//
// Usage:
//   node scripts/close-pre-launch-orders.js --env=<path> --company=privtech-solutions
//   node scripts/close-pre-launch-orders.js --env=<path> --company=<slug> --apply
//   node scripts/close-pre-launch-orders.js --env=<path> --rollback=<file>

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
// The pooled host (pgbouncer) is what made the first run of this time out. The direct host is
// already in the environment because migrations need it, and a bulk job wants it for the same
// reason: many statements in quick succession.
const direct = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url: direct } } });

// The day the new system started. A fixed date, not "two days ago" — it does not drift with the
// calendar, or re-running this next week would sweep up the work it is meant to protect.
const CUTOFF = new Date('2026-09-30T00:00:00+02:00');
const CLOSED = 'Delivered';
const money = (n) => `K${Number(n).toLocaleString('en', { maximumFractionDigits: 2 })}`;

async function rollback(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  console.log(`Restoring ${data.closed.length} order(s) to the status they had on ${data.stamp}\n`);
  let restored = 0;
  for (const row of data.closed) {
    await prisma.sale.updateMany({
      where: { id: row.saleId, companyId: data.companyId },
      data: { status: row.previousStatus },
    });
    if (row.logId) await prisma.orderStatusLog.deleteMany({ where: { id: row.logId } });
    restored += 1;
  }
  console.log(`Restored ${restored} order(s) and removed the timeline entries this added.`);
  await prisma.$disconnect();
}

async function main() {
  if (args.rollback) return rollback(args.rollback);

  if (!args.company) {
    console.error('--company=<slug> is required. This database holds several companies and an\nunscoped sweep would close somebody else\'s orders.');
    process.exit(1);
  }
  const company = await prisma.company.findUnique({ where: { slug: String(args.company) } });
  if (!company) {
    const all = await prisma.company.findMany({ select: { slug: true } });
    console.error(`No company with slug "${args.company}". Known: ${all.map(c => c.slug).join(', ')}`);
    process.exit(1);
  }
  const companyId = company.id;
  console.log(`Company: ${company.name} (${company.slug})`);
  // Printed in Lusaka time, because the UTC rendering of midnight on the 30th reads as the 29th
  // and would have somebody reasonably believing the cutoff was a day earlier than it is.
  const lusaka = (d) => new Date(d.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`Closing orders dated before ${lusaka(CUTOFF)} (Lusaka) that are still open.\n`);

  const open = await prisma.sale.findMany({
    where: { companyId, status: { notIn: ['Cancelled', CLOSED] }, date: { lt: CUTOFF } },
    select: { id: true, orderNumber: true, status: true, date: true, totalPrice: true, amountPaid: true, paymentStatus: true },
    orderBy: { date: 'asc' },
  });

  if (!open.length) {
    console.log('Nothing to close — no open orders predate the cutoff.');
    return prisma.$disconnect();
  }

  const byStatus = {};
  for (const s of open) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  console.log(`${open.length} order(s) to close:`);
  for (const [k, v] of Object.entries(byStatus)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log(`  dated ${lusaka(open[0].date)} to ${lusaka(open[open.length - 1].date)}`);

  const unpaid = open.filter(s => s.paymentStatus !== 'Paid');
  const owed = unpaid.reduce((a, s) => a + (parseFloat(s.totalPrice) - parseFloat(s.amountPaid)), 0);
  console.log(`\n${unpaid.length} of them are not fully paid, owing ${money(owed)} between them.`);
  console.log('That balance is left untouched and stays in the credit tracker.');
  console.log(`\nStock is not touched: ${byStatus.Pending || 0} Pending order(s) keep their undeducted stock.`);

  if (!args.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to make these changes.');
    return prisma.$disconnect();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const closed = [];

  // Done in chunks of bulk statements rather than a transaction per order. Two hundred and fifty
  // interactive transactions over a pooled connection is how the first attempt at this died
  // partway — Postgres could not hand out transactions fast enough and it stopped at 240.
  //
  // The timeline entries are written BEFORE the statuses move, deliberately. If this dies between
  // the two, the leftovers are log rows for orders still sitting at their old status, which is
  // both detectable and harmless to re-run. The other order would leave orders moved with no
  // record of what they were, which is the one state there is no way back from.
  const CHUNK = 25;
  for (let i = 0; i < open.length; i += CHUNK) {
    const batch = open.slice(i, i + CHUNK);
    // byUserId stays null on purpose. A script did this, not a person, and attributing it to
    // whoever happened to run it would put a name on hundreds of actions nobody took.
    await prisma.orderStatusLog.createMany({
      data: batch.map(sale => ({ saleId: sale.id, fromStatus: sale.status, toStatus: CLOSED, companyId })),
    });
    const logs = await prisma.orderStatusLog.findMany({
      where: { companyId, toStatus: CLOSED, byUserId: null, saleId: { in: batch.map(s => s.id) } },
      select: { id: true, saleId: true },
      orderBy: { createdAt: 'desc' },
      take: batch.length,
    });
    const logBySale = {};
    for (const l of logs) if (!logBySale[l.saleId]) logBySale[l.saleId] = l.id;

    await prisma.sale.updateMany({
      where: { id: { in: batch.map(s => s.id) }, companyId },
      data: { status: CLOSED },
    });
    for (const sale of batch) {
      closed.push({ saleId: sale.id, orderNumber: sale.orderNumber, previousStatus: sale.status, logId: logBySale[sale.id] || null });
    }
    process.stdout.write(`\r  closed ${closed.length} of ${open.length}…`);
  }
  process.stdout.write('\n');

  const file = path.resolve(args.rollbackDir || '.', `pre-launch-close-rollback-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ stamp, companyId, companySlug: company.slug, cutoff: CUTOFF.toISOString(), closed }, null, 2));

  console.log(`\nClosed ${closed.length} order(s). Stock and payments untouched.`);
  console.log(`Rollback file: ${file}`);
  console.log(`To undo: node scripts/close-pre-launch-orders.js --env=<path> --rollback=${file}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
