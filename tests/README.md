# Tests

```
npm test                        # every suite, both backends
npm test -- --backend=local     # just server/src
npm test -- --backend=vercel    # just api/index.js
npm test -- --suite=payroll     # one suite, both backends
```

## Why they run twice

This project serves the same API from two places:

- `server/src/routes/*` — what runs in local development
- `api/index.js` — the monolith Vercel actually serves

They are hand-mirrored copies of the same logic. The single most valuable thing these tests do is
run the same expectations against both and fail on the day the two stop agreeing, because that
divergence is silent otherwise: local development keeps working while production quietly does
something else.

## What they cover

| Suite | What it protects |
|---|---|
| `advances` | Salary advances staff ask for themselves: the instalments they state, the office approving on its own terms or declining, and repayments starting on the first pay day after the money is handed over, never a finalised cycle, with one loan per payout |
| `delivery-cash` | Cash a rider collects reaching the order's ledger only when the office confirms it, and coming back out when that is undone |
| `meta-feed` | The Facebook/WhatsApp catalogue feed: ZMW pricing and sale prices, variants, stock, image URLs, CSV escaping, one company's products never in another's feed, no cost or supplier data, and a database failure or empty catalogue never published as an empty feed |
| `money-splits` | Money splits counts staff pay from Payroll and the fares on orders, shows what is still to collect, flags buckets with no target yet, and cuts months at midnight in Zambia |
| `payroll` | Salary accrual and proration, the allowance cap, advances netting off what is owed, and staff pay reaching the P&L |
| `payrun` | A finalised cycle never changing, late customer payments and unpaid balances arriving on the next payslip, loan instalments deducted on their terms unless edited, recoveries and held money, and the wage cost booked once |
| `rider-finance` | The rider's balance, expenses settled as company cost or recharged, partial recharges, and the delivery finances figures |
| `rider-scope` | Who may reach what — every endpoint closed to a rider, the inventory role able to dispatch but not touch money, and the payment secret withheld from non-admins |
| `sale-status` | An order that still has to travel cannot be recorded as already delivered, while a counter collection can |

Every assertion goes over HTTP against a real backend and a real Postgres, because what is worth
protecting here lives in the route handlers and the database — authorisation, money arithmetic,
what a status transition does to stock — not in isolated functions.

## The database

A scratch database is created, migrated with the real migrations, and dropped again. Each suite
truncates first and seeds exactly what it needs, so the order they run in cannot matter.

**It only ever runs against a local Postgres.** `lib/harness.js` reads `DATABASE_URL` from
`server/.env`, appends `_test` to the database name, and refuses outright if the host is not
localhost — these tests drop databases, and that is not a thing to leave to a flag somebody
might forget. Pointing it at Neon fails with an explanation rather than doing anything.

## Adding to them

A suite is a module exporting `{ name, seed, run }`:

```js
module.exports = {
  name: 'What this protects',
  seed: 'payroll',                      // a file in seeds/
  async run({ base, prisma, seed, t }) {
    const { eq, near, section } = t;
    const admin = await require('../lib/harness').loginAs(base, 'boss');
    section('what this group is about');
    eq('a sentence that reads as a claim', (await admin('GET', '/thing')).status, 200);
  },
};
```

Drop it in `suites/` and it is picked up. Write the label as the thing being claimed — a failure
should read as a statement that stopped being true, not as a test name.

Seeded accounts all use the password in `TEST_PASSWORD`. Nothing here is a real credential.
