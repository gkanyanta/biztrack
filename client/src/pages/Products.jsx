import { useState, useEffect } from 'react';
import { getProducts, createProduct, updateProduct, deleteProduct, bulkRestock, getStockLog } from '../services/api';
import { formatMoney, calcMargin } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiAlertTriangle, FiPackage } from 'react-icons/fi';

export default function Products() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [showRestock, setShowRestock] = useState(false);
  const [restockItems, setRestockItems] = useState([]);
  const [showStockLog, setShowStockLog] = useState(null);
  const [stockLogs, setStockLogs] = useState([]);
  const [filterLowStock, setFilterLowStock] = useState(false);

  const [form, setForm] = useState({
    name: '', sku: '', description: '', category: '',
    costPrice: '', sellingPrice: '', stock: '0', reorderLevel: '5',
    supplier: '', imageUrl: ''
  });

  const loadProducts = () => {
    setLoading(true);
    getProducts({ search: search || undefined, lowStock: filterLowStock || undefined })
      .then(res => setProducts(res.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadProducts(); }, [search, filterLowStock]);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', sku: '', description: '', category: '', costPrice: '', sellingPrice: '', stock: '0', reorderLevel: '5', supplier: '', imageUrl: '' });
    setShowForm(true);
  };

  const openEdit = (p) => {
    setEditing(p);
    setForm({
      name: p.name, sku: p.sku, description: p.description || '', category: p.category || '',
      costPrice: p.costPrice, sellingPrice: p.sellingPrice, stock: String(p.stock), reorderLevel: String(p.reorderLevel),
      supplier: p.supplier || '', imageUrl: p.imageUrl || ''
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const data = {
        ...form,
        costPrice: parseFloat(form.costPrice),
        sellingPrice: parseFloat(form.sellingPrice),
        stock: parseInt(form.stock),
        reorderLevel: parseInt(form.reorderLevel),
        sku: form.sku || undefined
      };
      if (editing) {
        await updateProduct(editing.id, data);
        toast.success('Product updated');
      } else {
        await createProduct(data);
        toast.success('Product created');
      }
      setShowForm(false);
      loadProducts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error saving product');
    }
  };

  const handleDelete = async () => {
    try {
      await deleteProduct(deleteConfirm.id);
      toast.success('Product deactivated');
      setDeleteConfirm(null);
      loadProducts();
    } catch {
      toast.error('Error deleting product');
    }
  };

  const openRestock = () => {
    setRestockItems(products.filter(p => p.isActive).map(p => ({ productId: p.id, name: p.name, quantity: 0, currentStock: p.stock })));
    setShowRestock(true);
  };

  const handleRestock = async () => {
    const items = restockItems.filter(i => i.quantity > 0);
    if (items.length === 0) return toast.error('Enter quantities to restock');
    try {
      await bulkRestock(items.map(i => ({ productId: i.productId, quantity: i.quantity })));
      toast.success(`${items.length} product(s) restocked`);
      setShowRestock(false);
      loadProducts();
    } catch {
      toast.error('Error restocking');
    }
  };

  const viewStockLog = async (product) => {
    setShowStockLog(product);
    const res = await getStockLog(product.id);
    setStockLogs(res.data);
  };

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <div className="flex gap-2 items-center w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-none">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input
              type="text"
              placeholder="Search products..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm w-full sm:w-64 outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <label className="flex items-center gap-1.5 text-sm text-gray-600 whitespace-nowrap">
            <input type="checkbox" checked={filterLowStock} onChange={e => setFilterLowStock(e.target.checked)} className="rounded" />
            Low stock
          </label>
        </div>
        <div className="flex gap-2">
          <button onClick={openRestock} className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
            Bulk Restock
          </button>
          <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <FiPlus size={16} /> Add Product
          </button>
        </div>
      </div>

      {/* Products table */}
      {loading ? <LoadingSpinner /> : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Product</th>
                <th className="text-left p-3 font-medium text-gray-600 hidden md:table-cell">SKU</th>
                <th className="text-left p-3 font-medium text-gray-600 hidden lg:table-cell">Category</th>
                <th className="text-right p-3 font-medium text-gray-600">Cost</th>
                <th className="text-right p-3 font-medium text-gray-600">Price</th>
                <th className="text-right p-3 font-medium text-gray-600 hidden sm:table-cell">Margin</th>
                <th className="text-right p-3 font-medium text-gray-600">Stock</th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.map(p => (
                <tr key={p.id} className={`border-b border-gray-50 hover:bg-gray-50 ${!p.isActive ? 'opacity-50' : ''}`}>
                  <td className="p-3">
                    <div className="font-medium text-gray-800">{p.name}</div>
                    <div className="text-xs text-gray-500 md:hidden">{p.sku}</div>
                  </td>
                  <td className="p-3 text-gray-600 hidden md:table-cell">{p.sku}</td>
                  <td className="p-3 text-gray-600 hidden lg:table-cell">{p.category || '-'}</td>
                  <td className="p-3 text-right text-gray-600">{formatMoney(p.costPrice)}</td>
                  <td className="p-3 text-right text-gray-800 font-medium">{formatMoney(p.sellingPrice)}</td>
                  <td className="p-3 text-right text-gray-600 hidden sm:table-cell">{calcMargin(p.costPrice, p.sellingPrice).toFixed(1)}%</td>
                  <td className="p-3 text-right">
                    <button onClick={() => viewStockLog(p)} className="hover:underline">
                      <span className={`font-medium ${p.stock <= p.reorderLevel ? 'text-red-600' : 'text-gray-800'}`}>
                        {p.stock}
                      </span>
                      {p.stock <= p.reorderLevel && <FiAlertTriangle className="inline ml-1 text-orange-500" size={14} />}
                    </button>
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEdit2 size={15} /></button>
                      <button onClick={() => setDeleteConfirm(p)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-gray-500">
                  <FiPackage className="mx-auto mb-2" size={32} />
                  No products found
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Product' : 'Add Product'} size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input type="text" required value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">SKU</label>
              <input type="text" value={form.sku} onChange={e => setForm({...form, sku: e.target.value})}
                placeholder="Auto-generated if blank"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <input type="text" value={form.category} onChange={e => setForm({...form, category: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
              <input type="text" value={form.supplier} onChange={e => setForm({...form, supplier: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cost Price *</label>
              <input type="number" step="0.01" required value={form.costPrice} onChange={e => setForm({...form, costPrice: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Selling Price *</label>
              <input type="number" step="0.01" required value={form.sellingPrice} onChange={e => setForm({...form, sellingPrice: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Stock</label>
              <input type="number" value={form.stock} onChange={e => setForm({...form, stock: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reorder Level</label>
              <input type="number" value={form.reorderLevel} onChange={e => setForm({...form, reorderLevel: e.target.value})}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          {form.costPrice && form.sellingPrice && (
            <p className="text-sm text-gray-500">
              Margin: <span className="font-medium text-gray-700">{calcMargin(form.costPrice, form.sellingPrice).toFixed(1)}%</span>
              {' | '}Profit: <span className="font-medium text-gray-700">{formatMoney(parseFloat(form.sellingPrice) - parseFloat(form.costPrice))}</span>
            </p>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              {editing ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Bulk Restock Modal */}
      <Modal isOpen={showRestock} onClose={() => setShowRestock(false)} title="Bulk Restock" size="lg">
        <div className="space-y-2 max-h-96 overflow-auto">
          {restockItems.map((item, i) => (
            <div key={item.productId} className="flex items-center gap-3 py-2 border-b border-gray-50">
              <span className="flex-1 text-sm text-gray-700">{item.name}</span>
              <span className="text-xs text-gray-500">Stock: {item.currentStock}</span>
              <input
                type="number"
                min="0"
                value={item.quantity}
                onChange={e => {
                  const updated = [...restockItems];
                  updated[i].quantity = parseInt(e.target.value) || 0;
                  setRestockItems(updated);
                }}
                className="w-20 border border-gray-300 rounded px-2 py-1 text-sm text-right outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
        </div>
        <div className="flex gap-3 justify-end pt-4">
          <button onClick={() => setShowRestock(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={handleRestock} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Restock</button>
        </div>
      </Modal>

      {/* Stock Log Modal */}
      <Modal isOpen={!!showStockLog} onClose={() => setShowStockLog(null)} title={`Stock Log — ${showStockLog?.name}`} size="md">
        <div className="space-y-2 max-h-96 overflow-auto">
          {stockLogs.map(log => (
            <div key={log.id} className="flex items-center justify-between py-2 border-b border-gray-50 text-sm">
              <div>
                <span className="text-gray-700">{log.reason}</span>
                <span className="text-xs text-gray-400 ml-2">{new Date(log.createdAt).toLocaleString()}</span>
              </div>
              <span className={`font-medium ${log.change > 0 ? 'text-green-600' : 'text-red-600'}`}>
                {log.change > 0 ? '+' : ''}{log.change}
              </span>
            </div>
          ))}
          {stockLogs.length === 0 && <p className="text-center text-gray-500 py-4">No stock changes recorded</p>}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={handleDelete}
        title="Deactivate Product"
        message={`Are you sure you want to deactivate "${deleteConfirm?.name}"?`}
      />
    </div>
  );
}
