import { useEffect, useState } from 'react';
import { getMoneySplits, updateSettings } from '../services/api';
import { formatMoney, DEFAULT_ALLOCATION_TARGETS } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiAlertTriangle, FiSettings, FiX, FiTrendingUp, FiTrendingDown } from 'react-icons/fi';

const BUCKETS = [
  { key: 'stock', label: 'Stock (COGS)', bar: 'bg-blue-500', overIsBad: false, note: 'Money sunk into inventory' },
  { key: 'ads', label: 'Ads & Marketing', bar: 'bg-purple-500', overIsBad: false, note: 'Facebook, WhatsApp ads' },
  { key: 'otherOps', label: 'Other Operations', bar: 'bg-gray-500', overIsBad: true, note: 'Shipping, data, transport, misc' },
  { key: 'ownerDraw', label: 'Owner Draw (You)', bar: 'bg-amber-500', overIsBad: true, note: 'Personal withdrawals' },
  { key: 'taxReserve', label: 'Tax Reserve', bar: 'bg-indigo-500', overIsBad: false, note: 'Set aside for compliance' },
  { key: 'profit', label: 'Profit / Growth Reserve', bar: 'bg-green-500', overIsBad: false, isProfit: true, note: 'Left over — keep for growth' },
];

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function currentYM() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function recentMonths(n = 6) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export default function MoneySplits() {
  const [ym, setYm] = useState(currentYM());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showTargets, setShowTargets] = useState(false);
  const [editTargets, setEditTargets] = useState({});
  const [savingTargets, setSavingTargets] = useState(false);

  const load = () => {
    setLoading(true);
    getMoneySplits({ month: ym })
      .then(res => setData(res.data))
      .catch(() => toast.error('Failed to load money splits'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [ym]);

  const openTargets = () => {
    setEditTargets({ ...(data?.targets || DEFAULT_ALLOCATION_TARGETS) });
    setShowTargets(true);
  };

  const saveTargets = async () => {
    const sum = Object.values(editTargets).reduce((s, v) => s + (parseFloat(v) || 0), 0);
    if (Math.abs(sum - 100) > 0.5) {
      toast.error(`Targets must sum to 100% (currently ${sum.toFixed(1)}%)`);
      return;
    }
    setSavingTargets(true);
    try {
      const payload = {};
      for (const [k, v] of Object.entries(editTargets)) payload[`alloc_${k}`] = parseFloat(v) || 0;
      await updateSettings(payload);
      toast.success('Targets saved');
      setShowTargets(false);
      load();
    } catch { toast.error('Failed to save targets'); }
    finally { setSavingTargets(false); }
  };

  if (loading || !data) return <LoadingSpinner />;

  const { revenue, cogs, targets, targetAmounts, actual, profitActual, ownerOwedBack } = data;

  const valueFor = (b) => {
    if (b.isProfit) return profitActual;
    if (b.key === 'stock') return cogs; // use COGS for stock — what was actually consumed
    return actual[b.key] || 0;
  };

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Money Splits</h2>
          <p className="text-xs text-gray-500">Where each kwacha of revenue is going — targets vs actual</p>
        </div>
        <div className="flex gap-2 items-center">
          <select value={ym} onChange={e => setYm(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none">
            {recentMonths(12).map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button onClick={openTargets}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
            <FiSettings size={14} /> Targets
          </button>
        </div>
      </div>

      {/* Revenue header */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-700 rounded-xl p-5 text-white shadow-lg">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs text-blue-100">Confirmed revenue — {monthLabel(data.month)}</p>
            <p className="text-3xl font-bold mt-1">{formatMoney(revenue)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-blue-100">Net profit so far</p>
            <p className={`text-2xl font-bold ${profitActual >= 0 ? 'text-green-300' : 'text-red-300'}`}>
              {formatMoney(profitActual)}
            </p>
            <p className="text-xs text-blue-100 mt-0.5">{revenue > 0 ? ((profitActual / revenue) * 100).toFixed(1) : '0'}% of revenue</p>
          </div>
        </div>
      </div>

      {/* Owner owed-back warning */}
      {ownerOwedBack > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-start gap-3">
          <FiAlertTriangle className="text-amber-600 mt-0.5 flex-shrink-0" size={20} />
          <div>
            <h3 className="font-semibold text-amber-900 text-sm">You've drawn more than your target</h3>
            <p className="text-xs text-amber-800 mt-1">
              Your owner draws this month are <strong>{formatMoney(actual.ownerDraw)}</strong>, but the target cap is <strong>{formatMoney(targetAmounts.ownerDraw)}</strong>.
              The excess — <strong>{formatMoney(ownerOwedBack)}</strong> — is treated as a loan from the business. Try to pay it back within 2 months to avoid starving stock/ads.
            </p>
          </div>
        </div>
      )}

      {/* Split cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {BUCKETS.map(b => {
          const actualAmt = valueFor(b);
          const targetAmt = targetAmounts[b.key] || 0;
          const targetPct = targets[b.key] || 0;
          const actualPct = revenue > 0 ? (actualAmt / revenue) * 100 : 0;
          const pctOfTarget = targetAmt > 0 ? Math.min(200, (actualAmt / targetAmt) * 100) : 0;
          const over = actualAmt > targetAmt;
          const barColor = b.isProfit
            ? (actualAmt >= targetAmt ? 'bg-green-500' : 'bg-amber-500')
            : b.overIsBad && over
              ? 'bg-red-500'
              : over ? 'bg-blue-400' : b.bar;
          const status = b.isProfit
            ? (actualAmt >= targetAmt ? 'On track' : 'Below target')
            : over
              ? (b.overIsBad ? 'Over budget' : 'Above plan')
              : 'Within budget';
          const StatusIcon = over && b.overIsBad ? FiTrendingUp : FiTrendingDown;

          return (
            <div key={b.key} className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-gray-800 text-sm">{b.label}</h4>
                  <p className="text-xs text-gray-400">{b.note}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${over && b.overIsBad ? 'bg-red-100 text-red-700' : b.isProfit && actualAmt < targetAmt ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                  {status}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-bold text-gray-800">{formatMoney(actualAmt)}</span>
                <span className="text-xs text-gray-500">of {formatMoney(targetAmt)}</span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, pctOfTarget)}%` }} />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Target {targetPct}% · Actual {actualPct.toFixed(1)}%</span>
                <span className={`flex items-center gap-0.5 ${over && b.overIsBad ? 'text-red-600' : 'text-gray-500'}`}>
                  <StatusIcon size={12} /> {pctOfTarget.toFixed(0)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {data.actual.uncategorized > 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-xs text-gray-600">
          <strong>{formatMoney(data.actual.uncategorized)}</strong> in expenses don't match any bucket category. Re-categorize them on the Expenses page for accurate splits.
        </div>
      )}

      {/* Targets editor modal */}
      {showTargets && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowTargets(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-gray-800">Allocation Targets</h3>
              <button onClick={() => setShowTargets(false)} className="text-gray-400 hover:text-gray-600"><FiX size={18} /></button>
            </div>
            <p className="text-xs text-gray-500 mb-4">Percentages of revenue. Must sum to 100%.</p>
            <div className="space-y-2">
              {BUCKETS.map(b => (
                <div key={b.key} className="flex items-center gap-3">
                  <label className="flex-1 text-sm text-gray-700">{b.label}</label>
                  <input type="number" step="0.5" min="0" max="100"
                    value={editTargets[b.key] ?? ''}
                    onChange={e => setEditTargets({ ...editTargets, [b.key]: e.target.value })}
                    className="w-20 border border-gray-300 rounded-lg px-2 py-1 text-sm text-right outline-none focus:ring-2 focus:ring-blue-500" />
                  <span className="text-xs text-gray-400 w-4">%</span>
                </div>
              ))}
              <div className="flex items-center gap-3 pt-2 border-t border-gray-200 mt-3">
                <span className="flex-1 text-sm font-semibold text-gray-700">Sum</span>
                <span className={`text-sm font-bold ${Math.abs(Object.values(editTargets).reduce((s, v) => s + (parseFloat(v) || 0), 0) - 100) < 0.5 ? 'text-green-600' : 'text-red-600'}`}>
                  {Object.values(editTargets).reduce((s, v) => s + (parseFloat(v) || 0), 0).toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <button onClick={() => setShowTargets(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={saveTargets} disabled={savingTargets}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {savingTargets ? 'Saving...' : 'Save Targets'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
