import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getConsultantDashboard } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import { StatusBadge, PaymentBadge } from '../components/StatusBadge';
import { FiShoppingCart, FiDollarSign, FiTrendingUp, FiPlus, FiCreditCard } from 'react-icons/fi';

export default function ConsultantDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getConsultantDashboard()
      .then(res => setData(res.data))
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (!data) return <p className="text-red-500">Failed to load{error ? `: ${error}` : ''}</p>;

  const { consultant, today, thisMonth, allTime, recentSales, recentPayments } = data;

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <div className="bg-gradient-to-r from-indigo-600 to-blue-700 rounded-xl p-5 text-white shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-bold">Welcome, {consultant.name}</h2>
            <p className="text-blue-100 text-sm">
              Commission: {formatMoney(consultant.commissionRate)}/item (first {consultant.tierThreshold}) then {formatMoney(consultant.tierRate)}/item
            </p>
          </div>
          <Link to="/sales" className="flex items-center gap-1.5 px-4 py-2 bg-white text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50">
            <FiPlus size={16} /> Record Sale
          </Link>
        </div>
      </div>

      {/* Today */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Today</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatCard icon={FiShoppingCart} label="Orders Today" value={today.ordersCount} color="bg-blue-500" />
          <StatCard icon={FiTrendingUp} label="Products Sold" value={today.productsSold} color="bg-purple-500" />
          <StatCard icon={FiDollarSign} label="Revenue Today" value={formatMoney(today.revenue)} color="bg-emerald-500" />
        </div>
      </div>

      {/* This month */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">This Month</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={FiShoppingCart} label="Orders" value={thisMonth.ordersCount} color="bg-blue-500" />
          <StatCard icon={FiTrendingUp} label="Products Sold" value={thisMonth.productsSold} color="bg-purple-500" />
          <StatCard icon={FiDollarSign} label="Revenue" value={formatMoney(thisMonth.revenue)} color="bg-indigo-500" />
          <StatCard icon={FiCreditCard} label="Commission Earned" value={formatMoney(thisMonth.commissionEarned)} color="bg-emerald-600" accent />
        </div>
      </div>

      {/* Balance */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Amount Due to You</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-emerald-50 rounded-lg p-4">
            <p className="text-xs text-gray-500">Total Earned (all time)</p>
            <p className="text-xl font-bold text-emerald-700">{formatMoney(allTime.commissionEarned)}</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-500">Paid to You</p>
            <p className="text-xl font-bold text-gray-700">{formatMoney(allTime.commissionPaid)}</p>
          </div>
          <div className="bg-amber-50 rounded-lg p-4 ring-2 ring-amber-200">
            <p className="text-xs text-amber-700 font-medium">Balance Owed</p>
            <p className="text-2xl font-bold text-amber-700">{formatMoney(allTime.balance)}</p>
          </div>
          <div className="bg-blue-50 rounded-lg p-4">
            <p className="text-xs text-gray-500">Allowance Paid</p>
            <p className="text-xl font-bold text-blue-700">{formatMoney(allTime.allowancePaid)}</p>
          </div>
        </div>
      </div>

      {/* Recent sales */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Recent Sales</h3>
          <Link to="/sales" className="text-sm text-blue-600 hover:underline">View all →</Link>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Order</th>
                <th className="text-left p-3 font-medium text-gray-600 hidden md:table-cell">Customer</th>
                <th className="text-right p-3 font-medium text-gray-600">Items</th>
                <th className="text-right p-3 font-medium text-gray-600">Total</th>
                <th className="text-center p-3 font-medium text-gray-600">Status</th>
                <th className="text-center p-3 font-medium text-gray-600 hidden sm:table-cell">Payment</th>
              </tr>
            </thead>
            <tbody>
              {recentSales.map(s => (
                <tr key={s.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="p-3">
                    <div className="font-medium text-gray-800">{s.orderNumber}</div>
                    <div className="text-xs text-gray-500">{formatDate(s.date)}</div>
                  </td>
                  <td className="p-3 text-gray-700 hidden md:table-cell">{s.customerName || '-'}</td>
                  <td className="p-3 text-right">{s.productsCount}</td>
                  <td className="p-3 text-right font-medium">{formatMoney(s.totalPrice)}</td>
                  <td className="p-3 text-center"><StatusBadge status={s.status} /></td>
                  <td className="p-3 text-center hidden sm:table-cell"><PaymentBadge status={s.paymentStatus} /></td>
                </tr>
              ))}
              {recentSales.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-gray-500">No sales yet — click "Record Sale" to start</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent payments */}
      {recentPayments.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Recent Payments to You</h3>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
            {recentPayments.map(p => (
              <div key={p.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <div className="font-medium text-gray-800 capitalize">{p.type}</div>
                  <div className="text-xs text-gray-500">{formatDate(p.createdAt)} {p.paymentMethod ? `• ${p.paymentMethod}` : ''}</div>
                </div>
                <span className="font-bold text-emerald-700">+{formatMoney(p.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color, accent }) {
  return (
    <div className={`bg-white rounded-xl p-4 shadow-sm border ${accent ? 'border-emerald-300 ring-1 ring-emerald-100' : 'border-gray-100'}`}>
      <div className="flex items-center gap-3">
        <div className={`${color} p-2 rounded-lg text-white`}><Icon size={18} /></div>
        <div>
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-lg font-bold text-gray-800">{value}</p>
        </div>
      </div>
    </div>
  );
}
