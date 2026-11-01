import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiHelpCircle, FiChevronRight } from 'react-icons/fi';
import { getOrderQuerySummary } from '../services/api';
import { useAuth } from '../hooks/useAuth';

// On the dashboard: the office sees consultants' replies waiting to be read; a consultant sees
// the office's questions waiting for an answer.
export default function OrderQueriesAlert() {
  const { user } = useAuth();
  const isOffice = user?.role === 'admin' || user?.role === 'superadmin';
  const [waiting, setWaiting] = useState(0);
  useEffect(() => { getOrderQuerySummary().then(res => setWaiting(res.data.waitingOnYou)).catch(() => setWaiting(0)); }, []);
  if (!waiting) return null;
  const text = isOffice
    ? `${waiting} consultant repl${waiting === 1 ? 'y' : 'ies'} to your order queries`
    : `The office has ${waiting} question${waiting === 1 ? '' : 's'} about your orders`;
  return (
    <Link to="/order-queries"
      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm border ${isOffice ? 'bg-emerald-50 border-emerald-200 hover:bg-emerald-100 text-emerald-900' : 'bg-red-50 border-red-200 hover:bg-red-100 text-red-900'}`}>
      <FiHelpCircle className="shrink-0" size={18} />
      <span className="flex-1">{text}</span>
      <span className="font-medium whitespace-nowrap">{isOffice ? 'Read' : 'Reply'}</span>
      <FiChevronRight />
    </Link>
  );
}
