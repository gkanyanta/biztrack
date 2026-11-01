// How a query thread's status reads, depending on who is looking at it.
export function queryStatusLabel(status, isOffice, consultantName) {
  if (status === 'closed') return { label: 'Closed', className: 'bg-gray-100 text-gray-500 border-gray-200' };
  if (isOffice) {
    return status === 'answered'
      ? { label: 'Replied', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
      : { label: `Waiting on ${consultantName || 'consultant'}`, className: 'bg-amber-50 text-amber-700 border-amber-200' };
  }
  return status === 'open'
    ? { label: 'Needs your reply', className: 'bg-red-50 text-red-700 border-red-200' }
    : { label: 'Sent to office', className: 'bg-blue-50 text-blue-700 border-blue-200' };
}
