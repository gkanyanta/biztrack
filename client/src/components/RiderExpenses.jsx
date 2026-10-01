import { useState, useEffect } from 'react';
import { getMyRiderAccount, getMyRiderExpenses, logMyRiderExpense, deleteMyRiderExpense, getMyRuns } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiLock, FiCheck } from 'react-icons/fi';

// The rider's side of the money. He spends his own cash on the company's behalf — a Platinum
// courier fee for an out-of-town parcel, fuel, airtime — and settlement is net, so what he logs
// here comes straight off what he has to hand over at the end of a run.

const CATEGORIES = ['Platinum courier', 'Other courier', 'Fuel', 'Airtime', 'Bike repair', 'Parking', 'Other'];

// A courier fee belongs to a particular parcel, so these ask which order it was. Fuel and
// airtime do not belong to any one drop, so they do not.
const COURIER_CATEGORIES = ['Platinum courier', 'Other courier'];

export default function RiderExpenses() {
  const [account, setAccount] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [runs, setRuns] = useState([]);
  const [form, setForm] = useState({ category: 'Platinum courier', amount: '', description: '', rechargeable: true, saleId: '' });

  const load = () => {
    setLoading(true);
    Promise.all([getMyRiderAccount(), getMyRiderExpenses(), getMyRuns()])
      .then(([a, e, r]) => {
        setAccount(a.data);
        setExpenses(e.data);
        // The parcels he is carrying — the ones a courier fee could belong to.
        setRuns([...(r.data.open || []), ...(r.data.completedToday || [])]);
      })
      .catch(() => toast.error('Could not load'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await logMyRiderExpense({ ...form, amount: parseFloat(form.amount) });
      toast.success('Logged — it comes off what you hand in');
      setForm({ category: 'Platinum courier', amount: '', description: '', rechargeable: true, saleId: '' });
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save');
    } finally { setSubmitting(false); }
  };

  const remove = async (x) => {
    try {
      await deleteMyRiderExpense(x.id);
      toast.success('Removed');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not remove'); }
  };

  const isCourier = COURIER_CATEGORIES.includes(form.category);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-4">
      {account && (
        <div className="bg-white rounded-2xl border border-gray-100 p-4">
          <div className="text-xs text-gray-500">To hand in</div>
          <div className={`text-3xl font-bold ${account.netDue > 0 ? 'text-amber-600' : account.netDue < 0 ? 'text-emerald-600' : 'text-gray-400'}`}>
            {formatMoney(Math.abs(account.netDue))}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {account.netDue > 0 ? 'cash you are holding for the company'
              : account.netDue < 0 ? 'the company owes you this'
              : 'you are settled up'}
          </div>
          <div className="mt-3 pt-3 border-t border-gray-100 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Collected at doors</span><span className="font-medium">{formatMoney(account.holding)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Your money out</span><span className="font-medium text-emerald-600">-{formatMoney(account.owedToRider)}</span></div>
          </div>
        </div>
      )}

      {!showForm ? (
        <button onClick={() => setShowForm(true)}
          className="w-full py-4 bg-slate-800 text-white rounded-2xl font-semibold text-base flex items-center justify-center gap-2">
          <FiPlus size={20} /> I paid for something
        </button>
      ) : (
        <form onSubmit={submit} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">What was it for?</label>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORIES.map(c => (
                <button key={c} type="button" onClick={() => setForm({ ...form, category: c })}
                  className={`py-2.5 px-2 rounded-xl text-xs font-medium ${form.category === c ? 'bg-slate-800 text-white' : 'bg-gray-50 text-gray-600 border border-gray-200'}`}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">How much did you pay?</label>
            <input required type="number" inputMode="decimal" min="0.01" step="0.01" value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              className="w-full border border-gray-300 rounded-xl px-3 py-3 text-lg outline-none focus:ring-2 focus:ring-slate-800" />
          </div>
          {isCourier && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Which parcel was it for?</label>
              <select value={form.saleId} onChange={e => setForm({ ...form, saleId: e.target.value })}
                className="w-full border border-gray-300 rounded-xl px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-slate-800">
                <option value="">Not sure / not on my list</option>
                {runs.map(d => (
                  <option key={d.id} value={d.saleId}>
                    {d.orderNumber} — {d.customerName || 'Customer'}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {form.saleId
                  ? 'The fee goes on this order as its delivery cost, and the company owes it back to you.'
                  : 'Pick the order if you can — the fee then lands on it as the delivery cost.'}
              </p>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Note (optional)</label>
            <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="e.g. parcel to Ndola for Mrs Banda"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-slate-800" />
          </div>
          <label className="flex items-start gap-2.5 bg-gray-50 rounded-xl p-3">
            <input type="checkbox" checked={form.rechargeable} onChange={e => setForm({ ...form, rechargeable: e.target.checked })}
              className="mt-0.5 w-5 h-5" />
            <span className="text-sm text-gray-700">
              The customer should pay this back
              <span className="block text-xs text-gray-400">Tick for courier fees you paid on a customer's parcel.</span>
            </span>
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-3 border border-gray-200 rounded-xl text-sm font-medium">Cancel</button>
            <button type="submit" disabled={submitting} className="flex-1 py-3 bg-emerald-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}

      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">What you have paid</h3>
        {expenses.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6 bg-white rounded-2xl border border-gray-100">Nothing logged yet.</p>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
            {expenses.map(x => (
              <div key={x.id} className="flex items-center justify-between gap-3 p-3.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-800">
                    {formatMoney(x.amount)}
                    <span className="text-xs text-gray-400 font-normal ml-2">{x.category}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {formatDate(x.date)}
                    {x.sale?.orderNumber ? ` · ${x.sale.orderNumber}` : ''}
                    {x.description ? ` · ${x.description}` : ''}
                  </div>
                  {x.onSaleShipping && (
                    <div className="text-xs text-blue-600 mt-0.5">on {x.sale?.orderNumber || 'the order'} as its delivery cost</div>
                  )}
                  {x.settledAt && (
                    <div className="text-xs text-emerald-600 mt-0.5 flex items-center gap-1"><FiCheck size={11} /> settled by the office</div>
                  )}
                </div>
                {x.settledAt ? (
                  <FiLock size={14} className="text-gray-300 shrink-0" />
                ) : (
                  <button onClick={() => remove(x)} className="p-2 text-gray-400 shrink-0"><FiTrash2 size={16} /></button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
