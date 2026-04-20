import { useState, useEffect } from 'react';
import { getExpenses, createExpense, updateExpense, deleteExpense } from '../services/api';
import { formatMoney, formatDate, EXPENSE_CATEGORIES, PAYMENT_METHODS } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import Pagination from '../components/Pagination';
import SortableHeader from '../components/SortableHeader';
import useTableControls from '../hooks/useTableControls';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiDollarSign } from 'react-icons/fi';

export default function Expenses() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const emptyForm = { description: '', amount: '', category: '', date: '', paymentMethod: '', isRecurring: false, frequency: '', notes: '' };
  const [form, setForm] = useState(emptyForm);

  const loadExpenses = () => {
    setLoading(true);
    getExpenses({ category: categoryFilter || undefined, from: fromDate || undefined, to: toDate || undefined })
      .then(res => setExpenses(res.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadExpenses(); }, [categoryFilter, fromDate, toDate]);

  const openCreate = () => { setEditing(null); setForm(emptyForm); setShowForm(true); };

  const openEdit = (e) => {
    setEditing(e);
    setForm({
      description: e.description, amount: e.amount, category: e.category,
      date: e.date ? e.date.slice(0, 10) : '', paymentMethod: e.paymentMethod || '',
      isRecurring: e.isRecurring, frequency: e.frequency || '', notes: e.notes || ''
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const data = { ...form, amount: parseFloat(form.amount) };
      data.date = data.date ? new Date(data.date).toISOString() : new Date().toISOString();
      if (editing) {
        await updateExpense(editing.id, data);
        toast.success('Expense updated');
      } else {
        await createExpense(data);
        toast.success('Expense added');
      }
      setShowForm(false);
      loadExpenses();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error saving expense');
    }
  };

  const handleDelete = async () => {
    try {
      await deleteExpense(deleteConfirm.id);
      toast.success('Expense deleted');
      setDeleteConfirm(null);
      loadExpenses();
    } catch { toast.error('Error deleting expense'); }
  };

  const total = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
  const table = useTableControls(expenses, { pageSize: 25 });

  // Group by category summary
  const byCat = {};
  expenses.forEach(e => {
    if (!byCat[e.category]) byCat[e.category] = 0;
    byCat[e.category] += parseFloat(e.amount);
  });

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <div className="flex gap-2 items-center flex-wrap">
          <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm outline-none">
            <option value="">All Categories</option>
            {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm outline-none" />
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm outline-none" />
        </div>
        <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <FiPlus size={16} /> Add Expense
        </button>
      </div>

      {/* Summary */}
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
        <div className="flex flex-wrap gap-4">
          <div className="text-sm"><span className="text-gray-500">Total:</span> <span className="font-bold text-gray-800">{formatMoney(total)}</span></div>
          {Object.entries(byCat).map(([cat, amt]) => (
            <div key={cat} className="text-sm"><span className="text-gray-500">{cat}:</span> <span className="font-medium">{formatMoney(amt)}</span></div>
          ))}
        </div>
      </div>

      {loading ? <LoadingSpinner /> : (
        <>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3"><SortableHeader label="Date" sortKey="date" accessor={(r) => new Date(r.date).getTime()} sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-left p-3"><SortableHeader label="Description" sortKey="description" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-left p-3 hidden sm:table-cell"><SortableHeader label="Category" sortKey="category" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-right p-3"><SortableHeader label="Amount" sortKey="amount" accessor={(r) => parseFloat(r.amount)} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-left p-3 hidden md:table-cell font-medium text-gray-600">Payment</th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {table.pageRows.map(e => (
                <tr key={e.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="p-3 text-gray-600">{formatDate(e.date)}</td>
                  <td className="p-3">
                    <div className="text-gray-800">{e.description}</div>
                    <div className="text-xs text-gray-500 sm:hidden">{e.category}</div>
                    {e.isRecurring && <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded ml-1">{e.frequency || 'recurring'}</span>}
                  </td>
                  <td className="p-3 text-gray-600 hidden sm:table-cell">{e.category}</td>
                  <td className="p-3 text-right font-medium text-gray-800">{formatMoney(e.amount)}</td>
                  <td className="p-3 text-gray-600 hidden md:table-cell">{e.paymentMethod || '-'}</td>
                  <td className="p-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => openEdit(e)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEdit2 size={15} /></button>
                      <button onClick={() => setDeleteConfirm(e)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {table.pageRows.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-gray-500">
                  <FiDollarSign className="mx-auto mb-2" size={32} />No expenses found
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={table.page} totalPages={table.totalPages} total={table.total}
          pageSize={table.pageSize} onPageChange={table.setPage} onPageSizeChange={table.setPageSize}
        />
        </>
      )}

      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Expense' : 'Add Expense'} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Description *</label>
              <input type="text" required value={form.description} onChange={e => setForm({...form, description: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
              <input type="number" step="0.01" required value={form.amount} onChange={e => setForm({...form, amount: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
              <select required value={form.category} onChange={e => setForm({...form, category: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select</option>
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
              <input type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
              <select value={form.paymentMethod} onChange={e => setForm({...form, paymentMethod: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select</option>
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2 flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.isRecurring} onChange={e => setForm({...form, isRecurring: e.target.checked})} />
                Recurring
              </label>
              {form.isRecurring && (
                <select value={form.frequency} onChange={e => setForm({...form, frequency: e.target.value})}
                  className="border border-gray-300 rounded-lg px-2 py-1 text-sm outline-none">
                  <option value="">Frequency</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              )}
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

      <ConfirmDialog isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} onConfirm={handleDelete}
        title="Delete Expense" message={`Delete "${deleteConfirm?.description}"?`} />
    </div>
  );
}
