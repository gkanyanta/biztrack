import { useState, useEffect } from 'react';
import { getDashboard } from '../services/api';
import { formatMoney } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import { FiDollarSign, FiShoppingCart, FiTrendingUp, FiAlertTriangle } from 'react-icons/fi';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend
} from 'recharts';

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316', '#6366F1'];

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getDashboard().then(res => setData(res.data)).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (!data) return <p className="text-gray-500">Failed to load dashboard</p>;

  const cards = [
    { label: 'Total Revenue', value: formatMoney(data.totalRevenue), icon: FiDollarSign, color: 'bg-blue-500' },
    { label: 'Net Profit', value: formatMoney(data.netProfit), icon: FiTrendingUp, color: data.netProfit >= 0 ? 'bg-green-500' : 'bg-red-500' },
    { label: 'Total Orders', value: data.totalOrders, icon: FiShoppingCart, color: 'bg-purple-500' },
    { label: 'Avg Order Value', value: formatMoney(data.avgOrderValue), icon: FiDollarSign, color: 'bg-indigo-500' },
    { label: 'Total Expenses', value: formatMoney(data.totalExpenses), icon: FiDollarSign, color: 'bg-orange-500' },
    { label: 'Ad Spend', value: formatMoney(data.adSpend), icon: FiDollarSign, color: 'bg-pink-500' },
    { label: 'ROAS', value: `${data.roas.toFixed(2)}x`, icon: FiTrendingUp, color: 'bg-cyan-500' },
    { label: 'Profit Margin', value: `${data.profitMargin.toFixed(1)}%`, icon: FiTrendingUp, color: data.profitMargin >= 0 ? 'bg-emerald-500' : 'bg-red-500' },
  ];

  const expensePieData = Object.entries(data.expenseByCategory).map(([name, value]) => ({ name, value }));

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(card => (
          <div key={card.label} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-3">
              <div className={`${card.color} p-2 rounded-lg text-white`}>
                <card.icon size={18} />
              </div>
              <div>
                <p className="text-xs text-gray-500">{card.label}</p>
                <p className="text-lg font-bold text-gray-800">{card.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly Revenue vs Profit */}
        {data.monthlySummary.length > 0 && (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Monthly Revenue vs Profit</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={data.monthlySummary}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => formatMoney(v)} />
                <Legend />
                <Bar dataKey="revenue" fill="#3B82F6" name="Revenue" />
                <Bar dataKey="profit" fill="#10B981" name="Profit" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Expense Breakdown */}
        {expensePieData.length > 0 && (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Expense Breakdown</h3>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie data={expensePieData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {expensePieData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => formatMoney(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Sales Trend */}
        {data.monthlySummary.length > 0 && (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Sales Trend</h3>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={data.monthlySummary}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => formatMoney(v)} />
                <Line type="monotone" dataKey="revenue" stroke="#3B82F6" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Top Products */}
        {data.topProducts.length > 0 && (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Top 5 Products by Revenue</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={data.topProducts} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={100} />
                <Tooltip formatter={(v) => formatMoney(v)} />
                <Bar dataKey="revenue" fill="#8B5CF6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Low stock + pending orders */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {data.lowStockProducts.length > 0 && (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <FiAlertTriangle className="text-orange-500" /> Low Stock Alerts
            </h3>
            <div className="space-y-2">
              {data.lowStockProducts.map(p => (
                <div key={p.id} className="flex justify-between items-center text-sm py-1 border-b border-gray-50">
                  <span className="text-gray-700">{p.name}</span>
                  <span className={`font-medium ${p.stock === 0 ? 'text-red-600' : 'text-orange-600'}`}>
                    {p.stock} left
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Quick Stats</h3>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Pending Orders</span>
              <span className="font-medium text-gray-800">{data.pendingOrders}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Gross Profit</span>
              <span className="font-medium text-gray-800">{formatMoney(data.grossProfit)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">COGS</span>
              <span className="font-medium text-gray-800">{formatMoney(data.totalCOGS)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
