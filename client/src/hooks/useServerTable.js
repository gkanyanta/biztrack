import { useState } from 'react';

// Pagination/sort state for tables whose rows come from a server-paginated endpoint
// (the API call itself passes page/pageSize/sortBy/sortDir and reads back total/totalPages).
export default function useServerTable({ pageSize: initialPageSize = 25, defaultSort = null } = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);
  const [sort, setSort] = useState(defaultSort);

  const setPageSize = (size) => { setPageSizeState(size); setPage(1); };

  const toggleSort = (key) => {
    setPage(1);
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc' };
      if (s.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  };

  const params = { page, pageSize, sortBy: sort?.key, sortDir: sort?.dir };

  return { page, pageSize, sort, params, setPage, setPageSize, toggleSort };
}
