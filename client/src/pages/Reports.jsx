import { useState, useEffect } from 'react';
import { getPnlReport, getSalesReport, getExpenseReport, getProductReport, getCustomerReport, getGrowthReport, getCreditReport, getInventoryReport, exportCSV } from '../services/api';
import { formatMoney } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiDownload, FiTrendingUp } from 'react-icons/fi';
import { saveAs } from 'file-saver';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, PieChart, Pie, Cell
} from 'recharts';

export default function Reports() {
  const [activeTab, setActiveTab] = useState('pnl');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [growthData, setGrowthData] = useState(null);
  const [loading, setLoading] = useState(false);

  const [creditData, setCreditData] = useState(null);
  const [inventoryData, setInventoryData] = useState(null);

  const tabs = [
    { id: 'pnl', label: 'P&L Statement' },
    { id: 'sales', label: 'Sales' },
    { id: 'expenses', label: 'Expenses' },
    { id: 'products', label: 'Products' },
    { id: 'customers', label: 'Customers' },
    { id: 'credit', label: 'Credit/Debt' },
    { id: 'inventory', label: 'Inventory Valuation' },
    { id: 'growth', label: 'Growth & Projections' },
  ];

  const autoLoadTabs = ['growth', 'credit', 'inventory'];

  const loadReport = async () => {
    setLoading(true);
    try {
      if (activeTab === 'growth') {
        const res = await getGrowthReport();
        setGrowthData(res.data);
        setData(null); setCreditData(null); setInventoryData(null);
      } else if (activeTab === 'credit') {
        const res = await getCreditReport();
        setCreditData(res.data);
        setData(null); setGrowthData(null); setInventoryData(null);
      } else if (activeTab === 'inventory') {
        const res = await getInventoryReport();
        setInventoryData(res.data);
        setData(null); setGrowthData(null); setCreditData(null);
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
        setGrowthData(null); setCreditData(null); setInventoryData(null);
      }
    } catch { toast.error('Error loading report'); }
    setLoading(false);
  };

  useEffect(() => {
    if (autoLoadTabs.includes(activeTab)) loadReport();
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
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setData(null); setGrowthData(null); setCreditData(null); setInventoryData(null); }}
            className={`px-3 py-2 text-sm rounded-md whitespace-nowrap transition-colors ${activeTab === tab.id ? 'bg-white text-gray-800 font-medium shadow-sm' : 'text-gray-600 hover:text-gray-800'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters - hide for auto-load tabs */}
      {!autoLoadTabs.includes(activeTab) && (
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

      {/* Credit/Debt Report */}
      {!loading && creditData && activeTab === 'credit' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => handleExport('credit')}
              className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
              <FiDownload size={14} /> Export CSV
            </button>
          </div>
          <CreditReport data={creditData} />
        </div>
      )}

      {/* Inventory Valuation Report */}
      {!loading && inventoryData && activeTab === 'inventory' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => handleExport('inventory')}
              className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
              <FiDownload size={14} /> Export CSV
            </button>
          </div>
          <InventoryReport data={inventoryData} />
        </div>
      )}

      {!loading && !data && !growthData && !creditData && !inventoryData && !autoLoadTabs.includes(activeTab) && (
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

const AGING_COLORS = ['#10B981', '#F59E0B', '#F97316', '#EF4444', '#991B1B'];

function CreditReport({ data }) {
  const { totalOutstanding, overdueTotal, totalCreditIssued, totalCollected, collectionRate, aging, agingDetails, paymentTrends, totalDebtors } = data;

  const agingChartData = [
    { name: 'Current', value: aging.current },
    { name: '1-30 days', value: aging.days30 },
    { name: '31-60 days', value: aging.days60 },
    { name: '61-90 days', value: aging.days90 },
    { name: '90+ days', value: aging.days90plus },
  ].filter(d => d.value > 0);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Total Outstanding</p>
          <p className="text-2xl font-bold mt-1 text-red-600">{formatMoney(totalOutstanding)}</p>
          <p className="text-xs text-gray-400 mt-1">{totalDebtors} debtor(s)</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Overdue</p>
          <p className="text-2xl font-bold mt-1 text-amber-600">{formatMoney(overdueTotal)}</p>
          <p className="text-xs text-gray-400 mt-1">Past due date</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Collection Rate</p>
          <p className={`text-2xl font-bold mt-1 ${collectionRate >= 70 ? 'text-green-600' : collectionRate >= 40 ? 'text-amber-600' : 'text-red-600'}`}>{collectionRate.toFixed(1)}%</p>
          <p className="text-xs text-gray-400 mt-1">{formatMoney(totalCollected)} of {formatMoney(totalCreditIssued)}</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Current (Not Due)</p>
          <p className="text-2xl font-bold mt-1 text-green-600">{formatMoney(aging.current)}</p>
          <p className="text-xs text-gray-400 mt-1">Within due date</p>
        </div>
      </div>

      {/* Aging chart + breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Aging Breakdown</h3>
          {agingChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={agingChartData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}>
                  {agingChartData.map((_, i) => <Cell key={i} fill={AGING_COLORS[i % AGING_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => formatMoney(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-400 text-sm text-center py-8">No outstanding credit</p>
          )}
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Aging Summary</h3>
          <div className="space-y-3">
            {[
              { label: 'Current (Not Due)', value: aging.current, color: 'bg-green-500' },
              { label: '1-30 Days Overdue', value: aging.days30, color: 'bg-yellow-500' },
              { label: '31-60 Days Overdue', value: aging.days60, color: 'bg-orange-500' },
              { label: '61-90 Days Overdue', value: aging.days90, color: 'bg-red-500' },
              { label: '90+ Days Overdue', value: aging.days90plus, color: 'bg-red-800' },
            ].map(b => (
              <div key={b.label} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${b.color}`} />
                  <span className="text-sm text-gray-600">{b.label}</span>
                </div>
                <span className="text-sm font-medium">{formatMoney(b.value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Payment collection trends */}
      {paymentTrends.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Monthly Collections (Last 6 Months)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={paymentTrends}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatMoney(v)} />
              <Bar dataKey="amount" fill="#3B82F6" name="Collected" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Debtor details table */}
      {agingDetails.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700">Outstanding Debts</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left p-3 font-medium text-gray-600">Order</th>
                  <th className="text-left p-3 font-medium text-gray-600">Customer</th>
                  <th className="text-right p-3 font-medium text-gray-600">Total</th>
                  <th className="text-right p-3 font-medium text-gray-600">Paid</th>
                  <th className="text-right p-3 font-medium text-gray-600">Balance</th>
                  <th className="text-center p-3 font-medium text-gray-600">Aging</th>
                  <th className="text-center p-3 font-medium text-gray-600">Days Overdue</th>
                </tr>
              </thead>
              <tbody>
                {agingDetails.map(d => (
                  <tr key={d.id} className="border-b border-gray-50">
                    <td className="p-3 font-medium">{d.orderNumber}</td>
                    <td className="p-3">{d.customerName}<br/><span className="text-xs text-gray-400">{d.customerPhone}</span></td>
                    <td className="p-3 text-right">{formatMoney(d.totalPrice)}</td>
                    <td className="p-3 text-right">{formatMoney(d.amountPaid)}</td>
                    <td className="p-3 text-right font-semibold text-red-600">{formatMoney(d.balance)}</td>
                    <td className="p-3 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                        d.bucket === 'Current' ? 'bg-green-100 text-green-700' :
                        d.bucket === '1-30 days' ? 'bg-yellow-100 text-yellow-700' :
                        d.bucket === '31-60 days' ? 'bg-orange-100 text-orange-700' :
                        'bg-red-100 text-red-700'
                      }`}>{d.bucket}</span>
                    </td>
                    <td className="p-3 text-center">{d.daysOverdue > 0 ? d.daysOverdue : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const CATEGORY_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'];

function InventoryReport({ data }) {
  const { summary, products, categoryBreakdown } = data;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Stock Value (Cost)</p>
          <p className="text-2xl font-bold mt-1 text-gray-800">{formatMoney(summary.totalStockValue)}</p>
          <p className="text-xs text-gray-400 mt-1">{summary.totalProducts} products</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Potential Revenue</p>
          <p className="text-2xl font-bold mt-1 text-blue-600">{formatMoney(summary.totalPotentialRevenue)}</p>
          <p className="text-xs text-gray-400 mt-1">If all stock sold</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Potential Profit</p>
          <p className="text-2xl font-bold mt-1 text-green-600">{formatMoney(summary.totalPotentialProfit)}</p>
          <p className="text-xs text-gray-400 mt-1">Revenue - Cost</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <p className="text-xs text-gray-500 uppercase font-medium">Dead Stock</p>
          <p className="text-2xl font-bold mt-1 text-red-600">{formatMoney(summary.deadStockValue)}</p>
          <p className="text-xs text-gray-400 mt-1">{summary.deadStockCount} item(s) not sold in 90+ days</p>
        </div>
      </div>

      {/* Alerts */}
      {(summary.deadStockCount > 0 || summary.lowStockCount > 0) && (
        <div className="flex gap-4 flex-wrap">
          {summary.deadStockCount > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
              <span className="font-medium">{summary.deadStockCount} dead stock item(s)</span> — {formatMoney(summary.deadStockValue)} tied up in unsold inventory (90+ days)
            </div>
          )}
          {summary.lowStockCount > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
              <span className="font-medium">{summary.lowStockCount} item(s)</span> at or below reorder level
            </div>
          )}
        </div>
      )}

      {/* Category breakdown chart */}
      {categoryBreakdown.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Stock Value by Category</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={categoryBreakdown}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatMoney(v)} />
              <Legend />
              <Bar dataKey="stockValue" fill="#3B82F6" name="Stock Value (Cost)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="potentialRevenue" fill="#10B981" name="Potential Revenue" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Product details table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">Product Inventory Details</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Product</th>
                <th className="text-right p-3 font-medium text-gray-600">Stock</th>
                <th className="text-right p-3 font-medium text-gray-600">Cost</th>
                <th className="text-right p-3 font-medium text-gray-600">Stock Value</th>
                <th className="text-right p-3 font-medium text-gray-600">Margin</th>
                <th className="text-right p-3 font-medium text-gray-600">Sold (90d)</th>
                <th className="text-right p-3 font-medium text-gray-600">Turnover</th>
                <th className="text-center p-3 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody>
              {products.map(p => (
                <tr key={p.id} className={`border-b border-gray-50 ${p.isDeadStock ? 'bg-red-50' : p.isLowStock ? 'bg-amber-50' : ''}`}>
                  <td className="p-3">
                    <span className="font-medium">{p.name}</span>
                    <br/><span className="text-xs text-gray-400">{p.sku}{p.category ? ` · ${p.category}` : ''}</span>
                  </td>
                  <td className="p-3 text-right">{p.stock}</td>
                  <td className="p-3 text-right">{formatMoney(p.costPrice)}</td>
                  <td className="p-3 text-right font-medium">{formatMoney(p.stockValue)}</td>
                  <td className="p-3 text-right">{p.margin.toFixed(1)}%</td>
                  <td className="p-3 text-right">{p.unitsSold90d}</td>
                  <td className="p-3 text-right">{p.turnoverRate.toFixed(1)}x</td>
                  <td className="p-3 text-center">
                    {p.isDeadStock && <span className="px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700">Dead</span>}
                    {!p.isDeadStock && p.isLowStock && <span className="px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Low</span>}
                    {!p.isDeadStock && !p.isLowStock && <span className="px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">OK</span>}
                  </td>
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
