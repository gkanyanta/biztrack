import { useState, useEffect } from 'react';
import { getSales, createSale, updateSale, updateSaleStatus, deleteSale, getProducts, getShippingRates } from '../services/api';
import { formatMoney, formatDate, ORDER_STATUSES, PAYMENT_STATUSES, PAYMENT_METHODS, SOURCES } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import { StatusBadge, PaymentBadge } from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiShoppingCart, FiEye } from 'react-icons/fi';

export default function Sales() {
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [shippingRates, setShippingRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [showDetail, setShowDetail] = useState(null);

  const emptyForm = {
    productId: '', qty: '1', unitPrice: '', customerName: '', customerPhone: '',
    customerCity: '', deliveryAddress: '', shippingCost: '', shippingCharge: '',
    discount: '0', paymentMethod: '', paymentStatus: 'Unpaid', source: '', notes: '', date: ''
  };
  const [form, setForm] = useState(emptyForm);

  const loadSales = () => {
    setLoading(true);
    getSales({ search: search || undefined, status: statusFilter || undefined })
      .then(res => setSales(res.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadSales(); }, [search, statusFilter]);
  useEffect(() => {
    getProducts().then(res => setProducts(res.data.filter(p => p.isActive)));
    getShippingRates().then(res => setShippingRates(res.data));
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (sale) => {
    setEditing(sale);
    setForm({
      productId: sale.productId, qty: String(sale.qty), unitPrice: sale.unitPrice,
      customerName: sale.customerName || '', customerPhone: sale.customerPhone || '',
      customerCity: sale.customerCity || '', deliveryAddress: sale.deliveryAddress || '',
      shippingCost: sale.shippingCost, shippingCharge: sale.shippingCharge,
      discount: sale.discount, paymentMethod: sale.paymentMethod || '',
      paymentStatus: sale.paymentStatus, source: sale.source || '', notes: sale.notes || '',
      date: sale.date ? sale.date.slice(0, 10) : ''
    });
    setShowForm(true);
  };

  const onProductChange = (productId) => {
    const product = products.find(p => p.id === productId);
    setForm(f => ({ ...f, productId, unitPrice: product ? product.sellingPrice : '' }));
  };

  const onCityChange = (city) => {
    const rate = shippingRates.find(r => r.city.toLowerCase() === city.toLowerCase());
    setForm(f => ({ ...f, customerCity: city, shippingCost: rate ? rate.rate : f.shippingCost }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const data = { ...form };
      if (editing) {
        await updateSale(editing.id, data);
        toast.success('Sale updated');
      } else {
        await createSale(data);
        toast.success('Sale recorded');
      }
      setShowForm(false);
      loadSales();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error saving sale');
    }
  };

  const handleStatusChange = async (sale, newStatus) => {
    try {
      await updateSaleStatus(sale.id, newStatus);
      toast.success(`Status changed to ${newStatus}`);
      loadSales();
    } catch {
      toast.error('Error updating status');
    }
  };

  const handleDelete = async () => {
    try {
      await deleteSale(deleteConfirm.id);
      toast.success('Sale deleted');
      setDeleteConfirm(null);
      loadSales();
    } catch {
      toast.error('Error deleting sale');
    }
  };

  const calcProfit = (s) => {
    return parseFloat(s.totalPrice) - (parseFloat(s.costPrice) * s.qty) -
      parseFloat(s.shippingCost) + parseFloat(s.shippingCharge) - parseFloat(s.discount);
  };

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <div className="flex gap-2 items-center w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-none">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input type="text" placeholder="Search orders..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm w-full sm:w-56 outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm outline-none">
            <option value="">All Status</option>
            {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <FiPlus size={16} /> Record Sale
        </button>
      </div>

      {/* Sales table */}
      {loading ? <LoadingSpinner /> : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Order</th>
                <th className="text-left p-3 font-medium text-gray-600 hidden md:table-cell">Product</th>
                <th className="text-left p-3 font-medium text-gray-600 hidden lg:table-cell">Customer</th>
                <th className="text-right p-3 font-medium text-gray-600">Total</th>
                <th className="text-right p-3 font-medium text-gray-600 hidden sm:table-cell">Profit</th>
                <th className="text-center p-3 font-medium text-gray-600">Status</th>
                <th className="text-center p-3 font-medium text-gray-600 hidden sm:table-cell">Payment</th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sales.map(s => (
                <tr key={s.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="p-3">
                    <div className="font-medium text-gray-800">{s.orderNumber}</div>
                    <div className="text-xs text-gray-500">{formatDate(s.date)}</div>
                  </td>
                  <td className="p-3 text-gray-600 hidden md:table-cell">
                    {s.product?.name} <span className="text-gray-400">x{s.qty}</span>
                  </td>
                  <td className="p-3 hidden lg:table-cell">
                    <div className="text-gray-700">{s.customerName || '-'}</div>
                    <div className="text-xs text-gray-500">{s.customerCity || ''}</div>
                  </td>
                  <td className="p-3 text-right font-medium text-gray-800">{formatMoney(s.totalPrice)}</td>
                  <td className="p-3 text-right hidden sm:table-cell">
                    <span className={calcProfit(s) >= 0 ? 'text-green-600' : 'text-red-600'}>
                      {formatMoney(calcProfit(s))}
                    </span>
                  </td>
                  <td className="p-3 text-center">
                    <select
                      value={s.status}
                      onChange={e => handleStatusChange(s, e.target.value)}
                      className="text-xs border border-gray-200 rounded px-1 py-0.5 outline-none"
                    >
                      {ORDER_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                    </select>
                  </td>
                  <td className="p-3 text-center hidden sm:table-cell">
                    <PaymentBadge status={s.paymentStatus} />
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => setShowDetail(s)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEye size={15} /></button>
                      <button onClick={() => openEdit(s)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEdit2 size={15} /></button>
                      <button onClick={() => setDeleteConfirm(s)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {sales.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-gray-500">
                  <FiShoppingCart className="mx-auto mb-2" size={32} />No sales found
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Sale Modal */}
      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Sale' : 'Record Sale'} size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Product *</label>
              <select required value={form.productId} onChange={e => onProductChange(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select product</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name} ({formatMoney(p.sellingPrice)}) — Stock: {p.stock}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Qty *</label>
                <input type="number" min="1" required value={form.qty} onChange={e => setForm({...form, qty: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Unit Price</label>
                <input type="number" step="0.01" value={form.unitPrice} onChange={e => setForm({...form, unitPrice: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer Name</label>
              <input type="text" value={form.customerName} onChange={e => setForm({...form, customerName: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input type="text" value={form.customerPhone} onChange={e => setForm({...form, customerPhone: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input type="text" value={form.customerCity} onChange={e => onCityChange(e.target.value)}
                list="cities"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <datalist id="cities">
                {shippingRates.map(r => <option key={r.id} value={r.city} />)}
              </datalist>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Delivery Address</label>
              <input type="text" value={form.deliveryAddress} onChange={e => setForm({...form, deliveryAddress: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Shipping Cost</label>
                <input type="number" step="0.01" value={form.shippingCost} onChange={e => setForm({...form, shippingCost: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Shipping Charge</label>
                <input type="number" step="0.01" value={form.shippingCharge} onChange={e => setForm({...form, shippingCharge: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Discount</label>
              <input type="number" step="0.01" value={form.discount} onChange={e => setForm({...form, discount: e.target.value})}
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
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Status</label>
              <select value={form.paymentStatus} onChange={e => setForm({...form, paymentStatus: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
              <select value={form.source} onChange={e => setForm({...form, source: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select</option>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
              <input type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          {form.unitPrice && form.qty && (
            <p className="text-sm text-gray-500">
              Total: <span className="font-medium text-gray-700">{formatMoney(parseFloat(form.unitPrice) * parseInt(form.qty || 0))}</span>
            </p>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">{editing ? 'Update' : 'Record Sale'}</button>
          </div>
        </form>
      </Modal>

      {/* Sale Detail Modal */}
      <Modal isOpen={!!showDetail} onClose={() => setShowDetail(null)} title={`Order ${showDetail?.orderNumber}`} size="md">
        {showDetail && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><span className="text-gray-500">Product:</span> <span className="font-medium">{showDetail.product?.name}</span></div>
              <div><span className="text-gray-500">Qty:</span> <span className="font-medium">{showDetail.qty}</span></div>
              <div><span className="text-gray-500">Unit Price:</span> <span className="font-medium">{formatMoney(showDetail.unitPrice)}</span></div>
              <div><span className="text-gray-500">Total:</span> <span className="font-medium">{formatMoney(showDetail.totalPrice)}</span></div>
              <div><span className="text-gray-500">Cost Price:</span> <span className="font-medium">{formatMoney(showDetail.costPrice)}</span></div>
              <div><span className="text-gray-500">Profit:</span> <span className={`font-medium ${calcProfit(showDetail) >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatMoney(calcProfit(showDetail))}</span></div>
              <div><span className="text-gray-500">Shipping Cost:</span> {formatMoney(showDetail.shippingCost)}</div>
              <div><span className="text-gray-500">Shipping Charge:</span> {formatMoney(showDetail.shippingCharge)}</div>
              <div><span className="text-gray-500">Customer:</span> {showDetail.customerName || '-'}</div>
              <div><span className="text-gray-500">Phone:</span> {showDetail.customerPhone || '-'}</div>
              <div><span className="text-gray-500">City:</span> {showDetail.customerCity || '-'}</div>
              <div><span className="text-gray-500">Source:</span> {showDetail.source || '-'}</div>
              <div><span className="text-gray-500">Status:</span> <StatusBadge status={showDetail.status} /></div>
              <div><span className="text-gray-500">Payment:</span> <PaymentBadge status={showDetail.paymentStatus} /></div>
            </div>
            {showDetail.notes && <div><span className="text-gray-500">Notes:</span> {showDetail.notes}</div>}
          </div>
        )}
      </Modal>

      <ConfirmDialog isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} onConfirm={handleDelete}
        title="Delete Sale" message={`Delete order ${deleteConfirm?.orderNumber}? Stock will be restored if applicable.`} />
    </div>
  );
}
