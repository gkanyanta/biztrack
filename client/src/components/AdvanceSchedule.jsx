import { formatMoney, formatDate } from '../utils/format';

// Each pay day an advance comes off, and how much.
export default function AdvanceSchedule({ schedule }) {
  if (!schedule?.length) return null;
  return (
    <table className="w-full text-sm mt-2">
      <thead><tr className="text-xs text-gray-400"><th className="text-left font-medium py-1">Pay day</th><th className="text-right font-medium py-1">Deducted</th></tr></thead>
      <tbody>
        {schedule.map(s => (
          <tr key={s.period} className="border-t border-gray-100">
            <td className="py-1.5 text-gray-700">{formatDate(s.payDate)}</td>
            <td className="py-1.5 text-right text-gray-700">{formatMoney(s.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
