// The business month: what "this month" means on the dashboard and in the monthly figures.
//
// A company counts either by calendar month (the 1st to the end of the month) or by its pay
// cycle (pay day to the day before the next pay day, e.g. 11 Nov to 10 Dec). A business that
// pays commission and judges targets on the cycle wants its profit, ad spend and sales measured
// over the same window, or every month cuts one pay cycle in two. Tax returns, bank statements
// and Meta billing stay calendar months, which is why this is a choice per company.
//
// Boundaries are midnight in Zambia (UTC+2 all year), whatever the server clock says.
// (mirrored in api/index.js)

const BUSINESS_ZM_OFFSET = 2 * 3600 * 1000;
const BUSINESS_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Midnight in Zambia on a calendar day; month and day may overflow, as with Date.UTC.
const business_zmMidnight = (y, m0, d) => new Date(Date.UTC(y, m0, d) - BUSINESS_ZM_OFFSET);
// The Zambian calendar day a moment falls on.
const business_zmDay = (at) => {
  const z = new Date(new Date(at).getTime() + BUSINESS_ZM_OFFSET);
  return { y: z.getUTCFullYear(), m: z.getUTCMonth(), d: z.getUTCDate() };
};
const business_dayText = (date) => {
  const { m, d } = business_zmDay(date);
  return `${d} ${BUSINESS_MONTH_NAMES[m]}`;
};

// The business month containing `at`, or `back` months before it.
//   from, to   the instants it runs between (to is exclusive)
//   key        sorts in time order: YYYY-MM of the month it starts in
//   name       how a person reads it: "November 2026", or "11 Nov – 10 Dec 2026" for a cycle
//   short      for a chart axis: "Nov 2026", or "Nov–Dec" for a cycle
//   days       how long it is
function business_month(basis, payDay, at = new Date(), back = 0) {
  const { y, m, d } = business_zmDay(at);
  const cycle = basis === 'cycle';
  const startMonth = (cycle && d < payDay ? m - 1 : m) - back;
  const startDay = cycle ? payDay : 1;
  const from = business_zmMidnight(y, startMonth, startDay);
  const to = business_zmMidnight(y, startMonth + 1, startDay);
  const s = business_zmDay(from);
  const lastDay = new Date(to.getTime() - 1);
  const e = business_zmDay(lastDay);
  const key = `${s.y}-${String(s.m + 1).padStart(2, '0')}`;
  const name = cycle
    ? `${business_dayText(from)} – ${business_dayText(lastDay)} ${e.y}`
    : `${new Date(Date.UTC(s.y, s.m, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${s.y}`;
  const short = cycle
    ? `${BUSINESS_MONTH_NAMES[s.m]}–${BUSINESS_MONTH_NAMES[e.m]}${s.y !== e.y ? ` ${String(e.y).slice(2)}` : ''}`
    : `${BUSINESS_MONTH_NAMES[s.m]} ${s.y}`;
  return { basis: cycle ? 'cycle' : 'calendar', from, to, key, name, short, days: Math.round((to - from) / 86400000) };
}

// How far into its business month `at` is, counting today: 1 on the first day.
const business_dayIndex = (month, at = new Date()) => Math.min(month.days, Math.max(1, Math.floor((new Date(at) - month.from) / 86400000) + 1));

// A company's choice, kept as the `monthBasis` setting; calendar unless it says cycle.
async function business_monthBasis(prisma, companyId) {
  const [company, setting] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { consultantPayDay: true } }),
    prisma.setting.findUnique({ where: { companyId_key: { companyId, key: 'monthBasis' } } }),
  ]);
  return { basis: setting?.value === 'cycle' ? 'cycle' : 'calendar', payDay: company?.consultantPayDay || 11 };
}

module.exports = { business_month, business_dayIndex, business_monthBasis, business_zmDay };
