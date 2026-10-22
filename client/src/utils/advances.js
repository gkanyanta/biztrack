// How each state of a salary advance request reads, shared by the staff page and Payroll.
export const ADVANCE_STATUS = {
  pending: { label: 'Waiting for a decision', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  approved: { label: 'Approved, not yet paid out', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  paid: { label: 'Paid out', className: 'bg-green-50 text-green-700 border-green-200' },
  declined: { label: 'Declined', className: 'bg-red-50 text-red-700 border-red-200' },
  withdrawn: { label: 'Withdrawn', className: 'bg-gray-50 text-gray-500 border-gray-200' },
};
