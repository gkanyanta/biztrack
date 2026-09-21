import { useState, useEffect } from 'react';
import { getMyRuns, updateDeliveryStatus } from '../services/api';
import { formatMoney } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiPhone, FiMapPin, FiPackage, FiCheck, FiX, FiTruck, FiDollarSign, FiNavigation } from 'react-icons/fi';

// The rider's whole app. Built for one hand on a phone: big targets, no tables, no nav
// beyond this page. Everything he needs for a drop is on the card — who, where, what,
// and how much to collect.

const FAILURE_REASONS = [
  'Customer not available',
  'Wrong or incomplete address',
  'Customer refused the order',
  'Customer could not pay',
  'Could not reach customer by phone',
  'Other',
];

function Stat({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-100 text-emerald-700',
    amber: 'bg-amber-100 text-amber-700',
  };
  return (
    <div className={`rounded-xl px-3 py-2.5 ${tones[tone]}`}>
      <div className="text-xl font-bold leading-tight">{value}</div>
      <div className="text-[11px] font-medium opacity-80">{label}</div>
    </div>
  );
}

export default function RiderDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [failing, setFailing] = useState(null);
  const [form, setForm] = useState({ recipientName: '', cashCollected: '' });
  const [failForm, setFailForm] = useState({ failureReason: FAILURE_REASONS[0], notes: '' });

  const load = () => getMyRuns().then(res => setData(res.data)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const setStatus = async (d, status, extra = {}) => {
    if (busyId) return;
    setBusyId(d.id);
    try {
      await updateDeliveryStatus(d.id, { status, ...extra });
      await load();
      setCompleting(null);
      setFailing(null);
      toast.success(status === 'Delivered' ? 'Delivery recorded' : status === 'Failed' ? 'Marked as failed' : 'Picked up');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update');
    } finally {
      setBusyId(null);
    }
  };

  const openComplete = (d) => {
    setForm({ recipientName: '', cashCollected: d.amountToCollect > 0 ? String(d.amountToCollect) : '0' });
    setCompleting(d);
  };

  if (loading) return <LoadingSpinner />;
  if (!data) return <p className="text-red-500">Could not load your runs.</p>;

  const { open, completedToday, today, rider } = data;

  return (
    <div className="space-y-5 pb-24 max-w-2xl mx-auto">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 rounded-xl p-4 text-white">
        <h2 className="text-lg font-bold">{rider?.name || 'My runs'}</h2>
        <p className="text-slate-300 text-sm">
          {today.outstanding > 0 ? `${today.outstanding} still to deliver` : 'Nothing outstanding — well done'}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="Delivered" value={today.delivered} tone="green" />
        <Stat label="Still out" value={today.outstanding} />
        <Stat label="Failed" value={today.failed} tone={today.failed > 0 ? 'amber' : 'slate'} />
        <Stat label="Cash held" value={formatMoney(today.cashToRemit)} tone={today.cashToRemit > 0 ? 'amber' : 'slate'} />
      </div>

      {today.cashToRemit > 0 && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          <FiDollarSign className="mt-0.5 shrink-0" size={16} />
          <span>You are holding <strong>{formatMoney(today.cashToRemit)}</strong> in customer payments. Hand it in before the end of the day.</span>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">To deliver</h3>
        {open.length === 0 ? (
          <div className="text-center py-10 bg-white rounded-xl border border-gray-100">
            <FiCheck className="mx-auto mb-2 text-emerald-400" size={32} />
            <p className="text-gray-500 text-sm">All clear. Nothing waiting.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {open.map(d => (
              <div key={d.id} className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-800">{d.customerName || 'Customer'}</div>
                    <div className="text-xs text-gray-400">{d.orderNumber}</div>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-[11px] font-medium shrink-0 ${d.status === 'PickedUp' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                    {d.status === 'PickedUp' ? 'On the way' : 'To collect'}
                  </span>
                </div>

                {d.deliveryAddress && (
                  <div className="flex items-start gap-2 text-sm text-gray-600">
                    <FiMapPin className="mt-0.5 shrink-0 text-gray-400" size={14} />
                    <span>{d.deliveryAddress}{d.customerCity ? `, ${d.customerCity}` : ''}</span>
                  </div>
                )}

                <div className="flex items-start gap-2 text-sm text-gray-600">
                  <FiPackage className="mt-0.5 shrink-0 text-gray-400" size={14} />
                  <span>{d.items.map(i => `${i.qty} × ${i.name}`).join(', ') || 'Items not listed'}</span>
                </div>

                {d.amountToCollect > 0 ? (
                  <div className="flex items-center gap-2 bg-amber-50 rounded-lg px-3 py-2 text-sm font-medium text-amber-800">
                    <FiDollarSign size={14} /> Collect {formatMoney(d.amountToCollect)}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 bg-emerald-50 rounded-lg px-3 py-2 text-sm font-medium text-emerald-700">
                    <FiCheck size={14} /> Already paid — collect nothing
                  </div>
                )}

                <div className="flex gap-2">
                  {d.customerPhone && (
                    <a href={`tel:${d.customerPhone}`} className="flex-1 py-2.5 border border-gray-200 text-gray-700 rounded-xl text-sm font-medium flex items-center justify-center gap-1.5 active:bg-gray-50">
                      <FiPhone size={14} /> Call
                    </a>
                  )}
                  {d.deliveryAddress && (
                    <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${d.deliveryAddress} ${d.customerCity || ''}`)}`}
                      target="_blank" rel="noreferrer"
                      className="flex-1 py-2.5 border border-gray-200 text-gray-700 rounded-xl text-sm font-medium flex items-center justify-center gap-1.5 active:bg-gray-50">
                      <FiNavigation size={14} /> Map
                    </a>
                  )}
                </div>

                <div className="flex gap-2">
                  {d.status === 'Assigned' ? (
                    <button onClick={() => setStatus(d, 'PickedUp')} disabled={busyId === d.id}
                      className="flex-1 py-3 bg-slate-800 text-white rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5">
                      <FiTruck size={15} /> Picked up
                    </button>
                  ) : (
                    <button onClick={() => openComplete(d)} disabled={busyId === d.id}
                      className="flex-1 py-3 bg-emerald-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5">
                      <FiCheck size={15} /> Delivered
                    </button>
                  )}
                  <button onClick={() => { setFailForm({ failureReason: FAILURE_REASONS[0], notes: '' }); setFailing(d); }} disabled={busyId === d.id}
                    className="px-4 py-3 border border-red-200 text-red-600 rounded-xl text-sm font-medium disabled:opacity-50">
                    <FiX size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {completedToday.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Done today</h3>
          <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
            {completedToday.map(d => (
              <div key={d.id} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm text-gray-700 truncate">{d.customerName || 'Customer'}</div>
                  <div className="text-xs text-gray-400">{d.orderNumber}{d.status === 'Failed' && d.failureReason ? ` · ${d.failureReason}` : ''}</div>
                </div>
                <div className="text-right shrink-0 ml-3">
                  {d.status === 'Delivered' ? (
                    <>
                      <span className="text-xs font-medium text-emerald-600">Delivered</span>
                      {parseFloat(d.cashCollected) > 0 && <div className="text-xs text-gray-500">{formatMoney(d.cashCollected)}</div>}
                    </>
                  ) : (
                    <span className="text-xs font-medium text-red-500">Failed</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirm a delivery */}
      {completing && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={() => setCompleting(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800">Confirm delivery</h3>
            <p className="text-sm text-gray-500">{completing.customerName} · {completing.orderNumber}</p>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Who received it?</label>
              <input value={form.recipientName} onChange={e => setForm({ ...form, recipientName: e.target.value })}
                placeholder="Name of the person" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-slate-800" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Cash collected</label>
              <input type="number" inputMode="decimal" min="0" step="0.01" value={form.cashCollected}
                onChange={e => setForm({ ...form, cashCollected: e.target.value })}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              {completing.amountToCollect > 0 && (
                <p className="text-xs text-gray-400 mt-1">Expected {formatMoney(completing.amountToCollect)}</p>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setCompleting(null)} className="flex-1 py-3 border border-gray-200 rounded-xl text-sm font-medium">Cancel</button>
              <button disabled={busyId === completing.id}
                onClick={() => setStatus(completing, 'Delivered', { recipientName: form.recipientName, cashCollected: parseFloat(form.cashCollected) || 0 })}
                className="flex-1 py-3 bg-emerald-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
                {busyId === completing.id ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Report a failure */}
      {failing && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={() => setFailing(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800">What went wrong?</h3>
            <p className="text-sm text-gray-500">{failing.customerName} · {failing.orderNumber}</p>
            <div className="space-y-2">
              {FAILURE_REASONS.map(reason => (
                <button key={reason} onClick={() => setFailForm({ ...failForm, failureReason: reason })}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-sm border transition-colors ${failForm.failureReason === reason ? 'border-slate-800 bg-slate-50 font-medium' : 'border-gray-200'}`}>
                  {reason}
                </button>
              ))}
            </div>
            <input value={failForm.notes} onChange={e => setFailForm({ ...failForm, notes: e.target.value })}
              placeholder="Anything to add (optional)" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-slate-800" />
            <div className="flex gap-2">
              <button onClick={() => setFailing(null)} className="flex-1 py-3 border border-gray-200 rounded-xl text-sm font-medium">Cancel</button>
              <button disabled={busyId === failing.id}
                onClick={() => setStatus(failing, 'Failed', { failureReason: failForm.failureReason, notes: failForm.notes })}
                className="flex-1 py-3 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
                {busyId === failing.id ? 'Saving…' : 'Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
