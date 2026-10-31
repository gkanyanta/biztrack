import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiInbox, FiChevronRight } from 'react-icons/fi';
import { getAdvanceSummary } from '../services/api';

// Tells the office there are advance requests waiting on them, so nobody has to remember to
// look in Payroll.
export default function AdvanceRequestsAlert() {
  const [summary, setSummary] = useState(null);
  useEffect(() => { getAdvanceSummary().then(res => setSummary(res.data)).catch(() => setSummary(null)); }, []);
  if (!summary || (summary.pending === 0 && summary.approved === 0)) return null;
  const parts = [
    summary.pending > 0 && `${summary.pending} advance request${summary.pending === 1 ? '' : 's'} waiting for your decision`,
    summary.approved > 0 && `${summary.approved} approved and not yet paid out`,
  ].filter(Boolean);
  return (
    <Link to="/payroll#advance-requests"
      className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm hover:bg-amber-100">
      <FiInbox className="text-amber-600 shrink-0" size={18} />
      <span className="flex-1 text-amber-900">{parts.join(' · ')}</span>
      <span className="font-medium text-amber-800 whitespace-nowrap">Review</span>
      <FiChevronRight className="text-amber-600" />
    </Link>
  );
}
