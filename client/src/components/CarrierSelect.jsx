// Who is carrying a delivery — one of us, or somebody hired for the trip.
//
// This exists because there were two of these: the assign screen offered our own people plus
// Yango plus another courier, and the reassign dropdown on an in-progress delivery offered only
// our own people. So a delivery already on Yango showed as "Nobody" there, and touching the
// dropdown would quietly turn it into an unassigned rider delivery and lose the courier. One
// component means the two cannot say different things again.
//
// The value encodes both halves of the answer: 'rider:<id>' for one of ours, 'hire:yango' or
// 'hire:other' for a car booked for the trip, and '' for nobody decided yet.

export const CARRIER_HIRED = ['yango', 'other'];

export function encodeCarrier(delivery) {
  if (!delivery) return '';
  if (delivery.courier && delivery.courier !== 'rider') return `hire:${delivery.courier}`;
  return delivery.rider?.id ? `rider:${delivery.rider.id}` : '';
}

// Back into the shape the endpoint wants. A hired courier is not one of our people, so the
// rider is explicitly cleared rather than left behind.
export function decodeCarrier(value) {
  if (value.startsWith('hire:')) return { courier: value.slice('hire:'.length), riderId: null };
  if (value.startsWith('rider:')) return { courier: 'rider', riderId: value.slice('rider:'.length) };
  return { courier: 'rider', riderId: null };
}

export default function CarrierSelect({ riders, value, onChange, className = '', unsetLabel = 'Nobody yet' }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={className}>
      <option value="">{unsetLabel}</option>
      {riders.filter(r => r.isActive).map(r => (
        <option key={r.id} value={`rider:${r.id}`}>{r.name}{r.vehicle ? ` (${r.vehicle})` : ''}</option>
      ))}
      <option value="hire:yango">Yango</option>
      <option value="hire:other">Another courier</option>
    </select>
  );
}
