import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiDollarSign, FiChevronRight } from 'react-icons/fi';
import { getPayrollDue } from '../services/api';
import { formatMoney } from '../utils/format';

// Pay day is easy to let slide: a cycle ends and nobody finalises it, or payslips are
// finalised and the payments never recorded. This says so on the dashboard. The Payroll page
// opens on whichever cycle needs doing, so the link needs no period.
export default function PayrollDueAlert() {
  const [due, setDue] = useState(null);
  useEffect(() => { getPayrollDue().then(res => setDue(res.data)).catch(() => setDue(null)); }, []);
  if (!due || (!due.toFinalise && due.unpaid.length === 0)) return null;
  const owed = due.unpaid.reduce((s, u) => s + u.outstanding, 0);
  const people = due.unpaid.reduce((s, u) => s + u.people, 0);
  const parts = [
    due.toFinalise && `The ${due.toFinalise} pay cycle has ended and is waiting to be finalised`,
    people > 0 && `${people} ${people === 1 ? 'payslip' : 'payslips'} still to pay, ${formatMoney(owed)}`,
  ].filter(Boolean);
  return (
    <Link to="/payroll"
      className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm hover:bg-amber-100">
      <FiDollarSign className="text-amber-600 shrink-0" size={18} />
      <span className="flex-1 text-amber-900">{parts.join(' · ')}</span>
      <span className="font-medium text-amber-800 whitespace-nowrap">Open payroll</span>
      <FiChevronRight className="text-amber-600" />
    </Link>
  );
}
