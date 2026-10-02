import { useState, useEffect } from 'react';
import { getAwaitingPayment, confirmPaymentReceived } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import toast from 'react-hot-toast';
import { FiPhone, FiCheck, FiAlertCircle, FiFileText } from 'react-icons/fi';
import { useAuth } from '../hooks/useAuth';

// Nobody confirms a customer received their parcel. What happens instead is that the courier's
// receipt is sent as proof it is on its way, and the customer pays against it — so dispatching
// starts a debt rather than finishing a job, and this is the list of those debts.
//
// It is the only place that was watching for this money. An order dispatched and never paid for
// previously just sat there looking delivered.

export default function AwaitingPayment() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const { user } = useAuth();
  const canConfirm = ['admin', 'superadmin', 'inventory'].includes(user?.role);

  const load = () => {
    getAwaitingPayment()
      .then(res => setData(res.data))
      .catch(() => toast.error('Could not load what is owed'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const confirm = async (p) => {
    if (busy) return;
    setBusy(p.deliveryId);
    try {
      await confirmPaymentReceived(p.deliveryId, {});
      toast.success(`${formatMoney(p.outstanding)} recorded against ${p.orderNumber}`);
      setLoading(true);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not record it');
    } finally { setBusy(null); }
  };

  if (loading) return <LoadingSpinner />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-500 mb-1">Dispatched, not yet paid</div>
          <div className="text-2xl font-bold text-amber-600">{formatMoney(data.total)}</div>
          <div className="text-xs text-gray-400 mt-1">{data.parcels.length} parcel{data.parcels.length === 1 ? '' : 's'}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-500 mb-1">Waiting three days or more</div>
          <div className={`text-2xl font-bold ${data.overdue > 0 ? 'text-red-600' : 'text-gray-400'}`}>{data.overdue}</div>
          <div className="text-xs text-gray-400 mt-1">worth a phone call</div>
        </div>
      </div>

      {data.parcels.length === 0 ? (
        <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
          <FiCheck className="mx-auto mb-2 text-emerald-400" size={30} />
          <p className="text-gray-500 text-sm">Every dispatched parcel has been paid for.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {data.parcels.map(p => {
            const stale = (p.daysWaiting || 0) >= 3;
            return (
              <div key={p.deliveryId} className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="text-sm text-gray-800">
                    {p.customerName || 'Customer'}
                    <span className="text-xs text-gray-400 ml-2">{p.orderNumber}</span>
                    {p.consultant && <span className="text-xs text-gray-400 ml-2">via {p.consultant}</span>}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {p.town || 'no town'} · {p.courier}
                    {p.receiptNo && <span className="text-blue-700"> · receipt {p.receiptNo}</span>}
                  </div>
                  <div className={`text-xs mt-0.5 ${stale ? 'text-red-600' : 'text-gray-400'}`}>
                    dispatched {formatDate(p.dispatchedAt)}
                    {p.daysWaiting != null && ` · ${p.daysWaiting} day${p.daysWaiting === 1 ? '' : 's'} ago`}
                  </div>
                  {p.customerPhone && (
                    <a href={`tel:${p.customerPhone}`} className="text-xs text-blue-600 mt-1 inline-flex items-center gap-1">
                      <FiPhone size={11} /> {p.customerPhone}
                    </a>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-amber-600">{formatMoney(p.outstanding)}</div>
                  {p.paid > 0 && <div className="text-xs text-gray-400">{formatMoney(p.paid)} already in</div>}
                  {canConfirm ? (
                    <button onClick={() => confirm(p)} disabled={busy === p.deliveryId}
                      title="Records the outstanding amount as paid against this order"
                      className="mt-2 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium disabled:opacity-50">
                      {busy === p.deliveryId ? 'Saving…' : 'Paid'}
                    </button>
                  ) : (
                    <div className="text-xs text-gray-400 mt-2">office confirms</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-gray-400 flex items-start gap-1.5">
        <FiFileText size={12} className="mt-0.5 shrink-0" />
        Marking one paid records a real payment against the order and closes the parcel. Nobody
        confirms the customer received it, so payment against the receipt is the only ending an
        order of this kind ever gets.
      </p>
      {data.overdue > 0 && (
        <p className="text-xs text-red-600 flex items-start gap-1.5">
          <FiAlertCircle size={12} className="mt-0.5 shrink-0" />
          {data.overdue} {data.overdue === 1 ? 'parcel has' : 'parcels have'} been with the courier
          three days or more without payment. The goods have gone; the money has not.
        </p>
      )}
    </div>
  );
}
