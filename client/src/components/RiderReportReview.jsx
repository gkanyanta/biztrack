import { useState, useEffect } from 'react';
import { getRiderReports, acknowledgeRiderReport } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import toast from 'react-hot-toast';
import { FiCheck, FiAlertCircle, FiFileText } from 'react-icons/fi';

// What the rider says about a day, next to what the records say about the same day. The variance
// column is the reason this screen exists — a matching pair needs no attention, a mismatched one
// is a conversation.

function Cell({ declared, actual, money = true, invert }) {
  const d = parseFloat(declared), a = parseFloat(actual);
  const diff = Math.round((d - a) * 100) / 100;
  const fmt = (v) => (money ? formatMoney(v) : String(v));
  const off = Math.abs(diff) > 0.01;
  return (
    <div>
      <div className={`text-sm ${off ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{fmt(d)}</div>
      <div className={`text-xs ${off ? (invert ? 'text-amber-600' : 'text-red-600') : 'text-gray-400'}`}>
        {off ? `${diff > 0 ? '+' : ''}${fmt(diff)} vs system` : 'matches'}
      </div>
    </div>
  );
}

export default function RiderReportReview() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [onlyOpen, setOnlyOpen] = useState(true);

  const load = () => {
    getRiderReports(onlyOpen ? { unacknowledged: 'true' } : {})
      .then(res => setRows(res.data))
      .catch(() => toast.error('Could not load reports'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [onlyOpen]);

  const ack = async (r, value) => {
    try {
      await acknowledgeRiderReport(r.id, value);
      toast.success(value ? 'Marked as checked' : 'Reopened');
      load();
    } catch { toast.error('Could not update'); }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input type="checkbox" checked={onlyOpen} onChange={e => { setOnlyOpen(e.target.checked); setLoading(true); }} />
        Only ones I have not checked
      </label>

      {rows.length === 0 ? (
        <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
          <FiFileText className="mx-auto mb-2 text-gray-300" size={30} />
          <p className="text-gray-500 text-sm">No daily reports {onlyOpen ? 'waiting' : 'yet'}.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(r => (
            <div key={r.id} className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="font-medium text-gray-800">{r.rider?.name}</div>
                  <div className="text-xs text-gray-400">{formatDate(r.date)} · sent {formatDate(r.submittedAt)}</div>
                </div>
                {r.acknowledgedAt ? (
                  <button onClick={() => ack(r, false)} className="text-xs text-emerald-600 flex items-center gap-1 shrink-0">
                    <FiCheck size={13} /> checked
                  </button>
                ) : (
                  <button onClick={() => ack(r, true)}
                    className="px-3 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-medium shrink-0">Mark checked</button>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">Drops done</div>
                  <Cell declared={r.deliveriesCompleted} actual={r.actuals.deliveriesCompleted} money={false} />
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">Cash collected</div>
                  <Cell declared={r.cashCollected} actual={r.actuals.cashCollected} />
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">His money spent</div>
                  <Cell declared={r.expensesPaid} actual={r.actuals.expensesPaid} invert />
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-0.5">Handed in</div>
                  <div className="text-sm text-gray-700">{formatMoney(r.cashHandedOver)}</div>
                  <div className="text-xs text-gray-400">still on him {formatMoney(r.closingFloat)}</div>
                </div>
              </div>

              {Math.abs(r.variance.unaccounted) > 0.01 && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-2.5 text-xs text-red-800 flex items-start gap-1.5">
                  <FiAlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    {formatMoney(Math.abs(r.variance.unaccounted))} does not add up by his own figures —
                    collected less spent should equal handed in plus what he still holds.
                  </span>
                </div>
              )}

              {r.actuals.failureReasons.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <div className="text-xs font-medium text-gray-500 mb-1">Failures that day</div>
                  {r.actuals.failureReasons.map(f => (
                    <div key={f.reason} className="flex justify-between text-xs text-gray-600 py-0.5">
                      <span>{f.reason}</span><span>{f.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
