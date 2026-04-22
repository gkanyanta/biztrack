import { useEffect, useState } from 'react';
import { getMyConsultantStock, getMyConsultantTransfers } from '../services/api';
import { formatMoney, formatDateTime } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import { FiPackage, FiArrowRight, FiArrowLeft } from 'react-icons/fi';

export default function ConsultantStock() {
  const [stock, setStock] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getMyConsultantStock(), getMyConsultantTransfers()])
      .then(([sRes, tRes]) => { setStock(sRes.data); setTransfers(tRes.data); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  const totalUnits = stock.reduce((s, i) => s + i.qty, 0);
  const totalValue = stock.reduce((s, i) => s + i.qty * parseFloat(i.product?.sellingPrice || 0), 0);

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">My Stock</h2>
        <p className="text-sm text-gray-500">Products transferred to you from the main inventory</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500">Products in Stock</p>
          <p className="text-xl font-bold text-gray-800">{stock.length}</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500">Total Units</p>
          <p className="text-xl font-bold text-gray-800">{totalUnits}</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500">Retail Value</p>
          <p className="text-xl font-bold text-emerald-700">{formatMoney(totalValue)}</p>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Current Stock</h3>
        {stock.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">
            <FiPackage className="mx-auto mb-2" size={32} />
            <p className="text-sm">No stock transferred to you yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {stock.map(item => (
              <div key={item.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="aspect-square bg-gray-100 flex items-center justify-center overflow-hidden">
                  {item.product?.imageUrl ? (
                    <img
                      src={item.product.imageUrl}
                      alt={item.product.name}
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none'; if (e.currentTarget.nextSibling) e.currentTarget.nextSibling.style.display = 'flex'; }}
                      className="w-full h-full object-cover"
                    />
                  ) : null}
                  <div className={`w-full h-full items-center justify-center ${item.product?.imageUrl ? 'hidden' : 'flex'}`}><FiPackage className="text-gray-300" size={32} /></div>
                </div>
                <div className="p-3">
                  <div className="font-medium text-gray-800 text-sm truncate">{item.product?.name}</div>
                  <div className="text-xs text-gray-500">{item.product?.sku}</div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="text-lg font-bold text-gray-800">{item.qty}</span>
                    <span className="text-xs text-gray-500">units</span>
                  </div>
                  <div className="text-xs text-blue-600 mt-1">{formatMoney(item.product?.sellingPrice)} / unit</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Transfer History</h3>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Date</th>
                <th className="text-left p-3 font-medium text-gray-600">Product</th>
                <th className="text-right p-3 font-medium text-gray-600">Qty</th>
                <th className="text-center p-3 font-medium text-gray-600">Direction</th>
                <th className="text-left p-3 font-medium text-gray-600 hidden sm:table-cell">Notes</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map(t => (
                <tr key={t.id} className="border-b border-gray-50">
                  <td className="p-3 text-gray-600 whitespace-nowrap">{formatDateTime(t.createdAt)}</td>
                  <td className="p-3">
                    <div className="text-gray-800">{t.product?.name}</div>
                    <div className="text-xs text-gray-500">{t.product?.sku}</div>
                  </td>
                  <td className="p-3 text-right font-medium">{t.qty}</td>
                  <td className="p-3 text-center">
                    {t.direction === 'to_consultant' ? (
                      <span className="inline-flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full"><FiArrowRight size={11} /> Received</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full"><FiArrowLeft size={11} /> Returned</span>
                    )}
                  </td>
                  <td className="p-3 text-gray-500 hidden sm:table-cell">{t.notes || '-'}</td>
                </tr>
              ))}
              {transfers.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-gray-500">No transfers yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
