import { useState, useEffect } from 'react';
import { getQuotes, getQuote, createQuote, updateQuote, updateQuoteStatus, convertQuoteToSale, deleteQuote, getProducts, getConsultants } from '../services/api';
import { formatMoney, formatDate, QUOTE_STATUSES, QUOTE_STATUS_COLORS } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import Pagination from '../components/Pagination';
import SortableHeader from '../components/SortableHeader';
import QuoteButton from '../components/QuoteButton';
import useServerTable from '../hooks/useServerTable';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiFileText, FiEye, FiX, FiCheckCircle, FiArrowRight } from 'react-icons/fi';
import { useAuth } from '../hooks/useAuth';

function QuoteStatusBadge({ quote }) {
  const isExpired = quote.expiresAt && new Date(quote.expiresAt) < new Date() && quote.status === 'Sent';
  const label = isExpired ? 'Expired' : quote.status;
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${QUOTE_STATUS_COLORS[label] || 'bg-gray-100 text-gray-800'}`}>
      {label}
    </span>
  );
}

export default function Quotes() {
  const { user } = useAuth();
  const isConsultant = user?.role === 'consultant';
  const [quotes, setQuotes] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [products, setProducts] = useState([]);
  const [consultants, setConsultants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [showDetail, setShowDetail] = useState(null);
  const [productSearch, setProductSearch] = useState('');
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [converting, setConverting] = useState(false);

  const [quoteItems, setQuoteItems] = useState([]);
  const emptyForm = {
    customerName: '', customerPhone: '', customerCity: '',
    shippingCharge: '0', discount: '0', notes: '', date: '', expiresAt: '', consultantId: '',
  };
  const [form, setForm] = useState(emptyForm);

  const quotesTable = useServerTable({ pageSize: 25 });

  const loadQuotes = () => {
    setLoading(true);
    getQuotes({ search: search || undefined, status: statusFilter || undefined, ...quotesTable.params })
      .then(res => { setQuotes(res.data.data); setTotal(res.data.total); setTotalPages(res.data.totalPages); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadQuotes(); }, [search, statusFilter, quotesTable.page, quotesTable.pageSize, quotesTable.sort]);
  useEffect(() => { quotesTable.setPage(1); }, [search, statusFilter]);
  useEffect(() => {
    getProducts().then(res => setProducts(res.data.filter(p => p.isActive)));
    if (!isConsultant) getConsultants({ active: 'true' }).then(res => setConsultants(res.data)).catch(() => {});
  }, [isConsultant]);

  const addProduct = (product) => {
    const existing = quoteItems.find(i => i.productId === product.id);
    if (existing) {
      setQuoteItems(quoteItems.map(i => i.productId === product.id ? { ...i, qty: i.qty + 1 } : i));
    } else {
      setQuoteItems([...quoteItems, { productId: product.id, name: product.name, sku: product.sku, qty: 1, unitPrice: parseFloat(product.sellingPrice) }]);
    }
    setShowProductPicker(false);
    setProductSearch('');
  };

  const updateItem = (idx, field, value) => {
    setQuoteItems(quoteItems.map((item, i) => {
      if (i !== idx) return item;
      if (field === 'qty') return { ...item, qty: parseInt(value) || 1 };
      return { ...item, [field]: parseFloat(value) || 0 };
    }));
  };

  const removeItem = (idx) => setQuoteItems(quoteItems.filter((_, i) => i !== idx));

  const openNew = () => {
    setEditing(null);
    setQuoteItems([]);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (quote) => {
    setEditing(quote);
    setQuoteItems((quote.items || []).map(i => ({
      productId: i.productId, name: i.product?.name || 'Product', sku: i.product?.sku || '', qty: i.qty, unitPrice: parseFloat(i.unitPrice),
    })));
    setForm({
      customerName: quote.customerName || '', customerPhone: quote.customerPhone || '', customerCity: quote.customerCity || '',
      shippingCharge: quote.shippingCharge, discount: quote.discount, notes: quote.notes || '',
      date: quote.date ? quote.date.slice(0, 10) : '', expiresAt: quote.expiresAt ? quote.expiresAt.slice(0, 10) : '',
      consultantId: quote.consultantId || '',
    });
    setShowForm(true);
  };

  const itemsTotal = quoteItems.reduce((sum, i) => sum + (i.qty * i.unitPrice), 0);
  const grandTotal = itemsTotal + (parseFloat(form.shippingCharge) || 0) - (parseFloat(form.discount) || 0);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!quoteItems.length) { toast.error('Add at least one product'); return; }
    setSubmitting(true);
    try {
      const data = {
        ...form,
        items: quoteItems.map(i => ({ productId: i.productId, qty: i.qty, unitPrice: i.unitPrice })),
        shippingCharge: parseFloat(form.shippingCharge) || 0,
        discount: parseFloat(form.discount) || 0,
        consultantId: form.consultantId || null,
      };
      if (data.date) data.date = new Date(data.date).toISOString();
      if (data.expiresAt) data.expiresAt = new Date(data.expiresAt).toISOString();
      if (editing) {
        await updateQuote(editing.id, data);
        toast.success('Quote updated');
      } else {
        await createQuote(data);
        toast.success('Quote created');
      }
      setShowForm(false);
      setQuoteItems([]);
      loadQuotes();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error saving quote');
    } finally {
      setSubmitting(false);
    }
  };

  const openDetail = async (quote) => {
    try { const { data } = await getQuote(quote.id); setShowDetail(data); }
    catch { setShowDetail(quote); }
  };

  const handleStatusChange = async (quote, status) => {
    try {
      const { data } = await updateQuoteStatus(quote.id, status);
      toast.success(`Marked as ${status}`);
      setShowDetail(data);
      loadQuotes();
    } catch (err) { toast.error(err.response?.data?.error || 'Error updating status'); }
  };

  const handleConvert = async (quote) => {
    if (converting) return;
    setConverting(true);
    try {
      const { data: sale } = await convertQuoteToSale(quote.id);
      toast.success(`Converted to order ${sale.orderNumber}`);
      setShowDetail(null);
      loadQuotes();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error converting quote');
    } finally {
      setConverting(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteQuote(deleteConfirm.id);
      toast.success('Quote deleted');
      setDeleteConfirm(null);
      loadQuotes();
    } catch (err) { toast.error(err.response?.data?.error || 'Error deleting quote'); }
  };

  const itemsSummary = (q) => {
    if (!q.items?.length) return '-';
    if (q.items.length === 1) return `${q.items[0].product?.name || 'Product'} x${q.items[0].qty}`;
    return `${q.items.length} items`;
  };

  const filteredProducts = products.filter(p =>
    !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase()) || p.sku.toLowerCase().includes(productSearch.toLowerCase())
  );

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Quotes</h1>
          <p className="text-sm text-gray-500">Price quotations for customers — convert to a real order once accepted.</p>
        </div>
        <button onClick={openNew} className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <FiPlus size={14} /> New Quote
        </button>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <div className="relative flex-1 sm:flex-none">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input type="text" placeholder="Search quotes..." value={search} onChange={e => setSearch(e.target.value)}
            className="pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm w-full sm:w-56 outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm outline-none">
          <option value="">All Status</option>
          {QUOTE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          <option value="Converted">Converted</option>
        </select>
      </div>

      {loading ? <LoadingSpinner /> : (
        <>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3"><SortableHeader label="Quote #" sortKey="quoteNumber" sort={quotesTable.sort} onToggle={quotesTable.toggleSort} /></th>
                <th className="text-left p-3"><SortableHeader label="Date" sortKey="date" sort={quotesTable.sort} onToggle={quotesTable.toggleSort} /></th>
                <th className="text-left p-3 font-medium text-gray-600">Customer</th>
                <th className="text-left p-3 font-medium text-gray-600 hidden md:table-cell">Items</th>
                {!isConsultant && <th className="text-left p-3 font-medium text-gray-600 hidden lg:table-cell">Consultant</th>}
                <th className="text-right p-3"><SortableHeader label="Total" sortKey="totalPrice" sort={quotesTable.sort} onToggle={quotesTable.toggleSort} align="right" /></th>
                <th className="text-left p-3 font-medium text-gray-600">Status</th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map(q => (
                <tr key={q.id} className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer" onClick={() => openDetail(q)}>
                  <td className="p-3 font-medium text-gray-800">{q.quoteNumber}</td>
                  <td className="p-3 text-gray-600">{formatDate(q.date)}</td>
                  <td className="p-3 text-gray-700">{q.customerName || q.customer?.name || '-'}</td>
                  <td className="p-3 text-gray-600 hidden md:table-cell">{itemsSummary(q)}</td>
                  {!isConsultant && <td className="p-3 text-gray-600 hidden lg:table-cell">{q.consultant?.name || '-'}</td>}
                  <td className="p-3 text-right font-medium text-gray-800">{formatMoney(q.totalPrice)}</td>
                  <td className="p-3"><QuoteStatusBadge quote={q} /></td>
                  <td className="p-3 text-right" onClick={e => e.stopPropagation()}>
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => openDetail(q)} className="p-1.5 text-gray-400 hover:text-blue-600" title="View"><FiEye size={15} /></button>
                      <QuoteButton quoteId={q.id} className="p-1.5 hover:text-blue-800" size={15} />
                      {q.status !== 'Converted' && (
                        <button onClick={() => openEdit(q)} className="p-1.5 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={15} /></button>
                      )}
                      {!isConsultant && q.status !== 'Converted' && (
                        <button onClick={() => setDeleteConfirm(q)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={15} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {quotes.length === 0 && (
                <tr><td colSpan={isConsultant ? 7 : 8} className="p-8 text-center text-gray-400">
                  <FiFileText className="mx-auto mb-2" size={28} />
                  No quotes yet
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={quotesTable.page} totalPages={totalPages} total={total} pageSize={quotesTable.pageSize}
          onPageChange={quotesTable.setPage} onPageSizeChange={quotesTable.setPageSize} />
        </>
      )}

      {/* Create/Edit Modal */}
      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editing ? `Edit ${editing.quoteNumber}` : 'New Quote'} size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Items *</label>
              <button type="button" onClick={() => setShowProductPicker(true)}
                className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
                <FiPlus size={14} /> Add Product
              </button>
            </div>
            {quoteItems.length === 0 ? (
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center text-gray-400 text-sm">
                Click "Add Product" to build the quote
              </div>
            ) : (
              <div className="space-y-2">
                {quoteItems.map((item, idx) => (
                  <div key={idx} className="bg-gray-50 rounded-lg p-2 border border-gray-200 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-800 text-sm truncate">{item.name}</div>
                      <div className="text-xs text-gray-400">{item.sku}</div>
                    </div>
                    <input type="number" min="1" value={item.qty} onChange={e => updateItem(idx, 'qty', e.target.value)}
                      className="w-16 border border-gray-300 rounded px-2 py-1 text-sm text-center outline-none focus:ring-1 focus:ring-blue-500" />
                    <span className="text-gray-400 text-xs">x</span>
                    <input type="number" step="0.01" value={item.unitPrice} onChange={e => updateItem(idx, 'unitPrice', e.target.value)}
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right outline-none focus:ring-1 focus:ring-blue-500" />
                    <span className="text-sm font-medium text-gray-700 w-24 text-right">{formatMoney(item.qty * item.unitPrice)}</span>
                    <button type="button" onClick={() => removeItem(idx)} className="p-1 text-red-400 hover:text-red-600"><FiX size={16} /></button>
                  </div>
                ))}
                <div className="flex justify-end text-sm font-semibold text-gray-800 pr-10">
                  Subtotal: {formatMoney(itemsTotal)}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer Name</label>
              <input type="text" value={form.customerName} onChange={e => setForm({ ...form, customerName: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input type="text" value={form.customerPhone} onChange={e => setForm({ ...form, customerPhone: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input type="text" value={form.customerCity} onChange={e => setForm({ ...form, customerCity: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
              <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Valid Until</label>
              <input type="date" value={form.expiresAt} onChange={e => setForm({ ...form, expiresAt: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-gray-400 mt-1">Defaults to 7 days from today if left blank</p>
            </div>
            {!isConsultant && consultants.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Prepared By (Consultant)</label>
                <select value={form.consultantId} onChange={e => setForm({ ...form, consultantId: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">None</option>
                  {consultants.filter(c => !c.isStockLocation).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Shipping Charge</label>
              <input type="number" step="0.01" value={form.shippingCharge} onChange={e => setForm({ ...form, shippingCharge: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Discount</label>
              <input type="number" step="0.01" value={form.discount} onChange={e => setForm({ ...form, discount: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          <div className="flex justify-end text-lg font-bold text-gray-800 pr-1">
            Total: {formatMoney(grandTotal)}
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {submitting ? 'Saving...' : editing ? 'Update Quote' : 'Create Quote'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Product Picker */}
      <Modal isOpen={showProductPicker} onClose={() => setShowProductPicker(false)} title="Add Product">
        <div className="space-y-3">
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input type="text" placeholder="Search..." autoFocus
              onChange={e => setProductSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filteredProducts.map(p => (
              <button key={p.id} onClick={() => addProduct(p)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-blue-50 text-left text-sm">
                <div>
                  <div className="font-medium text-gray-800">{p.name}</div>
                  <div className="text-xs text-gray-400">{p.sku}</div>
                </div>
                <span className="font-semibold text-blue-600">{formatMoney(p.sellingPrice)}</span>
              </button>
            ))}
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal isOpen={!!showDetail} onClose={() => setShowDetail(null)} title={showDetail ? `Quote ${showDetail.quoteNumber}` : ''} size="lg">
        {showDetail && (
          <div className="space-y-4 text-sm">
            <div className="flex items-center justify-between">
              <QuoteStatusBadge quote={showDetail} />
              <QuoteButton quoteId={showDetail.id} className="text-sm" />
            </div>

            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Items</h4>
              <div className="space-y-1">
                {(showDetail.items || []).map((item, i) => (
                  <div key={i} className="flex justify-between items-center bg-gray-50 rounded-lg px-3 py-2">
                    <div>
                      <span className="font-medium text-gray-800">{item.product?.name || 'Product'}</span>
                      <span className="text-gray-400 ml-2">x{item.qty} @ {formatMoney(item.unitPrice)}</span>
                    </div>
                    <span className="font-medium">{formatMoney(item.totalPrice)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Customer</div>
                <div className="font-medium">{showDetail.customerName || showDetail.customer?.name || '-'}</div>
                {showDetail.customerPhone && <div className="text-xs text-gray-500">{showDetail.customerPhone}</div>}
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Valid Until</div>
                <div className="font-medium">{showDetail.expiresAt ? formatDate(showDetail.expiresAt) : '-'}</div>
              </div>
            </div>

            {showDetail.notes && (
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Notes</div>
                <div className="text-gray-700">{showDetail.notes}</div>
              </div>
            )}

            <div className="flex justify-end text-lg font-bold text-gray-800 border-t border-gray-100 pt-3">
              Total: {formatMoney(showDetail.totalPrice)}
            </div>

            {showDetail.status === 'Converted' ? (
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-purple-700 text-sm flex items-center gap-2">
                <FiCheckCircle /> Converted to a sale order.
              </div>
            ) : (
              <div className="space-y-2 pt-2 border-t border-gray-100">
                <div className="flex gap-2 flex-wrap">
                  {QUOTE_STATUSES.filter(s => s !== showDetail.status).map(s => (
                    <button key={s} onClick={() => handleStatusChange(showDetail, s)}
                      className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50">
                      Mark {s}
                    </button>
                  ))}
                </div>
                <button onClick={() => handleConvert(showDetail)} disabled={converting}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed">
                  {converting ? 'Converting...' : <>Convert to Sale <FiArrowRight size={14} /></>}
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} onConfirm={handleDelete}
        title="Delete Quote" message={`Delete quote ${deleteConfirm?.quoteNumber}? This cannot be undone.`} />
    </div>
  );
}
