import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiMessageSquare, FiSend, FiCheck } from 'react-icons/fi';
import Modal from './Modal';
import LoadingSpinner from './LoadingSpinner';
import { PaymentBadge } from './StatusBadge';
import { getSale, getOrderQueries, raiseOrderQuery, replyOrderQuery, closeOrderQuery } from '../services/api';
import { formatMoney, formatDateTime } from '../utils/format';
import { queryStatusLabel } from '../utils/orderQueries';
import { useAuth } from '../hooks/useAuth';

// Everything said about one order: its payment notes, and the office's questions to the
// consultant with their answers. The office asks and closes; the consultant answers.
export default function OrderQueryModal({ saleId, isOpen, onClose, onChanged }) {
  const { user } = useAuth();
  const isOffice = user?.role === 'admin' || user?.role === 'superadmin';
  const [sale, setSale] = useState(null);
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const load = () => Promise.all([getSale(saleId), getOrderQueries({ saleId, status: 'all' })])
    .then(([s, q]) => { setSale(s.data); setThreads([...q.data].reverse()); });

  useEffect(() => {
    if (!isOpen || !saleId) return;
    setText(''); setSale(null); setLoading(true);
    load().catch(() => toast.error('Could not load this order')).finally(() => setLoading(false));
  }, [isOpen, saleId]);

  const active = threads.find(t => t.status !== 'closed') || null;
  const consultantName = sale?.consultant?.name;
  const canWrite = isOffice ? !!sale?.consultantId : !!active;

  const send = async () => {
    if (sending || !text.trim()) return;
    setSending(true);
    try {
      if (isOffice && !active) await raiseOrderQuery(saleId, text.trim());
      else await replyOrderQuery(active.id, text.trim());
      toast.success(isOffice ? `Sent to ${consultantName}` : 'Reply sent to the office');
      setText('');
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not send');
    } finally { setSending(false); }
  };

  const close = async () => {
    if (sending || !active) return;
    setSending(true);
    try {
      await closeOrderQuery(active.id);
      toast.success('Query closed');
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not close');
    } finally { setSending(false); }
  };

  const total = sale ? parseFloat(sale.totalPrice) : 0;
  const balance = sale ? total - parseFloat(sale.amountPaid) : 0;
  const notes = sale?.paymentNotes || [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={sale ? `${sale.orderNumber} · ${sale.customerName || sale.customer?.name || 'Customer'}` : 'Order'} size="md">
      {loading || !sale ? <LoadingSpinner /> : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-3 bg-gray-50 rounded-lg p-3">
            <PaymentBadge status={sale.paymentStatus} />
            <span className="text-gray-600">Total {formatMoney(total)}</span>
            {balance > 0 && <span className="font-semibold text-red-600">{formatMoney(balance)} still owed</span>}
            <span className="text-gray-500 ml-auto">{consultantName ? `Sold by ${consultantName}` : 'No consultant'}</span>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Payment notes</h4>
            {notes.length === 0 ? <p className="text-gray-400 text-xs">No notes yet.</p> : (
              <ul className="space-y-1.5">
                {notes.map(n => (
                  <li key={n.id} className="flex gap-2">
                    <FiMessageSquare size={13} className="text-gray-400 mt-0.5 shrink-0" />
                    <span className="text-gray-700 flex-1">{n.note}</span>
                    <span className="text-xs text-gray-400 whitespace-nowrap">{formatDateTime(n.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Queries</h4>
              {active && (() => { const st = queryStatusLabel(active.status, isOffice, consultantName); return <span className={`text-xs px-2 py-0.5 rounded-full border ${st.className}`}>{st.label}</span>; })()}
            </div>
            {threads.length === 0 ? (
              <p className="text-gray-400 text-xs">
                {isOffice ? (consultantName ? `No queries yet. Ask ${consultantName} what is happening with this order.` : 'This order has no consultant to ask.') : 'The office has not asked about this order.'}
              </p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {threads.map(t => (
                  <div key={t.id} className="space-y-2">
                    {t.messages.map(m => {
                      const mine = (m.authorRole === 'admin') === isOffice;
                      return (
                        <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[85%] rounded-lg px-3 py-2 ${mine ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'}`}>
                            <div className="whitespace-pre-wrap break-words">{m.message}</div>
                            <div className={`text-[11px] mt-1 ${mine ? 'text-blue-100' : 'text-gray-500'}`}>{m.authorName} · {formatDateTime(m.createdAt)}</div>
                          </div>
                        </div>
                      );
                    })}
                    {t.status === 'closed' && <p className="text-center text-[11px] text-gray-400">Closed {t.closedAt ? formatDateTime(t.closedAt) : ''}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {canWrite && (
            <div>
              <textarea value={text} onChange={e => setText(e.target.value)} rows={2} maxLength={1000}
                placeholder={isOffice ? `Ask ${consultantName} about this order…` : 'Tell the office what is happening…'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <div className="flex gap-2 mt-2">
                <button onClick={send} disabled={sending || !text.trim()}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                  <FiSend size={14} /> {sending ? 'Sending…' : isOffice ? (active ? 'Send' : `Ask ${consultantName}`) : 'Reply'}
                </button>
                {isOffice && active && (
                  <button onClick={close} disabled={sending}
                    className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">
                    <FiCheck size={14} /> Close query
                  </button>
                )}
              </div>
            </div>
          )}
          {!isOffice && !active && threads.length > 0 && <p className="text-xs text-gray-400">This query has been closed by the office.</p>}
        </div>
      )}
    </Modal>
  );
}
