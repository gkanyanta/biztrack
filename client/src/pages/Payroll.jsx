import { useState, useEffect } from 'react';
import {
  getPayRun, finalisePayRun, reopenPayRun, payPayslip, deletePayslipPayment,
  createPayAdjustment, deletePayAdjustment, releasePayAdjustment,
  getLoans, createLoan, updateLoan, deleteLoan, setLoanInstalment,
  getStaffMembers, createStaffMember, updateStaffMember, deleteStaffMember,
  getStaffPayments, payStaffMember, deleteStaffPayment, getRiders,
} from '../services/api';
import { formatMoney, formatDate, PAYMENT_METHODS } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import {
  FiUsers, FiPlus, FiDollarSign, FiTrash2, FiEdit2, FiAlertCircle, FiArrowRight, FiLock, FiUnlock, FiX,
} from 'react-icons/fi';
import { Link } from 'react-router-dom';

// One pay run per cycle. Until it is finalised the run is a live draft: commission, salary,
// loan instalments and anything added by hand, laid out as a payslip per person. Finalising
// writes it down, after which each payslip is paid here and whatever is left over moves to the
// next cycle's payslip. Commission workings stay on the Consultants page.

// Paid outside a payslip, during the cycle. Salary itself is paid from the payslip.
const DIRECT_PAY_TYPES = [
  { key: 'allowance', label: 'Communication allowance' },
  { key: 'bonus', label: 'Bonus' },
  { key: 'advance', label: 'Advance (comes off the next payslip)' },
];
const PAY_TYPE_LABEL = { salary: 'Salary', allowance: 'Communication allowance', bonus: 'Bonus', advance: 'Advance' };

const RECOVERY_BASES = [
  { key: 'returned', label: 'Goods came back unpaid: charge the delivery cost', refundable: false },
  { key: 'lost', label: 'Goods lost: charge the full order and delivery', refundable: true },
  { key: 'held', label: 'Hold until it is settled', refundable: true },
];

const EARNING_KINDS = ['salary', 'commission', 'arrears', 'bonus', 'refund'];
const PAID_KINDS = ['prepaid', 'advance'];
const DEDUCTION_KINDS = ['recovery', 'deduction', 'loan'];

const shiftLabel = (label, by) => {
  const [y, m] = label.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500';

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

function Row({ label, amount, strong, tone, children }) {
  const colour = tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-emerald-600' : 'text-gray-800';
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 text-sm ${strong ? 'font-semibold border-t border-gray-100 mt-1 pt-2' : ''}`}>
      <span className="text-gray-600 min-w-0 flex items-center gap-1.5">{label}{children}</span>
      <span className={`shrink-0 ${colour}`}>{formatMoney(amount)}</span>
    </div>
  );
}

export default function Payroll() {
  const [loading, setLoading] = useState(true);
  const [run, setRun] = useState(null);
  const [loans, setLoans] = useState([]);
  const [staff, setStaff] = useState([]);
  const [period, setPeriod] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const [showStaffForm, setShowStaffForm] = useState(false);
  const [editingStaff, setEditingStaff] = useState(null);
  const [riders, setRiders] = useState([]);
  const emptyStaff = { name: '', phone: '', jobTitle: '', monthlySalary: '', monthlyAllowance: '100', startDate: '', riderId: '' };
  const [staffForm, setStaffForm] = useState(emptyStaff);

  const [directFor, setDirectFor] = useState(null);
  const [directForm, setDirectForm] = useState({ amount: '', type: 'allowance', paymentMethod: '', reference: '', notes: '' });
  const [historyFor, setHistoryFor] = useState(null);
  const [history, setHistory] = useState([]);

  const [payFor, setPayFor] = useState(null);
  const [payForm, setPayForm] = useState({ amount: '', paymentMethod: '', reference: '', notes: '' });
  const [adjustFor, setAdjustFor] = useState(null);
  const [adjustForm, setAdjustForm] = useState({ kind: 'bonus', amount: '', reason: '', saleId: '', basis: 'returned', refundable: false });
  const [loanForm, setLoanForm] = useState(null);
  const [instalmentFor, setInstalmentFor] = useState(null);
  const [instalmentAmount, setInstalmentAmount] = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([getPayRun({ period: period || undefined }), getLoans(), getStaffMembers()])
      .then(([r, l, s]) => { setRun(r.data); setLoans(l.data); setStaff(s.data); })
      .catch(() => toast.error('Could not load payroll'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [period]);
  // Linking a staff record to a rider profile is what lets the delivery finances read the wage
  // actually being paid rather than the fallback figure in Settings.
  useEffect(() => { getRiders().then(res => setRiders(res.data)).catch(() => setRiders([])); }, []);

  // Every write goes through here so no button can fire twice while its request is in flight.
  const act = async (fn, done) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await fn();
      if (done) toast.success(done);
      load();
      return true;
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save');
      return false;
    } finally { setSubmitting(false); }
  };

  const openStaffForm = (s) => {
    if (s) {
      setEditingStaff(s);
      setStaffForm({
        name: s.name, phone: s.phone || '', jobTitle: s.jobTitle || '',
        monthlySalary: String(s.monthlySalary ?? ''), monthlyAllowance: String(s.monthlyAllowance ?? ''),
        startDate: s.startDate ? new Date(s.startDate).toISOString().slice(0, 10) : '',
        riderId: s.riderId || '',
      });
    } else {
      setEditingStaff(null);
      setStaffForm(emptyStaff);
    }
    setShowStaffForm(true);
  };

  const submitStaff = async (e) => {
    e.preventDefault();
    const ok = await act(
      () => (editingStaff ? updateStaffMember(editingStaff.id, staffForm) : createStaffMember(staffForm)),
      editingStaff ? 'Updated' : `${staffForm.name} added to payroll`,
    );
    if (ok) setShowStaffForm(false);
  };

  const submitDirect = async (e) => {
    e.preventDefault();
    const ok = await act(
      () => payStaffMember(directFor.id, { ...directForm, amount: parseFloat(directForm.amount), period: run.currentPeriod }),
      directForm.type === 'advance' ? `Advance recorded. It comes off ${directFor.name}'s next payslip.` : `Paid ${directFor.name}, and booked to Salaries & Wages`,
    );
    if (ok) setDirectFor(null);
  };

  const openHistory = async (person) => {
    setHistoryFor(person);
    try { const res = await getStaffPayments(person.id); setHistory(res.data); }
    catch { setHistory([]); }
  };

  const removeDirectPayment = async (p) => {
    const ok = await act(() => deleteStaffPayment(p.id), 'Payment removed');
    if (ok) { const res = await getStaffPayments(historyFor.id); setHistory(res.data); }
  };

  const openPay = (slip) => {
    setPayFor(slip);
    setPayForm({ amount: String(slip.outstanding), paymentMethod: '', reference: '', notes: '' });
  };

  const submitPay = async (e) => {
    e.preventDefault();
    const ok = await act(() => payPayslip(payFor.id, { ...payForm, amount: parseFloat(payForm.amount) }), `Paid ${payFor.name}`);
    if (ok) setPayFor(null);
  };

  const openAdjust = (slip, kind, order) => {
    setAdjustFor(slip);
    setAdjustForm({
      kind, basis: 'returned', saleId: order ? order.saleId : '',
      amount: order ? String(order.deliveryCharge || '') : '',
      reason: order ? 'Delivery cost, goods returned unpaid' : '',
      refundable: false,
    });
  };

  // Choosing the order or the reason for a recovery fills in what that normally costs. The
  // amount stays editable, because the admin has the last word.
  const setRecovery = (changes) => {
    const next = { ...adjustForm, ...changes };
    const order = adjustFor.unpaidOrders.find(o => o.saleId === next.saleId);
    const basis = RECOVERY_BASES.find(b => b.key === next.basis);
    next.refundable = basis.refundable;
    if (next.basis === 'returned') { next.amount = order ? String(order.deliveryCharge || '') : next.amount; next.reason = 'Delivery cost, goods returned unpaid'; }
    if (next.basis === 'lost') { next.amount = order ? String(order.lostCharge) : next.amount; next.reason = 'Order not paid and goods not recovered'; }
    if (next.basis === 'held') { next.amount = order ? String(order.balance) : next.amount; next.reason = order ? 'Held until the order is paid' : 'Held until settled'; }
    setAdjustForm(next);
  };

  const submitAdjust = async (e) => {
    e.preventDefault();
    const ok = await act(() => createPayAdjustment({
      personKind: adjustFor.kind, personId: adjustFor.personId, period: run.period.label,
      kind: adjustForm.kind, amount: parseFloat(adjustForm.amount), reason: adjustForm.reason,
      saleId: adjustForm.kind === 'recovery' && adjustForm.saleId ? adjustForm.saleId : undefined,
      refundable: adjustForm.kind === 'recovery' && adjustForm.refundable,
    }), 'Added to the payslip');
    if (ok) setAdjustFor(null);
  };

  const submitLoan = async (e) => {
    e.preventDefault();
    const { id, person, terms, instalments, instalmentAmount: perCycle, ...rest } = loanForm;
    const [personKind, personId] = (person || '').split(':');
    const payload = id
      ? { description: rest.description, principal: rest.principal, instalmentAmount: perCycle, firstPeriod: rest.firstPeriod, notes: rest.notes }
      : { ...rest, personKind, personId, ...(terms === 'count' ? { instalments } : { instalmentAmount: perCycle }) };
    const ok = await act(() => (id ? updateLoan(id, payload) : createLoan(payload)), id ? 'Loan updated' : 'Loan recorded. Repayments will come off each pay run.');
    if (ok) setLoanForm(null);
  };

  const submitInstalment = async (amount) => {
    const ok = await act(
      () => setLoanInstalment(instalmentFor.id, { period: run.period.label, amount }),
      amount === null ? 'Back to the agreed instalment' : 'Instalment changed for this cycle',
    );
    if (ok) setInstalmentFor(null);
  };

  if (loading && !run) return <LoadingSpinner />;
  if (!run) return null;

  const { totals, payslips } = run;
  const isDraft = run.status === 'draft';
  const openPeriod = isDraft ? run.period.label : run.currentPeriod;

  // The cycle label is the month the period closes and is paid.
  const periodOptions = [];
  for (let i = 0; i < 12; i++) periodOptions.push(shiftLabel(run.currentPeriod, -i));

  const people = [
    ...staff.filter(s => s.isActive).map(s => ({ key: `salaried:${s.id}`, name: s.name })),
    ...payslips.filter(p => p.kind === 'commission').map(p => ({ key: `commission:${p.personId}`, name: p.name })),
  ];
  const newLoan = () => setLoanForm({
    person: people[0]?.key || '', description: '', principal: '', terms: 'count', instalments: '2', instalmentAmount: '',
    firstPeriod: openPeriod, notes: '',
  });
  const editLoan = (l) => setLoanForm({
    id: l.id, name: l.name, description: l.description, principal: String(l.principal), instalmentAmount: String(l.instalmentAmount),
    firstPeriod: l.firstPeriod, notes: l.notes || '', started: l.repaid > 0,
  });

  const renderSlip = (slip) => {
    const shown = slip.lines.filter(l => l.kind !== 'baseline');
    const earnings = shown.filter(l => EARNING_KINDS.includes(l.kind));
    const paidAlready = shown.filter(l => PAID_KINDS.includes(l.kind));
    const deductions = shown.filter(l => DEDUCTION_KINDS.includes(l.kind));
    const removable = (l) => isDraft && l.adjustmentId && l.kind !== 'refund';
    const staffRecord = slip.kind === 'salaried' ? staff.find(s => s.id === slip.personId) : null;

    return (
      <div key={`${slip.kind}:${slip.personId}`} className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="font-semibold text-gray-800">{slip.name}</div>
            <div className="text-xs text-gray-400">{slip.jobTitle}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-gray-500">{slip.netPay < 0 ? 'Owes the company' : 'Net pay'}</div>
            <div className={`text-xl font-bold ${slip.netPay < 0 ? 'text-red-600' : 'text-slate-800'}`}>{formatMoney(Math.abs(slip.netPay))}</div>
          </div>
        </div>

        <div className="mt-3">
          {slip.broughtForward !== 0 && (
            <Row label={slip.broughtForward > 0 ? 'Brought forward: unpaid from last cycle' : 'Brought forward: owed back from last cycle'}
              amount={slip.broughtForward} tone={slip.broughtForward < 0 ? 'red' : undefined} />
          )}
          {earnings.map((l, i) => (
            <Row key={`e${i}`} label={l.label} amount={l.amount} tone={l.amount < 0 ? 'red' : undefined}>
              {removable(l) && <button onClick={() => act(() => deletePayAdjustment(l.adjustmentId), 'Removed')} className="text-gray-300 hover:text-red-600"><FiX size={13} /></button>}
            </Row>
          ))}
          {paidAlready.map((l, i) => <Row key={`p${i}`} label={l.label} amount={l.amount} />)}
          {deductions.map((l, i) => (
            <Row key={`d${i}`} label={l.label} amount={l.amount} tone="red">
              {l.refundable && <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">held</span>}
              {removable(l) && <button onClick={() => act(() => deletePayAdjustment(l.adjustmentId), 'Removed')} className="text-gray-300 hover:text-red-600"><FiX size={13} /></button>}
            </Row>
          ))}
          <Row label="Net pay" amount={slip.netPay} strong tone={slip.netPay < 0 ? 'red' : undefined} />
          {!isDraft && (
            <>
              {slip.payments.map(p => (
                <Row key={p.id} label={`Paid ${formatDate(p.createdAt)}${p.paymentMethod ? ` · ${p.paymentMethod}` : ''}`} amount={-p.amount}>
                  {!slip.carried && <button onClick={() => act(() => deletePayslipPayment(slip.id, p.id), 'Payment removed')} className="text-gray-300 hover:text-red-600"><FiX size={13} /></button>}
                </Row>
              ))}
              <Row label={slip.carried ? 'Carried into the next payslip' : slip.outstanding < 0 ? 'Owed back, carries to the next cycle' : 'Still to pay'}
                amount={slip.outstanding} strong tone={slip.outstanding < 0 ? 'red' : slip.outstanding > 0 && !slip.carried ? undefined : 'green'} />
            </>
          )}
        </div>

        {isDraft && slip.loans.map(l => (
          <div key={l.id} className="mt-2 text-xs text-gray-500 flex items-center justify-between gap-2 bg-gray-50 rounded-lg px-3 py-2">
            <span>
              {l.description}: {formatMoney(l.outstandingAfter)} left after this cycle
              {l.edited && <span className="text-amber-600"> · changed from the agreed {formatMoney(l.scheduled)}</span>}
              {l.shortBy > 0 && <span className="text-amber-600"> · {formatMoney(l.shortBy)} short of the instalment, the pay does not cover it</span>}
            </span>
            <button onClick={() => { setInstalmentFor(l); setInstalmentAmount(String(l.taking)); }} className="text-blue-600 hover:underline shrink-0">Change</button>
          </div>
        ))}

        {slip.held.length > 0 && (
          <div className="mt-2 text-xs bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 space-y-1">
            <div className="text-amber-800 font-medium">Held, to be given back</div>
            {slip.held.map(h => (
              <div key={h.id} className="flex items-center justify-between gap-2 text-amber-800">
                <span>{h.label} · {formatMoney(h.amount)}</span>
                <button disabled={submitting} onClick={() => act(() => releasePayAdjustment(h.id, openPeriod), `Released. It is refunded on the ${openPeriod} payslip.`)}
                  className="text-blue-600 hover:underline shrink-0">Give back</button>
              </div>
            ))}
          </div>
        )}

        {isDraft && slip.unpaidOrders.length > 0 && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-gray-500">{slip.unpaidOrders.length} unpaid {slip.unpaidOrders.length === 1 ? 'order' : 'orders'}, earning commission only on what is paid</summary>
            <div className="mt-1 divide-y divide-gray-50">
              {slip.unpaidOrders.map(o => (
                <div key={o.saleId} className="flex items-center justify-between gap-2 py-1.5 text-gray-600">
                  <span>{o.orderNumber} · {formatDate(o.date)} · {o.customerName || 'No name'} · {formatMoney(o.balance)} unpaid of {formatMoney(o.total)}</span>
                  {o.recovered
                    ? <span className="text-gray-400 shrink-0">recovery recorded</span>
                    : <button onClick={() => openAdjust(slip, 'recovery', o)} className="text-blue-600 hover:underline shrink-0">Recover</button>}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {isDraft ? (
            <>
              <button onClick={() => openAdjust(slip, 'bonus')} className="px-2.5 py-1 border border-gray-200 rounded-lg text-xs">+ Bonus</button>
              <button onClick={() => openAdjust(slip, 'deduction')} className="px-2.5 py-1 border border-gray-200 rounded-lg text-xs">+ Deduction</button>
              <button onClick={() => openAdjust(slip, 'recovery')} className="px-2.5 py-1 border border-gray-200 rounded-lg text-xs">+ Recovery</button>
            </>
          ) : (
            slip.outstanding > 0 && !slip.carried && (
              <button onClick={() => openPay(slip)} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium">Pay {formatMoney(slip.outstanding)}</button>
            )
          )}
          {staffRecord && (
            <button onClick={() => { setDirectFor(staffRecord); setDirectForm({ amount: '', type: 'allowance', paymentMethod: '', reference: '', notes: '' }); }}
              className="px-2.5 py-1 border border-gray-200 rounded-lg text-xs">Allowance or advance</button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><FiUsers size={20} /> Payroll</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Cycle {run.period.label} · {run.period.name} · paid on day {run.period.payDay} ·{' '}
            {isDraft
              ? <span className="text-amber-600 font-medium">Draft</span>
              : <span className="text-emerald-600 font-medium">Finalised {formatDate(run.finalisedAt)}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={period} onChange={e => setPeriod(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none">
            <option value="">Cycle to pay next</option>
            {periodOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={newLoan} className="px-3 py-2 border border-gray-200 rounded-lg text-sm flex items-center gap-1.5"><FiPlus size={15} /> Loan</button>
          <button onClick={() => openStaffForm(null)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm flex items-center gap-1.5"><FiPlus size={15} /> Staff</button>
          {run.canFinalise && (
            <button onClick={() => setConfirm({
              title: 'Finalise this cycle',
              message: `Finalise ${run.period.name}? The payslips are written down as they stand, ${formatMoney(totals.netPay)} net in all, and money that comes in later for these orders is paid on the next cycle.`,
              go: () => act(() => finalisePayRun(run.period.label), 'Cycle finalised. Pay each payslip below.'),
            })} className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium flex items-center gap-1.5"><FiLock size={14} /> Finalise cycle</button>
          )}
          {run.canReopen && (
            <button onClick={() => setConfirm({
              title: 'Reopen this cycle',
              message: 'Reopen this cycle? Its payslips go back to a live draft and are worked out again from today\'s figures.',
              go: () => act(() => reopenPayRun(run.period.label), 'Cycle reopened'),
            })} className="px-3 py-2 border border-gray-200 rounded-lg text-sm flex items-center gap-1.5"><FiUnlock size={14} /> Reopen</button>
          )}
        </div>
      </div>

      {isDraft && run.blockedReason && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 flex items-start gap-2">
          <FiAlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{run.blockedReason} The figures below are the position as of today.</span>
        </div>
      )}
      {isDraft && run.firstRun && run.canFinalise && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800 flex items-start gap-2">
          <FiAlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>
            This will be the first pay run. Everything before this cycle is treated as settled, so only money collected
            from now on for older orders is paid as late commission. Record anything still owed from before as a loan or a deduction first.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label="Earnings" value={formatMoney(totals.earnings)} sub={`${totals.headcount} on this run`} />
        <Card label="Deductions" value={formatMoney(totals.deductions)} sub={totals.alreadyPaid > 0 ? `plus ${formatMoney(totals.alreadyPaid)} paid during the cycle` : 'loans and recoveries'} />
        <Card label="Net pay" value={formatMoney(totals.netPay)} sub={totals.broughtForward !== 0 ? `includes ${formatMoney(totals.broughtForward)} brought forward` : undefined} />
        {isDraft
          ? <Card label="Status" value="Draft" sub="nothing is paid from a draft" tone="amber" />
          : <Card label="Still to pay" value={formatMoney(totals.outstanding)} sub={`${formatMoney(totals.paid)} paid`} tone={totals.outstanding > 0 ? 'amber' : 'green'} />}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">Payslips</h2>
          <Link to="/consultants" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
            Commission detail <FiArrowRight size={12} />
          </Link>
        </div>
        {payslips.length === 0
          ? <p className="bg-white rounded-xl border border-gray-100 p-6 text-center text-sm text-gray-500">Nobody is on this pay run.</p>
          : <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">{payslips.map(renderSlip)}</div>}
      </div>

      {/* ---- LOANS ---- */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Loans</h2>
        <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
          {loans.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">No loans. Record one when someone borrows from the company or takes goods on credit, with how it is to be repaid.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left p-3 font-medium">Who and what</th>
                  <th className="text-right p-3 font-medium">Loan</th>
                  <th className="text-right p-3 font-medium hidden sm:table-cell">Repaid</th>
                  <th className="text-right p-3 font-medium">Left</th>
                  <th className="text-right p-3 font-medium hidden md:table-cell">Per cycle</th>
                  <th className="text-right p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loans.map(l => (
                  <tr key={l.id} className={l.outstanding > 0 ? '' : 'opacity-50'}>
                    <td className="p-3">
                      <div className="font-medium text-gray-800">{l.name} · {l.description}</div>
                      <div className="text-xs text-gray-400">
                        {l.status === 'cancelled' ? `Cancelled, ${formatMoney(l.writtenOff)} written off`
                          : l.outstanding <= 0 ? 'Repaid in full'
                          : `From the ${l.firstPeriod} cycle · ${l.instalmentsLeft} ${l.instalmentsLeft === 1 ? 'instalment' : 'instalments'} left`}
                      </div>
                    </td>
                    <td className="p-3 text-right">{formatMoney(l.principal)}</td>
                    <td className="p-3 text-right hidden sm:table-cell text-gray-500">{formatMoney(l.repaid)}</td>
                    <td className="p-3 text-right font-semibold">{formatMoney(l.outstanding)}</td>
                    <td className="p-3 text-right hidden md:table-cell text-gray-500">{formatMoney(l.instalmentAmount)}</td>
                    <td className="p-3 text-right whitespace-nowrap">
                      {l.status === 'active' && l.outstanding > 0 && (
                        <button onClick={() => editLoan(l)} className="p-1.5 text-gray-400 hover:text-blue-600" title="Change the terms"><FiEdit2 size={14} /></button>
                      )}
                      {l.repaid === 0 ? (
                        <button onClick={() => setConfirm({ title: 'Remove loan', message: `Remove the ${l.description} loan for ${l.name}? Nothing has been repaid on it.`, go: () => act(() => deleteLoan(l.id), 'Loan removed') })}
                          className="p-1.5 text-gray-400 hover:text-red-600" title="Remove"><FiTrash2 size={14} /></button>
                      ) : l.status === 'active' && l.outstanding > 0 && (
                        <button onClick={() => setConfirm({ title: 'Write off the rest', message: `Stop deducting the ${l.description} loan and write off the ${formatMoney(l.outstanding)} ${l.name} still owes?`, go: () => act(() => updateLoan(l.id, { status: 'cancelled' }), 'Loan cancelled') })}
                          className="p-1.5 text-gray-400 hover:text-red-600" title="Write off the rest"><FiTrash2 size={14} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ---- STAFF RECORDS ---- */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Salaried staff</h2>
        <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
          {staff.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">
              Nobody on salary yet. Add the people who are paid a fixed wage — the inventory clerk, the rider.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left p-3 font-medium">Name</th>
                  <th className="text-right p-3 font-medium">Salary</th>
                  <th className="text-right p-3 font-medium hidden sm:table-cell">Allowance</th>
                  <th className="text-right p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {staff.map(s => (
                  <tr key={s.id} className={s.isActive ? '' : 'opacity-50'}>
                    <td className="p-3">
                      <div className="font-medium text-gray-800">{s.name}</div>
                      <div className="text-xs text-gray-400">{s.jobTitle || 'Staff'}{!s.isActive && ' · inactive'}</div>
                    </td>
                    <td className="p-3 text-right">{formatMoney(s.monthlySalary)}</td>
                    <td className="p-3 text-right hidden sm:table-cell text-gray-500">{formatMoney(s.monthlyAllowance)}</td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <button onClick={() => openHistory(s)} className="p-1.5 text-gray-400 hover:text-blue-600" title="Paid outside payslips"><FiDollarSign size={14} /></button>
                      <button onClick={() => openStaffForm(s)} className="p-1.5 text-gray-400 hover:text-blue-600"><FiEdit2 size={14} /></button>
                      <button onClick={() => setConfirm({
                        title: 'Remove from payroll',
                        message: `Remove ${s.name}? If they have been paid, the record is kept and simply marked inactive so the history survives.`,
                        go: () => act(async () => { const res = await deleteStaffMember(s.id); toast.success(res.data.message); }),
                      })} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

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
          {riders.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Also a rider?</label>
              <select value={staffForm.riderId} onChange={e => setStaffForm({ ...staffForm, riderId: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Not a rider</option>
                {riders.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                Links this pay record to their rider profile, so Shipping &rarr; Delivery finances costs
                the bike against the wage you actually pay.
              </p>
            </div>
          )}
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

      {/* ---- PAY A PAYSLIP ---- */}
      <Modal isOpen={!!payFor} onClose={() => setPayFor(null)} title={payFor ? `Pay ${payFor.name}` : ''}>
        {payFor && (
          <form onSubmit={submitPay} className="space-y-3">
            <div className="bg-gray-50 rounded-lg p-3 text-sm grid grid-cols-2 gap-2">
              <div><span className="text-gray-500">Net pay:</span> <span className="font-medium">{formatMoney(payFor.netPay)}</span></div>
              <div><span className="text-gray-500">Still to pay:</span> <span className="font-medium">{formatMoney(payFor.outstanding)}</span></div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount handed over</label>
              <input required type="number" min="0.01" step="0.01" max={payFor.outstanding} value={payForm.amount}
                onChange={e => setPayForm({ ...payForm, amount: e.target.value })} className={inputClass} />
              <p className="text-xs text-gray-400 mt-1">Pay less than the full amount and the rest is brought forward to the next cycle.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                <select value={payForm.paymentMethod} onChange={e => setPayForm({ ...payForm, paymentMethod: e.target.value })} className={inputClass}>
                  <option value="">Not recorded</option>
                  {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
                <input value={payForm.reference} onChange={e => setPayForm({ ...payForm, reference: e.target.value })} className={inputClass} />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <input value={payForm.notes} onChange={e => setPayForm({ ...payForm, notes: e.target.value })} className={inputClass} />
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

      {/* ---- BONUS, DEDUCTION, RECOVERY ---- */}
      <Modal isOpen={!!adjustFor} onClose={() => setAdjustFor(null)}
        title={adjustFor ? `${adjustForm.kind === 'bonus' ? 'Bonus for' : adjustForm.kind === 'recovery' ? 'Recover from' : 'Deduct from'} ${adjustFor.name}` : ''}>
        {adjustFor && (
          <form onSubmit={submitAdjust} className="space-y-3">
            {adjustForm.kind === 'recovery' && (
              <>
                {adjustFor.unpaidOrders.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Order</label>
                    <select value={adjustForm.saleId} onChange={e => setRecovery({ saleId: e.target.value })} className={inputClass}>
                      <option value="">Not tied to an order</option>
                      {adjustFor.unpaidOrders.map(o => (
                        <option key={o.saleId} value={o.saleId}>{o.orderNumber} · {o.customerName || 'No name'} · {formatMoney(o.balance)} unpaid</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">What happened</label>
                  <select value={adjustForm.basis} onChange={e => setRecovery({ basis: e.target.value })} className={inputClass}>
                    {RECOVERY_BASES.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
                  </select>
                </div>
              </>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
              <input required type="number" min="0.01" step="0.01" value={adjustForm.amount}
                onChange={e => setAdjustForm({ ...adjustForm, amount: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What it is for</label>
              <input required value={adjustForm.reason} onChange={e => setAdjustForm({ ...adjustForm, reason: e.target.value })}
                placeholder="Shown on the payslip" className={inputClass} />
            </div>
            {adjustForm.kind === 'recovery' && (
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input type="checkbox" className="mt-0.5" checked={adjustForm.refundable}
                  onChange={e => setAdjustForm({ ...adjustForm, refundable: e.target.checked })} />
                <span>
                  Give it back later
                  <span className="block text-xs text-gray-400">Refunded by itself once the order is paid, or when you choose to give it back.</span>
                </span>
              </label>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setAdjustFor(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Saving…' : 'Add to payslip'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---- LOAN ---- */}
      <Modal isOpen={!!loanForm} onClose={() => setLoanForm(null)} title={loanForm?.id ? `${loanForm.name}: change loan terms` : 'Record a loan'}>
        {loanForm && (
          <form onSubmit={submitLoan} className="space-y-3">
            {!loanForm.id && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Who is borrowing</label>
                <select required value={loanForm.person} onChange={e => setLoanForm({ ...loanForm, person: e.target.value })} className={inputClass}>
                  {people.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What it is for</label>
              <input required value={loanForm.description} onChange={e => setLoanForm({ ...loanForm, description: e.target.value })}
                placeholder="e.g. Motorola phone on credit" className={inputClass} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount lent</label>
                <input required type="number" min="0.01" step="0.01" value={loanForm.principal}
                  onChange={e => setLoanForm({ ...loanForm, principal: e.target.value })} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">First deducted in</label>
                <select value={loanForm.firstPeriod} disabled={loanForm.started} onChange={e => setLoanForm({ ...loanForm, firstPeriod: e.target.value })} className={inputClass}>
                  {(loanForm.started ? [loanForm.firstPeriod] : [0, 1, 2, 3, 4, 5].map(i => shiftLabel(openPeriod, i))).map(p => <option key={p} value={p}>{p} cycle</option>)}
                </select>
              </div>
            </div>
            {loanForm.id ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Deducted each cycle</label>
                <input required type="number" min="0.01" step="0.01" value={loanForm.instalmentAmount}
                  onChange={e => setLoanForm({ ...loanForm, instalmentAmount: e.target.value })} className={inputClass} />
                <p className="text-xs text-gray-400 mt-1">Applies from the next pay run. What has already been deducted stays as it is.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Repaid</label>
                  <select value={loanForm.terms} onChange={e => setLoanForm({ ...loanForm, terms: e.target.value })} className={inputClass}>
                    <option value="count">Over a number of cycles</option>
                    <option value="amount">A fixed amount each cycle</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{loanForm.terms === 'count' ? 'Number of instalments' : 'Amount each cycle'}</label>
                  {loanForm.terms === 'count'
                    ? <input required type="number" min="1" step="1" value={loanForm.instalments} onChange={e => setLoanForm({ ...loanForm, instalments: e.target.value })} className={inputClass} />
                    : <input required type="number" min="0.01" step="0.01" value={loanForm.instalmentAmount} onChange={e => setLoanForm({ ...loanForm, instalmentAmount: e.target.value })} className={inputClass} />}
                </div>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <input value={loanForm.notes} onChange={e => setLoanForm({ ...loanForm, notes: e.target.value })} className={inputClass} />
            </div>
            <p className="text-xs text-gray-400">
              The instalment comes off every pay run by itself until the loan is repaid. You can change or skip it on any one cycle from the payslip.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setLoanForm(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---- ONE CYCLE'S INSTALMENT ---- */}
      <Modal isOpen={!!instalmentFor} onClose={() => setInstalmentFor(null)} title={instalmentFor ? `${instalmentFor.description}: this cycle's instalment` : ''}>
        {instalmentFor && (
          <form onSubmit={e => { e.preventDefault(); submitInstalment(parseFloat(instalmentAmount)); }} className="space-y-3">
            <p className="text-sm text-gray-600">
              {formatMoney(instalmentFor.outstanding)} is left on this loan and the agreed instalment is {formatMoney(instalmentFor.scheduled)}.
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Deduct this cycle</label>
              <input required type="number" min="0" step="0.01" max={instalmentFor.outstanding} value={instalmentAmount}
                onChange={e => setInstalmentAmount(e.target.value)} className={inputClass} />
              <p className="text-xs text-gray-400 mt-1">Zero skips this cycle. Whatever is not taken stays on the loan.</p>
            </div>
            <div className="flex justify-between gap-2 pt-1">
              <button type="button" disabled={submitting || !instalmentFor.edited} onClick={() => submitInstalment(null)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm disabled:opacity-40">Back to agreed amount</button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---- ALLOWANCE, BONUS OR ADVANCE OUTSIDE A PAYSLIP ---- */}
      <Modal isOpen={!!directFor} onClose={() => setDirectFor(null)} title={directFor ? `Pay ${directFor.name}` : ''}>
        {directFor && (
          <form onSubmit={submitDirect} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What is this?</label>
              <select value={directForm.type} onChange={e => setDirectForm({ ...directForm, type: e.target.value })} className={inputClass}>
                {DIRECT_PAY_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {directForm.type === 'advance'
                  ? 'Money handed over before pay day. It is taken off the payslip for the cycle running now.'
                  : 'Paid on top of salary and recorded as a Salaries & Wages expense.'}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
              <input required type="number" min="0.01" step="0.01" value={directForm.amount}
                onChange={e => setDirectForm({ ...directForm, amount: e.target.value })} className={inputClass} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                <input value={directForm.paymentMethod} onChange={e => setDirectForm({ ...directForm, paymentMethod: e.target.value })}
                  placeholder="Cash, Mobile Money…" className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input value={directForm.notes} onChange={e => setDirectForm({ ...directForm, notes: e.target.value })} className={inputClass} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setDirectFor(null)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm">Cancel</button>
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
                    <span className="text-xs text-gray-400 ml-2">{p.payslipId ? 'Payslip payment' : PAY_TYPE_LABEL[p.type] || p.type}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {formatDate(p.createdAt)}{p.paymentMethod ? ` · ${p.paymentMethod}` : ''}
                  </div>
                </div>
                {/* A payslip payment is undone from its payslip, where the balance it changes is in view. */}
                {!p.payslipId && <button onClick={() => removeDirectPayment(p)} className="p-1.5 text-gray-400 hover:text-red-600 shrink-0"><FiTrash2 size={14} /></button>}
              </div>
            ))}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => { const go = confirm.go; setConfirm(null); go(); }}
        title={confirm?.title || ''}
        message={confirm?.message || ''}
      />
    </div>
  );
}
