// Pagination is opt-in: only kicks in when the caller passes ?page=. Callers that
// need the full unfiltered array (dropdowns, pickers, reports) keep working unchanged.
function parsePagination(query, { defaultPageSize = 25, maxPageSize = 100 } = {}) {
  if (query.page === undefined) return null;
  const page = Math.max(1, parseInt(query.page) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, parseInt(query.pageSize) || defaultPageSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

function paginatedResponse(data, total, pagination) {
  return {
    data,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
  };
}

module.exports = { parsePagination, paginatedResponse };
