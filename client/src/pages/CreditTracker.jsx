import { useState, useEffect } from 'react';
import { getCreditSummary, getSales, recordCreditPayment, sendReminder, getSale } from '../services/api';
import { formatMoney, formatDate, formatDateTime, PAYMENT_METHODS } from '../utils/format';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import ReceiptButton from '../components/ReceiptButton';
import { PaymentBadge } from '../components/StatusBadge';
import Pagination from '../components/Pagination';
import SortableHeader from '../components/SortableHeader';
import useTableControls from '../hooks/useTableControls';
import toast from 'react-hot-toast';
import { FiAlertTriangle, FiDollarSign, FiClock, FiUsers, FiMessageCircle, FiChevronDown, FiChevronUp } from 'react-icons/fi';

export default function CreditTracker() {
  const [summary, setSummary] = useState(null);
  const [creditSales, setCreditSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all, overdue
  const [expandedDebtor, setExpandedDebtor] = useState(null);
  const [selectedSale, setSelectedSale] = useState(null);
  const [showPayment, setShowPayment] = useState(false);
  const [showReminder, setShowReminder] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ amount: '', paymentMethod: '', reference: '', notes: '' });
  const [reminderForm, setReminderForm] = useState({ channel: 'whatsapp', message: '' });

  const loadData = async () => {
    setLoading(true);
    try {
      const [summaryRes, salesRes] = await Promise.all([
        getCreditSummary(),
        getSales({ paymentType: 'Credit' })
      ]);
      setSummary(summaryRes.data);
      setCreditSales(salesRes.data);
    } catch (err) {
      toast.error('Failed to load credit data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const openSaleDetail = async (sale) => {
    try {
      const { data } = await getSale(sale.id);
      setSelectedSale(data);
    } catch {
      setSelectedSale(sale);
    }
  };

  const handleRecordPayment = async (e) => {
    e.preventDefault();
    try {
      await recordCreditPayment(selectedSale.id, {
        amount: parseFloat(paymentForm.amount),
        paymentMethod: paymentForm.paymentMethod || null,
        reference: paymentForm.reference || null,
        notes: paymentForm.notes || null,
      });
      toast.success('Payment recorded');
      setShowPayment(false);
      setPaymentForm({ amount: '', paymentMethod: '', reference: '', notes: '' });
      setSelectedSale(null);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error recording payment');
    }
  };

  const handleSendReminder = async (e) => {
    e.preventDefault();
    const sale = selectedSale;
    const phone = sale.customerPhone || sale.customer?.phone || sale.customer?.whatsapp;
    const message = reminderForm.message;

    try {
      await sendReminder(sale.id, { channel: reminderForm.channel, message });
      toast.success('Reminder logged');

      if (reminderForm.channel === 'whatsapp' && phone) {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`, '_blank');
      } else if (reminderForm.channel === 'sms' && phone) {
        window.open(`sms:${phone}?body=${encodeURIComponent(message)}`, '_blank');
      }

      setShowReminder(false);
      setSelectedSale(null);
      loadData();
    } catch (err) {
      toast.error('Failed to log reminder');
    }
  };

  const openReminder = (sale) => {
    const balance = parseFloat(sale.totalPrice) - parseFloat(sale.amountPaid);
    const defaultMsg = `Hi ${sale.customerName || 'Customer'}, this is a reminder regarding your outstanding balance of K${balance.toFixed(2)} for order ${sale.orderNumber}${sale.creditDueDate ? ` (due ${formatDate(sale.creditDueDate)})` : ''}. Please arrange payment at your earliest convenience. Thank you!`;
    setSelectedSale(sale);
    setReminderForm({ channel: 'whatsapp', message: defaultMsg });
    setShowReminder(true);
  };

  const filteredSales = creditSales.filter(s => {
    if (filter === 'overdue') return s.creditDueDate && new Date(s.creditDueDate) < new Date() && s.paymentStatus !== 'Paid';
    if (filter === 'unpaid') return s.paymentStatus !== 'Paid';
    return true;
  });

  const table = useTableControls(filteredSales, { pageSize: 25 });

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <FiDollarSign size={16} /> Total Outstanding
          </div>
          <div className="text-2xl font-bold text-gray-800">{formatMoney(summary?.totalOutstanding || 0)}</div>
        </div>
        <div className="bg-white rounded-xl border border-red-200 p-4">
          <div className="flex items-center gap-2 text-red-500 text-sm mb-1">
            <FiAlertTriangle size={16} /> Overdue Amount
          </div>
          <div className="text-2xl font-bold text-red-600">{formatMoney(summary?.overdueAmount || 0)}</div>
        </div>
        <div className="bg-white rounded-xl border border-amber-200 p-4">
          <div className="flex items-center gap-2 text-amber-500 text-sm mb-1">
            <FiClock size={16} /> Overdue Sales
          </div>
          <div className="text-2xl font-bold text-amber-600">{summary?.overdueCount || 0}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <FiUsers size={16} /> Debtors
          </div>
          <div className="text-2xl font-bold text-gray-800">{summary?.topDebtors?.length || 0}</div>
        </div>
      </div>

      {/* Top Debtors */}
      {summary?.topDebtors?.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-800">Top Debtors</h3>
          </div>
          <div className="divide-y divide-gray-50">
            {summary.topDebtors.map((d, i) => (
              <div key={d.customerId || i}>
                <button
                  onClick={() => setExpandedDebtor(expandedDebtor === i ? null : i)}
                  className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-bold text-sm">
                      {(d.customerName || '?')[0].toUpperCase()}
                    </div>
                    <div className="text-left">
                      <div className="font-medium text-gray-800">{d.customerName}</div>
                      <div className="text-xs text-gray-500">{d.salesCount} sale{d.salesCount > 1 ? 's' : ''} {d.customerPhone ? `- ${d.customerPhone}` : ''}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-red-600">{formatMoney(d.totalOwed)}</span>
                    {expandedDebtor === i ? <FiChevronUp size={16} /> : <FiChevronDown size={16} />}
                  </div>
                </button>
                {expandedDebtor === i && (
                  <div className="px-4 pb-4 bg-gray-50">
                    <div className="space-y-2">
                      {creditSales
                        .filter(s => (s.customerId || s.customerName) === (d.customerId || d.customerName) && s.paymentStatus !== 'Paid')
                        .map(s => {
                          const balance = parseFloat(s.totalPrice) - parseFloat(s.amountPaid);
                          const isOverdue = s.creditDueDate && new Date(s.creditDueDate) < new Date();
                          return (
                            <div key={s.id} className="flex items-center justify-between bg-white rounded-lg p-3 text-sm">
                              <div>
                                <span className="font-medium">{s.orderNumber}</span>
                                <span className="text-gray-400 ml-2">{formatDate(s.date)}</span>
                                {isOverdue && <span className="ml-2 text-xs text-red-600 font-medium">OVERDUE</span>}
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="text-red-600 font-medium">{formatMoney(balance)}</span>
                                <ReceiptButton saleId={s.id} size={14} />
                                <button onClick={() => { setSelectedSale(s); setShowPayment(true); }}
                                  className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700">Pay</button>
                                <button onClick={() => openReminder(s)}
                                  className="text-xs bg-amber-500 text-white px-2 py-1 rounded hover:bg-amber-600">
                                  <FiMessageCircle size={12} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Credit Sales List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-800">Credit Sales</h3>
          <div className="flex gap-2">
            {['all', 'unpaid', 'overdue'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1 text-xs rounded-lg border transition-colors ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                {f === 'all' ? 'All' : f === 'unpaid' ? 'Unpaid' : 'Overdue'}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3"><SortableHeader label="Order" sortKey="orderNumber" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-left p-3 hidden md:table-cell"><SortableHeader label="Customer" sortKey="customerName" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-right p-3"><SortableHeader label="Total" sortKey="totalPrice" accessor={(r) => parseFloat(r.totalPrice)} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-right p-3"><SortableHeader label="Paid" sortKey="amountPaid" accessor={(r) => parseFloat(r.amountPaid)} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-right p-3"><SortableHeader label="Balance" sortKey="balance" accessor={(r) => parseFloat(r.totalPrice) - parseFloat(r.amountPaid)} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-center p-3 hidden sm:table-cell"><SortableHeader label="Due Date" sortKey="creditDueDate" accessor={(r) => r.creditDueDate ? new Date(r.creditDueDate).getTime() : null} sort={table.sort} onToggle={table.toggleSort} align="center" /></th>
                <th className="text-center p-3"><SortableHeader label="Status" sortKey="paymentStatus" sort={table.sort} onToggle={table.toggleSort} align="center" /></th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {table.pageRows.map(s => {
                const balance = parseFloat(s.totalPrice) - parseFloat(s.amountPaid);
                const isOverdue = s.creditDueDate && new Date(s.creditDueDate) < new Date() && s.paymentStatus !== 'Paid';
                return (
                  <tr key={s.id} className={`border-b border-gray-50 hover:bg-gray-50 ${isOverdue ? 'bg-red-50' : ''}`}>
                    <td className="p-3">
                      <div className="font-medium text-gray-800">{s.orderNumber}</div>
                      <div className="text-xs text-gray-500">{formatDate(s.date)}</div>
                    </td>
                    <td className="p-3 hidden md:table-cell">
                      <div className="text-gray-700">{s.customerName || '-'}</div>
                      <div className="text-xs text-gray-500">{s.customerPhone || ''}</div>
                    </td>
                    <td className="p-3 text-right font-medium">{formatMoney(s.totalPrice)}</td>
                    <td className="p-3 text-right text-green-600">{formatMoney(s.amountPaid)}</td>
                    <td className="p-3 text-right font-bold text-red-600">{formatMoney(balance)}</td>
                    <td className="p-3 text-center hidden sm:table-cell">
                      {s.creditDueDate ? (
                        <span className={isOverdue ? 'text-red-600 font-medium' : ''}>
                          {formatDate(s.creditDueDate)}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="p-3 text-center"><PaymentBadge status={s.paymentStatus} /></td>
                    <td className="p-3 text-right">
                      <div className="flex gap-1 justify-end">
                        <ReceiptButton saleId={s.id} size={14} />
                        {s.paymentStatus !== 'Paid' && (
                          <>
                            <button onClick={() => { setSelectedSale(s); setShowPayment(true); }}
                              className="p-1 text-green-600 hover:text-green-800" title="Record Payment">
                              <FiDollarSign size={15} />
                            </button>
                            <button onClick={() => openReminder(s)}
                              className="p-1 text-amber-600 hover:text-amber-800" title="Send Reminder">
                              <FiMessageCircle size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {table.pageRows.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-gray-500">No credit sales found</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={table.page} totalPages={table.totalPages} total={table.total}
          pageSize={table.pageSize} onPageChange={table.setPage} onPageSizeChange={table.setPageSize}
        />
      </div>

      {/* Recent Payments */}
      {summary?.recentPayments?.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-800">Recent Payments</h3>
          </div>
          <div className="divide-y divide-gray-50">
            {summary.recentPayments.map(p => (
              <div key={p.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <span className="font-medium">{p.sale?.orderNumber}</span>
                  <span className="text-gray-400 ml-2">{p.sale?.customerName}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-500">{formatDateTime(p.createdAt)}</span>
                  <span className="text-gray-500">{p.paymentMethod || ''}</span>
                  <span className="font-medium text-green-600">+{formatMoney(p.amount)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Record Payment Modal */}
      <Modal isOpen={showPayment} onClose={() => { setShowPayment(false); setSelectedSale(null); }} title={`Record Payment — ${selectedSale?.orderNumber}`} size="sm">
        {selectedSale && (
          <div>
            <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Total:</span><span className="font-medium">{formatMoney(selectedSale.totalPrice)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Paid:</span><span className="text-green-600">{formatMoney(selectedSale.amountPaid)}</span></div>
              <div className="flex justify-between border-t mt-1 pt-1"><span className="text-gray-500 font-medium">Balance:</span><span className="font-bold text-red-600">{formatMoney(parseFloat(selectedSale.totalPrice) - parseFloat(selectedSale.amountPaid))}</span></div>
            </div>
            <form onSubmit={handleRecordPayment} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                <input type="number" step="0.01" min="0.01" required value={paymentForm.amount}
                  onChange={e => setPaymentForm({...paymentForm, amount: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
                <select value={paymentForm.paymentMethod} onChange={e => setPaymentForm({...paymentForm, paymentMethod: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
                  <option value="">Select</option>
                  {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
                <input type="text" value={paymentForm.reference} onChange={e => setPaymentForm({...paymentForm, reference: e.target.value})}
                  placeholder="e.g. Transaction ID"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="flex gap-3 justify-end pt-2">
                <button type="button" onClick={() => { setShowPayment(false); setSelectedSale(null); }}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">Record Payment</button>
              </div>
            </form>
          </div>
        )}
      </Modal>

      {/* Send Reminder Modal */}
      <Modal isOpen={showReminder} onClose={() => { setShowReminder(false); setSelectedSale(null); }} title="Send Payment Reminder" size="md">
        {selectedSale && (
          <form onSubmit={handleSendReminder} className="space-y-4">
            <div className="bg-gray-50 rounded-lg p-3 text-sm">
              <div><span className="text-gray-500">Customer:</span> <span className="font-medium">{selectedSale.customerName || 'Unknown'}</span></div>
              <div><span className="text-gray-500">Phone:</span> {selectedSale.customerPhone || selectedSale.customer?.phone || 'N/A'}</div>
              <div><span className="text-gray-500">Balance:</span> <span className="font-bold text-red-600">{formatMoney(parseFloat(selectedSale.totalPrice) - parseFloat(selectedSale.amountPaid))}</span></div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Channel</label>
              <div className="flex gap-2">
                {['whatsapp', 'sms'].map(ch => (
                  <button key={ch} type="button" onClick={() => setReminderForm({...reminderForm, channel: ch})}
                    className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${reminderForm.channel === ch ? 'bg-green-600 text-white border-green-600' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                    {ch === 'whatsapp' ? 'WhatsApp' : 'SMS'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
              <textarea value={reminderForm.message} onChange={e => setReminderForm({...reminderForm, message: e.target.value})}
                rows={4} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button type="button" onClick={() => { setShowReminder(false); setSelectedSale(null); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="submit" className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">Send Reminder</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
