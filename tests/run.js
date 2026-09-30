#!/usr/bin/env node
// Runs every suite against both backends.
//
// This project serves the same API from two places: server/src for local development, and the
// api/index.js monolith on Vercel. They are hand-mirrored copies of the same logic, so the most
// valuable thing these tests do is run twice and fail the day the two stop agreeing.
//
//   npm test                     both backends, every suite
//   npm test -- --backend=local  just server/src
//   npm test -- --suite=payroll  just one suite, both backends
//
// A scratch database is created, migrated, and dropped again. It only ever runs against a local
// Postgres — see the guard in lib/harness.js.

const path = require('path');
const fs = require('fs');
const h = require('./lib/harness');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const SUITE_DIR = path.join(__dirname, 'suites');
const suites = fs.readdirSync(SUITE_DIR).filter(f => f.endsWith('.js')).sort()
  .map(f => ({ file: f, ...require(path.join(SUITE_DIR, f)) }))
  .filter(s => !args.suite || s.file.includes(args.suite) || s.name.toLowerCase().includes(String(args.suite).toLowerCase()));

const backends = Object.keys(h.BACKENDS).filter(b => !args.backend || b === args.backend);

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

(async () => {
  if (!suites.length) { console.error('No suites matched.'); process.exit(1); }

  const testUrl = h.testDatabaseUrl();
  console.log(dim(`scratch database: ${new URL(testUrl).pathname.slice(1)} on ${new URL(testUrl).hostname}`));

  console.log(dim('creating and migrating…'));
  await h.resetDatabase(testUrl);
  await h.migrate(testUrl);

  const results = [];
  let totalPass = 0, totalFail = 0;

  for (const which of backends) {
    const backend = await h.startBackend(which, testUrl);
    console.log(`\n${bold(backend.label)}`);
    try {
      for (const suite of suites) {
        // Each suite starts from an empty database and seeds exactly what it needs, so the order
        // they run in can never matter.
        await h.truncateAll(testUrl);
        const prisma = h.rawClient(testUrl);
        try {
          const seedFn = require(path.join(__dirname, 'seeds', `${suite.seed}.js`));
          const seed = await seedFn(prisma);
          const t = h.makeAsserts();
          console.log(`\n  ${suite.name}`);
          await suite.run({ base: backend.base, prisma, seed, t });
          totalPass += t.state.pass;
          totalFail += t.state.fail;
          results.push({ backend: which, suite: suite.name, ...t.state });
        } finally {
          await prisma.$disconnect();
        }
      }
    } finally {
      backend.proc.kill();
    }
  }

  await h.dropDatabase(testUrl);

  console.log(`\n${bold('summary')}`);
  for (const r of results) {
    const mark = r.fail ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m';
    console.log(`  ${mark} ${r.backend.padEnd(7)} ${r.suite.padEnd(36)} ${r.pass} passed${r.fail ? `, ${r.fail} FAILED` : ''}`);
  }
  console.log(`\n${totalFail ? '\x1b[31m' : '\x1b[32m'}${totalPass} passed, ${totalFail} failed\x1b[0m across ${backends.length} backend(s)\n`);
  process.exit(totalFail ? 1 : 0);
})().catch(err => {
  console.error(`\n\x1b[31m${err.message}\x1b[0m`);
  process.exit(1);
});
