import { FiChevronUp, FiChevronDown } from 'react-icons/fi';

export default function SortableHeader({ label, sortKey, accessor, sort, onToggle, align = 'left', className = '' }) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  const alignClass = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';

  return (
    <button
      type="button"
      onClick={() => onToggle(sortKey, accessor)}
      className={`flex items-center gap-1 font-medium text-gray-600 hover:text-gray-900 select-none w-full ${alignClass} ${className}`}
    >
      <span>{label}</span>
      <span className="flex flex-col leading-none">
        <FiChevronUp size={10} className={active && dir === 'asc' ? 'text-blue-600' : 'text-gray-300'} />
        <FiChevronDown size={10} className={active && dir === 'desc' ? 'text-blue-600' : 'text-gray-300'} />
      </span>
    </button>
  );
}
