import { useState, useEffect } from 'react';
import { getCustomers, createCustomer, updateCustomer, deleteCustomer, getCustomerOrders } from '../services/api';
import { formatMoney, formatDate, SOURCES } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import { StatusBadge } from '../components/StatusBadge';
import Pagination from '../components/Pagination';
import SortableHeader from '../components/SortableHeader';
import useTableControls from '../hooks/useTableControls';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiUsers, FiEye } from 'react-icons/fi';

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [showOrders, setShowOrders] = useState(null);
  const [orders, setOrders] = useState([]);

  const emptyForm = { name: '', phone: '', whatsapp: '', city: '', email: '', source: '', notes: '' };
  const [form, setForm] = useState(emptyForm);

  const loadCustomers = () => {
    setLoading(true);
    getCustomers({ search: search || undefined })
      .then(res => setCustomers(res.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadCustomers(); }, [search]);

  const openCreate = () => { setEditing(null); setForm(emptyForm); setShowForm(true); };
  const openEdit = (c) => {
    setEditing(c);
    setForm({ name: c.name, phone: c.phone || '', whatsapp: c.whatsapp || '', city: c.city || '', email: c.email || '', source: c.source || '', notes: c.notes || '' });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await updateCustomer(editing.id, form);
        toast.success('Customer updated');
      } else {
        await createCustomer(form);
        toast.success('Customer added');
      }
      setShowForm(false);
      loadCustomers();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error');
    }
  };

  const handleDelete = async () => {
    try {
      await deleteCustomer(deleteConfirm.id);
      toast.success('Customer deleted');
      setDeleteConfirm(null);
      loadCustomers();
    } catch { toast.error('Error deleting'); }
  };

  const viewOrders = async (c) => {
    setShowOrders(c);
    const res = await getCustomerOrders(c.id);
    setOrders(res.data);
  };

  const repeatCustomers = customers.filter(c => (c._count?.sales || 0) > 1).length;
  const table = useTableControls(customers, { pageSize: 25 });

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <div className="flex gap-3 items-center w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-none">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input type="text" placeholder="Search customers..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm w-full sm:w-64 outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="text-sm text-gray-500">
            {customers.length} total / {repeatCustomers} repeat
          </div>
        </div>
        <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <FiPlus size={16} /> Add Customer
        </button>
      </div>

      {loading ? <LoadingSpinner /> : (
        <>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3"><SortableHeader label="Name" sortKey="name" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-left p-3 hidden sm:table-cell"><SortableHeader label="Phone" sortKey="phone" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-left p-3 hidden md:table-cell"><SortableHeader label="City" sortKey="city" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-left p-3 hidden lg:table-cell"><SortableHeader label="Source" sortKey="source" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-center p-3"><SortableHeader label="Orders" sortKey="orders" accessor={(r) => r._count?.sales || 0} sort={table.sort} onToggle={table.toggleSort} align="center" /></th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {table.pageRows.map(c => (
                <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="p-3">
                    <div className="font-medium text-gray-800">{c.name}</div>
                    <div className="text-xs text-gray-500 sm:hidden">{c.phone || ''}</div>
                  </td>
                  <td className="p-3 text-gray-600 hidden sm:table-cell">{c.phone || '-'}</td>
                  <td className="p-3 text-gray-600 hidden md:table-cell">{c.city || '-'}</td>
                  <td className="p-3 text-gray-600 hidden lg:table-cell">{c.source || '-'}</td>
                  <td className="p-3 text-center">
                    <button onClick={() => viewOrders(c)} className="text-blue-600 hover:underline font-medium">
                      {c._count?.sales || 0}
                    </button>
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => viewOrders(c)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEye size={15} /></button>
                      <button onClick={() => openEdit(c)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEdit2 size={15} /></button>
                      <button onClick={() => setDeleteConfirm(c)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {table.pageRows.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-gray-500">
                  <FiUsers className="mx-auto mb-2" size={32} />No customers found
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

      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Customer' : 'Add Customer'} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input type="text" value={form.city} onChange={e => setForm({...form, city: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
              <select value={form.source} onChange={e => setForm({...form, source: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select</option>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
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

      {/* Customer Orders Modal */}
      <Modal isOpen={!!showOrders} onClose={() => setShowOrders(null)} title={`Orders — ${showOrders?.name}`} size="lg">
        <div className="space-y-2">
          {orders.map(o => (
            <div key={o.id} className="flex items-center justify-between py-2 border-b border-gray-50 text-sm">
              <div>
                <span className="font-medium text-gray-800">{o.orderNumber}</span>
                <span className="text-gray-500 ml-2">{formatDate(o.date)}</span>
                <span className="text-gray-500 ml-2">{o.product?.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={o.status} />
                <span className="font-medium">{formatMoney(o.totalPrice)}</span>
              </div>
            </div>
          ))}
          {orders.length === 0 && <p className="text-center text-gray-500 py-4">No orders yet</p>}
          {orders.length > 0 && (
            <div className="pt-2 text-sm text-right font-medium text-gray-700">
              Total: {formatMoney(orders.reduce((s, o) => s + parseFloat(o.totalPrice), 0))}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} onConfirm={handleDelete}
        title="Delete Customer" message={`Delete "${deleteConfirm?.name}"?`} />
    </div>
  );
}
