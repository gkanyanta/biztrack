import { useState, useEffect } from 'react';
import { getSale, updateSalePayment } from '../services/api';
import { formatMoney, formatDateTime } from '../utils/format';
import { PaymentBadge } from './StatusBadge';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { FiCheckCircle, FiXCircle, FiClock } from 'react-icons/fi';

export default function PaymentStatusModal({ sale, isOpen, onClose, onUpdated }) {
  const [notes, setNotes] = useState([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen || !sale) return;
    setNote('');
    setLoadingNotes(true);
    getSale(sale.id).then(res => setNotes(res.data.paymentNotes || [])).finally(() => setLoadingNotes(false));
  }, [isOpen, sale?.id]);

  if (!sale) return null;
  const isCredit = sale.paymentType === 'Credit';
  const nextStatus = sale.paymentStatus === 'Paid' ? 'Unpaid' : 'Paid';

  const submit = async (statusChange) => {
    if (submitting) return;
    if (!statusChange && !note.trim()) return toast.error('Add a note or change the status');
    setSubmitting(true);
    try {
      const payload = {};
      if (statusChange) payload.paymentStatus = nextStatus;
      if (note.trim()) payload.note = note.trim();
      const { data } = await updateSalePayment(sale.id, payload);
      toast.success(statusChange ? `Marked ${nextStatus}` : 'Note added');
      setNote('');
      setNotes(data.paymentNotes || []);
      onUpdated?.(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error updating payment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Payment — ${sale.orderNumber}`} size="sm">
      <div className="space-y-4 text-sm">
        <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
          <div>
            <div className="text-xs text-gray-500">Current Status</div>
            <PaymentBadge status={sale.paymentStatus} />
          </div>
          <div className="text-right">
            <div className="text-xs text-gray-500">Total</div>
            <div className="font-semibold text-gray-800">{formatMoney(sale.totalPrice)}</div>
          </div>
        </div>

        {isCredit ? (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
            This is a Credit sale — record payments from the Credit Tracker so the balance stays accurate. You can still leave a note below.
          </p>
        ) : (
          <button
            onClick={() => submit(true)}
            disabled={submitting}
            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed ${nextStatus === 'Paid' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-500 hover:bg-red-600'}`}
          >
            {nextStatus === 'Paid' ? <FiCheckCircle size={16} /> : <FiXCircle size={16} />}
            {submitting ? 'Updating...' : `Mark as ${nextStatus}`}
          </button>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Add a payment note</label>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="e.g. Will pay tomorrow via MoMo"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          <button onClick={() => submit(false)} disabled={submitting || !note.trim()}
            className="mt-2 w-full py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? 'Saving...' : 'Add Note'}
          </button>
        </div>

        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1"><FiClock size={12} /> History</div>
          {loadingNotes ? (
            <p className="text-xs text-gray-400">Loading...</p>
          ) : notes.length === 0 ? (
            <p className="text-xs text-gray-400">No notes yet</p>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-2">
              {notes.map(n => (
                <div key={n.id} className="bg-gray-50 rounded-lg p-2">
                  <div className="text-gray-700">{n.note}</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{formatDateTime(n.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
