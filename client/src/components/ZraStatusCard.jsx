import { useState, useEffect } from 'react';
import { getZraStatus, retryZra, retryZraDocument } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import toast from 'react-hot-toast';
import { FiFileText, FiRefreshCw } from 'react-icons/fi';

// The company's view of ZRA Smart Invoice: is it on, and has anything not reached ZRA. Shows
// nothing at all for a company that has never had it.
export default function ZraStatusCard() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { getZraStatus().then(r => setStatus(r.data)).catch(() => {}); }, []);
  if (!status) return null;
  const { counts } = status;
  if (!status.enabled && !counts.pending && !counts.failed && !counts.issued) return null;

  const retry = async (fn) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      setStatus(r.data);
      const left = r.data.counts.pending + r.data.counts.failed;
      toast[left ? 'error' : 'success'](left ? `${left} still not through. See the reasons below.` : 'Everything has reached ZRA');
    } catch (err) { toast.error(err.response?.data?.error || 'Could not retry'); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><FiFileText size={16} /> ZRA Smart Invoice</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full ${!status.enabled ? 'bg-gray-100 text-gray-600' : status.environment === 'production' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
          {!status.enabled ? 'Off' : status.environment === 'production' ? 'On, live' : 'On, sandbox (test invoices)'}
        </span>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Each sale is reported to ZRA when it is confirmed, and a cancelled one is reversed with a credit note.
        {status.defaultTaxCategory === 'TOT' && ' Sales are reported as turnover tax, so no tax is added to the customer\'s price.'}
        {' '}Switching it on or off is done by the BizTrack administrator.
      </p>

      {status.setupProblems.length > 0 && (
        <p className="text-sm text-red-700 bg-red-50 rounded p-2 mb-3">The set-up is incomplete: {status.setupProblems.join(', ')}. Ask the BizTrack administrator.</p>
      )}
      {status.unmappedProducts > 0 && (
        <p className="text-sm text-amber-700 bg-amber-50 rounded p-2 mb-3">
          {status.unmappedProducts} active product{status.unmappedProducts === 1 ? ' has' : 's have'} no ZRA classification code. A sale of one cannot be reported until it is added on the product.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3 mb-4 text-center">
        <div className="rounded-lg bg-green-50 p-2"><p className="text-lg font-semibold text-green-700">{counts.issued}</p><p className="text-xs text-green-700">Issued</p></div>
        <div className="rounded-lg bg-amber-50 p-2"><p className="text-lg font-semibold text-amber-700">{counts.pending}</p><p className="text-xs text-amber-700">Waiting</p></div>
        <div className="rounded-lg bg-red-50 p-2"><p className="text-lg font-semibold text-red-700">{counts.failed}</p><p className="text-xs text-red-700">Need fixing</p></div>
      </div>

      {status.attention.length > 0 && (
        <div className="space-y-2 mb-3">
          {status.attention.map(d => (
            <div key={d.id} className="flex items-start justify-between gap-3 border border-gray-100 rounded-lg p-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-gray-800">
                  {d.sale.orderNumber}{d.kind === 'credit_note' ? ' (credit note)' : ''} · {d.sale.customerName || 'Customer'} · {formatMoney(d.sale.totalPrice)}
                </p>
                <p className="text-xs text-gray-400">{formatDate(d.sale.date)} · tried {d.attempts} time{d.attempts === 1 ? '' : 's'}</p>
                {d.lastError && <p className={`text-xs mt-1 ${d.status === 'failed' ? 'text-red-600' : 'text-amber-700'}`}>{d.lastError}</p>}
              </div>
              <button disabled={busy || !status.enabled} onClick={() => retry(() => retryZraDocument(d.id))} className="text-xs text-blue-600 hover:underline disabled:opacity-40 whitespace-nowrap">Try again</button>
            </div>
          ))}
        </div>
      )}
      {(counts.pending > 0 || counts.failed > 0) && (
        <button disabled={busy || !status.enabled} onClick={() => retry(retryZra)} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
          <FiRefreshCw size={14} className={busy ? 'animate-spin' : ''} /> {busy ? 'Sending…' : 'Send everything waiting'}
        </button>
      )}
    </div>
  );
}
