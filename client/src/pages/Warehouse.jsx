import { useState, useEffect } from 'react';
import { getProducts, bulkRestock, getSales, updateSaleStatus } from '../services/api';
import { FiPackage, FiTruck, FiPlus, FiSearch, FiCheckCircle, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDate } from '../utils/format';
import CounterSale from '../components/CounterSale';
import OrderTracker from '../components/OrderTracker';

// Searchable product picker — filters by name/SKU as you type instead of scrolling a long <select>.
function ProductSearchPicker({ products, value, onChange, placeholder = 'Search product by name or SKU...' }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = products.find(p => p.id === value);

  const filtered = query
    ? products.filter(p => p.name.toLowerCase().includes(query.toLowerCase()) || p.sku.toLowerCase().includes(query.toLowerCase())).slice(0, 50)
    : products.slice(0, 50);

  const select = (p) => {
    onChange(p.id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="relative">
      {selected && !open ? (
        <div className="flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50">
          <span className="flex-1 truncate">{selected.name} <span className="text-gray-400">({selected.sku})</span> — {selected.stock} in stock</span>
          <button type="button" onClick={() => { onChange(''); setQuery(''); setOpen(true); }} className="text-gray-400 hover:text-red-600 flex-shrink-0">
            <FiX size={15} />
          </button>
        </div>
      ) : (
        <div className="relative">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input
            type="text"
            value={query}
            placeholder={placeholder}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
          {filtered.length === 0 ? (
            <p className="p-3 text-sm text-gray-400 text-center">No products match</p>
          ) : (
            filtered.map(p => (
              <button key={p.id} type="button" onMouseDown={() => select(p)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-blue-50">
                <span className="truncate">{p.name} <span className="text-gray-400 text-xs">{p.sku}</span></span>
                <span className={`flex-shrink-0 ml-2 text-xs font-medium ${p.stock <= 0 ? 'text-red-500' : 'text-gray-500'}`}>{p.stock} in stock</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function Warehouse() {
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [loadingProducts, setLoadingProducts] = useState(true);
  // Unfiltered catalog for the Stock In picker, kept separate from the "Warehouse Stock"
  // table's search below so typing in one doesn't limit what the other can pick from.
  const [allProducts, setAllProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [orderSearch, setOrderSearch] = useState('');
  const [orderAge, setOrderAge] = useState('14');

  const [stockInForm, setStockInForm] = useState({ productId: '', quantity: '' });
  const [stockInSubmitting, setStockInSubmitting] = useState(false);
  const [dispatchingOrderId, setDispatchingOrderId] = useState(null);

  const loadProducts = () => {
    setLoadingProducts(true);
    getProducts({ search: search || undefined })
      .then(res => setProducts(res.data))
      .finally(() => setLoadingProducts(false));
  };

  const loadAllProducts = () => { getProducts().then(res => setAllProducts(res.data)).catch(() => {}); };

  useEffect(() => { loadProducts(); }, [search]);
  useEffect(() => { loadAllProducts(); }, []);

  const loadOrders = () => {
    setLoadingOrders(true);
    getSales({ status: 'Confirmed', page: 1, pageSize: 300 })
      // Only orders with at least one warehouse-sourced item need dispatching from here;
      // orders fulfilled entirely from a consultant's own stock are already with the seller.
      .then(res => setOrders(res.data.data.filter(o => (o.items || []).some(i => !i.stockSourceConsultantId))))
      .finally(() => setLoadingOrders(false));
  };

  useEffect(() => { loadOrders(); }, []);

  // Orders have been accumulating in Confirmed since July, so the queue defaults to recent work
  // and the search covers the three things she actually looks for: the order, who it is for, and
  // what is in it.
  const orderCutoff = orderAge === 'all' ? null : new Date(Date.now() - parseInt(orderAge, 10) * 86400000);
  const orderQuery = orderSearch.trim().toLowerCase();
  const filteredOrders = orders.filter(o => {
    if (orderCutoff && new Date(o.date) < orderCutoff) return false;
    if (!orderQuery) return true;
    const haystack = [
      o.orderNumber, o.customerName, o.customerPhone, o.customerCity, o.deliveryAddress,
      ...(o.items || []).map(i => i.product?.name),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(orderQuery);
  });

  const handleStockIn = async (e) => {
    e.preventDefault();
    if (stockInSubmitting) return;
    if (!stockInForm.productId || !stockInForm.quantity || parseInt(stockInForm.quantity) <= 0) {
      return toast.error('Select a product and enter a quantity');
    }
    setStockInSubmitting(true);
    try {
      await bulkRestock([{ productId: stockInForm.productId, quantity: parseInt(stockInForm.quantity) }]);
      toast.success('Stock added to warehouse');
      setStockInForm({ productId: '', quantity: '' });
      loadProducts();
      loadAllProducts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error adding stock');
    } finally {
      setStockInSubmitting(false);
    }
  };

  // Marking an order packed moves it to Shipped, which is what makes it show as READY on the
  // Deliveries assign tab. No stock moves — that happened when the order was confirmed.
  const handleMarkPacked = async (order) => {
    if (dispatchingOrderId) return;
    setDispatchingOrderId(order.id);
    try {
      await updateSaleStatus(order.id, 'Shipped');
      toast.success(`${order.orderNumber} is packed and ready for the rider`);
      loadOrders();
      loadProducts();
      loadAllProducts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error updating order');
    } finally {
      setDispatchingOrderId(null);
    }
  };

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <h1 className="text-2xl font-bold text-gray-800">Warehouse</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><FiPlus /> Stock In (new purchases arriving)</h2>
          <form onSubmit={handleStockIn} className="space-y-3">
            <ProductSearchPicker products={allProducts} value={stockInForm.productId} onChange={id => setStockInForm(f => ({ ...f, productId: id }))} />
            <input type="number" min="1" placeholder="Quantity received" value={stockInForm.quantity}
              onChange={e => setStockInForm(f => ({ ...f, quantity: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" disabled={stockInSubmitting} className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">{stockInSubmitting ? 'Adding...' : 'Add to Warehouse Stock'}</button>
          </form>
        </div>

      </div>

      <CounterSale onRecorded={() => { loadProducts(); loadAllProducts(); }} />

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Orders to prepare</h2>
          <span className="text-xs text-gray-400">{filteredOrders.length} of {orders.length}</span>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Pick and pack each one, then mark it packed — it then shows as ready on the Deliveries
          screen for whoever puts it on the bike.
        </p>
        <div className="flex gap-2 mb-3 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input value={orderSearch} onChange={e => setOrderSearch(e.target.value)}
              placeholder="Order number, customer or product"
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {/* Orders have sat in here since July, so the default is the recent ones. */}
          <select value={orderAge} onChange={e => setOrderAge(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none">
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">Everything</option>
          </select>
        </div>
        {loadingOrders ? <LoadingSpinner /> : filteredOrders.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">
            {orders.length === 0 ? 'Nothing waiting to be prepared.' : 'Nothing matches — widen the date range or clear the search.'}
          </p>
        ) : (
          <div className="space-y-2">
            {filteredOrders.map(o => (
              <div key={o.id} className="flex items-center justify-between border border-gray-100 rounded-lg p-3">
                <div className="min-w-0">
                  <div className="font-medium text-gray-800">
                    {o.orderNumber}
                    {o.consultant?.name && <span className="text-xs text-gray-400 font-normal ml-2">via {o.consultant.name}</span>}
                  </div>
                  <div className="text-xs text-gray-500">{o.customerName || 'Walk-in'}{o.customerPhone ? ` · ${o.customerPhone}` : ''} · {formatDate(o.date)}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {o.deliveryAddress || <span className="text-amber-600">no address given</span>}
                    {o.customerCity ? `${o.deliveryAddress ? ', ' : ''}${o.customerCity}` : ''}
                  </div>
                  <div className="text-xs text-gray-700 mt-1">
                    {(o.items || []).map(i => `${i.qty > 1 ? i.qty + '× ' : ''}${i.product?.name || 'Item'}`).join(', ')}
                  </div>
                </div>
                <button onClick={() => handleMarkPacked(o)} disabled={dispatchingOrderId === o.id} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
                  <FiCheckCircle size={14} /> {dispatchingOrderId === o.id ? 'Saving...' : 'Mark packed'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <OrderTracker />

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Warehouse Stock</h2>
          <div className="relative">
            <FiSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        {loadingProducts ? <LoadingSpinner /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left p-2">Product</th>
                  <th className="text-left p-2 hidden sm:table-cell">SKU</th>
                  <th className="text-right p-2">Stock</th>
                </tr>
              </thead>
              <tbody>
                {products.map(p => (
                  <tr key={p.id} className="border-b border-gray-50">
                    <td className="p-2">{p.name}</td>
                    <td className="p-2 text-gray-500 hidden sm:table-cell">{p.sku}</td>
                    <td className={`p-2 text-right font-medium ${p.stock <= p.reorderLevel ? 'text-red-600' : 'text-gray-800'}`}>{p.stock}</td>
                  </tr>
                ))}
                {products.length === 0 && (
                  <tr><td colSpan={3} className="p-6 text-center text-gray-400"><FiPackage className="mx-auto mb-2" size={24} />No products found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
