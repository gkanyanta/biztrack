import { useState, useEffect } from 'react';
import { getProducts, bulkRestock, getStockLocations, transferStockToConsultant, getSales, updateSaleStatus } from '../services/api';
import { FiPackage, FiTruck, FiPlus, FiSearch, FiCheckCircle, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatDate } from '../utils/format';

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
  // Unfiltered catalog for the Stock In / Dispatch pickers, kept separate from the "Warehouse
  // Stock" table's search below so typing in one doesn't limit what the other can pick from.
  const [allProducts, setAllProducts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(true);

  const [stockInForm, setStockInForm] = useState({ productId: '', quantity: '' });
  const [dispatchForm, setDispatchForm] = useState({ productId: '', qty: '', notes: '' });

  const loadProducts = () => {
    setLoadingProducts(true);
    getProducts({ search: search || undefined })
      .then(res => setProducts(res.data))
      .finally(() => setLoadingProducts(false));
  };

  const loadAllProducts = () => { getProducts().then(res => setAllProducts(res.data)).catch(() => {}); };

  useEffect(() => { loadProducts(); }, [search]);
  useEffect(() => { loadAllProducts(); }, []);

  useEffect(() => {
    getStockLocations().then(res => {
      setLocations(res.data);
      if (res.data.length === 1) setLocationId(res.data[0].id);
    }).catch(() => {});
  }, []);

  const loadOrders = () => {
    setLoadingOrders(true);
    getSales({ status: 'Confirmed', page: 1, pageSize: 50 })
      // Only orders with at least one warehouse-sourced item need dispatching from here;
      // orders fulfilled entirely from a consultant's own stock are already with the seller.
      .then(res => setOrders(res.data.data.filter(o => (o.items || []).some(i => !i.stockSourceConsultantId))))
      .finally(() => setLoadingOrders(false));
  };

  useEffect(() => { loadOrders(); }, []);

  const handleStockIn = async (e) => {
    e.preventDefault();
    if (!stockInForm.productId || !stockInForm.quantity || parseInt(stockInForm.quantity) <= 0) {
      return toast.error('Select a product and enter a quantity');
    }
    try {
      await bulkRestock([{ productId: stockInForm.productId, quantity: parseInt(stockInForm.quantity) }]);
      toast.success('Stock added to warehouse');
      setStockInForm({ productId: '', quantity: '' });
      loadProducts();
      loadAllProducts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error adding stock');
    }
  };

  const handleDispatchToCar = async (e) => {
    e.preventDefault();
    if (!locationId) return toast.error('No car stock location set up — ask an admin to set one up in Settings');
    if (!dispatchForm.productId || !dispatchForm.qty || parseInt(dispatchForm.qty) <= 0) {
      return toast.error('Select a product and enter a quantity');
    }
    try {
      await transferStockToConsultant(locationId, { productId: dispatchForm.productId, qty: parseInt(dispatchForm.qty), notes: dispatchForm.notes || undefined });
      toast.success('Dispatched to car stock');
      setDispatchForm({ productId: '', qty: '', notes: '' });
      loadProducts();
      loadAllProducts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error dispatching stock');
    }
  };

  const handleMarkDispatched = async (order) => {
    try {
      await updateSaleStatus(order.id, 'Shipped');
      toast.success(`Order ${order.orderNumber} marked dispatched`);
      loadOrders();
      loadProducts();
      loadAllProducts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error updating order');
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
            <button type="submit" className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Add to Warehouse Stock</button>
          </form>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><FiTruck /> Dispatch to Car</h2>
          {locations.length === 0 ? (
            <p className="text-sm text-gray-500">No car stock location set up yet — ask an admin to set one up in Settings.</p>
          ) : (
            <form onSubmit={handleDispatchToCar} className="space-y-3">
              {locations.length > 1 && (
                <select value={locationId} onChange={e => setLocationId(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              )}
              <ProductSearchPicker products={allProducts} value={dispatchForm.productId} onChange={id => setDispatchForm(f => ({ ...f, productId: id }))} />
              <input type="number" min="1" placeholder="Quantity" value={dispatchForm.qty}
                onChange={e => setDispatchForm(f => ({ ...f, qty: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <input type="text" placeholder="Notes (optional)" value={dispatchForm.notes}
                onChange={e => setDispatchForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <button type="submit" className="w-full py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700">Dispatch</button>
            </form>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Orders Ready to Dispatch</h2>
        {loadingOrders ? <LoadingSpinner /> : orders.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">No confirmed orders waiting to be dispatched.</p>
        ) : (
          <div className="space-y-2">
            {orders.map(o => (
              <div key={o.id} className="flex items-center justify-between border border-gray-100 rounded-lg p-3">
                <div>
                  <div className="font-medium text-gray-800">{o.orderNumber}</div>
                  <div className="text-xs text-gray-500">{o.customerName || 'Walk-in'} · {formatDate(o.date)}</div>
                  <div className="text-xs text-gray-400">{(o.items || []).map(i => `${i.product?.name || 'Item'} x${i.qty}`).join(', ')}</div>
                </div>
                <button onClick={() => handleMarkDispatched(o)} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700">
                  <FiCheckCircle size={14} /> Mark Dispatched
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
