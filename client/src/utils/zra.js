// ZRA Smart Invoice tax categories BizTrack can report.
export const ZRA_TAX_CATEGORIES = [
  { code: 'TOT', label: 'Turnover tax' },
  { code: 'A', label: 'Standard VAT 16%' },
  { code: 'C1', label: 'Zero-rated (exports)' },
  { code: 'C2', label: 'Zero-rated (LPO)' },
  { code: 'C3', label: 'Zero-rated (other)' },
  { code: 'D', label: 'Exempt' },
  { code: 'E', label: 'Disbursement' },
];

// The ZRA invoice on a sale, and how to show where it is.
export const zraInvoice = (sale) => (sale?.fiscalDocuments || []).find(d => d.kind === 'invoice') || null;
export const zraCreditNote = (sale) => (sale?.fiscalDocuments || []).find(d => d.kind === 'credit_note') || null;
export const ZRA_DOC_STATUS = {
  issued: { label: 'ZRA ✓', className: 'bg-green-50 text-green-700 border-green-200' },
  pending: { label: 'ZRA pending', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  failed: { label: 'ZRA failed', className: 'bg-red-50 text-red-700 border-red-200' },
};
