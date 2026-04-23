import { useState, useEffect } from 'react';
import { getTargets, createTarget, updateTarget, deleteTarget } from '../services/api';
import { formatMoney } from '../utils/format';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2 } from 'react-icons/fi';

const toDateInput = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';
const formatDate = (d) => d ? new Date(d).toLocaleDateString() : '';

const PRESETS = [
  { label: 'This month', build: () => {
      const n = new Date();
      return { start: new Date(n.getFullYear(), n.getMonth(), 1), end: new Date(n.getFullYear(), n.getMonth() + 1, 0) };
    } },
  { label: 'Next month', build: () => {
      const n = new Date();
      return { start: new Date(n.getFullYear(), n.getMonth() + 1, 1), end: new Date(n.getFullYear(), n.getMonth() + 2, 0) };
    } },
  { label: 'This quarter', build: () => {
      const n = new Date();
      const q = Math.floor(n.getMonth() / 3);
      return { start: new Date(n.getFullYear(), q * 3, 1), end: new Date(n.getFullYear(), q * 3 + 3, 0) };
    } },
  { label: 'This year', build: () => {
      const n = new Date();
      return { start: new Date(n.getFullYear(), 0, 1), end: new Date(n.getFullYear(), 11, 31) };
    } },
];

const emptyForm = { label: '', periodStart: '', periodEnd: '', revenueTarget: '', savingsRatePercent: '25' };

export default function Targets() {
  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const load = () => {
    setLoading(true);
    getTargets().then(res => setTargets(res.data)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditing(null); setForm(emptyForm); setShowForm(true); };
  const openEdit = (t) => {
    setEditing(t);
    setForm({
      label: t.label || '',
      periodStart: toDateInput(t.periodStart),
      periodEnd: toDateInput(t.periodEnd),
      revenueTarget: t.revenueTarget,
      savingsRatePercent: String(Math.round(parseFloat(t.savingsRate) * 10000) / 100),
    });
    setShowForm(true);
  };

  const applyPreset = (preset) => {
    const { start, end } = preset.build();
    setForm(f => ({ ...f, periodStart: toDateInput(start), periodEnd: toDateInput(end), label: f.label || preset.label }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const savingsRate = parseFloat(form.savingsRatePercent) / 100;
      const data = {
        label: form.label || null,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        revenueTarget: parseFloat(form.revenueTarget),
        savingsRate,
      };
      if (editing) {
        await updateTarget(editing.id, data);
        toast.success('Target updated');
      } else {
        await createTarget(data);
        toast.success('Target created');
      }
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error');
    }
  };

  const handleDelete = async () => {
    try {
      await deleteTarget(deleteConfirm.id);
      toast.success('Target deleted');
      setDeleteConfirm(null);
      load();
    } catch { toast.error('Error'); }
  };

  const now = new Date();
  const isActive = (t) => new Date(t.periodStart) <= now && new Date(t.periodEnd) >= now;

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-1">Sales Targets</h3>
        <p className="text-xs text-gray-500">Set a revenue goal and savings rate for any period. The dashboard shows the most-specific target containing today's date.</p>
      </div>

      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-gray-700">All Targets</h3>
        <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <FiPlus size={16} /> Add Target
        </button>
      </div>

      {loading ? <LoadingSpinner /> : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left p-3 font-medium text-gray-600">Label</th>
                <th className="text-left p-3 font-medium text-gray-600">Period</th>
                <th className="text-right p-3 font-medium text-gray-600">Revenue Target</th>
                <th className="text-right p-3 font-medium text-gray-600">Savings %</th>
                <th className="text-center p-3 font-medium text-gray-600">Status</th>
                <th className="text-right p-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {targets.map(t => (
                <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="p-3 font-medium text-gray-800">{t.label || '—'}</td>
                  <td className="p-3 text-gray-600">{formatDate(t.periodStart)} → {formatDate(t.periodEnd)}</td>
                  <td className="p-3 text-right font-medium text-gray-800">{formatMoney(t.revenueTarget)}</td>
                  <td className="p-3 text-right text-gray-800">{(parseFloat(t.savingsRate) * 100).toFixed(1)}%</td>
                  <td className="p-3 text-center">
                    {isActive(t) ? <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">Active</span>
                      : new Date(t.periodEnd) < now ? <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600">Past</span>
                      : <span className="px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-700">Upcoming</span>}
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => openEdit(t)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEdit2 size={15} /></button>
                      <button onClick={() => setDeleteConfirm(t)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {targets.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-gray-500">No targets defined. The dashboard will use 3× last month as a fallback.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Target' : 'Add Target'} size="sm">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
            <input type="text" placeholder="e.g. Q2 2026" value={form.label} onChange={e => setForm({...form, label: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <div className="flex gap-1.5 flex-wrap mb-2">
              {PRESETS.map(p => (
                <button type="button" key={p.label} onClick={() => applyPreset(p)} className="px-2 py-1 text-xs border border-gray-200 rounded-md hover:bg-gray-50 text-gray-600">{p.label}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Start *</label>
                <input type="date" required value={form.periodStart} onChange={e => setForm({...form, periodStart: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">End *</label>
                <input type="date" required value={form.periodEnd} onChange={e => setForm({...form, periodEnd: e.target.value})}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Revenue Target *</label>
            <input type="number" step="0.01" min="0" required value={form.revenueTarget} onChange={e => setForm({...form, revenueTarget: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Savings Rate (%)</label>
            <input type="number" step="0.1" min="0" max="100" value={form.savingsRatePercent} onChange={e => setForm({...form, savingsRatePercent: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            <p className="text-xs text-gray-500 mt-1">Portion of gross profit to set aside during this period.</p>
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">{editing ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} onConfirm={handleDelete}
        title="Delete Target" message={`Delete target "${deleteConfirm?.label || formatDate(deleteConfirm?.periodStart)}"?`} />
    </div>
  );
}
