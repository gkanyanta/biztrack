import { useState } from 'react';
import { getSales, getSale } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import OrderTimeline from './OrderTimeline';
import toast from 'react-hot-toast';
import { FiSearch, FiChevronDown, FiChevronUp, FiTruck } from 'react-icons/fi';

// "Where is that order?" asked from the warehouse. Once an order is packed it leaves the prepare
// queue, and until now there was nowhere for her to look — the answer lived on a page her role
// cannot open. Deliberately narrow: find an order, see where it is and who has it. No prices
// beyond the order total, no profit, no editing.

const STATE = {
  Pending: 'bg-yellow-100 text-yellow-700',
  Confirmed: 'bg-blue-100 text-blue-700',
  Shipped: 'bg-purple-100 text-purple-700',
  Delivered: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-700',
};

const WHERE = {
  Assigned: 'with the rider',
  PickedUp: 'on the road',
  Delivered: 'dropped off',
  Failed: 'came back',
};

export default function OrderTracker() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(null);
  const [searching, setSearching] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);

  const search = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setOpenId(null);
    try {
      const res = await getSales({ search: query.trim(), page: 1, pageSize: 20 });
      setRows(Array.isArray(res.data) ? res.data : res.data.data);
    } catch {
      toast.error('Could not search orders');
    } finally { setSearching(false); }
  };

  const toggle = async (o) => {
    if (openId === o.id) return setOpenId(null);
    setOpenId(o.id);
    setDetail(null);
    try {
      const res = await getSale(o.id);
      setDetail(res.data);
    } catch {
      toast.error('Could not load that order');
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2"><FiTruck size={15} /> Where is an order?</h2>
      <p className="text-xs text-gray-400 mb-3">
        Look up any order by number or customer to see where it has got to and who has it.
      </p>
      <form onSubmit={search} className="flex gap-2">
        <div className="relative flex-1">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Order number or customer name"
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <button type="submit" disabled={searching || !query.trim()}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
          {searching ? 'Looking…' : 'Find'}
        </button>
      </form>

      {rows !== null && (
        rows.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">Nothing matched "{query}".</p>
        ) : (
          <div className="mt-3 border border-gray-100 rounded-lg divide-y divide-gray-50">
            {rows.map(o => (
              <div key={o.id}>
                <button onClick={() => toggle(o)} className="w-full text-left p-3 hover:bg-gray-50 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800">
                      {o.orderNumber}
                      <span className="text-xs text-gray-400 font-normal ml-2">{formatDate(o.date)}</span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {o.customerName || 'Walk-in'}
                      {o.customerCity ? ` · ${o.customerCity}` : ''}
                      {' · '}{formatMoney(o.totalPrice)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATE[o.status] || 'bg-gray-100 text-gray-600'}`}>
                      {o.status}
                    </span>
                    {o.delivery && (
                      <span className="text-[10px] text-gray-500">
                        {o.delivery.rider?.name ? `${o.delivery.rider.name}, ` : ''}{WHERE[o.delivery.status] || o.delivery.status}
                      </span>
                    )}
                    {openId === o.id ? <FiChevronUp size={15} className="text-gray-400" /> : <FiChevronDown size={15} className="text-gray-400" />}
                  </div>
                </button>
                {openId === o.id && (
                  <div className="px-3 pb-4 pt-1 bg-gray-50">
                    {!detail ? (
                      <p className="text-xs text-gray-400 py-2">Loading…</p>
                    ) : (
                      <>
                        <div className="text-xs text-gray-600 mb-3">
                          {(detail.items || []).map(i => `${i.qty > 1 ? i.qty + '× ' : ''}${i.product?.name || 'Item'}`).join(', ')}
                          {detail.deliveryAddress && <div className="text-gray-500 mt-0.5">{detail.deliveryAddress}{detail.customerCity ? `, ${detail.customerCity}` : ''}</div>}
                        </div>
                        <OrderTimeline statusHistory={detail.statusHistory} delivery={detail.delivery}
                          fulfilment={detail.fulfilment} />
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
