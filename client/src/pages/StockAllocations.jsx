import { useState, useEffect, useMemo } from 'react';
import { getStockAllocations } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import { FiTruck, FiUserCheck, FiHome } from 'react-icons/fi';

const TYPE_META = {
  warehouse: { icon: FiHome, color: 'blue' },
  car: { icon: FiTruck, color: 'emerald' },
  consultant: { icon: FiUserCheck, color: 'purple' },
};

function SummaryCard({ label, value, sub, color }) {
  const colors = { gray: 'bg-gray-50 text-gray-700', blue: 'bg-blue-50 text-blue-600', emerald: 'bg-emerald-50 text-emerald-600', purple: 'bg-purple-50 text-purple-600' };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className={`inline-block text-xs font-medium px-2 py-0.5 rounded mb-2 ${colors[color] || colors.gray}`}>{label}</div>
      <p className="text-2xl font-bold text-gray-800">{value.toLocaleString()}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

export default function StockAllocations() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStockAllocations().then(res => setData(res.data)).finally(() => setLoading(false));
  }, []);

  const pivot = useMemo(() => {
    if (!data) return [];
    const productMap = new Map();
    data.locations.forEach(loc => {
      loc.items.forEach(item => {
        if (!productMap.has(item.productId)) productMap.set(item.productId, { productId: item.productId, name: item.name, sku: item.sku, qtyByLocation: {} });
        productMap.get(item.productId).qtyByLocation[loc.id] = item.qty;
      });
    });
    return Array.from(productMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  if (loading) return <LoadingSpinner />;
  if (!data) return null;

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <h1 className="text-2xl font-bold text-gray-800">Stock Allocations</h1>
      <p className="text-sm text-gray-500 -mt-4">Where every unit of stock currently sits — warehouse, your car, and consultant mini-stock.</p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard label="Total Units" value={data.grandTotal} color="gray" />
        {data.locations.map(loc => (
          <SummaryCard key={loc.id} label={loc.name} value={loc.totalUnits} color={TYPE_META[loc.type]?.color} sub={loc.isActive === false ? 'Inactive' : undefined} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {data.locations.map(loc => {
          const meta = TYPE_META[loc.type] || TYPE_META.warehouse;
          const Icon = meta.icon;
          return (
            <div key={loc.id} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><Icon size={16} /> {loc.name}</h2>
                <span className="text-xs text-gray-400">{loc.totalUnits} units</span>
              </div>
              {loc.items.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No stock here</p>
              ) : (
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {loc.items.map(item => (
                        <tr key={item.productId} className="border-b border-gray-50">
                          <td className="py-1.5 text-gray-700">{item.name} <span className="text-gray-400 text-xs">{item.sku}</span></td>
                          <td className="py-1.5 text-right font-medium text-gray-800">{item.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 overflow-x-auto">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">By Product</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left p-2">Product</th>
              {data.locations.map(loc => <th key={loc.id} className="text-right p-2 whitespace-nowrap">{loc.name}</th>)}
              <th className="text-right p-2 font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {pivot.map(row => {
              const total = Object.values(row.qtyByLocation).reduce((s, q) => s + q, 0);
              return (
                <tr key={row.productId} className="border-b border-gray-50">
                  <td className="p-2 text-gray-800">{row.name} <span className="text-xs text-gray-400">{row.sku}</span></td>
                  {data.locations.map(loc => <td key={loc.id} className="p-2 text-right text-gray-600">{row.qtyByLocation[loc.id] ?? '–'}</td>)}
                  <td className="p-2 text-right font-semibold text-gray-800">{total}</td>
                </tr>
              );
            })}
            {pivot.length === 0 && (
              <tr><td colSpan={data.locations.length + 2} className="p-6 text-center text-gray-400">No stock allocated anywhere</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
