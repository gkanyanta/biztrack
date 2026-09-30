import { FiClock, FiCheck, FiTruck, FiPackage, FiX, FiUser, FiDollarSign, FiAlertCircle, FiNavigation } from 'react-icons/fi';
import { formatDateTime, formatMoney } from '../utils/format';

// One thread per order, so the same question — where is it? — has the same answer for whoever
// asks. The status log says what the office recorded; the delivery says what happened on the
// road. Read separately they each leave a gap: a status of Shipped with no pickup means the
// warehouse packed it and nobody collected it, and that is exactly the sort of thing worth
// seeing rather than inferring.

const STATUS_STYLE = {
  Pending: { icon: FiClock, tone: 'bg-yellow-100 text-yellow-700', say: 'Order taken, not yet confirmed' },
  Confirmed: { icon: FiCheck, tone: 'bg-blue-100 text-blue-700', say: 'Confirmed — stock set aside' },
  Shipped: { icon: FiPackage, tone: 'bg-purple-100 text-purple-700', say: 'Packed by the warehouse, ready to go' },
  Delivered: { icon: FiCheck, tone: 'bg-green-100 text-green-700', say: 'Order complete' },
  Cancelled: { icon: FiX, tone: 'bg-red-100 text-red-700', say: 'Cancelled' },
};

// Milestones the Delivery records in its own right, each only real once it has a time on it.
function deliveryEvents(delivery) {
  if (!delivery) return [];
  const who = delivery.rider?.name;
  const events = [];
  if (delivery.assignedAt) {
    events.push({
      at: delivery.assignedAt, icon: FiUser, tone: 'bg-slate-100 text-slate-700',
      title: who ? `Given to ${who}` : 'Queued for a rider',
      detail: who ? 'On their run sheet' : 'Not yet assigned to anybody',
    });
  }
  if (delivery.pickedUpAt) {
    events.push({
      at: delivery.pickedUpAt, icon: FiNavigation, tone: 'bg-blue-100 text-blue-700',
      title: who ? `${who} picked it up` : 'Picked up',
      detail: 'On the way to the customer',
    });
  }
  if (delivery.deliveredAt) {
    const cash = parseFloat(delivery.cashCollected || 0);
    events.push({
      at: delivery.deliveredAt, icon: FiTruck, tone: 'bg-green-100 text-green-700',
      title: delivery.recipientName ? `Handed to ${delivery.recipientName}` : 'Dropped off',
      detail: cash > 0 ? `${formatMoney(cash)} collected at the door` : 'Nothing to collect',
    });
  }
  if (delivery.failedAt) {
    events.push({
      at: delivery.failedAt, icon: FiAlertCircle, tone: 'bg-red-100 text-red-700',
      title: 'Delivery failed',
      detail: delivery.failureReason || 'No reason recorded',
    });
  }
  if (delivery.cashRemittedAt) {
    events.push({
      at: delivery.cashRemittedAt, icon: FiDollarSign, tone: 'bg-emerald-100 text-emerald-700',
      title: 'Cash confirmed by the office',
      detail: 'Posted against this order',
    });
  }
  return events;
}

export default function OrderTimeline({ statusHistory, delivery, fulfilment }) {
  const fromStatus = (statusHistory || []).map(e => {
    const style = STATUS_STYLE[e.toStatus] || { icon: FiClock, tone: 'bg-gray-100 text-gray-700' };
    return {
      at: e.createdAt, icon: style.icon, tone: style.tone,
      title: e.fromStatus && e.fromStatus !== 'New' ? `${e.fromStatus} → ${e.toStatus}` : e.toStatus,
      detail: style.say,
    };
  });

  const events = [...fromStatus, ...deliveryEvents(delivery)]
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  if (!events.length) return null;

  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Order timeline</h4>
      {fulfilment === 'collection' && (
        <p className="text-xs text-gray-400 mb-2">Collected at the counter — there was never a delivery.</p>
      )}
      <div className="space-y-0">
        {events.map((e, idx) => {
          const Icon = e.icon;
          const last = idx === events.length - 1;
          return (
            <div key={`${e.at}-${idx}`} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${e.tone}`}>
                  <Icon size={13} />
                </div>
                {!last && <div className="flex-1 w-px bg-gray-200 my-1" />}
              </div>
              <div className="flex-1 pb-3 min-w-0">
                <div className="text-sm font-medium text-gray-800">{e.title}</div>
                {e.detail && <div className="text-xs text-gray-500">{e.detail}</div>}
                <div className="text-xs text-gray-400">{formatDateTime(e.at)}</div>
              </div>
            </div>
          );
        })}
      </div>
      {/* A packed order nobody has collected is the gap this view exists to expose. */}
      {delivery && !delivery.pickedUpAt && !delivery.deliveredAt && !delivery.failedAt && (
        <p className="text-xs text-amber-600 flex items-start gap-1">
          <FiAlertCircle size={12} className="mt-0.5 shrink-0" />
          Nobody has picked this up yet.
        </p>
      )}
    </div>
  );
}
