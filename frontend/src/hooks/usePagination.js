import { useMemo, useState } from "react";

export function usePagination(items = [], pageSize = 10) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const pageItems = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize]
  );

  return { page, setPage, pageCount, pageItems };
}

export default usePagination;
