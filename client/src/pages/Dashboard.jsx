import { useState, useEffect } from 'react';
import { getDashboard } from '../services/api';
import { formatMoney } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import { FiDollarSign, FiShoppingCart, FiTrendingUp, FiAlertTriangle, FiTarget, FiZap, FiSave, FiUserCheck } from 'react-icons/fi';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend
} from 'recharts';

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316', '#6366F1'];

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getDashboard()
      .then(res => setData(res.data))
      .catch(err => {
        console.error('Dashboard error:', err.response?.data || err.message);
        setError(err.response?.data?.error || err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (!data) return <p className="text-red-500">Failed to load dashboard{error ? `: ${error}` : ''}</p>;

  const g = data.growth;

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
      {/* Growth Tracker - Top Priority */}
      {g && (
        <div className="bg-gradient-to-r from-blue-600 to-indigo-700 rounded-xl p-5 text-white shadow-lg">
          <div className="flex items-center gap-2 mb-4">
            <FiTarget size={20} />
            <h3 className="font-bold text-lg">200% Growth Tracker</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="bg-white/15 rounded-lg p-3">
              <p className="text-blue-100 text-xs">This Month Revenue</p>
              <p className="text-xl font-bold">{formatMoney(g.thisMonthRevenue)}</p>
              <p className="text-blue-200 text-xs">{g.thisMonthOrders} orders</p>
            </div>
            <div className="bg-white/15 rounded-lg p-3">
              <p className="text-blue-100 text-xs">Target (3x Last Month)</p>
              <p className="text-xl font-bold">{formatMoney(g.growthTarget)}</p>
              <p className="text-blue-200 text-xs">Last month: {formatMoney(g.lastMonthRevenue)}</p>
            </div>
            <div className="bg-white/15 rounded-lg p-3">
              <p className="text-blue-100 text-xs">Projected This Month</p>
              <p className="text-xl font-bold">{formatMoney(g.projectedMonthRevenue)}</p>
              <p className="text-blue-200 text-xs">~{g.projectedMonthOrders} orders at current pace</p>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mb-3">
            <div className="flex justify-between text-xs text-blue-100 mb-1">
              <span>Progress to 200% growth target</span>
              <span>{g.growthProgress.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-white/20 rounded-full h-3">
              <div
                className={`h-3 rounded-full transition-all ${g.growthProgress >= 100 ? 'bg-green-400' : g.growthProgress >= 50 ? 'bg-yellow-400' : 'bg-white'}`}
                style={{ width: `${Math.min(g.growthProgress, 100)}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-blue-200">Remaining</span>
              <p className="font-semibold">{formatMoney(g.remainingToTarget)}</p>
            </div>
            <div>
              <span className="text-blue-200">Daily target needed</span>
              <p className="font-semibold">{formatMoney(g.dailyTargetNeeded)}/day</p>
            </div>
            <div>
              <span className="text-blue-200">Days left</span>
              <p className="font-semibold">{g.daysLeft} days</p>
            </div>
            <div>
              <span className="text-blue-200">Current daily rate</span>
              <p className="font-semibold">{formatMoney(g.dailyRevenueRate)}/day</p>
            </div>
          </div>
        </div>
      )}

      {/* Daily Savings Guide */}
      {data.savings && (
        <div className="bg-gradient-to-r from-emerald-600 to-teal-700 rounded-xl p-5 text-white shadow-lg">
          <div className="flex items-center gap-2 mb-4">
            <FiSave size={20} />
            <h3 className="font-bold text-lg">Daily Savings Guide</h3>
            <span className="ml-auto text-emerald-200 text-xs font-medium bg-white/15 px-2 py-1 rounded-full">
              {(data.savings.rate * 100).toFixed(0)}% of gross profit
            </span>
          </div>

          {/* Today's breakdown */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-white/15 rounded-lg p-3">
              <p className="text-emerald-100 text-xs">Today's Revenue</p>
              <p className="text-xl font-bold">{formatMoney(data.savings.today.revenue)}</p>
              <p className="text-emerald-200 text-xs">{data.savings.today.orders} orders</p>
            </div>
            <div className="bg-white/15 rounded-lg p-3">
              <p className="text-emerald-100 text-xs">Today's Gross Profit</p>
              <p className="text-xl font-bold">{formatMoney(data.savings.today.grossProfit)}</p>
            </div>
            <div className="bg-white/20 rounded-lg p-3 ring-2 ring-white/30">
              <p className="text-emerald-100 text-xs font-medium">Save Today</p>
              <p className="text-2xl font-bold">{formatMoney(data.savings.today.savings)}</p>
              <p className="text-emerald-200 text-xs">put aside</p>
            </div>
            <div className="bg-white/15 rounded-lg p-3">
              <p className="text-emerald-100 text-xs">Reinvest Today</p>
              <p className="text-xl font-bold">{formatMoney(data.savings.today.reinvest)}</p>
              <p className="text-emerald-200 text-xs">back into business</p>
            </div>
          </div>

          {/* Monthly summary */}
          <div className="bg-white/10 rounded-lg p-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <span className="text-emerald-200">This Month Profit</span>
                <p className="font-semibold text-sm">{formatMoney(data.savings.thisMonth.grossProfit)}</p>
              </div>
              <div>
                <span className="text-emerald-200">Total Saved This Month</span>
                <p className="font-semibold text-sm">{formatMoney(data.savings.thisMonth.totalSavings)}</p>
              </div>
              <div>
                <span className="text-emerald-200">Total Reinvested</span>
                <p className="font-semibold text-sm">{formatMoney(data.savings.thisMonth.totalReinvest)}</p>
              </div>
              <div>
                <span className="text-emerald-200">Avg Daily Savings</span>
                <p className="font-semibold text-sm">{formatMoney(data.savings.avgDailySavings)}/day</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reinvestment Guide */}
      {g && g.reinvestment && (
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <FiZap className="text-amber-500" size={18} />
            <h3 className="text-sm font-bold text-gray-800">Reinvestment Guide — How to Hit 200% Growth</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Per Sale Breakdown */}
            <div>
              <p className="text-xs text-gray-500 mb-3 uppercase font-medium">Per Sale Action</p>
              <div className="space-y-3">
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">Avg profit per sale</span>
                  <span className="font-bold text-green-600">{formatMoney(g.reinvestment.avgProfitPerSale)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">Set aside per sale for growth</span>
                  <span className="font-bold text-blue-600">{formatMoney(g.reinvestment.perSale)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">% of profit to reinvest</span>
                  <span className="font-bold text-amber-600">{g.reinvestment.percentOfProfit.toFixed(0)}%</span>
                </div>
                <div className="flex justify-between items-center py-2">
                  <span className="text-sm text-gray-600">Keep as take-home</span>
                  <span className="font-bold text-gray-800">{formatMoney(Math.max(0, g.reinvestment.avgProfitPerSale - g.reinvestment.perSale))}</span>
                </div>
              </div>

              {g.reinvestment.avgProfitPerSale > 0 && data.savings && (
                <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-xs text-amber-800">
                    <strong>Rule of thumb:</strong> For every sale averaging {formatMoney(g.reinvestment.avgProfitPerSale)} profit
                    — save {formatMoney(g.reinvestment.avgProfitPerSale * data.savings.rate)} (25%),
                    reinvest {formatMoney(g.reinvestment.perSale)} into ads + inventory,
                    and take home {formatMoney(Math.max(0, g.reinvestment.avgProfitPerSale - (g.reinvestment.avgProfitPerSale * data.savings.rate) - g.reinvestment.perSale))}.
                  </p>
                </div>
              )}
            </div>

            {/* Monthly Budget */}
            <div>
              <p className="text-xs text-gray-500 mb-3 uppercase font-medium">Monthly Reinvestment Budget</p>
              <div className="space-y-3">
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <div>
                    <span className="text-sm text-gray-600">Facebook Ads budget</span>
                    <p className="text-xs text-gray-400">Based on {g.reinvestment.roas.toFixed(1)}x ROAS</p>
                  </div>
                  <span className="font-bold text-pink-600">{formatMoney(g.reinvestment.monthlyAdBudget)}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <div>
                    <span className="text-sm text-gray-600">Inventory investment</span>
                    <p className="text-xs text-gray-400">Stock for 3x orders</p>
                  </div>
                  <span className="font-bold text-purple-600">{formatMoney(g.reinvestment.monthlyInventory)}</span>
                </div>
                <div className="flex justify-between items-center py-2 bg-gray-50 rounded-lg px-3">
                  <span className="text-sm font-medium text-gray-700">Total monthly reinvestment</span>
                  <span className="font-bold text-gray-800 text-lg">{formatMoney(g.reinvestment.totalMonthly)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Consultant Impact */}
      {data.consultantImpact && (
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <FiUserCheck className="text-indigo-600" size={18} />
            <h3 className="text-sm font-bold text-gray-800">Consultant Impact (This Month)</h3>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-indigo-50 rounded-lg p-3">
              <p className="text-xs text-gray-500">Consultant Orders</p>
              <p className="text-xl font-bold text-indigo-700">{data.consultantImpact.consultantSalesCount}</p>
              <p className="text-xs text-gray-400">{data.consultantImpact.consultantSharePercent.toFixed(0)}% of all orders</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-3">
              <p className="text-xs text-gray-500">Revenue via Consultants</p>
              <p className="text-xl font-bold text-blue-700">{formatMoney(data.consultantImpact.consultantRevenue)}</p>
              <p className="text-xs text-gray-400">{data.consultantImpact.revenueSharePercent.toFixed(0)}% of revenue</p>
            </div>
            <div className="bg-orange-50 rounded-lg p-3">
              <p className="text-xs text-gray-500">Commission Cost</p>
              <p className="text-xl font-bold text-orange-700">{formatMoney(data.consultantImpact.totalCommissionEarned)}</p>
              <p className="text-xs text-gray-400">total earned</p>
            </div>
            <div className="bg-green-50 rounded-lg p-3">
              <p className="text-xs text-gray-500">Net After Commission</p>
              <p className="text-xl font-bold text-green-700">{formatMoney(data.consultantImpact.netProfitAfterCommission)}</p>
              <p className="text-xs text-gray-400">your profit from their sales</p>
            </div>
          </div>

          {/* Per consultant breakdown */}
          {data.consultantImpact.byConsultant.filter(c => c.totalSales > 0 || c.isActive).length > 0 && (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b">
                    <th className="text-left p-2 font-medium text-gray-600">Consultant</th>
                    <th className="text-right p-2 font-medium text-gray-600">Orders</th>
                    <th className="text-right p-2 font-medium text-gray-600">Products</th>
                    <th className="text-right p-2 font-medium text-gray-600 hidden sm:table-cell">Revenue</th>
                    <th className="text-right p-2 font-medium text-gray-600">Commission</th>
                    <th className="text-right p-2 font-medium text-gray-600 hidden sm:table-cell">Your Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.consultantImpact.byConsultant.filter(c => c.totalSales > 0 || c.isActive).map(c => (
                    <tr key={c.id} className="border-b border-gray-50">
                      <td className="p-2 font-medium text-gray-800">{c.name}</td>
                      <td className="p-2 text-right">{c.totalSales}</td>
                      <td className="p-2 text-right font-medium">{c.productsSold || 0}</td>
                      <td className="p-2 text-right hidden sm:table-cell">{formatMoney(c.revenue)}</td>
                      <td className="p-2 text-right text-orange-600">{formatMoney(c.commissionEarned)}</td>
                      <td className="p-2 text-right hidden sm:table-cell text-green-600 font-medium">{formatMoney(c.netProfit)}</td>
                    </tr>
                  ))}
                  {/* Direct sales row */}
                  <tr className="bg-gray-50 font-medium">
                    <td className="p-2 text-gray-600">Direct (no consultant)</td>
                    <td className="p-2 text-right">{data.consultantImpact.directSalesCount}</td>
                    <td className="p-2 text-right">-</td>
                    <td className="p-2 text-right hidden sm:table-cell">{formatMoney(data.consultantImpact.directRevenue)}</td>
                    <td className="p-2 text-right">-</td>
                    <td className="p-2 text-right hidden sm:table-cell">-</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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
