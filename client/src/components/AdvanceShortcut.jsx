import { Link } from 'react-router-dom';
import { FiInbox, FiChevronRight } from 'react-icons/fi';
import { useAuth } from '../hooks/useAuth';

// The way into a salary advance from a staff member's own home screen, since on a phone the
// sidebar link hides behind the menu. The office never sees it: admins decide requests, they
// don't make them.
const STAFF_ROLES = ['consultant', 'rider', 'inventory', 'purchasing'];

export default function AdvanceShortcut() {
  const { user } = useAuth();
  if (!STAFF_ROLES.includes(user?.role)) return null;
  return (
    <Link to="/my-advances"
      className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm hover:border-blue-300 hover:bg-blue-50">
      <FiInbox className="text-blue-600 shrink-0" size={18} />
      <span className="flex-1 text-gray-700">Need a salary advance? <span className="font-medium text-blue-700">Ask for one</span></span>
      <FiChevronRight className="text-gray-400" />
    </Link>
  );
}
