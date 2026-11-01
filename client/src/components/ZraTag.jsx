import { zraInvoice, zraCreditNote, ZRA_DOC_STATUS } from '../utils/zra';

// Where a sale stands with ZRA, beside its status. Nothing for a sale ZRA never needed to see.
export default function ZraTag({ sale }) {
  const invoice = zraInvoice(sale);
  if (!invoice) return null;
  const credit = zraCreditNote(sale);
  // A cancelled sale is only settled once its credit note is through too.
  const doc = credit && invoice.status === 'issued' ? credit : invoice;
  const st = ZRA_DOC_STATUS[doc.status] || ZRA_DOC_STATUS.pending;
  return (
    <span title={doc.lastError || (credit ? 'Cancelled on ZRA with a credit note' : `ZRA receipt ${invoice.rcptNo ?? ''}`)}
      className={`inline-block mt-1 ml-1 text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${st.className}`}>
      {credit && doc.status === 'issued' ? 'ZRA credited' : st.label}
    </span>
  );
}
