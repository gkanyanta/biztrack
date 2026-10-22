import { useState, useEffect } from 'react';
import { getMyAdvances, requestAdvance, withdrawAdvance } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmDialog from '../components/ConfirmDialog';
import toast from 'react-hot-toast';
import { FiInbox, FiSend } from 'react-icons/fi';
import AdvanceSchedule from '../components/AdvanceSchedule';
import { ADVANCE_STATUS } from '../utils/advances';

// Where anyone on the payroll asks for a salary advance and follows it. They choose how many pay
// days it comes back over; repayments start from the first pay day after the money reaches them.

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500';
const perInstalment = (amount, n) => (amount > 0 && n > 0 ? Math.ceil((amount / n) * 100) / 100 : 0);
const instalmentWord = (n) => `${n} instalment${n === 1 ? '' : 's'}`;

export default function MyAdvances() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ amount: '', instalments: '1', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const load = () => getMyAdvances()
    .then(res => setData(res.data))
    .catch(err => setError(err.response?.data?.error || 'Could not load your advances'));
  useEffect(() => { load(); }, []);

  if (error) return <div className="max-w-xl mx-auto mt-10 text-center text-sm text-gray-500">{error}</div>;
  if (!data) return <LoadingSpinner />;

  const open = data.requests.find(r => r.status === 'pending' || r.status === 'approved');
  const amount = parseFloat(form.amount) || 0;
  const n = parseInt(form.instalments, 10);
  const per = perInstalment(amount, n);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await requestAdvance({ amount, instalments: n, reason: form.reason });
      toast.success('Request sent to the office');
      setForm({ amount: '', instalments: '1', reason: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not send the request'); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><FiInbox /> Salary advance</h1>
        <p className="text-sm text-gray-500 mt-1">Ask for part of your pay early and choose how many pay days it comes back over.</p>
      </div>

      {open ? (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800">
          You have a request open. You can ask for another once it has been paid out, declined or withdrawn.
        </div>
      ) : (
        <form onSubmit={submit} className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (K)</label>
              <input required type="number" min="1" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Pay it back over</label>
              <select value={form.instalments} onChange={e => setForm({ ...form, instalments: e.target.value })} className={inputClass}>
                {Array.from({ length: data.maxInstalments }, (_, i) => i + 1).map(i => (
                  <option key={i} value={i}>{i === 1 ? 'One pay day (all at once)' : `${i} pay days`}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">What is it for?</label>
            <textarea required rows={2} maxLength={500} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} className={inputClass} />
          </div>
          {per > 0 && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700">
              <span className="font-semibold">{formatMoney(per)}</span> comes off your pay on each of {n === 1 ? 'one pay day' : `${n} pay days`}.
              Deductions start on the <span className="font-semibold">first pay day after you receive the money</span>. If it is paid out today, that is {formatDate(data.nextPayDate)}.
            </div>
          )}
          <button type="submit" disabled={submitting} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
            <FiSend size={14} /> {submitting ? 'Sending…' : 'Send request'}
          </button>
        </form>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Your requests</h2>
        {data.requests.length === 0 && <p className="text-sm text-gray-400">You have not asked for an advance yet.</p>}
        {data.requests.map(r => {
          const st = ADVANCE_STATUS[r.status] || ADVANCE_STATUS.pending;
          return (
            <div key={r.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-gray-800">{formatMoney(r.agreed.amount)} over {instalmentWord(r.agreed.instalments)}</p>
                  <p className="text-xs text-gray-400">Asked {formatDate(r.createdAt)} · {r.reason}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${st.className}`}>{st.label}</span>
              </div>
              {r.termsChanged && (
                <p className="text-xs text-gray-500 mt-2">You asked for {formatMoney(r.requested.amount)} over {instalmentWord(r.requested.instalments)}; the office agreed the terms above.</p>
              )}
              {r.decisionNote && <p className="text-sm text-gray-600 mt-2 italic">“{r.decisionNote}”</p>}
              {r.status === 'paid' && (
                <p className="text-sm text-gray-600 mt-2">
                  Received {formatDate(r.paidAt)}. Repaid {formatMoney(r.repaid)}, {formatMoney(r.outstanding)} still to come off.
                </p>
              )}
              {r.schedule.length > 0 && (
                <>
                  {r.preview && <p className="text-xs text-gray-400 mt-2">If it is paid out today:</p>}
                  <AdvanceSchedule schedule={r.schedule} />
                </>
              )}
              {r.status === 'pending' && (
                <button onClick={() => setConfirm(r)} className="mt-3 text-sm text-red-600 hover:underline">Withdraw request</button>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try { await withdrawAdvance(confirm.id); toast.success('Request withdrawn'); load(); }
          catch (err) { toast.error(err.response?.data?.error || 'Could not withdraw it'); }
          setConfirm(null);
        }}
        title="Withdraw request"
        message={confirm ? `Withdraw your request for ${formatMoney(confirm.agreed.amount)}?` : ''}
      />
    </div>
  );
}
