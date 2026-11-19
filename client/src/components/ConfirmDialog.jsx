// The confirm button says what it does. It defaults to a red "Delete" because most callers
// delete something; anything else (finalise, reopen, withdraw) passes its own label and tone.
export default function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Delete', tone = 'danger' }) {
  if (!isOpen) return null;

  const confirmClass = tone === 'danger'
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-slate-800 hover:bg-slate-900';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-2">{title || 'Confirm'}</h3>
        <p className="text-gray-600 mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
            Cancel
          </button>
          <button onClick={onConfirm} className={`px-4 py-2 text-sm text-white rounded-lg ${confirmClass}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
