import { useState, useEffect } from 'react';
import { getMyDailyReport, submitMyDailyReport, getMyDailyReports } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import toast from 'react-hot-toast';
import { FiCheck, FiSend, FiAlertCircle } from 'react-icons/fi';

// The rider's account of his day. Every field is pre-filled from what the system already knows,
// so he only has to correct what differs — and where he does differ, the office sees both numbers
// side by side. That gap is the point of asking him at all.

export default function RiderDayReport() {
  const [state, setState] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState(null);
  // Which day he is reporting on. Today unless he picks an earlier one, which he needs to be
  // able to do: a day that went by without being balanced still has to be balanced afterwards.
  const [date, setDate] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([getMyDailyReport(date || undefined), getMyDailyReports()])
      .then(([r, h]) => {
        setState(r.data);
        setHistory(h.data);
        const a = r.data.actuals, existing = r.data.report;
        setForm({
          deliveriesCompleted: String(existing?.deliveriesCompleted ?? a.deliveriesCompleted),
          deliveriesFailed: String(existing?.deliveriesFailed ?? a.deliveriesFailed),
          cashCollected: String(existing?.cashCollected ?? a.cashCollected),
          expensesPaid: String(existing?.expensesPaid ?? a.expensesPaid),
          cashHandedOver: String(existing?.cashHandedOver ?? ''),
          closingFloat: String(existing?.closingFloat ?? ''),
        });
      })
      .catch(() => toast.error('Could not load that day'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [date]);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitMyDailyReport({ ...form, date: state.date });
      toast.success('Sent to the office');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not send');
    } finally { setSubmitting(false); }
  };

  if (loading || !form) return <LoadingSpinner />;
  const a = state.actuals;
  const todayKey = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
  const isToday = state.date?.slice(0, 10) === todayKey;

  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  // What he says he took, less what he says he spent and handed over and still holds.
  const unaccounted = Math.round((num(form.cashCollected) - num(form.expensesPaid) - num(form.cashHandedOver) - num(form.closingFloat)) * 100) / 100;

  const Field = ({ label, k, hint, money = true }) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input type="number" inputMode="decimal" min="0" step={money ? '0.01' : '1'} value={form[k]}
        onChange={e => setForm({ ...form, [k]: e.target.value })}
        className="w-full border border-gray-300 rounded-xl px-3 py-3 text-lg outline-none focus:ring-2 focus:ring-slate-800" />
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      {state.report && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-3.5 text-sm text-emerald-800 flex items-start gap-2">
          <FiCheck size={16} className="mt-0.5 shrink-0" />
          <span>
            Sent for {formatDate(state.date)}.
            {state.report.acknowledgedAt ? ' The office has seen it.' : ' Waiting for the office to check it.'}
            {' '}Sending again will replace it.
          </span>
        </div>
      )}

      <form onSubmit={submit} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-800">
            {isToday ? 'Today' : 'Catching up'} — {formatDate(state.date)}
          </h3>
          {/* A missed day is reported by picking it, and the figures above fill from that day. */}
          <input type="date" value={state.date?.slice(0, 10) || ''} max={todayKey}
            onChange={e => setDate(e.target.value || null)}
            className="border border-gray-300 rounded-xl px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-slate-800" />
        </div>
        {!isToday && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-2.5">
            You are reporting on an earlier day. The figures start from what the system recorded that day.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Drops done" k="deliveriesCompleted" money={false} hint={`system: ${a.deliveriesCompleted}`} />
          <Field label="Drops failed" k="deliveriesFailed" money={false} hint={`system: ${a.deliveriesFailed}`} />
        </div>

        {a.failureReasons.length > 0 && (
          <div className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs font-medium text-gray-600 mb-1">Why today's failed</p>
            {a.failureReasons.map(r => (
              <div key={r.reason} className="flex justify-between text-xs text-gray-600 py-0.5">
                <span>{r.reason}</span><span>{r.count}</span>
              </div>
            ))}
          </div>
        )}

        <Field label="Cash you collected" k="cashCollected" hint={`system: ${formatMoney(a.cashCollected)}`} />
        <Field label="Your money you spent" k="expensesPaid" hint={`system: ${formatMoney(a.expensesPaid)} — log each one on the Money tab`} />
        <Field label="Cash you handed in" k="cashHandedOver" />
        <Field label="Cash still on you" k="closingFloat" hint="what is in your pocket at the end of the day" />

        {Math.abs(unaccounted) > 0.01 && (
          <div className={`rounded-xl p-3 text-sm flex items-start gap-2 ${unaccounted > 0 ? 'bg-amber-50 border border-amber-200 text-amber-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
            <FiAlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>
              {unaccounted > 0
                ? `${formatMoney(unaccounted)} is not accounted for. Collected less spent should equal what you handed in plus what you still have.`
                : `You have ${formatMoney(Math.abs(unaccounted))} more than you collected. Check the figures.`}
            </span>
          </div>
        )}

        <button type="submit" disabled={submitting}
          className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-semibold text-base flex items-center justify-center gap-2 disabled:opacity-50">
          <FiSend size={18} /> {submitting ? 'Sending…' : state.report ? 'Send again' : 'Send to the office'}
        </button>
      </form>

      {history.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Your last reports</h3>
          <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
            {history.map(r => (
              <button type="button" key={r.id} onClick={() => setDate(r.date.slice(0, 10))}
                className="w-full text-left flex items-center justify-between gap-3 p-3.5 active:bg-gray-50">
                <div>
                  <div className="text-sm text-gray-800">{formatDate(r.date)}</div>
                  <div className="text-xs text-gray-500">
                    {r.deliveriesCompleted} done · collected {formatMoney(r.cashCollected)} · handed in {formatMoney(r.cashHandedOver)}
                  </div>
                </div>
                {r.acknowledgedAt
                  ? <span className="text-xs text-emerald-600 flex items-center gap-1 shrink-0"><FiCheck size={12} /> checked</span>
                  : <span className="text-xs text-gray-400 shrink-0">sent</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
