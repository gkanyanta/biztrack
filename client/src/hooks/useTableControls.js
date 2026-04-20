import { useMemo, useState } from 'react';

export default function useTableControls(rows, { pageSize: initialPageSize = 25, defaultSort = null } = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [sort, setSort] = useState(defaultSort);

  const sorted = useMemo(() => {
    if (!sort || !sort.key) return rows;
    const { key, dir, accessor } = sort;
    const get = accessor || ((r) => r[key]);
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const na = typeof va === 'string' ? va.toLowerCase() : va;
      const nb = typeof vb === 'string' ? vb.toLowerCase() : vb;
      if (na < nb) return dir === 'asc' ? -1 : 1;
      if (na > nb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [rows, sort]);

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  const toggleSort = (key, accessor) => {
    setPage(1);
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc', accessor };
      if (s.dir === 'asc') return { key, dir: 'desc', accessor };
      return null;
    });
  };

  return {
    pageRows,
    page: safePage,
    pageSize,
    total,
    totalPages,
    setPage,
    setPageSize,
    sort,
    toggleSort,
    resetPage: () => setPage(1),
  };
}
