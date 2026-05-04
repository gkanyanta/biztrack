// Consultant pay period helpers.
// A "pay period" runs from payDay of one month (inclusive) to payDay of the next month (exclusive).
// e.g. payDay=11 → period [Apr 11 00:00, May 11 00:00); pay date = May 11.

function getConsultantPayPeriod(refDate, payDay = 11) {
  const d = new Date(refDate);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const startsThisMonth = day >= payDay;
  const periodFrom = new Date(y, startsThisMonth ? m : m - 1, payDay, 0, 0, 0, 0);
  const periodTo   = new Date(y, startsThisMonth ? m + 1 : m, payDay, 0, 0, 0, 0);
  const payDate = periodTo;
  const label = `${payDate.getFullYear()}-${String(payDate.getMonth() + 1).padStart(2, '0')}`;
  return { periodFrom, periodTo, payDate, label };
}

// Resolve a "YYYY-MM" label (= the month the cycle closes & is paid) to its pay period.
function payPeriodFromLabel(label, payDay = 11) {
  const [y, m] = label.split('-').map(Number);
  const periodTo   = new Date(y, m - 1, payDay, 0, 0, 0, 0);
  const periodFrom = new Date(y, m - 2, payDay, 0, 0, 0, 0);
  return { periodFrom, periodTo, payDate: periodTo, label };
}

// Slice of a cycle the consultant was actually active for (proration anchor).
// Returns null if the consultant joined after the cycle ended.
// factor = effectiveDays / totalCycleDays, used to prorate the allowance cap.
function getEffectivePeriod(periodFrom, periodTo, startDate) {
  const cycleMs = periodTo - periodFrom;
  if (!startDate) return { effectiveFrom: periodFrom, effectiveTo: periodTo, factor: 1, prorated: false };
  const start = new Date(startDate);
  if (start <= periodFrom) return { effectiveFrom: periodFrom, effectiveTo: periodTo, factor: 1, prorated: false };
  if (start >= periodTo) return null;
  return { effectiveFrom: start, effectiveTo: periodTo, factor: (periodTo - start) / cycleMs, prorated: true };
}

module.exports = { getConsultantPayPeriod, payPeriodFromLabel, getEffectivePeriod };
