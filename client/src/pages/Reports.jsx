import { useState, useEffect } from 'react';
import { getPnlReport, getSalesReport, getExpenseReport, getProductReport, getCustomerReport, getGrowthReport, exportCSV } from '../services/api';
import { formatMoney } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiDownload, FiTrendingUp } from 'react-icons/fi';
import { saveAs } from 'file-saver';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend
} from 'recharts';

export default function Reports() {
  const [activeTab, setActiveTab] = useState('pnl');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [growthData, setGrowthData] = useState(null);
  const [loading, setLoading] = useState(false);

  const tabs = [
    { id: 'pnl', label: 'P&L Statement' },
    { id: 'sales', label: 'Sales' },
    { id: 'expenses', label: 'Expenses' },
    { id: 'products', label: 'Products' },
    { id: 'customers', label: 'Customers' },
    { id: 'growth', label: 'Growth & Projections' },
  ];

  const loadReport = async () => {
    setLoading(true);
    try {
      if (activeTab === 'growth') {
        const res = await getGrowthReport();
        setGrowthData(res.data);
        setData(null);
      } else {
        const params = { from: from || undefined, to: to || undefined };
        let res;
        switch (activeTab) {
          case 'pnl': res = await getPnlReport(params); break;
          case 'sales': res = await getSalesReport(params); break;
          case 'expenses': res = await getExpenseReport(params); break;
          case 'products': res = await getProductReport(params); break;
          case 'customers': res = await getCustomerReport(params); break;
        }
        setData(res.data);
        setGrowthData(null);
      }
    } catch { toast.error('Error loading report'); }
    setLoading(false);
  };

  // Auto-load growth report when tab switches to it
  useEffect(() => {
    if (activeTab === 'growth') loadReport();
  }, [activeTab]);

  const handleExport = async (type) => {
    try {
      const params = { from: from || undefined, to: to || undefined };
      const res = await exportCSV(type, params);
      if (type === 'pnl') {
        saveAs(new Blob([res.data]), 'pnl-statement.xlsx');
      } else {
        const blob = new Blob([res.data], { type: 'text/csv' });
        saveAs(blob, `${type}-report.csv`);
      }
      toast.success('Export downloaded');
    } catch { toast.error('Export failed'); }
  };

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto bg-gray-100 rounded-lg p-1">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setData(null); setGrowthData(null); }}
            className={`px-3 py-2 text-sm rounded-md whitespace-nowrap transition-colors ${activeTab === tab.id ? 'bg-white text-gray-800 font-medium shadow-sm' : 'text-gray-600 hover:text-gray-800'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters - hide for growth tab */}
      {activeTab !== 'growth' && (
        <div className="flex flex-wrap gap-3 items-center">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none" />
          <span className="text-gray-400">to</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none" />
          <button onClick={loadReport} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Generate
          </button>
          {data && (
            <button onClick={() => handleExport(activeTab === 'pnl' ? 'pnl' : activeTab)}
              className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
              <FiDownload size={14} /> Export {activeTab === 'pnl' ? 'XLSX' : 'CSV'}
            </button>
          )}
        </div>
      )}

      {loading && <LoadingSpinner />}

      {/* Growth & Projections Report */}
      {!loading && activeTab === 'growth' && growthData && (
        <GrowthReport data={growthData} />
      )}

      {/* P&L Report */}
      {!loading && data && activeTab === 'pnl' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">Profit & Loss Statement</h3>
          <div className="space-y-2">
            <Row label="Revenue" value={data.revenue} bold />
            <Row label="Cost of Goods Sold" value={-data.cogs} negative />
            <Row label="Shipping Costs Paid" value={-data.shippingCost} negative />
            <Row label="Shipping Charged" value={data.shippingCharge} />
            <Row label="Discounts Given" value={-data.discount} negative />
            <div className="border-t border-gray-300 pt-2 mt-2">
              <Row label="Gross Profit" value={data.grossProfit} bold highlight />
            </div>
            <div className="mt-4">
              <p className="text-sm font-medium text-gray-600 mb-2">Expenses</p>
              {Object.entries(data.expensesByCategory).map(([cat, amt]) => (
                <Row key={cat} label={`  ${cat}`} value={-amt} negative />
              ))}
              <Row label="Total Expenses" value={-data.totalExpenses} negative bold />
            </div>
            <div className="border-t-2 border-gray-800 pt-3 mt-3">
              <Row label="Net Profit" value={data.netProfit} bold highlight large />
              <p className="text-sm text-gray-500 mt-1">
                Profit Margin: {data.profitMargin.toFixed(1)}%
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Sales Report */}
      {!loading && data && activeTab === 'sales' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex gap-6 flex-wrap">
            <div className="text-sm"><span className="text-gray-500">Total Sales:</span> <span className="font-bold">{data.summary.totalSales}</span></div>
            <div className="text-sm"><span className="text-gray-500">Revenue:</span> <span className="font-bold">{formatMoney(data.summary.totalRevenue)}</span></div>
            <div className="text-sm"><span className="text-gray-500">Profit:</span> <span className="font-bold">{formatMoney(data.summary.totalProfit)}</span></div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left p-3 font-medium text-gray-600">Order</th>
                  <th className="text-left p-3 font-medium text-gray-600">Product</th>
                  <th className="text-left p-3 font-medium text-gray-600">Customer</th>
                  <th className="text-right p-3 font-medium text-gray-600">Total</th>
                  <th className="text-center p-3 font-medium text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.sales.map(s => (
                  <tr key={s.id} className="border-b border-gray-50">
                    <td className="p-3">{s.orderNumber}</td>
                    <td className="p-3">{s.product?.name} x{s.qty}</td>
                    <td className="p-3">{s.customerName || '-'}</td>
                    <td className="p-3 text-right font-medium">{formatMoney(s.totalPrice)}</td>
                    <td className="p-3 text-center">{s.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Expenses Report */}
      {!loading && data && activeTab === 'expenses' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex gap-6 flex-wrap">
            <div className="text-sm"><span className="text-gray-500">Total:</span> <span className="font-bold">{formatMoney(data.total)}</span></div>
            {Object.entries(data.byCategory).map(([cat, amt]) => (
              <div key={cat} className="text-sm"><span className="text-gray-500">{cat}:</span> <span className="font-medium">{formatMoney(amt)}</span></div>
            ))}
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left p-3 font-medium text-gray-600">Date</th>
                  <th className="text-left p-3 font-medium text-gray-600">Description</th>
                  <th className="text-left p-3 font-medium text-gray-600">Category</th>
                  <th className="text-right p-3 font-medium text-gray-600">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.expenses.map(e => (
                  <tr key={e.id} className="border-b border-gray-50">
                    <td className="p-3">{new Date(e.date).toLocaleDateString()}</td>
                    <td className="p-3">{e.description}</td>
                    <td className="p-3">{e.category}</td>
                    <td className="p-3 text-right font-medium">{formatMoney(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Product Report */}
      {!loading && data && activeTab === 'products' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">#</th>
                <th className="text-left p-3 font-medium text-gray-600">Product</th>
                <th className="text-right p-3 font-medium text-gray-600">Revenue</th>
                <th className="text-right p-3 font-medium text-gray-600">Qty Sold</th>
                <th className="text-right p-3 font-medium text-gray-600">Profit</th>
                <th className="text-right p-3 font-medium text-gray-600">Orders</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.id} className="border-b border-gray-50">
                  <td className="p-3 text-gray-500">{i + 1}</td>
                  <td className="p-3 font-medium">{p.name}</td>
                  <td className="p-3 text-right">{formatMoney(p.revenue)}</td>
                  <td className="p-3 text-right">{p.qtySold}</td>
                  <td className="p-3 text-right">{formatMoney(p.profit)}</td>
                  <td className="p-3 text-right">{p.orders}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Customer Report */}
      {!loading && data && activeTab === 'customers' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">#</th>
                <th className="text-left p-3 font-medium text-gray-600">Customer</th>
                <th className="text-left p-3 font-medium text-gray-600">City</th>
                <th className="text-right p-3 font-medium text-gray-600">Total Spent</th>
                <th className="text-right p-3 font-medium text-gray-600">Orders</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c, i) => (
                <tr key={c.id} className="border-b border-gray-50">
                  <td className="p-3 text-gray-500">{i + 1}</td>
                  <td className="p-3 font-medium">{c.name}</td>
                  <td className="p-3">{c.city || '-'}</td>
                  <td className="p-3 text-right">{formatMoney(c.totalSpent)}</td>
                  <td className="p-3 text-right">{c.orderCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !data && !growthData && activeTab !== 'growth' && (
        <div className="text-center text-gray-500 py-12">
          Select a date range and click Generate to view the report
        </div>
      )}
    </div>
  );
}

function GrowthReport({ data }) {
  const { history, projections, avgGrowthRate, targetGrowthRate } = data;

  // Build chart data: history + projections
  const chartData = [
    ...history.map(h => ({ month: h.month, actual: h.revenue, type: 'actual' })),
    ...projections.map(p => ({
      month: p.month,
      currentPace: p.currentTrajectory.revenue,
      target200: p.targetTrajectory.revenue,
      type: 'projected'
    }))
  ];

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Your Avg Monthly Growth</p>
          <p className={`text-2xl font-bold mt-1 ${avgGrowthRate >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {avgGrowthRate.toFixed(1)}%
          </p>
          <p className="text-xs text-gray-400 mt-1">Based on actual sales data</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Target Growth Rate</p>
          <p className="text-2xl font-bold mt-1 text-blue-600">200%</p>
          <p className="text-xs text-gray-400 mt-1">3x revenue every month</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Growth Gap</p>
          <p className={`text-2xl font-bold mt-1 ${avgGrowthRate >= targetGrowthRate ? 'text-green-600' : 'text-amber-600'}`}>
            {avgGrowthRate >= targetGrowthRate ? 'On Track!' : `${(targetGrowthRate - avgGrowthRate).toFixed(0)}% behind`}
          </p>
          <p className="text-xs text-gray-400 mt-1">Need {(targetGrowthRate - avgGrowthRate).toFixed(0)}% more growth</p>
        </div>
      </div>

      {/* Revenue Projection Chart */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
          <FiTrendingUp className="text-blue-500" /> Revenue Projection: Current Pace vs 200% Target
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => formatMoney(v)} />
            <Legend />
            <Line type="monotone" dataKey="actual" stroke="#3B82F6" strokeWidth={3} name="Actual Revenue" dot={{ r: 4 }} connectNulls={false} />
            <Line type="monotone" dataKey="currentPace" stroke="#F59E0B" strokeWidth={2} strokeDasharray="5 5" name="Current Pace" dot={{ r: 3 }} connectNulls={false} />
            <Line type="monotone" dataKey="target200" stroke="#10B981" strokeWidth={2} strokeDasharray="8 4" name="200% Target" dot={{ r: 3 }} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Monthly History */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">Monthly Performance History</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Month</th>
                <th className="text-right p-3 font-medium text-gray-600">Revenue</th>
                <th className="text-right p-3 font-medium text-gray-600">Orders</th>
                <th className="text-right p-3 font-medium text-gray-600">Profit</th>
                <th className="text-right p-3 font-medium text-gray-600">Ad Spend</th>
                <th className="text-right p-3 font-medium text-gray-600">ROAS</th>
                <th className="text-right p-3 font-medium text-gray-600">Growth</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.month} className="border-b border-gray-50">
                  <td className="p-3 font-medium">{h.month}</td>
                  <td className="p-3 text-right">{formatMoney(h.revenue)}</td>
                  <td className="p-3 text-right">{h.orders}</td>
                  <td className="p-3 text-right">{formatMoney(h.netProfit)}</td>
                  <td className="p-3 text-right">{formatMoney(h.adSpend)}</td>
                  <td className="p-3 text-right">{h.roas.toFixed(1)}x</td>
                  <td className="p-3 text-right">
                    <span className={h.growthRate > 0 ? 'text-green-600' : h.growthRate < 0 ? 'text-red-600' : 'text-gray-400'}>
                      {h.growthRate > 0 ? '+' : ''}{h.growthRate.toFixed(0)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Projections Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">6-Month Projections</h3>
          <p className="text-xs text-gray-400 mt-1">What you need to invest each month to hit 200% growth</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Month</th>
                <th className="text-right p-3 font-medium text-gray-600">Current Pace</th>
                <th className="text-right p-3 font-medium text-gray-600">200% Target</th>
                <th className="text-right p-3 font-medium text-gray-600">Gap</th>
                <th className="text-right p-3 font-medium text-gray-600">Ad Spend Needed</th>
                <th className="text-right p-3 font-medium text-gray-600">Inventory Needed</th>
              </tr>
            </thead>
            <tbody>
              {projections.map(p => (
                <tr key={p.month} className="border-b border-gray-50">
                  <td className="p-3 font-medium">{p.month}</td>
                  <td className="p-3 text-right text-amber-600">{formatMoney(p.currentTrajectory.revenue)}</td>
                  <td className="p-3 text-right text-green-600 font-medium">{formatMoney(p.targetTrajectory.revenue)}</td>
                  <td className="p-3 text-right text-red-500">{formatMoney(p.gap)}</td>
                  <td className="p-3 text-right">{formatMoney(p.targetTrajectory.adSpendNeeded)}</td>
                  <td className="p-3 text-right">{formatMoney(p.targetTrajectory.inventoryNeeded)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold, negative, highlight, large }) {
  const val = parseFloat(value) || 0;
  return (
    <div className={`flex justify-between py-1 ${bold ? 'font-semibold' : ''} ${large ? 'text-lg' : 'text-sm'}`}>
      <span className={highlight ? 'text-gray-800' : 'text-gray-600'}>{label}</span>
      <span className={val < 0 ? 'text-red-600' : highlight ? 'text-gray-800' : 'text-gray-700'}>
        {formatMoney(Math.abs(val))}
      </span>
    </div>
  );
}
