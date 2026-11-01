import { useState, useEffect } from 'react';
import { getCompanyZra, saveCompanyZra, initialiseCompanyZra } from '../services/api';
import toast from 'react-hot-toast';
import { FiFileText, FiZap } from 'react-icons/fi';
import { ZRA_TAX_CATEGORIES } from '../utils/zra';

// The superadmin's switch for one company's ZRA Smart Invoice, and where its invoices go.
// It cannot be switched on until everything is filled in and the device has been initialised.

const FIELDS = ['environment', 'vsdcUrl', 'tpin', 'branchId', 'deviceSerial', 'defaultTaxCategory', 'startDate', 'originCountry', 'deliveryClassCode', 'refundReasonCode', 'qtyUnitCode', 'pkgUnitCode'];
const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 bg-white';

function toForm(c) {
  const f = {};
  FIELDS.forEach(k => { f[k] = c[k] ?? ''; });
  f.startDate = c.startDate ? new Date(c.startDate).toLocaleDateString('en-CA', { timeZone: 'Africa/Lusaka' }) : '';
  return f;
}

export default function ZraCompanySettings({ companyId }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getCompanyZra(companyId).then(r => { setConfig(r.data); setForm(toForm(r.data)); }).catch(() => toast.error('Could not load the ZRA settings'));
  }, [companyId]);

  if (!config || !form) return null;

  const run = async (fn, done) => {
    if (busy) return;
    setBusy(true);
    try { const r = await fn(); setConfig(r.data); setForm(toForm(r.data)); if (done) toast.success(done); }
    catch (err) { toast.error(err.response?.data?.error || 'Something went wrong'); }
    finally { setBusy(false); }
  };
  const save = (e) => { e.preventDefault(); run(() => saveCompanyZra(companyId, form), 'Saved'); };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const field = (label, k, props = {}) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input value={form[k]} onChange={set(k)} className={inputClass} {...props} />
    </div>
  );
  const onlyInitialiseLeft = config.problems.length === 1 && config.problems[0] === 'initialising the device with ZRA';

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><FiFileText /> ZRA Smart Invoice</h4>
        <div className="flex items-center gap-2">
          {config.enabled && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${config.environment === 'production' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
              {config.environment === 'production' ? 'Live' : 'Sandbox'}
            </span>
          )}
          <button type="button" disabled={busy} onClick={() => run(() => saveCompanyZra(companyId, { enabled: !config.enabled }), config.enabled ? 'Switched off' : 'Switched on')}
            className={`text-sm px-3 py-1 rounded-lg disabled:opacity-50 ${config.enabled ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-green-600 text-white hover:bg-green-700'}`}>
            {config.enabled ? 'Switch off' : 'Switch on'}
          </button>
        </div>
      </div>

      {config.problems.length > 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded p-2 mb-3">Still needed before it can go on: {config.problems.join(', ')}.</p>
      )}

      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Environment</label>
            <select value={form.environment} onChange={set('environment')} className={inputClass}>
              <option value="sandbox">Sandbox (testing)</option>
              <option value="production">Production (live)</option>
            </select>
          </div>
          {field('TPIN', 'tpin', { inputMode: 'numeric', maxLength: 10, placeholder: '10 digits' })}
          {field('Branch ID', 'branchId', { inputMode: 'numeric', maxLength: 3 })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">{field('VSDC address', 'vsdcUrl', { placeholder: 'https://vsdc.example.com/zravsdc' })}</div>
          {field('Device serial number', 'deviceSerial')}
        </div>
        {config.allowedHosts.length === 0 && (
          <p className="text-xs text-gray-500">No VSDC host is approved yet. Add it to ZRA_ALLOWED_HOSTS in the server's environment.</p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Default tax category</label>
            <select value={form.defaultTaxCategory} onChange={set('defaultTaxCategory')} className={inputClass}>
              <option value="">Choose…</option>
              {ZRA_TAX_CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
            </select>
          </div>
          {field('Report sales from', 'startDate', { type: 'date' })}
          {field('Goods made in', 'originCountry', { maxLength: 2, placeholder: 'e.g. CN' })}
          {field('Credit note reason code', 'refundReasonCode')}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {field('Delivery classification code', 'deliveryClassCode')}
          {field('Quantity unit code', 'qtyUnitCode')}
          {field('Packaging unit code', 'pkgUnitCode')}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="submit" disabled={busy} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">Save</button>
          <button type="button" disabled={busy || !onlyInitialiseLeft && !config.initialisedAt} onClick={() => run(() => initialiseCompanyZra(companyId), 'The VSDC answered: device initialised')}
            title="Save first, then initialise. This is also the connection test."
            className="px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 flex items-center gap-1">
            <FiZap size={13} /> {config.initialisedAt ? 'Test connection again' : 'Initialise device'}
          </button>
        </div>
      </form>
    </div>
  );
}
