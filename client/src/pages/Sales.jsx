import { useState, useEffect } from 'react';
import { getSales, createSale, updateSale, updateSaleStatus, deleteSale, getProducts, getShippingRates, recordCreditPayment, getSale } from '../services/api';
import { formatMoney, formatDate, formatDateTime, ORDER_STATUSES, PAYMENT_STATUSES, PAYMENT_METHODS, SOURCES, PAYMENT_TYPES } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import { StatusBadge, PaymentBadge } from '../components/StatusBadge';
import ReceiptButton from '../components/ReceiptButton';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiShoppingCart, FiEye, FiPackage, FiDollarSign, FiX } from 'react-icons/fi';

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
  const [productSearch, setProductSearch] = useState('');
  const [showProductPicker, setShowProductPicker] = useState(false);

  // Line items for the order
  const [orderItems, setOrderItems] = useState([]);
  const emptyForm = {
    customerName: '', customerPhone: '', customerCity: '', deliveryAddress: '',
    shippingCost: '', shippingCharge: '', discount: '0', paymentMethod: '',
    paymentStatus: 'Unpaid', source: '', notes: '', date: '',
    paymentType: 'Cash', amountPaid: '', creditDueDate: '', creditNotes: ''
  };
  const [form, setForm] = useState(emptyForm);
  const [creditPaymentForm, setCreditPaymentForm] = useState({ amount: '', paymentMethod: '', reference: '', notes: '' });
  const [showPaymentForm, setShowPaymentForm] = useState(false);

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

  const addProduct = (product) => {
    const existing = orderItems.find(i => i.productId === product.id);
    if (existing) {
      setOrderItems(orderItems.map(i => i.productId === product.id ? { ...i, qty: i.qty + 1 } : i));
    } else {
      setOrderItems([...orderItems, { productId: product.id, name: product.name, sku: product.sku, qty: 1, unitPrice: parseFloat(product.sellingPrice), stock: product.stock }]);
    }
    setShowProductPicker(false);
    setProductSearch('');
  };

  const updateItem = (idx, field, value) => {
    setOrderItems(orderItems.map((item, i) => i === idx ? { ...item, [field]: field === 'qty' ? parseInt(value) || 1 : parseFloat(value) || 0 } : item));
  };

  const removeItem = (idx) => {
    setOrderItems(orderItems.filter((_, i) => i !== idx));
  };

  const openNewSale = () => {
    setEditing(null);
    setOrderItems([]);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (sale) => {
    setEditing(sale);
    setOrderItems((sale.items || []).map(i => ({
      productId: i.productId, name: i.product?.name || 'Product', sku: i.product?.sku || '', qty: i.qty, unitPrice: parseFloat(i.unitPrice), stock: i.product?.stock || 0
    })));
    setForm({
      customerName: sale.customerName || '', customerPhone: sale.customerPhone || '',
      customerCity: sale.customerCity || '', deliveryAddress: sale.deliveryAddress || '',
      shippingCost: sale.shippingCost, shippingCharge: sale.shippingCharge,
      discount: sale.discount, paymentMethod: sale.paymentMethod || '',
      paymentStatus: sale.paymentStatus, source: sale.source || '', notes: sale.notes || '',
      date: sale.date ? sale.date.slice(0, 10) : '',
      paymentType: sale.paymentType || 'Cash', amountPaid: sale.amountPaid || '',
      creditDueDate: sale.creditDueDate ? sale.creditDueDate.slice(0, 10) : '', creditNotes: sale.creditNotes || ''
    });
    setShowForm(true);
  };

  const onCityChange = (city) => {
    const rate = shippingRates.find(r => r.city.toLowerCase() === city.toLowerCase());
    setForm(f => ({ ...f, customerCity: city, shippingCost: rate ? rate.rate : f.shippingCost }));
  };

  const itemsTotal = orderItems.reduce((sum, i) => sum + (i.qty * i.unitPrice), 0);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!orderItems.length) { toast.error('Add at least one product'); return; }
    try {
      const data = {
        ...form,
        items: orderItems.map(i => ({ productId: i.productId, qty: i.qty, unitPrice: i.unitPrice })),
        shippingCost: parseFloat(form.shippingCost) || 0,
        shippingCharge: parseFloat(form.shippingCharge) || 0,
        discount: parseFloat(form.discount) || 0,
        amountPaid: parseFloat(form.amountPaid) || 0,
      };
      if (data.date) data.date = new Date(data.date).toISOString();
      if (editing) {
        await updateSale(editing.id, data);
        toast.success('Sale updated');
      } else {
        await createSale(data);
        toast.success('Sale recorded');
      }
      setShowForm(false);
      setOrderItems([]);
      loadSales();
      getProducts().then(res => setProducts(res.data.filter(p => p.isActive)));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error saving sale');
    }
  };

  const handleStatusChange = async (sale, newStatus) => {
    try {
      await updateSaleStatus(sale.id, newStatus);
      toast.success(`Status changed to ${newStatus}`);
      loadSales();
    } catch { toast.error('Error updating status'); }
  };

  const handleDelete = async () => {
    try {
      await deleteSale(deleteConfirm.id);
      toast.success('Sale deleted');
      setDeleteConfirm(null);
      loadSales();
    } catch { toast.error('Error deleting sale'); }
  };

  const handleRecordPayment = async (e) => {
    e.preventDefault();
    try {
      const { data } = await recordCreditPayment(showDetail.id, {
        amount: parseFloat(creditPaymentForm.amount),
        paymentMethod: creditPaymentForm.paymentMethod || null,
        reference: creditPaymentForm.reference || null,
        notes: creditPaymentForm.notes || null,
      });
      toast.success('Payment recorded');
      setShowDetail(data);
      setShowPaymentForm(false);
      setCreditPaymentForm({ amount: '', paymentMethod: '', reference: '', notes: '' });
      loadSales();
    } catch (err) { toast.error(err.response?.data?.error || 'Error recording payment'); }
  };

  const openDetail = async (sale) => {
    try { const { data } = await getSale(sale.id); setShowDetail(data); }
    catch { setShowDetail(sale); }
  };

  const calcProfit = (s) => {
    const cogs = (s.items || []).reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0);
    return parseFloat(s.totalPrice) - cogs - parseFloat(s.shippingCost) + parseFloat(s.shippingCharge) - parseFloat(s.discount);
  };

  const itemsSummary = (s) => {
    if (!s.items?.length) return '-';
    if (s.items.length === 1) return `${s.items[0].product?.name || 'Product'} x${s.items[0].qty}`;
    return `${s.items.length} items`;
  };

  const filteredProducts = products.filter(p =>
    !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase()) || p.sku.toLowerCase().includes(productSearch.toLowerCase())
  );

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      {/* Quick Add from Product Tiles */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Quick Sale — tap a product</h3>
          <div className="flex gap-2">
            <div className="relative">
              <FiSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input type="text" placeholder="Search products..." value={productSearch} onChange={e => setProductSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm w-48 outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <button onClick={openNewSale} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
              <FiPlus size={14} /> New Order
            </button>
          </div>
        </div>

        {filteredProducts.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filteredProducts.map(p => (
              <button key={p.id} onClick={() => { addProduct(p); if (!showForm) { setForm(emptyForm); setEditing(null); setShowForm(true); } }}
                className="bg-white rounded-xl border border-gray-200 p-3 text-left hover:border-blue-400 hover:shadow-md transition-all group">
                <div className="flex items-center justify-center w-10 h-10 bg-blue-50 rounded-lg mb-2 group-hover:bg-blue-100">
                  <FiPackage className="text-blue-500" size={20} />
                </div>
                <div className="font-medium text-gray-800 text-sm truncate">{p.name}</div>
                <div className="text-xs text-gray-500 mt-0.5">{p.sku}</div>
                <div className="font-bold text-blue-600 text-sm mt-1">{formatMoney(p.sellingPrice)}</div>
                <div className={`text-xs mt-1 ${p.stock <= p.reorderLevel ? 'text-red-500 font-medium' : 'text-gray-400'}`}>{p.stock} in stock</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">
            <FiPackage className="mx-auto mb-2" size={32} />
            <p className="text-sm">No products found.</p>
          </div>
        )}
      </div>

      {/* Orders Table */}
      <div>
        <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Orders</h3>
          <div className="flex gap-2 items-center w-full sm:w-auto">
            <div className="relative flex-1 sm:flex-none">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input type="text" placeholder="Search orders..." value={search} onChange={e => setSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm w-full sm:w-48 outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm outline-none">
              <option value="">All Status</option>
              {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {loading ? <LoadingSpinner /> : (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left p-3 font-medium text-gray-600">Order</th>
                  <th className="text-left p-3 font-medium text-gray-600 hidden md:table-cell">Items</th>
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
                      {itemsSummary(s)}
                    </td>
                    <td className="p-3 hidden lg:table-cell">
                      <div className="text-gray-700">{s.customerName || '-'}</div>
                      <div className="text-xs text-gray-500">{s.customerCity || ''}</div>
                    </td>
                    <td className="p-3 text-right font-medium text-gray-800">{formatMoney(s.totalPrice)}</td>
                    <td className="p-3 text-right hidden sm:table-cell">
                      <span className={calcProfit(s) >= 0 ? 'text-green-600' : 'text-red-600'}>{formatMoney(calcProfit(s))}</span>
                    </td>
                    <td className="p-3 text-center">
                      <select value={s.status} onChange={e => handleStatusChange(s, e.target.value)}
                        className="text-xs border border-gray-200 rounded px-1 py-0.5 outline-none">
                        {ORDER_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                      </select>
                    </td>
                    <td className="p-3 text-center hidden sm:table-cell"><PaymentBadge status={s.paymentStatus} /></td>
                    <td className="p-3 text-right">
                      <div className="flex gap-1 justify-end">
                        <ReceiptButton saleId={s.id} size={15} className="p-1.5" />
                        <button onClick={() => openDetail(s)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEye size={15} /></button>
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
      </div>

      {/* Record/Edit Sale Modal */}
      <Modal isOpen={showForm} onClose={() => { setShowForm(false); setOrderItems([]); }} title={editing ? 'Edit Sale' : 'New Order'} size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Items *</label>
              <button type="button" onClick={() => setShowProductPicker(true)}
                className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
                <FiPlus size={14} /> Add Product
              </button>
            </div>
            {orderItems.length === 0 ? (
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center text-gray-400 text-sm">
                Tap a product tile above or click "Add Product"
              </div>
            ) : (
              <div className="space-y-2">
                {orderItems.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2 bg-gray-50 rounded-lg p-2 border border-gray-200">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-800 text-sm truncate">{item.name}</div>
                      <div className="text-xs text-gray-400">{item.sku}</div>
                    </div>
                    <input type="number" min="1" value={item.qty} onChange={e => updateItem(idx, 'qty', e.target.value)}
                      className="w-16 border border-gray-300 rounded px-2 py-1 text-sm text-center outline-none focus:ring-1 focus:ring-blue-500" />
                    <span className="text-gray-400 text-xs">x</span>
                    <input type="number" step="0.01" value={item.unitPrice} onChange={e => updateItem(idx, 'unitPrice', e.target.value)}
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right outline-none focus:ring-1 focus:ring-blue-500" />
                    <span className="text-sm font-medium text-gray-700 w-24 text-right">{formatMoney(item.qty * item.unitPrice)}</span>
                    <button type="button" onClick={() => removeItem(idx)} className="p-1 text-red-400 hover:text-red-600"><FiX size={16} /></button>
                  </div>
                ))}
                <div className="flex justify-end text-sm font-semibold text-gray-800 pr-10">
                  Subtotal: {formatMoney(itemsTotal)}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              <input type="text" value={form.customerCity} onChange={e => onCityChange(e.target.value)} list="cities"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <datalist id="cities">{shippingRates.map(r => <option key={r.id} value={r.city} />)}</datalist>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Type</label>
              <div className="flex gap-2">
                {PAYMENT_TYPES.map(t => (
                  <button key={t} type="button" onClick={() => setForm({...form, paymentType: t})}
                    className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${form.paymentType === t ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Status</label>
              <select value={form.paymentStatus} onChange={e => setForm({...form, paymentStatus: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {form.paymentType === 'Credit' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Initial Deposit</label>
                  <input type="number" step="0.01" min="0" value={form.amountPaid} onChange={e => setForm({...form, amountPaid: e.target.value})}
                    placeholder="0.00" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
                  <input type="date" value={form.creditDueDate} onChange={e => setForm({...form, creditDueDate: e.target.value})}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Credit Notes</label>
                  <input type="text" value={form.creditNotes} onChange={e => setForm({...form, creditNotes: e.target.value})}
                    placeholder="e.g. Will pay after payday" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </>
            )}
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

          {orderItems.length > 0 && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-gray-500">Items total</span><span>{formatMoney(itemsTotal)}</span></div>
              {parseFloat(form.shippingCharge) > 0 && <div className="flex justify-between"><span className="text-gray-500">Shipping</span><span>+{formatMoney(form.shippingCharge)}</span></div>}
              {parseFloat(form.discount) > 0 && <div className="flex justify-between"><span className="text-gray-500">Discount</span><span>-{formatMoney(form.discount)}</span></div>}
              <div className="flex justify-between font-bold text-gray-800 pt-1 border-t border-gray-200">
                <span>Order Total</span>
                <span>{formatMoney(itemsTotal + (parseFloat(form.shippingCharge) || 0) - (parseFloat(form.discount) || 0))}</span>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => { setShowForm(false); setOrderItems([]); }} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">{editing ? 'Update' : 'Record Sale'}</button>
          </div>
        </form>
      </Modal>

      {/* Product Picker Modal */}
      <Modal isOpen={showProductPicker} onClose={() => setShowProductPicker(false)} title="Add Product">
        <div className="space-y-3">
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input type="text" placeholder="Search..." autoFocus
              onChange={e => setProductSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filteredProducts.map(p => (
              <button key={p.id} onClick={() => addProduct(p)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-blue-50 text-left text-sm">
                <div>
                  <div className="font-medium text-gray-800">{p.name}</div>
                  <div className="text-xs text-gray-400">{p.sku} &middot; {p.stock} in stock</div>
                </div>
                <span className="font-semibold text-blue-600">{formatMoney(p.sellingPrice)}</span>
              </button>
            ))}
          </div>
        </div>
      </Modal>

      {/* Sale Detail Modal */}
      <Modal isOpen={!!showDetail} onClose={() => { setShowDetail(null); setShowPaymentForm(false); }} title={`Order ${showDetail?.orderNumber}`} size="lg">
        {showDetail && (
          <div className="space-y-4 text-sm">
            {/* Items table */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Items</h4>
              <div className="space-y-1">
                {(showDetail.items || []).map((item, i) => (
                  <div key={i} className="flex justify-between items-center bg-gray-50 rounded-lg px-3 py-2">
                    <div>
                      <span className="font-medium text-gray-800">{item.product?.name || 'Product'}</span>
                      <span className="text-gray-400 ml-2">x{item.qty} @ {formatMoney(item.unitPrice)}</span>
                    </div>
                    <span className="font-medium">{formatMoney(item.totalPrice)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-between items-start">
              <div className="grid grid-cols-2 gap-3 flex-1">
                <div><span className="text-gray-500">Total:</span> <span className="font-medium">{formatMoney(showDetail.totalPrice)}</span></div>
                <div><span className="text-gray-500">Profit:</span> <span className={`font-medium ${calcProfit(showDetail) >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatMoney(calcProfit(showDetail))}</span></div>
                <div><span className="text-gray-500">Shipping Cost:</span> {formatMoney(showDetail.shippingCost)}</div>
                <div><span className="text-gray-500">Shipping Charge:</span> {formatMoney(showDetail.shippingCharge)}</div>
                <div><span className="text-gray-500">Customer:</span> {showDetail.customerName || '-'}</div>
                <div><span className="text-gray-500">Phone:</span> {showDetail.customerPhone || '-'}</div>
                <div><span className="text-gray-500">City:</span> {showDetail.customerCity || '-'}</div>
                <div><span className="text-gray-500">Source:</span> {showDetail.source || '-'}</div>
                <div><span className="text-gray-500">Status:</span> <StatusBadge status={showDetail.status} /></div>
                <div><span className="text-gray-500">Payment:</span> <PaymentBadge status={showDetail.paymentStatus} /> <span className="text-gray-400 ml-1">({showDetail.paymentType})</span></div>
              </div>
              <ReceiptButton saleId={showDetail.id} size={20} className="ml-3 p-2 bg-blue-50 rounded-lg hover:bg-blue-100" />
            </div>

            {showDetail.paymentType === 'Credit' && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-semibold text-amber-800">Credit Details</h4>
                  {showDetail.paymentStatus !== 'Paid' && (
                    <button onClick={() => setShowPaymentForm(!showPaymentForm)}
                      className="text-xs bg-green-600 text-white px-3 py-1 rounded-lg hover:bg-green-700 flex items-center gap-1">
                      <FiDollarSign size={12} /> Record Payment
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-amber-700">Amount Paid:</span> <span className="font-medium">{formatMoney(showDetail.amountPaid)}</span></div>
                  <div><span className="text-amber-700">Balance:</span> <span className="font-bold text-red-600">{formatMoney(parseFloat(showDetail.totalPrice) - parseFloat(showDetail.amountPaid))}</span></div>
                  {showDetail.creditDueDate && (
                    <div><span className="text-amber-700">Due Date:</span> <span className={`font-medium ${new Date(showDetail.creditDueDate) < new Date() && showDetail.paymentStatus !== 'Paid' ? 'text-red-600' : ''}`}>{formatDate(showDetail.creditDueDate)}</span></div>
                  )}
                  {showDetail.creditNotes && <div className="col-span-2"><span className="text-amber-700">Notes:</span> {showDetail.creditNotes}</div>}
                </div>
                {showPaymentForm && (
                  <form onSubmit={handleRecordPayment} className="mt-3 pt-3 border-t border-amber-200 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <input type="number" step="0.01" min="0.01" required placeholder="Amount *"
                        value={creditPaymentForm.amount} onChange={e => setCreditPaymentForm({...creditPaymentForm, amount: e.target.value})}
                        className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                      <select value={creditPaymentForm.paymentMethod} onChange={e => setCreditPaymentForm({...creditPaymentForm, paymentMethod: e.target.value})}
                        className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none">
                        <option value="">Method</option>
                        {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <input type="text" placeholder="Reference (optional)"
                      value={creditPaymentForm.reference} onChange={e => setCreditPaymentForm({...creditPaymentForm, reference: e.target.value})}
                      className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => setShowPaymentForm(false)} className="px-3 py-1 text-xs border rounded-lg hover:bg-gray-50">Cancel</button>
                      <button type="submit" className="px-3 py-1 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700">Save Payment</button>
                    </div>
                  </form>
                )}
                {showDetail.creditPayments?.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-amber-200">
                    <h5 className="text-xs font-semibold text-amber-700 mb-2">Payment History</h5>
                    <div className="space-y-1">
                      {showDetail.creditPayments.map(p => (
                        <div key={p.id} className="flex justify-between text-xs bg-white rounded px-2 py-1.5">
                          <span>{formatDateTime(p.createdAt)}</span>
                          <span className="text-gray-500">{p.paymentMethod || ''}</span>
                          <span className="font-medium text-green-700">+{formatMoney(p.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {showDetail.notes && <div><span className="text-gray-500">Notes:</span> {showDetail.notes}</div>}
          </div>
        )}
      </Modal>

      <ConfirmDialog isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} onConfirm={handleDelete}
        title="Delete Sale" message={`Delete order ${deleteConfirm?.orderNumber}? Stock will be restored if applicable.`} />
    </div>
  );
}
