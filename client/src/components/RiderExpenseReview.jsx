import { useState, useEffect } from 'react';
import { getRiderExpenses, updateRiderExpense } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { FiCheck, FiRotateCcw, FiAlertCircle } from 'react-icons/fi';

// Settling a rider expense is the moment someone decides what the money was. Either the company
// carried it, in which case it becomes a real expense in the books, or it went on to a customer,
// in which case it does not — and a partial recharge splits the difference. Making that one
// explicit choice is what stops the same kwacha being counted twice.

const FILTERS = [
  { key: 'unsettled', label: 'Needs settling', params: { unsettled: 'true' } },
  { key: 'recharge', label: 'To charge on', params: { awaitingRecharge: 'true' } },
  { key: 'all', label: 'All', params: {} },
];

export default function RiderExpenseReview() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('unsettled');
  const [settling, setSettling] = useState(null);
  const [settleForm, setSettleForm] = useState({ outcome: 'company_cost', rechargedAmount: '' });
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    getRiderExpenses(FILTERS.find(f => f.key === filter).params)
      .then(res => setRows(res.data))
      .catch(() => toast.error('Could not load rider expenses'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [filter]);

  const openSettle = (x) => {
    setSettling(x);
    setSettleForm({
      outcome: x.rechargeable ? 'recharged' : 'company_cost',
      rechargedAmount: x.rechargeable ? String(x.amount) : '',
    });
  };

  const settle = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const body = { settle: true, outcome: settleForm.outcome };
      if (settleForm.outcome === 'recharged') body.rechargedAmount = parseFloat(settleForm.rechargedAmount) || 0;
      await updateRiderExpense(settling.id, body);
      toast.success(settleForm.outcome === 'recharged' ? 'Settled — charged on to the customer' : 'Settled — booked as a delivery cost');
      setSettling(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not settle');
    } finally { setSubmitting(false); }
  };

  const unsettle = async (x) => {
    try {
      await updateRiderExpense(x.id, { unsettle: true });
      toast.success('Reopened, and its expense removed');
      load();
    } catch { toast.error('Could not reopen'); }
  };

  if (loading) return <LoadingSpinner />;

  const unsettledTotal = rows.filter(r => !r.settledAt).reduce((s, r) => s + parseFloat(r.amount), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${filter === f.key ? 'bg-slate-800 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}>
              {f.label}
            </button>
          ))}
        </div>
        {unsettledTotal > 0 && (
          <p className="text-xs text-gray-500">
            {formatMoney(unsettledTotal)} of the rider's own money is out and not yet accounted for.
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
          <FiCheck className="mx-auto mb-2 text-emerald-400" size={30} />
          <p className="text-gray-500 text-sm">Nothing here.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {rows.map(x => (
            <div key={x.id} className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="text-sm text-gray-800">
                  <span className="font-semibold">{formatMoney(x.amount)}</span>
                  <span className="text-xs text-gray-500 ml-2">{x.category}</span>
                  {x.rechargeable && !x.rechargedAt && (
                    <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded ml-2">to charge on</span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {x.rider?.name} · {formatDate(x.date)}
                  {x.sale?.orderNumber ? ` · ${x.sale.orderNumber}` : ''}
                  {x.description ? ` · ${x.description}` : ''}
                </div>
                {/* A courier drop is already the order's delivery cost, so the only thing left to
                    read is whether the customer is being billed enough to cover it. */}
                {x.onSaleShipping && (
                  <div className="text-xs mt-1 text-blue-700">
                    on {x.sale?.orderNumber || 'the order'} as its delivery cost
                    {x.sale && (
                      <span className="text-gray-500">
                        {' · '}billed {formatMoney(x.sale.shippingCharge)}
                        {parseFloat(x.sale.shippingCharge || 0) < parseFloat(x.amount)
                          ? ` · ${formatMoney(parseFloat(x.amount) - parseFloat(x.sale.shippingCharge || 0))} short`
                          : ''}
                      </span>
                    )}
                  </div>
                )}
                {x.settledAt && !x.onSaleShipping && (
                  <div className="text-xs mt-1">
                    {x.rechargedAt
                      ? <span className="text-emerald-600">charged on at {formatMoney(x.rechargedAmount)}{parseFloat(x.rechargedAmount) < parseFloat(x.amount) ? ` · company carried ${formatMoney(parseFloat(x.amount) - parseFloat(x.rechargedAmount))}` : ''}</span>
                      : <span className="text-gray-500">booked as a delivery cost</span>}
                  </div>
                )}
                {x.settledAt && x.onSaleShipping && (
                  <div className="text-xs mt-0.5 text-emerald-600">paid back to the rider</div>
                )}
              </div>
              <div className="shrink-0">
                {x.settledAt ? (
                  <button onClick={() => unsettle(x)} title="Reopen and remove its expense"
                    className="p-2 text-gray-400 hover:text-red-600"><FiRotateCcw size={15} /></button>
                ) : (
                  <button onClick={() => openSettle(x)}
                    className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium">Settle</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={!!settling} onClose={() => setSettling(null)} title={settling ? `Settle ${formatMoney(settling.amount)}` : ''}>
        {settling && (
          <div className="space-y-4">
            <div className="bg-gray-50 rounded-lg p-3 text-sm">
              <div className="text-gray-700">{settling.category} · {settling.rider?.name}</div>
              {settling.description && <div className="text-xs text-gray-500 mt-0.5">{settling.description}</div>}
              {settling.sale?.orderNumber && <div className="text-xs text-gray-500 mt-0.5">Order {settling.sale.orderNumber} — {settling.sale.customerName}</div>}
            </div>

            {settling.onSaleShipping ? (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
                This fee is already on {settling.sale?.orderNumber || 'the order'} as its delivery cost,
                so the books have it. Settling only records that the company has squared up with
                {' '}{settling.rider?.name || 'the rider'} — it raises no second expense, because that
                would charge the same money twice.
                {settling.sale && parseFloat(settling.sale.shippingCharge || 0) < parseFloat(settling.amount) && (
                  <p className="mt-2 text-amber-800">
                    The customer is only billed {formatMoney(settling.sale.shippingCharge)} against a
                    {' '}{formatMoney(settling.amount)} fee. Raise the order's delivery charge if it should cover it.
                  </p>
                )}
              </div>
            ) : (
            <div className="space-y-2">
              <label className={`flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer ${settleForm.outcome === 'company_cost' ? 'border-slate-800 bg-slate-50' : 'border-gray-200'}`}>
                <input type="radio" checked={settleForm.outcome === 'company_cost'} onChange={() => setSettleForm({ ...settleForm, outcome: 'company_cost' })} className="mt-0.5" />
                <span className="text-sm text-gray-800">
                  The company carried it
                  <span className="block text-xs text-gray-500">Books {formatMoney(settling.amount)} to Delivery Costs, so it shows in net profit.</span>
                </span>
              </label>
              <label className={`flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer ${settleForm.outcome === 'recharged' ? 'border-slate-800 bg-slate-50' : 'border-gray-200'}`}>
                <input type="radio" checked={settleForm.outcome === 'recharged'} onChange={() => setSettleForm({ ...settleForm, outcome: 'recharged' })} className="mt-0.5" />
                <span className="text-sm text-gray-800">
                  Charged on to the customer
                  <span className="block text-xs text-gray-500">No expense is booked for the part they pay. Add it to the order's delivery charge yourself.</span>
                </span>
              </label>
            </div>
            )}

            {!settling.onSaleShipping && settleForm.outcome === 'recharged' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount charged to the customer</label>
                <input type="number" min="0" step="0.01" value={settleForm.rechargedAmount}
                  onChange={e => setSettleForm({ ...settleForm, rechargedAmount: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                {parseFloat(settleForm.rechargedAmount || 0) < parseFloat(settling.amount) && (
                  <p className="text-xs text-amber-600 mt-1 flex items-start gap-1">
                    <FiAlertCircle size={12} className="mt-0.5 shrink-0" />
                    The {formatMoney(parseFloat(settling.amount) - (parseFloat(settleForm.rechargedAmount) || 0))} you are not charging on
                    gets booked as a delivery cost.
                  </p>
                )}
              </div>
            )}

            <p className="text-xs text-gray-400">
              Settling also clears it off what {settling.rider?.name || 'the rider'} owes, since he keeps
              this money out of the cash he hands in.
            </p>

            <div className="flex justify-end gap-2">
              <button onClick={() => setSettling(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button onClick={settle} disabled={submitting} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Settling…' : 'Settle'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
