import { useState, useEffect } from 'react';
import { getInventory, getCategories, getSettings } from '../services/api';
import { formatMoney } from '../utils/format';
import { FiSearch, FiPackage, FiTrendingUp, FiDollarSign, FiShoppingCart } from 'react-icons/fi';
import toast from 'react-hot-toast';
import Pagination from '../components/Pagination';
import SortableHeader from '../components/SortableHeader';
import useTableControls from '../hooks/useTableControls';

export default function Inventory() {
  const [data, setData] = useState({ items: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({ category: '', search: '' });
  const [search, setSearch] = useState('');
  const [currencySymbol, setCurrencySymbol] = useState('K');

  useEffect(() => {
    getSettings().then(res => {
      if (res.data?.currencySymbol) setCurrencySymbol(res.data.currencySymbol);
    }).catch(() => {});
    getCategories().then(res => setCategories(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    fetchInventory();
  }, [filters]);

  const fetchInventory = async () => {
    try {
      setLoading(true);
      const params = {};
      if (filters.category) params.category = filters.category;
      if (filters.search) params.search = filters.search;
      const res = await getInventory(params);
      setData(res.data);
    } catch {
      toast.error('Failed to load inventory');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setFilters(f => ({ ...f, search }));
  };

  const fmt = (v) => formatMoney(v, currencySymbol);
  const s = data.summary;
  const table = useTableControls(data.items || [], { pageSize: 25 });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">Inventory Tracker</h1>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          icon={FiPackage}
          label="Items in Stock"
          value={s.totalItemsInStock?.toLocaleString() || '0'}
          sub={`${s.totalProducts || 0} products`}
          color="blue"
        />
        <SummaryCard
          icon={FiDollarSign}
          label="Stock Cost Value"
          value={fmt(s.totalStockCostValue)}
          sub="What you paid"
          color="red"
        />
        <SummaryCard
          icon={FiTrendingUp}
          label="Stock Sell Value"
          value={fmt(s.totalStockSellValue)}
          sub={`Profit potential: ${fmt(s.totalPotentialProfit)}`}
          color="green"
        />
        <SummaryCard
          icon={FiShoppingCart}
          label="Total Sold"
          value={s.totalItemsSold?.toLocaleString() || '0'}
          sub={`COGS: ${fmt(s.totalSoldCostValue)} | Revenue: ${fmt(s.totalSoldSellValue)}`}
          color="purple"
        />
      </div>

      {/* Stocked vs Sold Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500 mb-1">Total Ever Stocked</p>
          <p className="text-2xl font-bold text-gray-800">{s.totalItemsStocked?.toLocaleString() || '0'} units</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500 mb-1">Total Sold</p>
          <p className="text-2xl font-bold text-gray-800">{s.totalItemsSold?.toLocaleString() || '0'} units</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500 mb-1">Sell-Through Rate</p>
          <p className="text-2xl font-bold text-gray-800">
            {s.totalItemsStocked ? ((s.totalItemsSold / s.totalItemsStocked) * 100).toFixed(1) : '0'}%
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name or SKU..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
            Search
          </button>
        </form>
        <select
          value={filters.category}
          onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Inventory Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3"><SortableHeader label="Product" sortKey="name" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-left px-4 py-3 hidden sm:table-cell"><SortableHeader label="SKU" sortKey="sku" sort={table.sort} onToggle={table.toggleSort} /></th>
                <th className="text-right px-4 py-3"><SortableHeader label="Stocked" sortKey="totalStocked" accessor={(r) => r.totalStocked} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-right px-4 py-3"><SortableHeader label="Sold" sortKey="totalSold" accessor={(r) => r.totalSold} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-right px-4 py-3"><SortableHeader label="In Stock" sortKey="currentStock" accessor={(r) => r.currentStock} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-right px-4 py-3 hidden md:table-cell"><SortableHeader label="Cost Price" sortKey="costPrice" accessor={(r) => parseFloat(r.costPrice)} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-right px-4 py-3 hidden md:table-cell"><SortableHeader label="Sell Price" sortKey="sellingPrice" accessor={(r) => parseFloat(r.sellingPrice)} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-right px-4 py-3"><SortableHeader label="Cost Value" sortKey="stockCostValue" accessor={(r) => parseFloat(r.stockCostValue)} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
                <th className="text-right px-4 py-3"><SortableHeader label="Sell Value" sortKey="stockSellValue" accessor={(r) => parseFloat(r.stockSellValue)} sort={table.sort} onToggle={table.toggleSort} align="right" /></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={9} className="text-center py-8 text-gray-400">Loading...</td></tr>
              ) : table.pageRows.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-8 text-gray-400">No inventory found</td></tr>
              ) : (
                table.pageRows.map(item => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-800">{item.name}</div>
                      {item.category && <div className="text-xs text-gray-400">{item.category}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{item.sku}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{item.totalStocked}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{item.totalSold}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-medium ${item.currentStock <= 0 ? 'text-red-600' : item.currentStock <= 5 ? 'text-yellow-600' : 'text-gray-800'}`}>
                        {item.currentStock}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500 hidden md:table-cell">{fmt(item.costPrice)}</td>
                    <td className="px-4 py-3 text-right text-gray-500 hidden md:table-cell">{fmt(item.sellingPrice)}</td>
                    <td className="px-4 py-3 text-right text-red-600 font-medium">{fmt(item.stockCostValue)}</td>
                    <td className="px-4 py-3 text-right text-green-600 font-medium">{fmt(item.stockSellValue)}</td>
                  </tr>
                ))
              )}
            </tbody>
            {!loading && table.pageRows.length > 0 && (
              <tfoot>
                <tr className="bg-gray-50 border-t-2 border-gray-300 font-semibold">
                  <td className="px-4 py-3 text-gray-800">Totals</td>
                  <td className="hidden sm:table-cell" />
                  <td className="px-4 py-3 text-right text-gray-800">{s.totalItemsStocked}</td>
                  <td className="px-4 py-3 text-right text-gray-800">{s.totalItemsSold}</td>
                  <td className="px-4 py-3 text-right text-gray-800">{s.totalItemsInStock}</td>
                  <td className="hidden md:table-cell" />
                  <td className="hidden md:table-cell" />
                  <td className="px-4 py-3 text-right text-red-600">{fmt(s.totalStockCostValue)}</td>
                  <td className="px-4 py-3 text-right text-green-600">{fmt(s.totalStockSellValue)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {!loading && data.items.length > 0 && (
          <div className="px-4 py-2 border-t border-gray-100">
            <Pagination
              page={table.page} totalPages={table.totalPages} total={table.total}
              pageSize={table.pageSize} onPageChange={table.setPage} onPageSizeChange={table.setPageSize}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, sub, color }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    red: 'bg-red-50 text-red-600',
    purple: 'bg-purple-50 text-purple-600',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-3 mb-2">
        <div className={`p-2 rounded-lg ${colors[color]}`}>
          <Icon size={18} />
        </div>
        <span className="text-sm text-gray-500">{label}</span>
      </div>
      <p className="text-xl font-bold text-gray-800">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}
