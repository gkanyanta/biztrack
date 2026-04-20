import { FiCalendar, FiX } from 'react-icons/fi';

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const firstOfMonthISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};
const firstOfYearISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), 0, 1).toISOString().slice(0, 10);
};

const PRESETS = [
  { label: 'Today', get: () => ({ from: todayISO(), to: todayISO() }) },
  { label: '7d', get: () => ({ from: daysAgoISO(6), to: todayISO() }) },
  { label: '30d', get: () => ({ from: daysAgoISO(29), to: todayISO() }) },
  { label: 'MTD', get: () => ({ from: firstOfMonthISO(), to: todayISO() }) },
  { label: 'YTD', get: () => ({ from: firstOfYearISO(), to: todayISO() }) },
];

export default function DateRangePicker({ from, to, onChange, className = '' }) {
  const apply = (f, t) => onChange({ from: f || '', to: t || '' });
  const hasRange = from || to;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <div className="flex items-center gap-1 text-gray-500">
        <FiCalendar size={14} />
        <span className="text-xs font-medium">Range:</span>
      </div>
      {PRESETS.map((p) => (
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
