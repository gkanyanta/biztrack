// Shared plumbing for the suites.
//
// Every suite talks to a real backend over HTTP against a real Postgres, because the things worth
// protecting here — who may reach what, whether a rider's balance nets correctly, whether paying
// someone books an expense — live in the route handlers and the database, not in isolated units.
//
// The same suites run twice: once against server/src (local development) and once against
// api/index.js (what Vercel serves). Those are two copies of the same logic, and the whole point
// is to catch the day they stop agreeing.

const path = require('path');
const { spawn } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..', '..');

// One password for every seeded account; nothing here is a real credential.
const TEST_PASSWORD = 'secret123';

// ---- safety ----

// Tests create and drop a database. Doing that against anything but a local Postgres would be
// unforgivable, so it is refused outright rather than guarded by a flag somebody can pass.
function assertLocal(url) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `Refusing to run tests against "${host}". These tests DROP and CREATE a database, so they\n` +
      `only ever run against a local Postgres. Point DATABASE_URL at localhost.`
    );
  }
}

function testDatabaseUrl() {
  require('dotenv').config({ path: path.join(ROOT, 'server', '.env'), quiet: true });
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set. Expected it in server/.env');
  assertLocal(base);
  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '').split('?')[0];
  if (name.endsWith('_test')) return base;
  url.pathname = `/${name}_test`;
  return url.toString();
}

// CREATE and DROP DATABASE need a connection to something other than the database in question,
// so this points at "postgres". Prisma's raw executor is used rather than adding a second
// Postgres driver to the project just for the tests.
function rawClient(url, database) {
  const u = new URL(url);
  if (database) u.pathname = `/${database}`;
  return new PrismaClient({ datasources: { db: { url: u.toString() } } });
}

function databaseName(url) {
  return new URL(url).pathname.replace(/^\//, '').split('?')[0];
}

async function resetDatabase(testUrl) {
  const name = databaseName(testUrl);
  if (!name.endsWith('_test')) throw new Error(`Refusing to drop "${name}" — it is not a _test database`);
  const admin = rawClient(testUrl, 'postgres');
  try {
    await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`);
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally { await admin.$disconnect(); }
}

async function dropDatabase(testUrl) {
  const name = databaseName(testUrl);
  if (!name.endsWith('_test')) return;
  const admin = rawClient(testUrl, 'postgres');
  try {
    await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`);
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
  } finally { await admin.$disconnect(); }
}

// Wipe the rows between suites without rebuilding the schema. Truncating every table the app
// owns is cheaper than a migrate, and listing them from the catalogue means a new model is
// covered the day it is added instead of the day somebody remembers.
async function truncateAll(testUrl) {
  const db = rawClient(testUrl);
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`);
    if (rows.length) {
      const list = rows.map(r => `"${r.tablename}"`).join(', ');
      await db.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
    }
  } finally { await db.$disconnect(); }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'pipe', ...opts });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed:\n${out}`))));
  });
}

async function migrate(testUrl) {
  await run('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: testUrl, DATABASE_URL_UNPOOLED: testUrl },
  });
}

// ---- the backend under test ----

// Two entry points, one set of expectations. 'local' is the express app under server/src;
// 'vercel' is the monolith in api/index.js, which exports its app and so needs a listener.
const BACKENDS = {
  local: { label: 'server/src (local dev)', port: 5099, start: (env) => spawn('node', ['server/src/index.js'], { cwd: ROOT, env, stdio: 'pipe' }) },
  vercel: { label: 'api/index.js (Vercel)', port: 5098, start: (env) => spawn('node', ['-e', "const app=require('./api/index.js');app.listen(process.env.PORT);"], { cwd: ROOT, env, stdio: 'pipe' }) },
};

async function startBackend(which, testUrl) {
  const cfg = BACKENDS[which];
  const env = {
    ...process.env,
    DATABASE_URL: testUrl,
    DATABASE_URL_UNPOOLED: testUrl,
    JWT_SECRET: 'test-secret-not-a-real-one',
    PORT: String(cfg.port),
    // See the comments on both limiters in the entry points.
    AUTH_RATE_LIMIT_MAX: '100000',
    RATE_LIMIT_MAX: '1000000',
  };
  const proc = cfg.start(env);
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  const base = `http://localhost:${cfg.port}/api/v1`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/auth/me`);
      if (r.status === 401) return { proc, base, label: cfg.label };
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`${cfg.label} did not come up on port ${cfg.port}:\n${log}`);
}

// ---- assertions ----

function makeAsserts() {
  const state = { pass: 0, fail: 0, failures: [] };
  const record = (ok, label, detail) => {
    if (ok) { state.pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
    else { state.fail++; state.failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `\n      ${detail}` : ''}`); }
  };
  return {
    state,
    eq(label, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      record(ok, label, ok ? null : `expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
    },
    near(label, actual, expected, tolerance = 1) {
      const ok = Math.abs(actual - expected) <= tolerance;
      record(ok, label, ok ? null : `expected ~${expected} (±${tolerance})\n      actual   ${actual}`);
    },
    section(name) { console.log(`\n  \x1b[2m${name}\x1b[0m`); },
  };
}

// An HTTP client bound to one identity, so a suite reads as "this person tried that".
function client(base, token) {
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

// The raw token, for suites that build their own clients.
async function tokenFor(base, username, password = TEST_PASSWORD) {
  const res = await client(base)('POST', '/auth/login', { username, password });
  if (!res.body?.token) throw new Error(`could not log in as ${username}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function loginAs(base, username, password = TEST_PASSWORD) {
  const res = await client(base)('POST', '/auth/login', { username, password });
  if (!res.body?.token) throw new Error(`could not log in as ${username}: ${JSON.stringify(res.body)}`);
  return client(base, res.body.token);
}

module.exports = {
  ROOT, testDatabaseUrl, resetDatabase, dropDatabase, truncateAll, migrate, rawClient,
  startBackend, BACKENDS, makeAsserts, client, loginAs, tokenFor, TEST_PASSWORD,
};
