import { FiClock, FiCheck, FiTruck, FiPackage, FiX } from 'react-icons/fi';
import { formatDateTime } from '../utils/format';

const ICONS = {
  Pending: FiClock,
  Confirmed: FiCheck,
  Shipped: FiTruck,
  Delivered: FiPackage,
  Cancelled: FiX,
};
const COLORS = {
  Pending: 'bg-yellow-100 text-yellow-700',
  Confirmed: 'bg-blue-100 text-blue-700',
  Shipped: 'bg-purple-100 text-purple-700',
  Delivered: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-700',
  New: 'bg-gray-100 text-gray-700',
};

export default function OrderTimeline({ statusHistory }) {
  if (!statusHistory?.length) return null;
  // Chronological (oldest first)
  const events = [...statusHistory].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Order Timeline</h4>
      <div className="space-y-2">
        {events.map((e, idx) => {
          const Icon = ICONS[e.toStatus] || FiClock;
          const color = COLORS[e.toStatus] || 'bg-gray-100 text-gray-700';
          const last = idx === events.length - 1;
          return (
            <div key={e.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center ${color}`}>
                  <Icon size={13} />
                </div>
                {!last && <div className="flex-1 w-px bg-gray-200 my-1" />}
              </div>
              <div className="flex-1 pb-2">
                <div className="text-sm text-gray-800">
                  <span className="font-medium">{e.fromStatus || 'New'}</span>
                  <span className="text-gray-400 mx-1">→</span>
                  <span className="font-medium">{e.toStatus}</span>
                </div>
                <div className="text-xs text-gray-500">{formatDateTime(e.createdAt)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
