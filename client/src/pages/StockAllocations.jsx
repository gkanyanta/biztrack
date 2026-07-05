import { useState, useEffect, useMemo } from 'react';
import { getStockAllocations } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import Modal from '../components/Modal';
import { FiTruck, FiUserCheck, FiHome, FiChevronRight } from 'react-icons/fi';

const TYPE_META = {
  warehouse: { icon: FiHome, color: 'blue' },
  car: { icon: FiTruck, color: 'emerald' },
  consultant: { icon: FiUserCheck, color: 'purple' },
};

function SummaryCard({ label, value, sub, color, onClick }) {
  const colors = { gray: 'bg-gray-50 text-gray-700', blue: 'bg-blue-50 text-blue-600', emerald: 'bg-emerald-50 text-emerald-600', purple: 'bg-purple-50 text-purple-600' };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick}
      className={`bg-white rounded-xl border border-gray-200 p-4 text-left w-full transition-all group ${onClick ? 'hover:border-blue-300 hover:shadow-sm cursor-pointer' : ''}`}>
      <div className="flex items-start justify-between">
        <div className={`inline-block text-xs font-medium px-2 py-0.5 rounded mb-2 ${colors[color] || colors.gray}`}>{label}</div>
        {onClick && <FiChevronRight size={14} className="text-gray-300 group-hover:text-blue-500 mt-0.5" />}
      </div>
      <p className="text-2xl font-bold text-gray-800">{value.toLocaleString()}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </Tag>
  );
}

export default function StockAllocations() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    getStockAllocations().then(res => setData(res.data)).finally(() => setLoading(false));
  }, []);

  const selectedLocation = data?.locations.find(l => l.id === selectedId) || null;
  const SelectedIcon = selectedLocation ? (TYPE_META[selectedLocation.type] || TYPE_META.warehouse).icon : null;

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
          <SummaryCard key={loc.id} label={loc.name} value={loc.totalUnits} color={TYPE_META[loc.type]?.color}
            sub={loc.isActive === false ? 'Inactive' : undefined} onClick={() => setSelectedId(loc.id)} />
        ))}
      </div>

      <Modal isOpen={!!selectedLocation} onClose={() => setSelectedId(null)}
        title={selectedLocation && <span className="flex items-center gap-2"><SelectedIcon size={16} /> {selectedLocation.name}</span>}
        size="md">
        {selectedLocation && (
          selectedLocation.items.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No stock here</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left pb-2 font-medium text-gray-500">Product</th>
                    <th className="text-right pb-2 font-medium text-gray-500">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedLocation.items.map(item => (
                    <tr key={item.productId} className="border-b border-gray-50">
                      <td className="py-1.5 text-gray-700">{item.name} <span className="text-gray-400 text-xs">{item.sku}</span></td>
                      <td className="py-1.5 text-right font-medium text-gray-800">{item.qty}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 font-semibold">
                    <td className="pt-2 text-gray-700">Total</td>
                    <td className="pt-2 text-right text-gray-800">{selectedLocation.totalUnits}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        )}
      </Modal>

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
