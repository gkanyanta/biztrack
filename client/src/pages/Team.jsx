import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiUsers, FiEdit2, FiRepeat, FiPhone, FiHelpCircle } from 'react-icons/fi';
import { getTeam, changeSaleDetails, reassignSale } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import { useAuth } from '../hooks/useAuth';

// The sales supervisor's page, also open to the office: how each consultant is doing this pay
// cycle, the orders still to go out, and the orders still unpaid. From here the supervisor
// corrects a customer's details or moves an order to another consultant, before it goes out.
// Both are logged. Pay and cost figures are not shown here, to anyone.

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500';
const dayText = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export default function Team() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [who, setWho] = useState('');
  const [editFor, setEditFor] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [moveFor, setMoveFor] = useState(null);
  const [moveTo, setMoveTo] = useState('');

  const load = () => {
    setLoading(true);
    getTeam().then(res => setData(res.data)).catch(() => toast.error('Could not load the team')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const act = async (fn, done) => {
    if (submitting) return false;
    setSubmitting(true);
    try { await fn(); toast.success(done); load(); return true; }
    catch (err) { toast.error(err.response?.data?.error || 'Could not save'); return false; }
    finally { setSubmitting(false); }
  };

  const openEdit = (o) => {
    setEditFor(o);
    setEditForm({ customerName: o.customerName || '', customerPhone: o.customerPhone || '', customerCity: o.customerCity || '', deliveryAddress: o.deliveryAddress || '', notes: o.notes || '' });
  };
  const submitEdit = async (e) => {
    e.preventDefault();
    if (await act(() => changeSaleDetails(editFor.id, editForm), `${editFor.orderNumber} updated`)) setEditFor(null);
  };
  const openMove = (o) => { setMoveFor(o); setMoveTo(''); };
  const submitMove = async (e) => {
    e.preventDefault();
    const to = data.consultants.find(c => c.id === moveTo);
    if (await act(() => reassignSale(moveFor.id, moveTo), `${moveFor.orderNumber} moved to ${to?.name}`)) setMoveFor(null);
  };

  if (loading && !data) return <LoadingSpinner />;
  if (!data) return null;

  const { cycle, consultants } = data;
  const shown = (list) => (who ? list.filter(o => o.consultant?.id === who) : list);
  const toGoOut = shown(data.toGoOut);
  const unpaid = shown(data.unpaid);
  const cycleName = `${dayText(cycle.from)} – ${dayText(new Date(new Date(cycle.to).getTime() - 86400000))}`;
  const totals = consultants.reduce((t, c) => ({ orders: t.orders + c.orders, sales: t.sales + c.sales, collected: t.collected + c.collected }), { orders: 0, sales: 0, collected: 0 });

  const orderRow = (o, { actions }) => (
    <div key={o.id} className="p-3 flex flex-wrap items-start gap-3 text-sm">
      <div className="flex-1 min-w-[14rem]">
        <p className="font-medium text-gray-800">
          {o.orderNumber} · {o.customerName || 'No name'}
          <span className="ml-2 text-xs font-normal text-gray-500">{o.consultant?.name || 'No consultant'}</span>
        </p>
        <p className="text-xs text-gray-500">
          {formatDate(o.date)} · {o.status} · {o.paymentStatus}
          {o.balance > 0 && <> · <span className="text-amber-700">{formatMoney(o.balance)} unpaid</span> of {formatMoney(o.total)}</>}
        </p>
        <p className="text-xs text-gray-500 flex items-center gap-1">
          {o.customerPhone && <><FiPhone size={11} /> {o.customerPhone} · </>}
          {[o.deliveryAddress, o.customerCity].filter(Boolean).join(', ') || 'No address'}
        </p>
        {o.notes && <p className="text-xs text-gray-400 mt-0.5">{o.notes}</p>}
      </div>
      {actions && (
        <div className="flex gap-2">
          <button onClick={() => openEdit(o)} className="px-2.5 py-1 border border-gray-200 rounded-lg text-xs flex items-center gap-1 hover:bg-gray-50"><FiEdit2 size={12} /> Details</button>
          <button onClick={() => openMove(o)} className="px-2.5 py-1 border border-gray-200 rounded-lg text-xs flex items-center gap-1 hover:bg-gray-50"><FiRepeat size={12} /> Move</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-5 pb-20 lg:pb-0">
      <div>
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><FiUsers size={20} /> Team</h1>
        <p className="text-xs text-gray-400 mt-0.5">
          Pay cycle {cycleName} · {totals.orders} orders · {formatMoney(totals.sales)} sold · {formatMoney(totals.collected)} collected
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left p-3 font-medium">Consultant</th>
              <th className="text-right p-3 font-medium">Orders</th>
              <th className="text-right p-3 font-medium hidden sm:table-cell">Sold</th>
              <th className="text-left p-3 font-medium">Target</th>
              <th className="text-right p-3 font-medium hidden md:table-cell">To go out</th>
              <th className="text-right p-3 font-medium">Unpaid</th>
              <th className="text-right p-3 font-medium hidden md:table-cell">Queries</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {consultants.map(c => (
              <tr key={c.id} onClick={() => setWho(who === c.id ? '' : c.id)}
                className={`cursor-pointer ${who === c.id ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                <td className="p-3">
                  <div className="font-medium text-gray-800">{c.name}{c.id === user?.consultantId && <span className="text-xs text-gray-400"> (you)</span>}</div>
                  {c.isSupervisor && <div className="text-xs text-indigo-600">Supervisor</div>}
                </td>
                <td className="p-3 text-right">{c.orders}</td>
                <td className="p-3 text-right hidden sm:table-cell">{formatMoney(c.sales)}</td>
                <td className="p-3 min-w-[9rem]">
                  {c.target ? (
                    <>
                      <div className="text-xs text-gray-600">{formatMoney(c.target.collected)} of {formatMoney(c.target.target)}</div>
                      <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1">
                        <div className={`h-1.5 rounded-full ${c.target.reached ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${c.target.progress}%` }} />
                      </div>
                    </>
                  ) : <span className="text-xs text-gray-400">No target set</span>}
                </td>
                <td className="p-3 text-right hidden md:table-cell">{c.toGoOut}</td>
                <td className="p-3 text-right">
                  {c.unpaid.count > 0
                    ? <span className="text-amber-700">{c.unpaid.count} · {formatMoney(c.unpaid.balance)}</span>
                    : <span className="text-gray-400">0</span>}
                </td>
                <td className="p-3 text-right hidden md:table-cell">{c.openQueries > 0 ? <span className="text-amber-700">{c.openQueries}</span> : <span className="text-gray-400">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400 -mt-3">
        Tap a consultant to see only their orders below. Targets count goods value collected, the way the payslip does.
        {consultants.some(c => c.openQueries > 0) && <> Open queries are on the <Link to="/order-queries" className="text-blue-600 hover:underline inline-flex items-center gap-0.5"><FiHelpCircle size={11} /> Order Queries</Link> page.</>}
      </p>

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Still to go out {toGoOut.length > 0 && <span className="text-xs text-gray-400 font-normal">· {toGoOut.length}{who && ` for ${consultants.find(c => c.id === who)?.name}`}</span>}
        </h2>
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
          {toGoOut.length === 0
            ? <p className="p-6 text-center text-sm text-gray-500">Nothing waiting to go out.</p>
            : toGoOut.map(o => orderRow(o, { actions: true }))}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Unpaid, last 90 days {unpaid.length > 0 && <span className="text-xs text-gray-400 font-normal">· {unpaid.length} · {formatMoney(unpaid.reduce((a, o) => a + o.balance, 0))}</span>}
        </h2>
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
          {unpaid.length === 0
            ? <p className="p-6 text-center text-sm text-gray-500">Nothing unpaid.</p>
            : unpaid.map(o => orderRow(o, { actions: o.status === 'Pending' || o.status === 'Confirmed' }))}
        </div>
      </div>

      {/* ---- CUSTOMER DETAILS ---- */}
      <Modal isOpen={!!editFor} onClose={() => setEditFor(null)} title={editFor ? `${editFor.orderNumber}: customer details` : ''}>
        {editFor && (
          <form onSubmit={submitEdit} className="space-y-3">
            {[['customerName', 'Customer name'], ['customerPhone', 'Phone'], ['customerCity', 'Town'], ['deliveryAddress', 'Delivery address']].map(([k, label]) => (
              <div key={k}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
                <input value={editForm[k]} onChange={e => setEditForm({ ...editForm, [k]: e.target.value })} className={inputClass} />
              </div>
            ))}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea rows={2} value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} className={inputClass} />
            </div>
            <p className="text-xs text-gray-400">Recorded on the order with your name. Prices, items and payment stay with {editFor.consultant?.name || 'the consultant'} and the office.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setEditFor(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{submitting ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---- MOVE TO ANOTHER CONSULTANT ---- */}
      <Modal isOpen={!!moveFor} onClose={() => setMoveFor(null)} title={moveFor ? `Move ${moveFor.orderNumber}` : ''}>
        {moveFor && (
          <form onSubmit={submitMove} className="space-y-3">
            <p className="text-sm text-gray-600">
              {moveFor.customerName || 'This order'} is with <span className="font-medium">{moveFor.consultant?.name || 'no consultant'}</span>.
              Moving it moves the commission with it.
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Move to</label>
              <select required value={moveTo} onChange={e => setMoveTo(e.target.value)} className={inputClass}>
                <option value="">Choose a consultant</option>
                {consultants.filter(c => c.id !== moveFor.consultant?.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <p className="text-xs text-gray-400">Recorded on the order with your name, and visible to the office.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setMoveFor(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button type="submit" disabled={submitting || !moveTo} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{submitting ? 'Moving…' : 'Move order'}</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
