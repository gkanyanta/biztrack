import { useState, useEffect } from 'react';
import { pdf } from '@react-pdf/renderer';
import { getDailySalesReport, getConsultants, getSettings } from '../services/api';
import { formatMoney } from '../utils/format';
import { PaymentBadge } from '../components/StatusBadge';
import LoadingSpinner from '../components/LoadingSpinner';
import PaymentStatusModal from '../components/PaymentStatusModal';
import DailySalesReportPDF from '../components/DailySalesReportPDF';
import toast from 'react-hot-toast';
import { FiDownload, FiShare2, FiMessageSquare, FiFileText, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import { useAuth } from '../hooks/useAuth';

const PERIOD_LABEL = { day: 'Daily', week: 'Weekly', month: 'Monthly' };

function pad(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return toISODate(new Date()); }

// The period shape (day/week/month) is a purely client-side concern — the backend just
// takes an inclusive from/to range, so this is the only place that needs to know that a
// week runs Monday–Sunday or that a month means calendar-month boundaries.
function getRange(period, anchor) {
  const d = new Date(anchor + 'T00:00:00');
  if (period === 'week') {
    const day = d.getDay(); // 0=Sun..6=Sat
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(d); monday.setDate(d.getDate() + diffToMonday);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const fmt = (x) => x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    return { from: toISODate(monday), to: toISODate(sunday), label: `${fmt(monday)} – ${fmt(sunday)}, ${sunday.getFullYear()}` };
  }
  if (period === 'month') {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from: toISODate(first), to: toISODate(last), label: first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) };
  }
  return { from: anchor, to: anchor, label: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) };
}

function shiftAnchor(period, anchor, dir) {
  const d = new Date(anchor + 'T00:00:00');
  if (period === 'week') d.setDate(d.getDate() + dir * 7);
  else if (period === 'month') d.setMonth(d.getMonth() + dir);
  else d.setDate(d.getDate() + dir);
  return toISODate(d);
}

export default function DailySalesReport() {
  const { user } = useAuth();
  const isConsultant = user?.role === 'consultant';
  const [period, setPeriod] = useState('day');
  const [anchor, setAnchor] = useState(todayStr());
  const [consultantId, setConsultantId] = useState('');
  const [consultants, setConsultants] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [paymentModalSale, setPaymentModalSale] = useState(null);

  const range = getRange(period, anchor);

  const loadReport = () => {
    setLoading(true);
    getDailySalesReport({ from: range.from, to: range.to, consultantId: !isConsultant && consultantId ? consultantId : undefined })
      .then(res => setReport(res.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadReport(); }, [period, anchor, consultantId]);
  useEffect(() => {
    if (!isConsultant) getConsultants({ active: 'true' }).then(res => setConsultants(res.data.filter(c => !c.isStockLocation))).catch(() => {});
  }, [isConsultant]);

  const fileSlug = () => `Sales-Report-${range.from}${range.from !== range.to ? `_to_${range.to}` : ''}`;

  const buildPdfBlob = async () => {
    const { data: settings } = await getSettings();
    return pdf(<DailySalesReportPDF report={report} settings={settings} periodLabel={range.label} reportTypeLabel={PERIOD_LABEL[period]} />).toBlob();
  };

  const handleDownload = async () => {
    if (exporting || !report) return;
    setExporting(true);
    try {
      const blob = await buildPdfBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileSlug()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      toast.error('Error generating PDF');
    } finally {
      setExporting(false);
    }
  };

  const handleShare = async () => {
    if (exporting || !report) return;
    setExporting(true);
    try {
      const blob = await buildPdfBlob();
      const file = new File([blob], `${fileSlug()}.pdf`, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `${PERIOD_LABEL[period]} Sales Report — ${range.label}`, text: `${PERIOD_LABEL[period]} sales report for ${range.label}` });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
        toast('Sharing isn\'t supported on this device — downloaded instead', { icon: 'ℹ️' });
      }
    } catch (err) {
      if (err.name !== 'AbortError') { console.error(err); toast.error('Error sharing report'); }
    } finally {
      setExporting(false);
    }
  };

  const summary = report?.summary;

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">Sales Report</h1>
        <p className="text-sm text-gray-500">See what's paid and what's still outstanding — {range.label}.</p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
          {['day', 'week', 'month'].map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-sm capitalize ${period === p ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {p}
            </button>
          ))}
        </div>

        {period === 'day' ? (
          <input type="date" value={anchor} onChange={e => setAnchor(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
        ) : (
          <div className="flex items-center gap-1">
            <button onClick={() => setAnchor(shiftAnchor(period, anchor, -1))} className="p-1.5 border border-gray-300 rounded-lg hover:bg-gray-50">
              <FiChevronLeft size={14} />
            </button>
            <span className="text-sm font-medium text-gray-700 px-2 min-w-[150px] text-center">{range.label}</span>
            <button onClick={() => setAnchor(shiftAnchor(period, anchor, 1))} className="p-1.5 border border-gray-300 rounded-lg hover:bg-gray-50">
              <FiChevronRight size={14} />
            </button>
          </div>
        )}
        <button onClick={() => setAnchor(todayStr())} className="px-2 py-1.5 text-xs text-blue-600 hover:text-blue-800">Today</button>

        {!isConsultant && consultants.length > 0 && (
          <select value={consultantId} onChange={e => setConsultantId(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm outline-none">
            <option value="">All Consultants</option>
            {consultants.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div className="flex-1" />
        <button onClick={handleDownload} disabled={exporting || !report?.orders?.length}
          className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">
          <FiDownload size={14} /> PDF
        </button>
        <button onClick={handleShare} disabled={exporting || !report?.orders?.length}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
          <FiShare2 size={14} /> Share
        </button>
      </div>

      {loading ? <LoadingSpinner /> : !report ? null : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-xs text-gray-500">Total Orders</div>
              <div className="text-xl font-bold text-gray-800">{summary.totalOrders}</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-xs text-gray-500">Total Revenue</div>
              <div className="text-xl font-bold text-gray-800">{formatMoney(summary.totalRevenue)}</div>
            </div>
            <div className="bg-green-50 rounded-xl border border-green-200 p-4">
              <div className="text-xs text-green-700">Paid ({summary.paidCount})</div>
              <div className="text-xl font-bold text-green-700">{formatMoney(summary.paidAmount)}</div>
            </div>
            <div className="bg-red-50 rounded-xl border border-red-200 p-4">
              <div className="text-xs text-red-700">Outstanding ({summary.partialCount + summary.unpaidCount})</div>
              <div className="text-xl font-bold text-red-700">{formatMoney(summary.totalOutstanding)}</div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left p-3 font-medium text-gray-600">Order</th>
                  <th className="text-left p-3 font-medium text-gray-600">Customer</th>
                  <th className="text-left p-3 font-medium text-gray-600 hidden md:table-cell">Items</th>
                  {(!isConsultant && !consultantId) && <th className="text-left p-3 font-medium text-gray-600 hidden lg:table-cell">Consultant</th>}
                  <th className="text-right p-3 font-medium text-gray-600">Total</th>
                  <th className="text-center p-3 font-medium text-gray-600">Payment</th>
                  <th className="text-left p-3 font-medium text-gray-600 hidden md:table-cell">Note</th>
                </tr>
              </thead>
              <tbody>
                {report.orders.map(o => (
                  <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="p-3 font-medium text-gray-800">{o.orderNumber}</td>
                    <td className="p-3 text-gray-700">{o.customerName}</td>
                    <td className="p-3 text-gray-600 hidden md:table-cell">{o.items.map(i => `${i.name} x${i.qty}`).join(', ')}</td>
                    {(!isConsultant && !consultantId) && <td className="p-3 text-gray-600 hidden lg:table-cell">{o.consultant?.name || '-'}</td>}
                    <td className="p-3 text-right font-medium text-gray-800">{formatMoney(o.totalPrice)}</td>
                    <td className="p-3 text-center">
                      <button onClick={() => setPaymentModalSale(o)} className="hover:opacity-75" title="Click to update payment status">
                        <PaymentBadge status={o.paymentStatus} />
                      </button>
                    </td>
                    <td className="p-3 text-gray-600 hidden md:table-cell">
                      {o.latestNote ? (
                        <span className="flex items-center gap-1"><FiMessageSquare size={12} className="text-gray-400 shrink-0" /> {o.latestNote}{o.notesCount > 1 && <span className="text-gray-400"> (+{o.notesCount - 1})</span>}</span>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
                {report.orders.length === 0 && (
                  <tr><td colSpan={7} className="p-8 text-center text-gray-400">
                    <FiFileText className="mx-auto mb-2" size={28} />
                    No orders for this period
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <PaymentStatusModal sale={paymentModalSale} isOpen={!!paymentModalSale} onClose={() => setPaymentModalSale(null)}
        onUpdated={() => loadReport()} />
    </div>
  );
}
