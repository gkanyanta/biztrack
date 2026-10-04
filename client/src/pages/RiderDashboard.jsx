import { useState, useEffect } from 'react';
import { getMyRuns, updateDeliveryStatus } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiPhone, FiMapPin, FiPackage, FiCheck, FiX, FiTruck, FiDollarSign, FiNavigation, FiChevronLeft, FiChevronRight, FiCalendar, FiEdit2, FiLock } from 'react-icons/fi';
import RiderExpenses from '../components/RiderExpenses';
import RiderDayReport from '../components/RiderDayReport';

// Three screens rather than a nav: the runs he is on, the money passing through his hands, and
// his account of the day. Still one page, still big targets.
const RIDER_TABS = [
  { key: 'runs', label: 'Runs' },
  { key: 'money', label: 'Money' },
  { key: 'report', label: 'My day' },
];

// The rider's whole app. Built for one hand on a phone: big targets, no tables, no nav
// beyond this page. Everything he needs for a drop is on the card — who, where, what,
// and how much to collect.

// Walk one day along from a YYYY-MM-DD key.
function shiftDay(key, delta) {
  const d = new Date(key + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

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
  const [tab, setTab] = useState('runs');
  const [form, setForm] = useState({ recipientName: '', cashCollected: '' });
  const [failForm, setFailForm] = useState({ failureReason: FAILURE_REASONS[0], notes: '' });

  // Which day he is looking at. Today unless he steps back, and stepping back is the point:
  // his own record used to end at midnight, so a day he had not settled was gone by morning.
  const [date, setDate] = useState(null);
  const load = () => getMyRuns(date).then(res => setData(res.data)).finally(() => setLoading(false));
  useEffect(() => { setLoading(true); load(); }, [date]);

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
    const done = d.status === 'Delivered';
    setForm({
      recipientName: done ? (d.recipientName || '') : '',
      cashCollected: done ? String(parseFloat(d.cashCollected) || 0)
                          : (d.amountToCollect > 0 ? String(d.amountToCollect) : '0'),
    });
    setCompleting(d);
  };

  const openFail = (d) => {
    setFailForm({
      failureReason: d.failureReason && FAILURE_REASONS.includes(d.failureReason) ? d.failureReason : FAILURE_REASONS[0],
      notes: d.notes || '',
    });
    setFailing(d);
  };

  // He can fix his own finished work until the office has acted on it — banked the cash or checked
  // the day. After that a change here would disagree with their books, so it is theirs to make.
  const canFix = (d) => !d.cashRemitted && !data?.dayChecked;

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

      <div className="grid grid-cols-3 gap-2">
        {RIDER_TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`py-2.5 rounded-xl text-sm font-semibold transition-colors ${tab === t.key ? 'bg-slate-800 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'money' && <RiderExpenses />}
      {tab === 'report' && <RiderDayReport />}

      {tab === 'runs' && (<>
      {/* Yesterday and the days before it, one tap back at a time. */}
      <div className="flex items-center justify-between gap-2 bg-white rounded-xl border border-gray-200 px-2 py-2">
        <button onClick={() => setDate(shiftDay(data.date, -1))}
          className="px-3 py-2 rounded-lg text-sm font-medium text-gray-600 active:bg-gray-100 flex items-center gap-1">
          <FiChevronLeft size={16} /> Earlier
        </button>
        <div className="text-sm font-semibold text-gray-800">{data.isToday ? 'Today' : formatDate(data.date)}</div>
        {data.isToday ? (
          <span className="px-3 py-2 text-sm text-transparent select-none">Later</span>
        ) : (
          <button onClick={() => setDate(shiftDay(data.date, 1))}
            className="px-3 py-2 rounded-lg text-sm font-medium text-gray-600 active:bg-gray-100 flex items-center gap-1">
            Later <FiChevronRight size={16} />
          </button>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="Delivered" value={today.delivered} tone="green" />
        <Stat label="Still out" value={today.outstanding} />
        <Stat label="Failed" value={today.failed} tone={today.failed > 0 ? 'amber' : 'slate'} />
        <Stat label="Cash held" value={formatMoney(today.cashToRemit)} tone={today.cashToRemit > 0 ? 'amber' : 'slate'} />
      </div>

      {today.cashToRemit > 0 && data.isToday && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          <FiDollarSign className="mt-0.5 shrink-0" size={16} />
          <span>You are holding <strong>{formatMoney(today.cashToRemit)}</strong> in customer payments. Hand it in before the end of the day.</span>
        </div>
      )}

      {data.isToday && (
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
                  <button onClick={() => openFail(d)} disabled={busyId === d.id}
                    className="px-4 py-3 border border-red-200 text-red-600 rounded-xl text-sm font-medium disabled:opacity-50">
                    <FiX size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {completedToday.length === 0 && !data.isToday && (
        <div className="text-center py-10 bg-white rounded-xl border border-gray-100">
          <FiCalendar className="mx-auto mb-2 text-gray-300" size={28} />
          <p className="text-gray-500 text-sm">Nothing recorded on this day.</p>
        </div>
      )}

      {completedToday.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">{data.isToday ? 'Done today' : 'Done that day'}</h3>
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
                  {canFix(d) ? (
                    <button onClick={() => (d.status === 'Delivered' ? openComplete(d) : openFail(d))}
                      className="mt-1 text-xs font-medium text-slate-600 underline flex items-center gap-1 ml-auto">
                      <FiEdit2 size={11} /> Fix
                    </button>
                  ) : (
                    <div className="mt-1 text-[11px] text-gray-400 flex items-center gap-1 justify-end">
                      <FiLock size={10} /> with the office
                    </div>
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
            <h3 className="font-semibold text-gray-800">{completing.status === 'Delivered' ? 'Fix this delivery' : 'Confirm delivery'}</h3>
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
                {busyId === completing.id ? 'Saving…' : completing.status === 'Delivered' ? 'Save the fix' : 'Confirm'}
              </button>
            </div>
            {completing.status === 'Delivered' && (
              // Sometimes the fix is the outcome itself, not the figures.
              <button onClick={() => { const d = completing; setCompleting(null); openFail(d); }}
                className="w-full text-xs text-red-600 underline">It did not actually arrive</button>
            )}
          </div>
        </div>
      )}

      {/* Report a failure */}
      {failing && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={() => setFailing(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800">{failing.status === 'Failed' ? 'Fix what you reported' : 'What went wrong?'}</h3>
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
            {failing.status === 'Delivered' && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-2.5">
                You marked this one delivered. Saving this takes it back off, and takes the {formatMoney(failing.cashCollected)} with it.
              </p>
            )}
            <div className="flex gap-2">
              <button onClick={() => setFailing(null)} className="flex-1 py-3 border border-gray-200 rounded-xl text-sm font-medium">Cancel</button>
              <button disabled={busyId === failing.id}
                onClick={() => setStatus(failing, 'Failed', { failureReason: failForm.failureReason, notes: failForm.notes })}
                className="flex-1 py-3 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
                {busyId === failing.id ? 'Saving…' : failing.status === 'Failed' ? 'Save the fix' : 'Report'}
              </button>
            </div>
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
