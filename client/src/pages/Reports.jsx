import { useState } from 'react';
import { getPnlReport, getSalesReport, getExpenseReport, getProductReport, getCustomerReport, exportCSV } from '../services/api';
import { formatMoney } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiDownload } from 'react-icons/fi';
import { saveAs } from 'file-saver';

export default function Reports() {
  const [activeTab, setActiveTab] = useState('pnl');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const tabs = [
    { id: 'pnl', label: 'P&L Statement' },
    { id: 'sales', label: 'Sales' },
    { id: 'expenses', label: 'Expenses' },
    { id: 'products', label: 'Products' },
    { id: 'customers', label: 'Customers' },
  ];

  const loadReport = async () => {
    setLoading(true);
    try {
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
    } catch { toast.error('Error loading report'); }
    setLoading(false);
  };

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
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setData(null); }}
            className={`px-3 py-2 text-sm rounded-md whitespace-nowrap transition-colors ${activeTab === tab.id ? 'bg-white text-gray-800 font-medium shadow-sm' : 'text-gray-600 hover:text-gray-800'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
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

      {loading && <LoadingSpinner />}

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

      {!loading && !data && (
        <div className="text-center text-gray-500 py-12">
          Select a date range and click Generate to view the report
        </div>
      )}
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
        {val < 0 && negative ? '' : ''}
      </span>
    </div>
  );
}
