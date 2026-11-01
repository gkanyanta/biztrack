import { useEffect, useState } from 'react';
import { FiHelpCircle, FiChevronRight } from 'react-icons/fi';
import { getOrderQueries } from '../services/api';
import { formatMoney, formatDateTime } from '../utils/format';
import { queryStatusLabel } from '../utils/orderQueries';
import LoadingSpinner from '../components/LoadingSpinner';
import OrderQueryModal from '../components/OrderQueryModal';
import { useAuth } from '../hooks/useAuth';

// Every question the office has asked about an order, sorted by whose turn it is. The office
// raises them from the Sales Report; consultants answer them here.
export default function OrderQueries() {
  const { user } = useAuth();
  const isOffice = user?.role === 'admin' || user?.role === 'superadmin';
  const tabs = isOffice
    ? [{ key: 'answered', label: 'Replied' }, { key: 'open', label: 'Waiting on consultant' }, { key: 'closed', label: 'Closed' }]
    : [{ key: 'open', label: 'Needs your reply' }, { key: 'answered', label: 'Sent to office' }, { key: 'closed', label: 'Closed' }];
  const [tab, setTab] = useState(tabs[0].key);
  const [queries, setQueries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [threadSaleId, setThreadSaleId] = useState(null);

  const load = () => getOrderQueries({ status: tab }).then(res => setQueries(res.data)).catch(() => setQueries([])).finally(() => setLoading(false));
  useEffect(() => { load(); }, [tab]);

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">Order Queries</h1>
        <p className="text-sm text-gray-500">
          {isOffice
            ? 'Questions you have asked consultants about orders. Ask from the Sales Report: tap the Outstanding total, then open an order.'
            : 'Questions from the office about your orders. Open one to reply.'}
        </p>
      </div>

      <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
        {tabs.map(t => (
          <button key={t.key} onClick={() => { if (t.key !== tab) { setLoading(true); setTab(t.key); } }}
            className={`px-3 py-1.5 text-sm ${tab === t.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? <LoadingSpinner /> : queries.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-sm text-gray-400">
          <FiHelpCircle className="mx-auto mb-2" size={28} />
          Nothing here.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
          {queries.map(q => {
            const st = queryStatusLabel(q.status, isOffice, q.consultant?.name);
            return (
              <button key={q.id} onClick={() => setThreadSaleId(q.saleId)} className="w-full text-left p-3 flex items-center gap-3 hover:bg-gray-50">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-800">{q.order.orderNumber}</span>
                    <span className="text-gray-600 text-sm">{q.order.customerName}</span>
                    {isOffice && <span className="text-xs text-gray-400">· {q.consultant?.name}</span>}
                    <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${st.className}`}>{st.label}</span>
                  </div>
                  {q.lastMessage && (
                    <p className="text-sm text-gray-500 truncate mt-0.5">
                      <span className="text-gray-700">{q.lastMessage.authorName}:</span> {q.lastMessage.message}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 mt-0.5">
                    {q.order.balance > 0 ? `${formatMoney(q.order.balance)} still owed` : 'Paid in full'} · {q.order.paymentStatus} · updated {formatDateTime(q.updatedAt)}
                  </p>
                </div>
                <FiChevronRight className="text-gray-400 shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      <OrderQueryModal saleId={threadSaleId} isOpen={!!threadSaleId} onClose={() => setThreadSaleId(null)} onChanged={() => load()} />
    </div>
  );
}
