import { downloadPayslip } from '../components/PayslipPDF';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getConsultantDashboard } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import { StatusBadge, PaymentBadge } from '../components/StatusBadge';
import { FiShoppingCart, FiDollarSign, FiTrendingUp, FiPlus, FiCreditCard, FiInbox } from 'react-icons/fi';

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

  const { consultant, cycle, today, thisCycle, allTime, recentSales, recentPayments, payslip, payslipHistory = [] } = data;
  const savePayslip = (slip) => downloadPayslip({
    slip, name: consultant.name, jobTitle: 'Sales consultant', periodLabel: slip.period, periodName: slip.periodName,
    status: slip.status, finalisedAt: slip.finalisedAt,
  }).catch(() => {});
  const cycleFrom = cycle ? new Date(cycle.from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  const cycleTo = cycle ? new Date(new Date(cycle.to).getTime() - 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const cyclePayDate = cycle ? new Date(cycle.payDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <div className="bg-gradient-to-r from-indigo-600 to-blue-700 rounded-xl p-5 text-white shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-bold">Welcome, {consultant.name}</h2>
            <p className="text-blue-100 text-sm">
              {consultant.payType === 'revenue_pct'
                ? consultant.tierThreshold && parseFloat(consultant.tierRate) > 0
                  ? `Commission: ${parseFloat(consultant.commissionRate)}% (≤K${Number(consultant.tierThreshold).toLocaleString()}) · ${parseFloat(consultant.tierRate)}% (>K${Number(consultant.tierThreshold).toLocaleString()})`
                  : `Commission: ${parseFloat(consultant.commissionRate)}% of sales revenue`
                : `Commission: ${formatMoney(consultant.commissionRate)}/item (first ${consultant.tierThreshold}) then ${formatMoney(consultant.tierRate)}/item`}
            </p>
            {cycle && (
              <p className="text-blue-200 text-xs mt-1">Current cycle: {cycleFrom} – {cycleTo} · Pay date: {cyclePayDate}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/sales" className="flex items-center gap-1.5 px-4 py-2 bg-white text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50">
              <FiPlus size={16} /> Record Sale
            </Link>
            <Link to="/my-advances" className="flex items-center gap-1.5 px-4 py-2 bg-white/15 text-white border border-white/40 rounded-lg text-sm font-medium hover:bg-white/25">
              <FiInbox size={16} /> Ask for an advance
            </Link>
          </div>
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

      {/* This cycle */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-1">This Pay Cycle</h3>
        {cycle && <p className="text-xs text-gray-400 mb-3">{cycleFrom} – {cycleTo}</p>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={FiShoppingCart} label="Orders" value={thisCycle.ordersCount} color="bg-blue-500" />
          <StatCard icon={FiTrendingUp} label="Products Sold" value={thisCycle.productsSold} color="bg-purple-500" />
          <StatCard icon={FiDollarSign} label="Revenue" value={formatMoney(thisCycle.revenue)} color="bg-indigo-500" />
          <StatCard icon={FiCreditCard} label="Commission Earned" value={formatMoney(thisCycle.commissionEarned)} color="bg-emerald-600" accent />
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
            <p className="text-xs text-amber-700 font-medium">{allTime.balance < 0 ? 'You Owe Back' : 'Due On Next Payslip'}</p>
            <p className="text-2xl font-bold text-amber-700">{formatMoney(Math.abs(allTime.balance))}</p>
          </div>
          <div className="bg-blue-50 rounded-lg p-4">
            <p className="text-xs text-gray-500">Allowance Paid</p>
            <p className="text-xl font-bold text-blue-700">{formatMoney(allTime.allowancePaid)}</p>
          </div>
        </div>
        {/* The target for the cycle, and what reaching it is worth. */}
        {payslip?.target && (
          <div className="mt-3 bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <p className="font-medium text-blue-900">Your target · {payslip.periodName}</p>
              <p className="text-blue-900 font-semibold">{formatMoney(payslip.target.collected)} of {formatMoney(payslip.target.target)}</p>
            </div>
            <div className="w-full bg-white rounded-full h-2 mt-2">
              <div className={`h-2 rounded-full ${payslip.target.reached ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${payslip.target.progress}%` }} />
            </div>
            <p className="text-xs text-blue-800 mt-2">
              {payslip.target.reached
                ? `Target reached. Your bonus so far is ${formatMoney(payslip.target.bonusNow)}, and it grows with every paid order from here.`
                : `${formatMoney(payslip.target.toGo)} to go for a bonus of ${formatMoney(payslip.target.bonus)}${payslip.target.bonusRate > 0 ? `, plus ${payslip.target.bonusRate}% of everything above the target` : ''}.`}
              {' '}Only orders customers have paid for count.
            </p>
          </div>
        )}
        {/* How the figure above is made up: the payslip as it stands today. */}
        {payslip && (
          <div className="mt-3 bg-white border border-gray-100 rounded-lg p-4 text-sm">
            <p className="font-medium text-gray-700 mb-1">Your payslip so far · {payslip.periodName}</p>
            {payslip.broughtForward !== 0 && (
              <div className="flex justify-between py-0.5 text-gray-600"><span>Brought forward</span><span>{formatMoney(payslip.broughtForward)}</span></div>
            )}
            {payslip.lines.map((l, i) => (
              <div key={i} className="flex justify-between gap-3 py-0.5 text-gray-600">
                <span>{l.label}</span><span className={l.amount < 0 ? 'text-red-600' : ''}>{formatMoney(l.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between py-1 mt-1 border-t border-gray-100 font-semibold"><span>Net pay</span><span>{formatMoney(payslip.netPay)}</span></div>
            <p className="text-xs text-gray-400 mt-1">Commission counts only what customers have paid. It is final once the cycle is closed.</p>
          </div>
        )}
        {payslipHistory.length > 0 && (
          <div className="mt-3 bg-white border border-gray-100 rounded-lg p-4 text-sm">
            <p className="font-medium text-gray-700 mb-1">Your payslips</p>
            <div className="divide-y divide-gray-50">
              {payslipHistory.map(p => (
                <div key={p.period} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-gray-700 min-w-0">
                    {p.periodName} {new Date(p.finalisedAt).getFullYear()} · net pay {formatMoney(p.netPay)}
                    <span className="text-xs text-gray-400 ml-2">
                      {p.outstanding <= 0 ? 'paid' : p.carried ? `${formatMoney(p.outstanding)} carried forward` : `${formatMoney(p.outstanding)} still to pay`}
                    </span>
                  </span>
                  <button onClick={() => savePayslip(p)} className="text-blue-600 hover:underline shrink-0">Download PDF</button>
                </div>
              ))}
            </div>
          </div>
        )}
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
