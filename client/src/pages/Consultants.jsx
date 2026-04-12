import { useState, useEffect } from 'react';
import { getConsultants, createConsultant, updateConsultant, deleteConsultant, getCommissionSummary, recordCommissionPayment, getConsultant } from '../services/api';
import { formatMoney, formatDate, PAYMENT_METHODS } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiDollarSign, FiEye, FiUsers, FiTrendingUp } from 'react-icons/fi';

export default function Consultants() {
  const [consultants, setConsultants] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [showDetail, setShowDetail] = useState(null);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const emptyForm = { name: '', phone: '', whatsapp: '', commissionRate: '50', monthlyAllowance: '400', notes: '' };
  const [form, setForm] = useState(emptyForm);
  const emptyPayment = { amount: '', type: 'commission', paymentMethod: '', reference: '', notes: '', periodFrom: '', periodTo: '' };
  const [paymentForm, setPaymentForm] = useState(emptyPayment);

  const loadData = () => {
    setLoading(true);
    Promise.all([
      getConsultants(),
      getCommissionSummary({ from: fromDate || undefined, to: toDate || undefined })
    ]).then(([cRes, sRes]) => {
      setConsultants(cRes.data);
      setSummary(sRes.data);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, [fromDate, toDate]);

  const openCreate = () => { setEditing(null); setForm(emptyForm); setShowForm(true); };

  const openEdit = (c) => {
    setEditing(c);
    setForm({
      name: c.name, phone: c.phone || '', whatsapp: c.whatsapp || '',
      commissionRate: c.commissionRate, monthlyAllowance: c.monthlyAllowance, notes: c.notes || ''
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await updateConsultant(editing.id, form);
        toast.success('Consultant updated');
      } else {
        await createConsultant(form);
        toast.success('Consultant added');
      }
      setShowForm(false);
      loadData();
    } catch (err) { toast.error(err.response?.data?.error || 'Error saving consultant'); }
  };

  const handleDelete = async () => {
    try {
      await deleteConsultant(deleteConfirm.id);
      toast.success('Consultant removed');
      setDeleteConfirm(null);
      loadData();
    } catch { toast.error('Error removing consultant'); }
  };

  const openDetail = async (consultantSummary) => {
    try {
      const { data } = await getConsultant(consultantSummary.consultant.id);
      setShowDetail(data);
    } catch { toast.error('Error loading details'); }
  };

  const openPayment = (c) => {
    setShowDetail(c);
    setPaymentForm(emptyPayment);
    setShowPaymentForm(true);
  };

  const handlePayment = async (e) => {
    e.preventDefault();
    try {
      await recordCommissionPayment(showDetail.id, paymentForm);
      toast.success('Payment recorded');
      setShowPaymentForm(false);
      // Refresh detail
      const { data } = await getConsultant(showDetail.id);
      setShowDetail(data);
      loadData();
    } catch (err) { toast.error(err.response?.data?.error || 'Error recording payment'); }
  };

  const getSummaryFor = (id) => summary?.summary?.find(s => s.consultant.id === id);

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <div className="flex gap-2 items-center flex-wrap">
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm outline-none" />
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm outline-none" />
        </div>
        <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <FiPlus size={16} /> Add Consultant
        </button>
      </div>

      {/* Totals Summary */}
      {summary?.totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="text-xs text-gray-500">Total Sales</div>
            <div className="text-xl font-bold text-gray-800">{summary.totals.totalSales}</div>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="text-xs text-gray-500">Revenue (via Consultants)</div>
            <div className="text-xl font-bold text-gray-800">{formatMoney(summary.totals.totalRevenue)}</div>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="text-xs text-gray-500">Commission Earned</div>
            <div className="text-xl font-bold text-orange-600">{formatMoney(summary.totals.totalCommissionEarned)}</div>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="text-xs text-gray-500">Balance Owed</div>
            <div className="text-xl font-bold text-red-600">{formatMoney(summary.totals.totalBalance)}</div>
          </div>
        </div>
      )}

      {loading ? <LoadingSpinner /> : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Name</th>
                <th className="text-left p-3 font-medium text-gray-600 hidden sm:table-cell">Phone</th>
                <th className="text-right p-3 font-medium text-gray-600">Rate/Sale</th>
                <th className="text-right p-3 font-medium text-gray-600">Sales</th>
                <th className="text-right p-3 font-medium text-gray-600 hidden md:table-cell">Earned</th>
                <th className="text-right p-3 font-medium text-gray-600 hidden md:table-cell">Paid</th>
                <th className="text-right p-3 font-medium text-gray-600">Balance</th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {consultants.map(c => {
                const s = getSummaryFor(c.id);
                return (
                  <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="p-3">
                      <div className="font-medium text-gray-800">{c.name}</div>
                      {!c.isActive && <span className="text-xs text-red-500 bg-red-50 px-1.5 py-0.5 rounded">Inactive</span>}
                    </td>
                    <td className="p-3 text-gray-600 hidden sm:table-cell">{c.phone || '-'}</td>
                    <td className="p-3 text-right text-gray-800">{formatMoney(c.commissionRate)}</td>
                    <td className="p-3 text-right font-medium text-gray-800">{s?.totalSales || 0}</td>
                    <td className="p-3 text-right text-gray-800 hidden md:table-cell">{formatMoney(s?.commissionEarned || 0)}</td>
                    <td className="p-3 text-right text-gray-800 hidden md:table-cell">{formatMoney(s?.commissionPaid || 0)}</td>
                    <td className="p-3 text-right font-medium">
                      <span className={(s?.balance || 0) > 0 ? 'text-red-600' : 'text-green-600'}>
                        {formatMoney(s?.balance || 0)}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => openDetail(s || { consultant: c })} className="p-1.5 text-gray-400 hover:text-blue-600" title="View details"><FiEye size={15} /></button>
                        <button onClick={() => openPayment(c)} className="p-1.5 text-gray-400 hover:text-green-600" title="Record payment"><FiDollarSign size={15} /></button>
                        <button onClick={() => openEdit(c)} className="p-1.5 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={15} /></button>
                        <button onClick={() => setDeleteConfirm(c)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {consultants.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-gray-500">
                  <FiUsers className="mx-auto mb-2" size={32} />No consultants yet
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit Consultant Form */}
      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Consultant' : 'Add Consultant'} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input type="text" required value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input type="text" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">WhatsApp</label>
              <input type="text" value={form.whatsapp} onChange={e => setForm({...form, whatsapp: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Commission per Sale (ZMW)</label>
              <input type="number" step="0.01" value={form.commissionRate} onChange={e => setForm({...form, commissionRate: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Monthly Allowance (ZMW)</label>
              <input type="number" step="0.01" value={form.monthlyAllowance} onChange={e => setForm({...form, monthlyAllowance: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">{editing ? 'Update' : 'Add'}</button>
          </div>
        </form>
      </Modal>

      {/* Consultant Detail Modal */}
      <Modal isOpen={!!showDetail && !showPaymentForm} onClose={() => setShowDetail(null)} title={showDetail?.name || 'Consultant Details'} size="lg">
        {showDetail && (
          <div className="space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Total Sales</div>
                <div className="text-lg font-bold">{showDetail.totalSales || 0}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Revenue Generated</div>
                <div className="text-lg font-bold">{formatMoney(showDetail.totalRevenue || 0)}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Commission Earned</div>
                <div className="text-lg font-bold text-orange-600">{formatMoney(showDetail.commissionEarned || 0)}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Balance Owed</div>
                <div className="text-lg font-bold text-red-600">{formatMoney(showDetail.balance || 0)}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-blue-50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Commission Paid</div>
                <div className="text-lg font-bold text-blue-600">{formatMoney(showDetail.commissionPaid || 0)}</div>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Allowance Paid</div>
                <div className="text-lg font-bold text-green-600">{formatMoney(showDetail.allowancePaid || 0)}</div>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => { setPaymentForm(emptyPayment); setShowPaymentForm(true); }}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">
                <FiDollarSign size={14} /> Record Payment
              </button>
            </div>

            {/* Recent Sales */}
            {showDetail.sales?.length > 0 && (
              <div>
                <h3 className="font-medium text-gray-800 mb-2">Recent Sales</h3>
                <div className="max-h-48 overflow-auto border border-gray-200 rounded-lg">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        <th className="text-left p-2 font-medium text-gray-600">Order</th>
                        <th className="text-left p-2 font-medium text-gray-600">Date</th>
                        <th className="text-left p-2 font-medium text-gray-600">Customer</th>
                        <th className="text-right p-2 font-medium text-gray-600">Amount</th>
                        <th className="text-right p-2 font-medium text-gray-600">Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {showDetail.sales.slice(0, 20).map(s => (
                        <tr key={s.id} className="border-b border-gray-50">
                          <td className="p-2 text-gray-800">{s.orderNumber}</td>
                          <td className="p-2 text-gray-600">{formatDate(s.date)}</td>
                          <td className="p-2 text-gray-600">{s.customerName || '-'}</td>
                          <td className="p-2 text-right">{formatMoney(s.totalPrice)}</td>
                          <td className="p-2 text-right text-orange-600">{formatMoney(showDetail.commissionRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Payment History */}
            {showDetail.payments?.length > 0 && (
              <div>
                <h3 className="font-medium text-gray-800 mb-2">Payment History</h3>
                <div className="max-h-48 overflow-auto border border-gray-200 rounded-lg">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        <th className="text-left p-2 font-medium text-gray-600">Date</th>
                        <th className="text-left p-2 font-medium text-gray-600">Type</th>
                        <th className="text-right p-2 font-medium text-gray-600">Amount</th>
                        <th className="text-left p-2 font-medium text-gray-600">Method</th>
                        <th className="text-left p-2 font-medium text-gray-600">Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {showDetail.payments.map(p => (
                        <tr key={p.id} className="border-b border-gray-50">
                          <td className="p-2 text-gray-600">{formatDate(p.createdAt)}</td>
                          <td className="p-2">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${p.type === 'commission' ? 'bg-orange-50 text-orange-700' : 'bg-blue-50 text-blue-700'}`}>
                              {p.type}
                            </span>
                          </td>
                          <td className="p-2 text-right font-medium">{formatMoney(p.amount)}</td>
                          <td className="p-2 text-gray-600">{p.paymentMethod || '-'}</td>
                          <td className="p-2 text-gray-600">{p.reference || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Record Payment Modal */}
      <Modal isOpen={showPaymentForm} onClose={() => setShowPaymentForm(false)} title={`Pay ${showDetail?.name || 'Consultant'}`} size="md">
        <form onSubmit={handlePayment} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (ZMW) *</label>
              <input type="number" step="0.01" required value={paymentForm.amount} onChange={e => setPaymentForm({...paymentForm, amount: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select value={paymentForm.type} onChange={e => setPaymentForm({...paymentForm, type: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                <option value="commission">Commission</option>
                <option value="allowance">Communication Allowance</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
              <select value={paymentForm.paymentMethod} onChange={e => setPaymentForm({...paymentForm, paymentMethod: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select</option>
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
              <input type="text" value={paymentForm.reference} onChange={e => setPaymentForm({...paymentForm, reference: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period From</label>
              <input type="date" value={paymentForm.periodFrom} onChange={e => setPaymentForm({...paymentForm, periodFrom: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period To</label>
              <input type="date" value={paymentForm.periodTo} onChange={e => setPaymentForm({...paymentForm, periodTo: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea value={paymentForm.notes} onChange={e => setPaymentForm({...paymentForm, notes: e.target.value})} rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowPaymentForm(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">Record Payment</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} onConfirm={handleDelete}
        title="Remove Consultant" message={`Remove "${deleteConfirm?.name}"? If they have sales, they will be deactivated instead.`} />
    </div>
  );
}
