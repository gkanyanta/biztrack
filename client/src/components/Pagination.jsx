import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';

export default function Pagination({ page, totalPages, total, pageSize, onPageChange, onPageSizeChange, pageSizeOptions = [10, 25, 50, 100] }) {
  if (total === 0) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const pages = [];
  const maxBtns = 5;
  let from = Math.max(1, page - Math.floor(maxBtns / 2));
  let to = Math.min(totalPages, from + maxBtns - 1);
  if (to - from + 1 < maxBtns) from = Math.max(1, to - maxBtns + 1);
  for (let i = from; i <= to; i++) pages.push(i);

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mt-3 text-xs text-gray-600">
      <div className="flex items-center gap-2">
        <span>Showing <span className="font-medium text-gray-800">{start}-{end}</span> of <span className="font-medium text-gray-800">{total}</span></span>
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(parseInt(e.target.value))}
            className="border border-gray-300 rounded px-1 py-0.5 text-xs outline-none"
          >
            {pageSizeOptions.map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        )}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page === 1}
            className="p-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FiChevronLeft size={14} />
          </button>
          {from > 1 && (
            <>
              <button onClick={() => onPageChange(1)} className="px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50">1</button>
              {from > 2 && <span className="px-1 text-gray-400">…</span>}
            </>
          )}
          {pages.map((p) => (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={`px-2 py-0.5 rounded border ${p === page ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 hover:bg-gray-50'}`}
            >
              {p}
            </button>
          ))}
          {to < totalPages && (
            <>
              {to < totalPages - 1 && <span className="px-1 text-gray-400">…</span>}
              <button onClick={() => onPageChange(totalPages)} className="px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50">{totalPages}</button>
            </>
          )}
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page === totalPages}
            className="p-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FiChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
