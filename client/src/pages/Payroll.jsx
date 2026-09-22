import { useState, useEffect } from 'react';
import {
  getPayrollSummary, createStaffMember, updateStaffMember, deleteStaffMember,
  getStaffPayments, payStaffMember, deleteStaffPayment,
} from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import {
  FiUsers, FiPlus, FiDollarSign, FiTrash2, FiEdit2, FiAlertCircle, FiArrowRight,
} from 'react-icons/fi';
import { Link } from 'react-router-dom';

// Everyone the company pays, in one place. Salaried staff are managed here outright; the
// consultants are shown alongside so "who is owed what this cycle" is one number to read,
// with their detail left on the Consultants page where the commission workings live.

const PAY_TYPES = [
  { key: 'salary', label: 'Salary' },
  { key: 'allowance', label: 'Communication allowance' },
  { key: 'bonus', label: 'Bonus' },
  { key: 'advance', label: 'Advance' },
];

function Card({ label, value, sub, tone = 'slate' }) {
  const tones = { slate: 'text-slate-800', green: 'text-emerald-600', red: 'text-red-600', amber: 'text-amber-600' };
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${tones[tone]}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

// A balance is what is still owed. Negative means they have taken more than they have earned,
// which is the number worth noticing, so it gets the colour.
function Balance({ value }) {
  if (value === null || value === undefined) return <span className="text-gray-400">—</span>;
  const owedBack = value < 0;
  return (
    <span className={owedBack ? 'text-red-600 font-semibold' : value > 0 ? 'text-amber-600 font-semibold' : 'text-gray-400'}>
      {formatMoney(value)}
    </span>
  );
}

export default function Payroll() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [showStaffForm, setShowStaffForm] = useState(false);
  const [editingStaff, setEditingStaff] = useState(null);
  const emptyStaff = { name: '', phone: '', jobTitle: '', monthlySalary: '', monthlyAllowance: '100', startDate: '' };
  const [staffForm, setStaffForm] = useState(emptyStaff);

  const [payFor, setPayFor] = useState(null);
  const [payForm, setPayForm] = useState({ amount: '', type: 'salary', paymentMethod: '', reference: '', notes: '' });

  const [historyFor, setHistoryFor] = useState(null);
  const [history, setHistory] = useState([]);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const load = () => {
    setLoading(true);
    getPayrollSummary({ period: period || undefined })
      .then(res => setData(res.data))
      .catch(() => toast.error('Could not load payroll'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [period]);

  const openStaffForm = (s) => {
    if (s) {
      setEditingStaff(s);
      setStaffForm({
        name: s.name, phone: s.phone || '', jobTitle: s.jobTitle || '',
        monthlySalary: String(s.monthlySalary ?? ''), monthlyAllowance: String(s.monthlyAllowance ?? ''),
        startDate: s.startDate ? new Date(s.startDate).toISOString().slice(0, 10) : '',
      });
    } else {
      setEditingStaff(null);
      setStaffForm(emptyStaff);
    }
    setShowStaffForm(true);
  };

  const submitStaff = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (editingStaff) {
        await updateStaffMember(editingStaff.id, staffForm);
        toast.success('Updated');
      } else {
        await createStaffMember(staffForm);
        toast.success(`${staffForm.name} added to payroll`);
      }
      setShowStaffForm(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save');
    } finally { setSubmitting(false); }
  };

  const openPay = (person) => {
    setPayFor(person);
    // Default to settling exactly what is outstanding — the common case.
    setPayForm({
      amount: person.balance > 0 ? String(person.balance) : '',
      type: 'salary', paymentMethod: '', reference: '', notes: '',
    });
  };

  const submitPay = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await payStaffMember(payFor.id, { ...payForm, amount: parseFloat(payForm.amount), period: data?.period?.label });
      toast.success(
        payForm.type === 'advance'
          ? `Advance recorded — it nets off what ${payFor.name} is owed`
          : `Paid ${payFor.name}, and booked to Salaries & Wages`
      );
      setPayFor(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not record payment');
    } finally { setSubmitting(false); }
  };

  const openHistory = async (person) => {
    setHistoryFor(person);
    try { const res = await getStaffPayments(person.id); setHistory(res.data); }
    catch { setHistory([]); }
  };

  const removePayment = async (p) => {
    try {
      await deleteStaffPayment(p.id);
      toast.success('Payment removed, and its expense with it');
      const res = await getStaffPayments(historyFor.id);
      setHistory(res.data);
      load();
    } catch { toast.error('Could not remove'); }
  };

  const confirmRemoveStaff = async () => {
    try {
      const res = await deleteStaffMember(deleteConfirm.id);
      toast.success(res.data.message);
      setDeleteConfirm(null);
      load();
    } catch { toast.error('Could not remove'); }
  };

  if (loading) return <LoadingSpinner />;
  if (!data) return null;

  const { totals, salaried, commissioned } = data;
  const owedRows = [...salaried, ...commissioned].filter(p => p.activeInPeriod && p.balance > 0);

  // The cycle label is the month the period closes and is paid.
  const periodOptions = [];
  {
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      periodOptions.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><FiUsers size={20} /> Payroll</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Cycle {data.period.label} · {formatDate(data.period.from)} to {formatDate(data.period.to)} · paid on day {data.period.payDay}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={period} onChange={e => setPeriod(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none">
            <option value="">Current cycle</option>
            {periodOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={() => openStaffForm(null)}
            className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium flex items-center gap-1.5">
            <FiPlus size={15} /> Add staff
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label="On payroll this cycle" value={totals.headcount} />
        <Card label="Earned" value={formatMoney(totals.earned)} sub="salary + commission" />
        <Card label="Still owed" value={formatMoney(totals.balance)} tone={totals.balance > 0 ? 'amber' : 'green'} />
        <Card label="Out of the drawer" value={formatMoney(totals.cashOut)} sub="including advances" />
      </div>

      {totals.advancePaid > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 flex items-start gap-2">
          <FiAlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>
            {formatMoney(totals.advancePaid)} has gone out as advances this cycle. That money is already in
            people's pockets, so it is netted off what they are still owed below — it is not an extra cost.
          </span>
        </div>
      )}

      {/* ---- SALARIED ---- */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Salaried staff</h2>
        <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
          {salaried.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">
              Nobody on salary yet. Add the people who are paid a fixed wage — the inventory clerk, the rider.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left p-3 font-medium">Name</th>
                  <th className="text-right p-3 font-medium hidden sm:table-cell">Salary</th>
                  <th className="text-right p-3 font-medium">Earned</th>
                  <th className="text-right p-3 font-medium">Paid</th>
                  <th className="text-right p-3 font-medium hidden md:table-cell">Advance</th>
                  <th className="text-right p-3 font-medium hidden lg:table-cell">Allowance</th>
                  <th className="text-right p-3 font-medium">Owed</th>
                  <th className="text-right p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {salaried.map(s => (
                  <tr key={s.id} className={s.isActive ? '' : 'opacity-50'}>
                    <td className="p-3">
                      <div className="font-medium text-gray-800">{s.name}</div>
                      <div className="text-xs text-gray-400">
                        {s.jobTitle || 'Staff'}
                        {s.prorated && <span className="text-amber-600 ml-1">· part cycle</span>}
                        {!s.activeInPeriod && <span className="text-gray-400 ml-1">· not employed this cycle</span>}
                      </div>
                    </td>
                    <td className="p-3 text-right hidden sm:table-cell text-gray-500">{formatMoney(s.monthlySalary)}</td>
                    <td className="p-3 text-right">{formatMoney(s.earned)}</td>
                    <td className="p-3 text-right">{formatMoney(s.paid)}</td>
                    <td className="p-3 text-right hidden md:table-cell text-gray-500">{s.advancePaid > 0 ? formatMoney(s.advancePaid) : '—'}</td>
                    <td className="p-3 text-right hidden lg:table-cell text-gray-500">
                      {formatMoney(s.allowancePaid)}<span className="text-xs text-gray-400">/{formatMoney(s.allowanceCap)}</span>
                    </td>
                    <td className="p-3 text-right"><Balance value={s.balance} /></td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <button onClick={() => openPay(s)} disabled={!s.activeInPeriod}
                        className="px-2.5 py-1 bg-emerald-600 text-white rounded-lg text-xs font-medium disabled:opacity-40">Pay</button>
                      <button onClick={() => openHistory(s)} className="p-1.5 text-gray-400 hover:text-blue-600" title="Pay history"><FiDollarSign size={14} /></button>
                      <button onClick={() => openStaffForm(s)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEdit2 size={14} /></button>
                      <button onClick={() => setDeleteConfirm(s)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ---- COMMISSION ---- */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">Sales consultants</h2>
          <Link to="/consultants" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
            Commission detail <FiArrowRight size={12} />
          </Link>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
          {commissioned.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">No consultants.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left p-3 font-medium">Name</th>
                  <th className="text-right p-3 font-medium">Earned</th>
                  <th className="text-right p-3 font-medium">Paid</th>
                  <th className="text-right p-3 font-medium hidden md:table-cell">Advance</th>
                  <th className="text-right p-3 font-medium hidden lg:table-cell">Allowance</th>
                  <th className="text-right p-3 font-medium">Owed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {commissioned.map(c => (
                  <tr key={c.id} className={c.isActive ? '' : 'opacity-50'}>
                    <td className="p-3">
                      <div className="font-medium text-gray-800">{c.name}</div>
                      <div className="text-xs text-gray-400">{c.jobTitle}</div>
                    </td>
                    <td className="p-3 text-right">{formatMoney(c.earned)}</td>
                    <td className="p-3 text-right">{formatMoney(c.paid)}</td>
                    <td className="p-3 text-right hidden md:table-cell text-gray-500">{c.advancePaid > 0 ? formatMoney(c.advancePaid) : '—'}</td>
                    <td className="p-3 text-right hidden lg:table-cell text-gray-500">
                      {formatMoney(c.allowancePaid)}<span className="text-xs text-gray-400">/{formatMoney(c.allowanceCap)}</span>
                    </td>
                    <td className="p-3 text-right"><Balance value={c.balance} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {owedRows.length > 0 && (
        <p className="text-xs text-gray-400">
          {owedRows.length} {owedRows.length === 1 ? 'person is' : 'people are'} still owed for this cycle,
          totalling {formatMoney(owedRows.reduce((s, r) => s + r.balance, 0))}.
        </p>
      )}

      {/* ---- STAFF FORM ---- */}
      <Modal isOpen={showStaffForm} onClose={() => setShowStaffForm(false)} title={editingStaff ? `Edit ${editingStaff.name}` : 'Add staff member'}>
        <form onSubmit={submitStaff} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full name</label>
            <input required value={staffForm.name} onChange={e => setStaffForm({ ...staffForm, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Job title</label>
              <input value={staffForm.jobTitle} onChange={e => setStaffForm({ ...staffForm, jobTitle: e.target.value })}
                placeholder="e.g. Inventory control"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input value={staffForm.phone} onChange={e => setStaffForm({ ...staffForm, phone: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Monthly salary</label>
              <input type="number" min="0" step="0.01" value={staffForm.monthlySalary}
                onChange={e => setStaffForm({ ...staffForm, monthlySalary: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Communication allowance</label>
              <input type="number" min="0" step="0.01" value={staffForm.monthlyAllowance}
                onChange={e => setStaffForm({ ...staffForm, monthlyAllowance: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-gray-400 mt-1">Capped per cycle, prorated if they joined mid-cycle.</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start date</label>
            <input type="date" value={staffForm.startDate} onChange={e => setStaffForm({ ...staffForm, startDate: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            <p className="text-xs text-gray-400 mt-1">Used to prorate the first cycle's pay.</p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setShowStaffForm(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ---- PAY ---- */}
      <Modal isOpen={!!payFor} onClose={() => setPayFor(null)} title={payFor ? `Pay ${payFor.name}` : ''}>
        {payFor && (
          <form onSubmit={submitPay} className="space-y-3">
            <div className="bg-gray-50 rounded-lg p-3 text-sm grid grid-cols-2 gap-2">
              <div><span className="text-gray-500">Earned:</span> <span className="font-medium">{formatMoney(payFor.earned)}</span></div>
              <div><span className="text-gray-500">Already paid:</span> <span className="font-medium">{formatMoney(payFor.paid)}</span></div>
              {payFor.advancePaid > 0 && <div><span className="text-gray-500">Advanced:</span> <span className="font-medium">{formatMoney(payFor.advancePaid)}</span></div>}
              <div><span className="text-gray-500">Still owed:</span> <Balance value={payFor.balance} /></div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What is this?</label>
              <select value={payForm.type} onChange={e => setPayForm({ ...payForm, type: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                {PAY_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              {payForm.type === 'advance' ? (
                <p className="text-xs text-amber-600 mt-1">
                  An advance is a loan against pay not yet earned. It reduces what is owed, and is
                  deliberately not booked as an expense until the pay it anticipates is earned.
                </p>
              ) : (
                <p className="text-xs text-gray-400 mt-1">Recorded as a Salaries &amp; Wages expense, so it shows in net profit.</p>
              )}
              {payForm.type === 'allowance' && payFor.allowanceRemaining !== null && (
                <p className="text-xs text-gray-500 mt-1">{formatMoney(payFor.allowanceRemaining)} of this cycle's allowance is left.</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
              <input required type="number" min="0.01" step="0.01" value={payForm.amount}
                onChange={e => setPayForm({ ...payForm, amount: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                <input value={payForm.paymentMethod} onChange={e => setPayForm({ ...payForm, paymentMethod: e.target.value })}
                  placeholder="Cash, Mobile Money…"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
                <input value={payForm.reference} onChange={e => setPayForm({ ...payForm, reference: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <input value={payForm.notes} onChange={e => setPayForm({ ...payForm, notes: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setPayFor(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Recording…' : 'Record payment'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---- HISTORY ---- */}
      <Modal isOpen={!!historyFor} onClose={() => setHistoryFor(null)} title={historyFor ? `${historyFor.name} — pay history` : ''}>
        {history.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">Nothing paid yet.</p>
        ) : (
          <div className="divide-y divide-gray-50 max-h-96 overflow-y-auto">
            {history.map(p => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="text-sm text-gray-800">
                    {formatMoney(p.amount)}
                    <span className="text-xs text-gray-400 ml-2">{PAY_TYPES.find(t => t.key === p.type)?.label || p.type}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {formatDate(p.createdAt)}{p.paymentMethod ? ` · ${p.paymentMethod}` : ''}
                    {!p.expenseId && p.type === 'advance' && <span className="text-amber-600"> · not an expense yet</span>}
                  </div>
                </div>
                <button onClick={() => removePayment(p)} className="p-1.5 text-gray-400 hover:text-red-600 shrink-0"><FiTrash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmRemoveStaff}
        title="Remove from payroll"
        message={deleteConfirm ? `Remove ${deleteConfirm.name}? If they have been paid, the record is kept and simply marked inactive so the history survives.` : ''}
      />
    </div>
  );
}
