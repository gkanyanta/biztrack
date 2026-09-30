import { useState, useEffect } from 'react';
import { getProducts, getConsultantNames, createSale } from '../services/api';
import { formatMoney } from '../utils/format';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiShoppingBag, FiX } from 'react-icons/fi';

// A walk-in comes to the house, buys, and carries the goods away. That is a collection, not a
// delivery that happens to be instant — so it creates no run for anybody and is complete the
// moment it is recorded. The one thing the system cannot work out for itself is whose customer
// it was, which decides who earns the commission.

function PickProduct({ products, onPick }) {
  const [query, setQuery] = useState('');
  const matches = query.trim()
    ? products.filter(p => `${p.name} ${p.sku}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];
  return (
    <div>
      <div className="relative">
        <input value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search a product to add"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
        {query && (
          <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400">
            <FiX size={15} />
          </button>
        )}
      </div>
      {matches.length > 0 && (
        <div className="mt-1 border border-gray-200 rounded-lg divide-y divide-gray-50 max-h-52 overflow-y-auto">
          {matches.map(p => (
            <button key={p.id} type="button" onClick={() => { onPick(p); setQuery(''); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex justify-between gap-2">
              <span className="truncate">{p.name} <span className="text-gray-400">({p.sku})</span></span>
              <span className={`shrink-0 text-xs ${p.stock > 0 ? 'text-gray-500' : 'text-red-600'}`}>{p.stock} left</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CounterSale({ onRecorded }) {
  const [open, setOpen] = useState(false);
  const [products, setProducts] = useState([]);
  const [consultants, setConsultants] = useState([]);
  const [items, setItems] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const empty = { customerName: '', customerPhone: '', consultantId: '', paymentMethod: 'Cash' };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    getProducts().then(res => setProducts(res.data)).catch(() => {});
    getConsultantNames().then(res => setConsultants(res.data)).catch(() => setConsultants([]));
  }, []);

  const add = (p) => {
    if (items.some(i => i.productId === p.id)) return toast.error('Already on this sale');
    setItems([...items, { productId: p.id, name: p.name, qty: 1, unitPrice: parseFloat(p.sellingPrice), stock: p.stock }]);
  };
  const setItem = (idx, field, value) => setItems(items.map((it, n) => (n === idx ? { ...it, [field]: value } : it)));
  const total = items.reduce((s, i) => s + (parseFloat(i.unitPrice) || 0) * (parseInt(i.qty, 10) || 0), 0);

  const reset = () => { setItems([]); setForm(empty); setOpen(false); };

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!items.length) return toast.error('Add at least one product');
    if (items.some(i => !(parseInt(i.qty, 10) > 0))) return toast.error('Every line needs a quantity');
    setSubmitting(true);
    try {
      await createSale({
        customerName: form.customerName || null,
        customerPhone: form.customerPhone || null,
        consultantId: form.consultantId || null,
        paymentMethod: form.paymentMethod,
        paymentType: 'Cash',
        paymentStatus: 'Paid',
        source: 'Walk-in',
        // Carried away from the counter, so it is finished and belongs to no run.
        fulfilment: 'collection',
        status: 'Delivered',
        items: items.map(i => ({ productId: i.productId, qty: parseInt(i.qty, 10), unitPrice: parseFloat(i.unitPrice) })),
      });
      toast.success(`Counter sale recorded${form.consultantId ? ` for ${consultants.find(c => c.id === form.consultantId)?.name}` : ''}`);
      reset();
      onRecorded?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not record the sale');
    } finally { setSubmitting(false); }
  };

  if (!open) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2"><FiShoppingBag size={15} /> Counter sale</h2>
        <p className="text-xs text-gray-400 mb-3">
          Someone came to the house and bought something. Records it as collected — no rider, no delivery.
        </p>
        <button onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          <FiPlus size={15} /> Record a counter sale
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><FiShoppingBag size={15} /> Counter sale</h2>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Customer name</label>
            <input value={form.customerName} onChange={e => setForm({ ...form, customerName: e.target.value })}
              placeholder="Leave blank for a walk-in"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
            <input value={form.customerPhone} onChange={e => setForm({ ...form, customerPhone: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Whose customer is this?</label>
          <select value={form.consultantId} onChange={e => setForm({ ...form, consultantId: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">The business (no commission)</option>
            {consultants.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            Pick the consultant whose customer walked in — the commission follows this. Leave it on
            the business for a customer who is nobody's in particular.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">What did they buy?</label>
          <PickProduct products={products} onPick={add} />
        </div>

        {items.length > 0 && (
          <div className="border border-gray-200 rounded-lg divide-y divide-gray-50">
            {items.map((i, idx) => (
              <div key={i.productId} className="flex items-center gap-2 p-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800 truncate">{i.name}</div>
                  {parseInt(i.qty, 10) > i.stock && (
                    <div className="text-xs text-red-600">only {i.stock} in stock</div>
                  )}
                </div>
                <input type="number" min="1" value={i.qty} onChange={e => setItem(idx, 'qty', e.target.value)}
                  className="w-16 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-center outline-none" />
                <input type="number" min="0" step="0.01" value={i.unitPrice} onChange={e => setItem(idx, 'unitPrice', e.target.value)}
                  className="w-24 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right outline-none" />
                <button type="button" onClick={() => setItems(items.filter((_, n) => n !== idx))}
                  className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={15} /></button>
              </div>
            ))}
            <div className="flex justify-between items-baseline p-2.5 bg-gray-50">
              <span className="text-sm text-gray-600">Total</span>
              <span className="text-base font-bold text-gray-800">{formatMoney(total)}</span>
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Paid by</label>
          <select value={form.paymentMethod} onChange={e => setForm({ ...form, paymentMethod: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
            <option>Cash</option>
            <option>Mobile Money</option>
            <option>Bank Transfer</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">Recorded as paid in full — they have the goods.</p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={reset} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
          <button type="submit" disabled={submitting || !items.length}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {submitting ? 'Recording…' : `Record ${formatMoney(total)}`}
          </button>
        </div>
      </form>
    </div>
  );
}
