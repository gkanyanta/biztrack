import { useState, useEffect } from 'react';
import { getDeliveryActivity } from '../services/api';
import { formatDateTime } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import toast from 'react-hot-toast';
import { FiUser, FiPackage, FiTruck, FiShoppingBag, FiRefreshCw, FiAlertCircle } from 'react-icons/fi';

// What people have actually been doing to orders. The warehouse assigns runs, marks orders
// packed and records counter sales, and until actions were attributed none of that left a trace
// anybody could read — "who dispatched this" simply had no answer.

const KIND = {
  assigned: { icon: FiTruck, tone: 'bg-slate-100 text-slate-700' },
  packed: { icon: FiPackage, tone: 'bg-purple-100 text-purple-700' },
  'counter-sale': { icon: FiShoppingBag, tone: 'bg-blue-100 text-blue-700' },
  status: { icon: FiRefreshCw, tone: 'bg-gray-100 text-gray-600' },
};

const ROLE_LABEL = { admin: 'admin', superadmin: 'admin', inventory: 'warehouse', consultant: 'consultant', rider: 'rider', purchasing: 'purchasing' };

export default function DispatchActivity() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState('7');
  const [who, setWho] = useState('');

  useEffect(() => {
    getDeliveryActivity({ days, userId: who || undefined })
      .then(res => setData(res.data))
      .catch(() => toast.error('Could not load activity'))
      .finally(() => setLoading(false));
  }, [days, who]);

  if (loading) return <LoadingSpinner />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2">
          <select value={who} onChange={e => { setWho(e.target.value); setLoading(true); }}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none">
            <option value="">Everyone</option>
            {data.people.map(p => (
              <option key={p.id} value={p.id}>
                {p.name || p.username} — {ROLE_LABEL[p.role] || p.role} ({p.actions})
              </option>
            ))}
          </select>
          <select value={days} onChange={e => { setDays(e.target.value); setLoading(true); }}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none">
            <option value="1">Today</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </div>
        <p className="text-xs text-gray-400">{data.events.length} {data.events.length === 1 ? 'action' : 'actions'}</p>
      </div>

      {data.unattributed > 0 && (
        <p className="text-xs text-gray-500 flex items-start gap-1.5">
          <FiAlertCircle size={12} className="mt-0.5 shrink-0" />
          {data.unattributed} of these carry no name. Actions were only attributed from 1 October,
          and the storefront has no user behind it, so older entries genuinely have nobody to show.
        </p>
      )}

      {data.events.length === 0 ? (
        <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
          <FiUser className="mx-auto mb-2 text-gray-300" size={30} />
          <p className="text-gray-500 text-sm">Nothing recorded in this window.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {data.events.map((e, i) => {
            const k = KIND[e.kind] || KIND.status;
            const Icon = k.icon;
            return (
              <div key={`${e.at}-${i}`} className="flex items-start gap-3 p-3.5">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${k.tone}`}>
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-800">
                    <span className="font-medium">{e.who ? (e.who.name || e.who.username) : 'Someone'}</span>
                    {e.who && <span className="text-xs text-gray-400 ml-1.5">{ROLE_LABEL[e.who.role] || e.who.role}</span>}
                  </div>
                  <div className="text-sm text-gray-600">
                    {e.summary}
                    {e.orderNumber && <span className="text-gray-400"> · {e.orderNumber}</span>}
                    {e.customerName && <span className="text-gray-400"> · {e.customerName}</span>}
                  </div>
                  {e.detail && <div className="text-xs text-gray-400">{e.detail}</div>}
                  <div className="text-xs text-gray-400">{formatDateTime(e.at)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
