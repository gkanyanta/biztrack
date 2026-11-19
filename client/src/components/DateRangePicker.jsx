import { FiCalendar, FiX } from 'react-icons/fi';

// Dates as the YYYY-MM-DD the date inputs use, in local time. (toISOString would give the UTC
// day, which in Zambia is the day before for anything at midnight.)
const iso = (d) => d.toLocaleDateString('en-CA');
const todayISO = () => iso(new Date());
const daysAgoISO = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};
const firstOfMonthISO = () => {
  const d = new Date();
  return iso(new Date(d.getFullYear(), d.getMonth(), 1));
};
const firstOfYearISO = () => iso(new Date(new Date().getFullYear(), 0, 1));

// The pay cycle runs from pay day to the day before the next one, e.g. 11 Nov to 10 Dec.
const cycleStart = (payDay, back = 0) => {
  const d = new Date();
  const month = (d.getDate() >= payDay ? d.getMonth() : d.getMonth() - 1) - back;
  return new Date(d.getFullYear(), month, payDay);
};

const PRESETS = [
  { label: 'Today', get: () => ({ from: todayISO(), to: todayISO() }) },
  { label: '7d', get: () => ({ from: daysAgoISO(6), to: todayISO() }) },
  { label: '30d', get: () => ({ from: daysAgoISO(29), to: todayISO() }) },
  { label: 'MTD', get: () => ({ from: firstOfMonthISO(), to: todayISO() }) },
  { label: 'YTD', get: () => ({ from: firstOfYearISO(), to: todayISO() }) },
];
const CYCLE_PRESETS = (payDay) => [
  { label: 'This cycle', get: () => ({ from: iso(cycleStart(payDay)), to: todayISO() }) },
  {
    label: 'Last cycle',
    get: () => {
      const end = cycleStart(payDay);
      end.setDate(end.getDate() - 1);
      return { from: iso(cycleStart(payDay, 1)), to: iso(end) };
    },
  },
];

// With a payDay, it also offers the pay cycle running now and the one before it.
export default function DateRangePicker({ from, to, onChange, payDay, className = '' }) {
  const apply = (f, t) => onChange({ from: f || '', to: t || '' });
  const hasRange = from || to;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <div className="flex items-center gap-1 text-gray-500">
        <FiCalendar size={14} />
        <span className="text-xs font-medium">Range:</span>
      </div>
      {[...PRESETS, ...(payDay ? CYCLE_PRESETS(payDay) : [])].map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => { const r = p.get(); apply(r.from, r.to); }}
          className="px-2 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700"
        >
          {p.label}
        </button>
      ))}
      <input
        type="date"
        value={from || ''}
        onChange={(e) => apply(e.target.value, to)}
        className="border border-gray-300 rounded-lg px-2 py-1 text-xs outline-none"
      />
      <span className="text-gray-400 text-xs">→</span>
      <input
        type="date"
        value={to || ''}
        onChange={(e) => apply(from, e.target.value)}
        className="border border-gray-300 rounded-lg px-2 py-1 text-xs outline-none"
      />
      {hasRange && (
        <button
          type="button"
          onClick={() => apply('', '')}
          className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
          title="Clear"
        >
          <FiX size={12} /> Clear
        </button>
      )}
    </div>
  );
}
