import { useState, useEffect } from 'react';
import { getShippingRates, createShippingRate, updateShippingRate, deleteShippingRate } from '../services/api';
import { formatMoney, calcMargin, calcSuggestedPrice } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2 } from 'react-icons/fi';

export default function Shipping() {
  const [rates, setRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [form, setForm] = useState({ city: '', region: '', rate: '' });

  // Pricing calculator state
  const [calcMode, setCalcMode] = useState('margin'); // margin or price
  const [calcCost, setCalcCost] = useState('');
  const [calcMarginVal, setCalcMarginVal] = useState('');
  const [calcPrice, setCalcPrice] = useState('');

  const loadRates = () => {
    setLoading(true);
    getShippingRates().then(res => setRates(res.data)).finally(() => setLoading(false));
  };

  useEffect(() => { loadRates(); }, []);

  const openCreate = () => { setEditing(null); setForm({ city: '', region: '', rate: '' }); setShowForm(true); };
  const openEdit = (r) => { setEditing(r); setForm({ city: r.city, region: r.region || '', rate: r.rate }); setShowForm(true); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const data = { ...form, rate: parseFloat(form.rate) };
      if (editing) {
        await updateShippingRate(editing.id, data);
        toast.success('Rate updated');
      } else {
        await createShippingRate(data);
        toast.success('Rate added');
      }
      setShowForm(false);
      loadRates();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error');
    }
  };

  const handleDelete = async () => {
    try {
      await deleteShippingRate(deleteConfirm.id);
      toast.success('Rate deleted');
      setDeleteConfirm(null);
      loadRates();
    } catch { toast.error('Error'); }
  };

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      {/* Pricing Calculator */}
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Pricing Calculator</h3>
        <div className="flex gap-4 mb-4">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={calcMode === 'margin'} onChange={() => setCalcMode('margin')} />
            Calculate selling price
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={calcMode === 'price'} onChange={() => setCalcMode('price')} />
            Calculate margin
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Cost Price</label>
            <input type="number" step="0.01" value={calcCost} onChange={e => setCalcCost(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {calcMode === 'margin' ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Desired Margin %</label>
                <input type="number" step="0.1" value={calcMarginVal} onChange={e => setCalcMarginVal(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Suggested Price</label>
                <div className="border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 text-sm font-medium text-gray-800">
                  {calcCost && calcMarginVal ? formatMoney(calcSuggestedPrice(calcCost, calcMarginVal)) : '-'}
                </div>
                {calcCost && calcMarginVal && (
                  <p className="text-xs text-gray-500 mt-1">
                    Profit per unit: {formatMoney(calcSuggestedPrice(calcCost, calcMarginVal) - parseFloat(calcCost))}
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Selling Price</label>
                <input type="number" step="0.01" value={calcPrice} onChange={e => setCalcPrice(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Result</label>
                <div className="border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 text-sm font-medium text-gray-800">
                  {calcCost && calcPrice ? (
                    <>
                      Margin: {calcMargin(calcCost, calcPrice).toFixed(1)}% | Profit: {formatMoney(parseFloat(calcPrice) - parseFloat(calcCost))}
                    </>
                  ) : '-'}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Shipping Rates */}
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-gray-700">Shipping Rates by City</h3>
        <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <FiPlus size={16} /> Add Rate
        </button>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">City</th>
                <th className="text-left p-3 font-medium text-gray-600">Region</th>
                <th className="text-right p-3 font-medium text-gray-600">Rate</th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rates.map(r => (
                <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="p-3 font-medium text-gray-800">{r.city}</td>
                  <td className="p-3 text-gray-600">{r.region || '-'}</td>
                  <td className="p-3 text-right font-medium text-gray-800">{formatMoney(r.rate)}</td>
                  <td className="p-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => openEdit(r)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEdit2 size={15} /></button>
                      <button onClick={() => setDeleteConfirm(r)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {rates.length === 0 && (
                <tr><td colSpan={4} className="p-8 text-center text-gray-500">No shipping rates defined</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Rate' : 'Add Rate'} size="sm">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">City *</label>
            <input type="text" required value={form.city} onChange={e => setForm({...form, city: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
            <input type="text" value={form.region} onChange={e => setForm({...form, region: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Rate (ZMW) *</label>
            <input type="number" step="0.01" required value={form.rate} onChange={e => setForm({...form, rate: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">{editing ? 'Update' : 'Add'}</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} onConfirm={handleDelete}
        title="Delete Rate" message={`Delete shipping rate for "${deleteConfirm?.city}"?`} />
    </div>
  );
}
