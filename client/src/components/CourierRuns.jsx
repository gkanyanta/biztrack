import { useState, useEffect } from 'react';
import {
  getCourierRuns, addParcelsToRun, removeParcelFromRun, dispatchCourierRun,
  getUnassignedOrders, getRiders,
} from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { FiPackage, FiPlus, FiTrash2, FiSend, FiCheck, FiClock, FiMapPin, FiUser } from 'react-icons/fi';

// Out-of-town parcels go to Platinum in batches rather than one trip each. A session is a run:
// morning, afternoon, day end. Platinum charges per parcel because every one is going to a
// different customer in a different town, so the fee and the receipt are entered per parcel when
// the run goes out — and that receipt is what the customer is sent, and what they pay against.

const STATUS_TONE = {
  Open: 'bg-blue-100 text-blue-700',
  Dispatched: 'bg-emerald-100 text-emerald-700',
};

export default function CourierRuns({ homeCity = 'Lusaka' }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [candidates, setCandidates] = useState([]);
  const [riders, setRiders] = useState([]);
  const [adding, setAdding] = useState(null);       // the slot being loaded
  const [picked, setPicked] = useState([]);
  const [riderId, setRiderId] = useState('');
  const [dispatching, setDispatching] = useState(null);
  const [fees, setFees] = useState({});
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    Promise.all([getCourierRuns({ date }), getUnassignedOrders(), getRiders()])
      .then(([r, u, rd]) => {
        setData(r.data);
        // Anything not going to the home city needs a courier rather than the bike.
        setCandidates(u.data.filter(o => (o.customerCity || '').trim().toLowerCase() !== homeCity.toLowerCase()));
        setRiders(rd.data.filter(x => x.isActive));
      })
      .catch(() => toast.error('Could not load the runs'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [date]);

  const openAdd = (session) => {
    setAdding(session);
    setPicked([]);
    setRiderId(session.rider?.id || riders[0]?.id || '');
  };

  const submitAdd = async () => {
    if (submitting || !picked.length) return;
    setSubmitting(true);
    try {
      await addParcelsToRun({ date, slot: adding.slot, saleIds: picked, riderId: riderId || null });
      toast.success(`${picked.length} parcel${picked.length === 1 ? '' : 's'} on the ${adding.slotLabel.toLowerCase()}`);
      setAdding(null);
      setLoading(true);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not add those');
    } finally { setSubmitting(false); }
  };

  const pull = async (session, parcel) => {
    try {
      await removeParcelFromRun(session.id, parcel.deliveryId);
      toast.success(`${parcel.orderNumber} taken off the run`);
      setLoading(true);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not remove it'); }
  };

  const openDispatch = (session) => {
    setDispatching(session);
    const seed = {};
    for (const p of session.parcels) seed[p.deliveryId] = { fee: p.fee ? String(p.fee) : '', receiptNo: p.receiptNo || '' };
    setFees(seed);
  };

  const submitDispatch = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await dispatchCourierRun(dispatching.id, {
        parcels: dispatching.parcels.map(p => ({
          deliveryId: p.deliveryId,
          fee: fees[p.deliveryId]?.fee || 0,
          receiptNo: fees[p.deliveryId]?.receiptNo || null,
        })),
      });
      toast.success('Run dispatched — the parcels are now waiting on payment');
      setDispatching(null);
      setLoading(true);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not dispatch');
    } finally { setSubmitting(false); }
  };

  if (loading) return <LoadingSpinner />;
  if (!data) return null;

  const feeTotal = dispatching
    ? dispatching.parcels.reduce((s, p) => s + (parseFloat(fees[p.deliveryId]?.fee) || 0), 0)
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><FiPackage size={15} /> Courier runs</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            {candidates.length} out-of-town order{candidates.length === 1 ? '' : 's'} waiting ·
            {' '}next session {data.next.slot} on {data.next.date}
          </p>
        </div>
        <input type="date" value={date} onChange={e => { setDate(e.target.value); setLoading(true); }}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {data.sessions.map(s => (
          <div key={s.slot} className="bg-white rounded-xl border border-gray-100 p-4 flex flex-col">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-gray-800">{s.slotLabel}</div>
                <div className="text-xs text-gray-400 flex items-center gap-1"><FiClock size={11} /> {s.slot} · {s.courier}</div>
              </div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_TONE[s.status] || 'bg-gray-100 text-gray-600'}`}>
                {s.status === 'Dispatched' ? 'gone' : 'open'}
              </span>
            </div>

            <div className="mt-3 flex-1">
              {s.parcelCount === 0 ? (
                <p className="text-xs text-gray-400 py-3">Nothing on this run yet.</p>
              ) : (
                <>
                  <div className="text-2xl font-bold text-gray-800">{s.parcelCount}</div>
                  <div className="text-xs text-gray-500">parcel{s.parcelCount === 1 ? '' : 's'} to {s.towns.length} town{s.towns.length === 1 ? '' : 's'}</div>
                  <div className="text-xs text-gray-400 mt-1">{s.towns.join(', ')}</div>
                  {s.rider && <div className="text-xs text-gray-500 mt-1 flex items-center gap-1"><FiUser size={11} /> {s.rider.name}</div>}
                  {s.status === 'Dispatched' && (
                    <div className="text-xs text-gray-500 mt-2">
                      fees {formatMoney(s.feesTotal)} · {formatMoney(s.outstandingTotal)} still owed
                    </div>
                  )}
                </>
              )}
            </div>

            {s.status === 'Open' ? (
              <div className="mt-3 flex gap-2">
                <button onClick={() => openAdd(s)} disabled={candidates.length === 0}
                  className="flex-1 py-2 bg-slate-800 text-white rounded-lg text-xs font-medium flex items-center justify-center gap-1 disabled:opacity-40">
                  <FiPlus size={13} /> Load
                </button>
                {s.parcelCount > 0 && (
                  <button onClick={() => openDispatch(s)}
                    className="flex-1 py-2 bg-emerald-600 text-white rounded-lg text-xs font-medium flex items-center justify-center gap-1">
                    <FiSend size={13} /> Dispatch
                  </button>
                )}
              </div>
            ) : (
              <div className="mt-3 text-xs text-emerald-700 flex items-center gap-1">
                <FiCheck size={13} /> went out {formatDate(s.dispatchedAt)}
                {s.dispatchedBy?.name ? ` · ${s.dispatchedBy.name}` : ''}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* The manifest, grouped by customer — a customer with more than one order on the run goes
          in one physical parcel, and seeing that is how it gets bundled correctly. */}
      {data.sessions.filter(s => s.parcelCount > 0).map(s => (
        <div key={`m-${s.slot}`} className="bg-white rounded-xl border border-gray-100 p-4">
          <h4 className="text-sm font-semibold text-gray-700 mb-2">{s.slotLabel} — manifest</h4>
          <div className="divide-y divide-gray-50">
            {s.parcels.map(p => (
              <div key={p.deliveryId} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-gray-800">
                    {p.customerName || 'Customer'}
                    <span className="text-xs text-gray-400 ml-2">{p.orderNumber}</span>
                    {p.consultant && <span className="text-xs text-gray-400 ml-2">via {p.consultant}</span>}
                  </div>
                  <div className="text-xs text-gray-500 flex items-center gap-1">
                    <FiMapPin size={10} /> {p.town || 'no town'}{p.customerPhone ? ` · ${p.customerPhone}` : ''}
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">
                    {p.items.map(i => `${i.qty > 1 ? i.qty + '× ' : ''}${i.name}`).join(', ')}
                  </div>
                  {p.receiptNo && <div className="text-xs text-blue-700 mt-0.5">receipt {p.receiptNo}</div>}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm text-gray-700">{formatMoney(p.orderTotal)}</div>
                  {p.outstanding > 0 && <div className="text-xs text-amber-600">{formatMoney(p.outstanding)} owed</div>}
                  {s.status === 'Open' && (
                    <button onClick={() => pull(s, p)} className="p-1 text-gray-400 hover:text-red-600 mt-1"><FiTrash2 size={13} /></button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ---- LOAD ---- */}
      <Modal isOpen={!!adding} onClose={() => setAdding(null)} title={adding ? `Load the ${adding.slotLabel.toLowerCase()}` : ''}>
        {adding && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Who is taking it to {adding.courier}?</label>
              <select value={riderId} onChange={e => setRiderId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
                <option value="">Nobody yet</option>
                {riders.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                Whoever takes it pays the fees, so the company credits them back.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">Out-of-town orders ready</label>
                <button onClick={() => setPicked(picked.length === candidates.length ? [] : candidates.map(c => c.id))}
                  className="text-xs text-blue-600">{picked.length === candidates.length ? 'none' : 'all'}</button>
              </div>
              {candidates.length === 0 ? (
                <p className="text-sm text-gray-500 py-3">Nothing waiting for a courier.</p>
              ) : (
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-50 max-h-72 overflow-y-auto">
                  {candidates.map(o => (
                    <label key={o.id} className="flex items-start gap-2.5 p-2.5 cursor-pointer hover:bg-gray-50">
                      <input type="checkbox" checked={picked.includes(o.id)} className="mt-1"
                        onChange={() => setPicked(picked.includes(o.id) ? picked.filter(x => x !== o.id) : [...picked, o.id])} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-gray-800">
                          {o.customerName || 'Customer'} <span className="text-xs text-gray-400">{o.orderNumber}</span>
                          {o.isReady && <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded ml-2">READY</span>}
                        </span>
                        <span className="block text-xs text-gray-500">{o.customerCity}{o.customerPhone ? ` · ${o.customerPhone}` : ''}</span>
                        <span className="block text-xs text-gray-600">{(o.items || []).map(i => `${i.qty > 1 ? i.qty + '× ' : ''}${i.name}`).join(', ')}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setAdding(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button onClick={submitAdd} disabled={submitting || !picked.length}
                className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Loading…' : `Add ${picked.length || ''}`.trim()}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ---- DISPATCH ---- */}
      <Modal isOpen={!!dispatching} onClose={() => setDispatching(null)} title={dispatching ? `Dispatch the ${dispatching.slotLabel.toLowerCase()}` : ''}>
        {dispatching && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              {dispatching.courier} charges per parcel. Enter what each one cost and its receipt
              number — the receipt is what the customer is sent as proof it is on its way, and what
              they pay against.
            </p>
            <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
              {dispatching.parcels.map(p => (
                <div key={p.deliveryId} className="py-2.5">
                  <div className="text-sm text-gray-800">
                    {p.customerName || 'Customer'} <span className="text-xs text-gray-400 ml-1">{p.orderNumber}</span>
                  </div>
                  <div className="text-xs text-gray-500 mb-1.5">{p.town} · {p.items.length} item{p.items.length === 1 ? '' : 's'}</div>
                  <div className="flex gap-2">
                    <input type="number" min="0" step="0.01" placeholder="Fee"
                      value={fees[p.deliveryId]?.fee || ''}
                      onChange={e => setFees({ ...fees, [p.deliveryId]: { ...fees[p.deliveryId], fee: e.target.value } })}
                      className="w-24 border border-gray-300 rounded-lg px-2 py-1.5 text-sm outline-none" />
                    <input placeholder="Receipt number"
                      value={fees[p.deliveryId]?.receiptNo || ''}
                      onChange={e => setFees({ ...fees, [p.deliveryId]: { ...fees[p.deliveryId], receiptNo: e.target.value } })}
                      className="flex-1 border border-gray-300 rounded-lg px-2 py-1.5 text-sm outline-none" />
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-sm flex justify-between">
              <span className="text-gray-600">Fees on this run</span>
              <span className="font-bold text-gray-800">{formatMoney(feeTotal)}</span>
            </div>
            {dispatching.rider && feeTotal > 0 && (
              <p className="text-xs text-gray-500">
                {formatMoney(feeTotal)} will be credited to {dispatching.rider.name} as money he laid out.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setDispatching(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button onClick={submitDispatch} disabled={submitting}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Dispatching…' : 'Dispatch the run'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
