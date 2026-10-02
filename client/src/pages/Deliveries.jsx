import { useState, useEffect } from 'react';
import {
  getRiders, createRider, updateRider, createRiderLogin,
  getUnassignedOrders, getDeliveries, assignDeliveries, reassignDelivery,
  remitDeliveryCash, deleteDelivery, getDeliveryPerformance, updateDeliveryStatus,
} from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import {
  FiTruck, FiPlus, FiUser, FiCheck, FiX, FiDollarSign, FiKey, FiTrash2, FiAlertCircle, FiClock,
} from 'react-icons/fi';
import RiderExpenseReview from '../components/RiderExpenseReview';
import RiderReportReview from '../components/RiderReportReview';
import DispatchActivity from '../components/DispatchActivity';
import CourierRuns from '../components/CourierRuns';
import AwaitingPayment from '../components/AwaitingPayment';
import { useAuth } from '../hooks/useAuth';
import Modal from '../components/Modal';
import CarrierSelect, { encodeCarrier, decodeCarrier } from '../components/CarrierSelect';

// money: true means the tab reads or moves money, which stays with an admin. The inventory
// role assigns and watches runs; it does not reconcile cash or settle the rider's expenses.
const TABS = [
  { key: 'assign', label: 'Assign' },
  { key: 'active', label: 'In progress' },
  { key: 'runs', label: 'Courier runs' },
  { key: 'owed', label: 'Awaiting payment', money: true },
  { key: 'cash', label: 'Cash', money: true },
  { key: 'performance', label: 'Performance', money: true },
  { key: 'expenses', label: 'His spending', money: true },
  { key: 'reports', label: 'Daily reports', money: true },
  { key: 'riders', label: 'Who delivers', money: true },
  // An oversight view, so it belongs with the admin-only tabs.
  { key: 'activity', label: 'Who did what', money: true },
];

// 'rider' on a delivery means we carried it ourselves, which includes the owner in a car.
const COURIER_LABELS = { rider: 'Us', yango: 'Yango', other: 'Hired courier' };

// The office closes a delivery for reasons a rider on a doorstep would not phrase the same way.
const OFFICE_FAILURE_REASONS = [
  'Customer not available',
  'Wrong or incomplete address',
  'Customer refused the order',
  'Customer could not pay',
  'Courier could not deliver',
  'Other',
];

// Ready-first is the default because a packed order is the one physically waiting to go out.
// Oldest-first is the one that earns its keep though: the order nobody has sent is the order
// that has been sitting longest, and newest-first hides exactly that.
const ASSIGN_SORTS = {
  ready: { label: 'Ready to go first', compare: (a, b) => (a.isReady ? 0 : 1) - (b.isReady ? 0 : 1) || new Date(b.date) - new Date(a.date) },
  newest: { label: 'Newest first', compare: (a, b) => new Date(b.date) - new Date(a.date) },
  oldest: { label: 'Oldest first', compare: (a, b) => new Date(a.date) - new Date(b.date) },
};

const STATUS_STYLES = {
  Assigned: 'bg-slate-100 text-slate-700',
  PickedUp: 'bg-blue-100 text-blue-700',
  Delivered: 'bg-emerald-100 text-emerald-700',
  Failed: 'bg-red-100 text-red-700',
};

function Card({ label, value, sub, tone = 'slate' }) {
  const tones = { slate: 'text-slate-800', green: 'text-emerald-600', red: 'text-red-600', amber: 'text-amber-600' };
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${tones[tone]}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

export default function Deliveries() {
  const { user } = useAuth();
  const canSeeMoney = user?.role === 'admin' || user?.role === 'superadmin';
  const visibleTabs = TABS.filter(t => canSeeMoney || !t.money);
  const [tab, setTab] = useState('assign');
  const [loading, setLoading] = useState(true);
  const [riders, setRiders] = useState([]);
  const [unassigned, setUnassigned] = useState([]);
  const [active, setActive] = useState([]);
  const [cashRows, setCashRows] = useState([]);
  const [remittedRows, setRemittedRows] = useState([]);
  const [perf, setPerf] = useState(null);
  const [selected, setSelected] = useState([]);
  // 'rider:<id>' for one of ours, 'hire:yango' or 'hire:other' for a car booked for the trip.
  const [carrier, setCarrier] = useState('');
  const [fareForm, setFareForm] = useState({ cost: '', ref: '' });
  const [assignSort, setAssignSort] = useState('ready');
  const [closing, setClosing] = useState(null);
  const [closeForm, setCloseForm] = useState({ recipientName: '', cashCollected: '' });
  const [failing, setFailing] = useState(null);
  const [failReason, setFailReason] = useState('');
  const [cityFilter, setCityFilter] = useState('Lusaka');
  const [submitting, setSubmitting] = useState(false);
  const [showRiderForm, setShowRiderForm] = useState(false);
  const [riderForm, setRiderForm] = useState({ name: '', phone: '', nrc: '', licenceNo: '', vehicle: '', startDate: '' });
  const [loginFor, setLoginFor] = useState(null);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });

  const loadAll = () => {
    setLoading(true);
    // Only ask for what this role may have. Requesting the money endpoints as inventory would
    // 403 and take the whole page down with it.
    Promise.all([
      getRiders(),
      getUnassignedOrders({ city: cityFilter || undefined }),
      getDeliveries({ open: 'true' }),
      canSeeMoney ? getDeliveries({ unremitted: 'true' }) : Promise.resolve({ data: [] }),
      canSeeMoney ? getDeliveries({ remitted: 'true' }) : Promise.resolve({ data: [] }),
      canSeeMoney ? getDeliveryPerformance() : Promise.resolve({ data: null }),
    ])
      .then(([r, u, a, c, cr, p]) => {
        setRiders(r.data);
        setUnassigned(u.data);
        setActive(a.data);
        setCashRows(c.data);
        setRemittedRows(cr.data);
        setPerf(p.data);
        if (!carrier) {
          const firstActive = r.data.find(x => x.isActive);
          if (firstActive) setCarrier(`rider:${firstActive.id}`);
        }
      })
      .catch(() => toast.error('Could not load deliveries'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, [cityFilter]);

  const toggle = (id) => setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleAssign = async () => {
    if (submitting || !selected.length) return;
    setSubmitting(true);
    try {
      await assignDeliveries({
        saleIds: selected,
        ...(hiring
          ? { courier: carrier.slice('hire:'.length), courierCost: fareForm.cost || undefined, courierRef: fareForm.ref || undefined }
          : { riderId: carrier.startsWith('rider:') ? carrier.slice('rider:'.length) : null }),
      });
      toast.success(`${selected.length} order${selected.length === 1 ? '' : 's'} assigned`);
      setSelected([]);
      setFareForm({ cost: '', ref: '' });
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not assign');
    } finally { setSubmitting(false); }
  };

  const handleRiderSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await createRider(riderForm);
      toast.success('Rider added');
      setShowRiderForm(false);
      setRiderForm({ name: '', phone: '', nrc: '', licenceNo: '', startDate: '' });
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save rider');
    } finally { setSubmitting(false); }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await createRiderLogin(loginFor.id, loginForm);
      toast.success(`Login created for ${loginFor.name}`);
      setLoginFor(null);
      setLoginForm({ username: '', password: '' });
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not create login');
    } finally { setSubmitting(false); }
  };

  // The same endpoint the rider's phone calls. An admin has always been allowed to use it; there
  // was simply no way to reach it from here.
  const openClose = (d) => {
    setClosing(d);
    setCloseForm({ recipientName: '', cashCollected: d.amountToCollect > 0 ? String(d.amountToCollect) : '0' });
  };
  const submitClose = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await updateDeliveryStatus(closing.id, {
        status: 'Delivered',
        recipientName: closeForm.recipientName || null,
        cashCollected: parseFloat(closeForm.cashCollected) || 0,
      });
      toast.success(`${closing.orderNumber} marked delivered`);
      setClosing(null);
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not close it');
    } finally { setSubmitting(false); }
  };

  const openFail = (d) => { setFailing(d); setFailReason(OFFICE_FAILURE_REASONS[0]); };
  const submitFail = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await updateDeliveryStatus(failing.id, { status: 'Failed', failureReason: failReason });
      toast.success(`${failing.orderNumber} marked failed`);
      setFailing(null);
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update it');
    } finally { setSubmitting(false); }
  };

  const remit = async (d, value) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await remitDeliveryCash(d.id, value);
      toast.success(value ? `${formatMoney(d.cashCollected)} posted to ${d.orderNumber}` : 'Payment reversed — back to outstanding');
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update');
    } finally { setSubmitting(false); }
  };

  const hiring = carrier.startsWith('hire:');
  const sortedUnassigned = unassigned.slice().sort(ASSIGN_SORTS[assignSort].compare);

  if (loading) return <LoadingSpinner />;

  const cashTotal = cashRows.reduce((s, d) => s + parseFloat(d.cashCollected), 0);

  return (
    <div className="space-y-5 pb-20">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><FiTruck /> Deliveries</h1>
          <p className="text-sm text-gray-500">Assign runs, track the bike, and see whether it is paying for itself</p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {visibleTabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-full text-sm whitespace-nowrap font-medium transition-colors ${tab === t.key ? 'bg-slate-800 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}>
            {t.label}
            {t.key === 'active' && active.length > 0 && <span className="ml-1.5 text-xs opacity-75">{active.length}</span>}
            {t.key === 'cash' && cashRows.length > 0 && <span className="ml-1.5 text-xs opacity-75">{cashRows.length}</span>}
          </button>
        ))}
      </div>

      {/* ---- ASSIGN ---- */}
      {tab === 'assign' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3 bg-white rounded-xl border border-gray-100 p-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
              <input value={cityFilter} onChange={e => setCityFilter(e.target.value)} placeholder="All cities"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Order by</label>
              <select value={assignSort} onChange={e => setAssignSort(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800">
                {Object.entries(ASSIGN_SORTS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Who is taking it</label>
              <CarrierSelect riders={riders} value={carrier} onChange={setCarrier}
                unsetLabel="One of us — not decided yet"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
            </div>
            {hiring && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Fare per order</label>
                  <input type="number" min="0" step="0.01" value={fareForm.cost}
                    onChange={e => setFareForm({ ...fareForm, cost: e.target.value })}
                    placeholder="0.00"
                    className="w-28 px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reference</label>
                  <input value={fareForm.ref} onChange={e => setFareForm({ ...fareForm, ref: e.target.value })}
                    placeholder="Driver, plate, trip"
                    className="w-40 px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
                </div>
              </>
            )}
            <button onClick={handleAssign} disabled={!selected.length || submitting}
              className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium disabled:opacity-40">
              {submitting ? 'Assigning…' : `Assign ${selected.length || ''}`.trim()}
            </button>
            {hiring && (
              <p className="text-xs text-gray-400 w-full">
                The fare is recorded against each order as its delivery cost, so a hired trip can be
                compared with what the bike costs. Bill the customer on the order's delivery charge.
              </p>
            )}
          </div>

          {unassigned.length === 0 ? (
            <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
              <FiCheck className="mx-auto mb-2 text-emerald-400" size={30} />
              <p className="text-gray-500 text-sm">Every order{cityFilter ? ` in ${cityFilter}` : ''} already has a delivery.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs">
                  <tr>
                    <th className="p-3 w-10">
                      <input type="checkbox" checked={selected.length === unassigned.length && unassigned.length > 0}
                        onChange={e => setSelected(e.target.checked ? sortedUnassigned.map(s => s.id) : [])} />
                    </th>
                    <th className="text-left p-3">Order</th>
                    <th className="text-left p-3">Customer &amp; where</th>
                    <th className="text-left p-3">What is going</th>
                    <th className="text-right p-3">To collect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {sortedUnassigned.map(s => (
                    <tr key={s.id} className={`hover:bg-gray-50 ${selected.includes(s.id) ? 'bg-slate-50' : ''}`}>
                      <td className="p-3"><input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} /></td>
                      <td className="p-3 align-top">
                        <div className="font-medium text-gray-700">{s.orderNumber}</div>
                        <div className="text-xs text-gray-400">
                          {formatDate(s.date)}
                          {(() => {
                            const days = Math.floor((Date.now() - new Date(s.date)) / 86400000);
                            if (days < 2) return null;
                            return <span className={days >= 7 ? 'text-amber-600 ml-1' : 'ml-1'}>· {days}d waiting</span>;
                          })()}
                        </div>
                        {/* Packed by the warehouse, so this is the one actually waiting to go. */}
                        {s.isReady && (
                          <span className="inline-block mt-1 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium">READY</span>
                        )}
                      </td>
                      <td className="p-3 align-top">
                        <div className="text-gray-700">{s.customerName || 'Walk-in'}</div>
                        {s.customerPhone && <div className="text-xs text-gray-500">{s.customerPhone}</div>}
                        <div className="text-xs text-gray-500 mt-0.5">
                          {s.deliveryAddress || <span className="text-amber-600">no address given</span>}
                          {s.customerCity ? `${s.deliveryAddress ? ', ' : ''}${s.customerCity}` : ''}
                        </div>
                      </td>
                      <td className="p-3 align-top text-xs text-gray-600">
                        {(s.items || []).length === 0 ? <span className="text-gray-400">—</span> : (
                          <div className="space-y-0.5">
                            {s.items.map((i, n) => (
                              <div key={n}>{i.qty > 1 && <span className="text-gray-400">{i.qty}× </span>}{i.name}</div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-right font-medium">{s.amountToCollect > 0 ? formatMoney(s.amountToCollect) : <span className="text-emerald-600 text-xs">Paid</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ---- IN PROGRESS ---- */}
      {tab === 'active' && (
        active.length === 0 ? (
          <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
            <FiCheck className="mx-auto mb-2 text-emerald-400" size={30} />
            <p className="text-gray-500 text-sm">Nothing out on the road.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {active.map(d => (
              <div key={d.id} className="bg-white rounded-xl border border-gray-100 p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-800">{d.customerName || 'Customer'} <span className="text-xs text-gray-400 ml-1">{d.orderNumber}</span></div>
                    <div className="text-xs text-gray-500 mt-0.5">{d.deliveryAddress || 'No address'}{d.customerCity ? `, ${d.customerCity}` : ''}</div>
                    <div className="text-xs text-gray-400 mt-1 flex items-center gap-1"><FiClock size={11} /> assigned {formatDate(d.assignedAt)}{d.attempts > 1 ? ` · attempt ${d.attempts}` : ''}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {/* Who is carrying it, what the trip cost if we hired one, and whether the
                          warehouse ever touched it. */}
                      {d.courier === 'rider'
                        ? (d.rider ? `${d.rider.name}${d.rider.vehicle ? ` · ${d.rider.vehicle}` : ''}` : 'nobody carrying it yet')
                        : `${COURIER_LABELS[d.courier] || d.courier}${d.courierRef ? ` · ${d.courierRef}` : ''}`}
                      {d.courier !== 'rider' && d.courierCost > 0 && (
                        <span className="text-gray-400"> · fare {formatMoney(d.courierCost)}</span>
                      )}
                      <span className="text-gray-400"> · from {d.dispatchedFrom}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`px-2 py-1 rounded-full text-[11px] font-medium ${STATUS_STYLES[d.status]}`}>{d.status === 'PickedUp' ? 'On the way' : d.status}</span>
                    {d.amountToCollect > 0 && <span className="text-xs font-medium text-amber-700">{formatMoney(d.amountToCollect)} to collect</span>}
                    {!d.rider && (
                      <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-medium">
                        office closes this
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <CarrierSelect riders={riders} value={encodeCarrier(d)}
                    onChange={async (v) => {
                      try {
                        await reassignDelivery(d.id, decodeCarrier(v));
                        toast.success('Handed over');
                        loadAll();
                      } catch (err) { toast.error(err.response?.data?.error || 'Could not hand it over'); }
                    }}
                    className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none" />
                  <button onClick={() => openClose(d)}
                    className="px-2.5 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium">Delivered</button>
                  <button onClick={() => openFail(d)}
                    className="px-2.5 py-1.5 border border-red-200 text-red-700 rounded-lg text-xs font-medium">Failed</button>
                  <button onClick={async () => { if (!window.confirm('Remove this delivery? The order goes back to unassigned.')) return; await deleteDelivery(d.id); toast.success('Removed'); loadAll(); }}
                    className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ---- CASH ---- */}
      {tab === 'cash' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-gray-500">Collected but not yet handed in</div>
              <div className="text-2xl font-bold text-amber-600">{formatMoney(cashTotal)}</div>
              <div className="text-xs text-gray-400 mt-1">
                Still counted as owed on the order until you confirm it arrived.
              </div>
            </div>
            <FiDollarSign className="text-amber-400" size={28} />
          </div>
          {cashRows.length === 0 ? (
            <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
              <FiCheck className="mx-auto mb-2 text-emerald-400" size={30} />
              <p className="text-gray-500 text-sm">All money collected has been accounted for.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
              {cashRows.map(d => (
                <div key={d.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="text-sm text-gray-800">{d.customerName} <span className="text-xs text-gray-400 ml-1">{d.orderNumber}</span></div>
                    <div className="text-xs text-gray-500">{d.rider?.name || 'Unassigned'} · delivered {formatDate(d.deliveredAt)}</div>
                    {/* The rider can hand over more than the order was short of — the excess is his to explain. */}
                    {parseFloat(d.cashCollected) > d.amountToCollect && d.amountToCollect > 0 && (
                      <div className="text-xs text-amber-600 mt-0.5">
                        {formatMoney(parseFloat(d.cashCollected) - d.amountToCollect)} more than the {formatMoney(d.amountToCollect)} outstanding
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-semibold text-gray-800">{formatMoney(d.cashCollected)}</span>
                    <button onClick={() => remit(d, true)} disabled={submitting}
                      title="Records this as a cash payment against the order"
                      className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium disabled:opacity-50">Received</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {remittedRows.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Confirmed received</h3>
              <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
                {remittedRows.slice(0, 15).map(d => (
                  <div key={d.id} className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <div className="text-sm text-gray-800">{d.customerName} <span className="text-xs text-gray-400 ml-1">{d.orderNumber}</span></div>
                      <div className="text-xs text-gray-500">
                        {d.rider?.name || 'Unassigned'} · confirmed {formatDate(d.cashRemittedAt)}
                        {d.cashPosted > 0 && <span className="text-emerald-600"> · {formatMoney(d.cashPosted)} posted to the order</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-semibold text-gray-800">{formatMoney(d.cashCollected)}</span>
                      <button onClick={() => remit(d, false)} disabled={submitting}
                        title="Takes the payment back off the order"
                        className="px-3 py-1.5 border border-gray-200 text-gray-600 rounded-lg text-xs font-medium hover:bg-gray-50 disabled:opacity-50">Undo</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'runs' && <CourierRuns />}
      {tab === 'owed' && <AwaitingPayment />}
      {tab === 'activity' && <DispatchActivity />}
      {tab === 'expenses' && <RiderExpenseReview />}
      {tab === 'reports' && <RiderReportReview />}

      {/* ---- PERFORMANCE ---- */}
      {tab === 'performance' && perf && (
        <div className="space-y-5">
          <p className="text-xs text-gray-400">{perf.from} to {perf.to} · {perf.activeDays} day{perf.activeDays === 1 ? '' : 's'} with runs</p>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card label="Delivered" value={perf.overall.delivered} sub={`${perf.overall.failed} failed`} tone="green" />
            <Card label="Success rate" value={perf.overall.successRate != null ? `${perf.overall.successRate.toFixed(0)}%` : '—'} sub="of runs that finished" />
            <Card label="Per active day" value={perf.perDay.toFixed(1)}
              sub={perf.breakEvenPerDay ? `break-even ${perf.breakEvenPerDay.toFixed(1)}` : null}
              tone={perf.breakEvenPerDay && perf.perDay >= perf.breakEvenPerDay ? 'green' : 'red'} />
            <Card label="Cost per delivery" value={perf.costPerDelivery != null ? formatMoney(perf.costPerDelivery) : '—'}
              sub={`vs ${formatMoney(perf.basis.feeCharged)} courier fee`}
              tone={perf.costPerDelivery != null && perf.costPerDelivery <= perf.basis.feeCharged ? 'green' : 'red'} />
          </div>

          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Is the bike paying for itself?</h3>
            <p className="text-sm text-gray-600">
              The bike and rider cost <strong>{formatMoney(perf.basis.monthlyFixed)}</strong> a month
              ({formatMoney(perf.basis.bikeWeekly)}/week hire plus {formatMoney(perf.basis.riderMonthly)} wages).
              At {formatMoney(perf.basis.feeCharged)} a delivery that needs <strong>{Math.ceil(perf.basis.breakEvenPerMonth)}</strong> deliveries
              a month to break even, about <strong>{perf.breakEvenPerDay?.toFixed(1)}</strong> a day.
            </p>
            <p className={`text-sm mt-2 font-medium ${perf.breakEvenPerDay && perf.perDay >= perf.breakEvenPerDay ? 'text-emerald-600' : 'text-red-600'}`}>
              {perf.breakEvenPerDay && perf.perDay >= perf.breakEvenPerDay
                ? `Running at ${perf.perDay.toFixed(1)} a day — ahead of break-even.`
                : `Running at ${perf.perDay.toFixed(1)} a day — below break-even.`}
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="text-left p-3">Rider</th>
                  <th className="text-right p-3">Assigned</th>
                  <th className="text-right p-3">Delivered</th>
                  <th className="text-right p-3">Failed</th>
                  <th className="text-right p-3 hidden sm:table-cell">Success</th>
                  <th className="text-right p-3 hidden md:table-cell">Avg time</th>
                  <th className="text-right p-3">Cash owing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {perf.byRider.map(r => (
                  <tr key={r.rider.id}>
                    <td className="p-3 text-gray-700">{r.rider.name}{!r.rider.isActive && <span className="text-xs text-gray-400 ml-1">inactive</span>}</td>
                    <td className="p-3 text-right">{r.assigned}</td>
                    <td className="p-3 text-right text-emerald-600 font-medium">{r.delivered}</td>
                    <td className="p-3 text-right text-red-500">{r.failed}</td>
                    <td className="p-3 text-right hidden sm:table-cell">{r.successRate != null ? `${r.successRate.toFixed(0)}%` : '—'}</td>
                    <td className="p-3 text-right hidden md:table-cell text-gray-500">{r.avgMinutesToDeliver != null ? `${r.avgMinutesToDeliver}m` : '—'}</td>
                    <td className={`p-3 text-right ${r.cashOutstanding > 0 ? 'text-amber-600 font-medium' : 'text-gray-400'}`}>{formatMoney(r.cashOutstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {perf.failureReasons.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1.5"><FiAlertCircle size={14} /> Why deliveries failed</h3>
              <div className="space-y-2">
                {perf.failureReasons.map(f => (
                  <div key={f.reason} className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">{f.reason}</span>
                    <span className="font-medium text-gray-800">{f.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- RIDERS ---- */}
      {tab === 'riders' && (
        <div className="space-y-4">
          <button onClick={() => setShowRiderForm(!showRiderForm)}
            className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium flex items-center gap-1.5">
            <FiPlus size={15} /> Add someone
          </button>

          {showRiderForm && (
            <form onSubmit={handleRiderSubmit} className="bg-white rounded-xl border border-gray-100 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input required value={riderForm.name} onChange={e => setRiderForm({ ...riderForm, name: e.target.value })} placeholder="Full name"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <input value={riderForm.phone} onChange={e => setRiderForm({ ...riderForm, phone: e.target.value })} placeholder="Phone"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <input value={riderForm.nrc} onChange={e => setRiderForm({ ...riderForm, nrc: e.target.value })} placeholder="NRC number"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <input value={riderForm.vehicle} onChange={e => setRiderForm({ ...riderForm, vehicle: e.target.value })} placeholder="Vehicle — motorbike, car…"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <input value={riderForm.licenceNo} onChange={e => setRiderForm({ ...riderForm, licenceNo: e.target.value })} placeholder="Licence number"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <input type="date" value={riderForm.startDate} onChange={e => setRiderForm({ ...riderForm, startDate: e.target.value })}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowRiderForm(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
                <button type="submit" disabled={submitting} className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {submitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
            {riders.length === 0 && <p className="p-6 text-center text-sm text-gray-500">No riders yet.</p>}
            {riders.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-3 p-4 flex-wrap">
                <div className="min-w-0">
                  <div className="font-medium text-gray-800 flex items-center gap-2">
                    {r.name}
                    {!r.isActive && <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full">inactive</span>}
                  </div>
                  <div className="text-xs text-gray-500">
                    {r.vehicle || 'vehicle not recorded'}{r.phone ? ` · ${r.phone}` : ''}{r.licenceNo ? ` · licence ${r.licenceNo}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {r.hasLogin ? (
                    <span className="text-xs text-emerald-600 flex items-center gap-1"><FiCheck size={12} /> has login</span>
                  ) : (
                    <button onClick={() => { setLoginFor(r); setLoginForm({ username: '', password: '' }); }}
                      className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-medium flex items-center gap-1"><FiKey size={12} /> Create login</button>
                  )}
                  <button onClick={async () => { await updateRider(r.id, { isActive: !r.isActive }); toast.success(r.isActive ? 'Deactivated' : 'Reactivated'); loadAll(); }}
                    className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs">{r.isActive ? 'Deactivate' : 'Reactivate'}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loginFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setLoginFor(null)}>
          <form onSubmit={handleLogin} className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 flex items-center gap-2"><FiUser size={16} /> Login for {loginFor.name}</h3>
            <input required value={loginForm.username} onChange={e => setLoginForm({ ...loginForm, username: e.target.value })}
              placeholder="Username" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-slate-800" />
            <input required type="text" value={loginForm.password} onChange={e => setLoginForm({ ...loginForm, password: e.target.value })}
              placeholder="Password (at least 6 characters)" className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-slate-800" />
            <p className="text-xs text-gray-400">Write these down and give them to the rider — the password is not shown again.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setLoginFor(null)} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm">Cancel</button>
              <button type="submit" disabled={submitting} className="flex-1 py-2.5 bg-slate-800 text-white rounded-xl text-sm font-medium disabled:opacity-50">
                {submitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      <Modal isOpen={!!closing} onClose={() => setClosing(null)} title={closing ? `Close ${closing.orderNumber}` : ''}>
        {closing && (
          <div className="space-y-3">
            <div className="bg-gray-50 rounded-lg p-3 text-sm">
              <div className="text-gray-800">{closing.customerName || 'Customer'}</div>
              <div className="text-xs text-gray-500">{closing.deliveryAddress || 'No address'}{closing.customerCity ? `, ${closing.customerCity}` : ''}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                carried by {closing.courier === 'rider' ? (closing.rider?.name || 'nobody') : (COURIER_LABELS[closing.courier] || closing.courier)}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Who received it?</label>
              <input value={closeForm.recipientName} onChange={e => setCloseForm({ ...closeForm, recipientName: e.target.value })}
                placeholder="Name at the door, if known"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cash collected</label>
              <input type="number" min="0" step="0.01" value={closeForm.cashCollected}
                onChange={e => setCloseForm({ ...closeForm, cashCollected: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-gray-400 mt-1">
                {closing.amountToCollect > 0
                  ? `${formatMoney(closing.amountToCollect)} was outstanding on this order.`
                  : 'This order was already paid, so there should be nothing to collect.'}
                {closing.rider
                  ? ` Anything entered counts as cash ${closing.rider.name} is holding until you confirm it arrived.`
                  : ' A hired courier collects nothing, so leave this at zero unless somebody handed money over.'}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setClosing(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button onClick={submitClose} disabled={submitting}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Saving…' : 'Mark delivered'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!failing} onClose={() => setFailing(null)} title={failing ? `${failing.orderNumber} did not arrive` : ''}>
        {failing && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What happened?</label>
              <select value={failReason} onChange={e => setFailReason(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                {OFFICE_FAILURE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                A fixed list, so failures add up to something readable instead of free text. The
                order stays where it was and can be sent out again.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setFailing(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button onClick={submitFail} disabled={submitting}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Saving…' : 'Mark failed'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
