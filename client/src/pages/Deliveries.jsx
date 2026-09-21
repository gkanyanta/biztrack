import { useState, useEffect } from 'react';
import {
  getRiders, createRider, updateRider, createRiderLogin,
  getUnassignedOrders, getDeliveries, assignDeliveries, reassignDelivery,
  remitDeliveryCash, deleteDelivery, getDeliveryPerformance,
} from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import {
  FiTruck, FiPlus, FiUser, FiCheck, FiX, FiDollarSign, FiKey, FiTrash2, FiAlertCircle, FiClock,
} from 'react-icons/fi';

const TABS = [
  { key: 'assign', label: 'Assign' },
  { key: 'active', label: 'In progress' },
  { key: 'cash', label: 'Cash' },
  { key: 'performance', label: 'Performance' },
  { key: 'riders', label: 'Riders' },
];

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
  const [tab, setTab] = useState('assign');
  const [loading, setLoading] = useState(true);
  const [riders, setRiders] = useState([]);
  const [unassigned, setUnassigned] = useState([]);
  const [active, setActive] = useState([]);
  const [cashRows, setCashRows] = useState([]);
  const [perf, setPerf] = useState(null);
  const [selected, setSelected] = useState([]);
  const [assignTo, setAssignTo] = useState('');
  const [cityFilter, setCityFilter] = useState('Lusaka');
  const [submitting, setSubmitting] = useState(false);
  const [showRiderForm, setShowRiderForm] = useState(false);
  const [riderForm, setRiderForm] = useState({ name: '', phone: '', nrc: '', licenceNo: '', startDate: '' });
  const [loginFor, setLoginFor] = useState(null);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      getRiders(),
      getUnassignedOrders({ city: cityFilter || undefined }),
      getDeliveries({ open: 'true' }),
      getDeliveries({ unremitted: 'true' }),
      getDeliveryPerformance(),
    ])
      .then(([r, u, a, c, p]) => {
        setRiders(r.data);
        setUnassigned(u.data);
        setActive(a.data);
        setCashRows(c.data);
        setPerf(p.data);
        if (!assignTo) {
          const firstActive = r.data.find(x => x.isActive);
          if (firstActive) setAssignTo(firstActive.id);
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
      await assignDeliveries({ riderId: assignTo || null, saleIds: selected });
      toast.success(`${selected.length} order${selected.length === 1 ? '' : 's'} assigned`);
      setSelected([]);
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

  const remit = async (d, value) => {
    try {
      await remitDeliveryCash(d.id, value);
      toast.success(value ? 'Marked as received' : 'Marked as outstanding');
      loadAll();
    } catch { toast.error('Could not update'); }
  };

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
        {TABS.map(t => (
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
              <label className="block text-xs font-medium text-gray-600 mb-1">Assign to</label>
              <select value={assignTo} onChange={e => setAssignTo(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800">
                <option value="">Unassigned</option>
                {riders.filter(r => r.isActive).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <button onClick={handleAssign} disabled={!selected.length || submitting}
              className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium disabled:opacity-40">
              {submitting ? 'Assigning…' : `Assign ${selected.length || ''}`.trim()}
            </button>
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
                        onChange={e => setSelected(e.target.checked ? unassigned.map(s => s.id) : [])} />
                    </th>
                    <th className="text-left p-3">Order</th>
                    <th className="text-left p-3 hidden sm:table-cell">Customer</th>
                    <th className="text-left p-3 hidden lg:table-cell">Address</th>
                    <th className="text-right p-3">To collect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {unassigned.map(s => (
                    <tr key={s.id} className={`hover:bg-gray-50 ${selected.includes(s.id) ? 'bg-slate-50' : ''}`}>
                      <td className="p-3"><input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} /></td>
                      <td className="p-3">
                        <div className="font-medium text-gray-700">{s.orderNumber}</div>
                        <div className="text-xs text-gray-400">{formatDate(s.date)}</div>
                      </td>
                      <td className="p-3 hidden sm:table-cell">
                        <div className="text-gray-700">{s.customerName || '-'}</div>
                        <div className="text-xs text-gray-400">{s.customerPhone || ''}</div>
                      </td>
                      <td className="p-3 hidden lg:table-cell text-gray-600 text-xs">{s.deliveryAddress || '—'}{s.customerCity ? `, ${s.customerCity}` : ''}</td>
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
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-1 rounded-full text-[11px] font-medium ${STATUS_STYLES[d.status]}`}>{d.status === 'PickedUp' ? 'On the way' : d.status}</span>
                    {d.amountToCollect > 0 && <span className="text-xs font-medium text-amber-700">{formatMoney(d.amountToCollect)} to collect</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <select value={d.rider?.id || ''} onChange={async (e) => { await reassignDelivery(d.id, e.target.value || null); toast.success('Reassigned'); loadAll(); }}
                    className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none">
                    <option value="">Unassigned</option>
                    {riders.filter(r => r.isActive).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
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
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-semibold text-gray-800">{formatMoney(d.cashCollected)}</span>
                    <button onClick={() => remit(d, true)} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium">Received</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
            <FiPlus size={15} /> Add rider
          </button>

          {showRiderForm && (
            <form onSubmit={handleRiderSubmit} className="bg-white rounded-xl border border-gray-100 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input required value={riderForm.name} onChange={e => setRiderForm({ ...riderForm, name: e.target.value })} placeholder="Full name"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <input value={riderForm.phone} onChange={e => setRiderForm({ ...riderForm, phone: e.target.value })} placeholder="Phone"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <input value={riderForm.nrc} onChange={e => setRiderForm({ ...riderForm, nrc: e.target.value })} placeholder="NRC number"
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800" />
              <input value={riderForm.licenceNo} onChange={e => setRiderForm({ ...riderForm, licenceNo: e.target.value })} placeholder="Rider's licence number"
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
                  <div className="text-xs text-gray-500">{r.phone || 'no phone'}{r.licenceNo ? ` · licence ${r.licenceNo}` : ''}</div>
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
    </div>
  );
}
