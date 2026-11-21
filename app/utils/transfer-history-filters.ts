export const TRANSFER_STATUSES = ["DRAFT", "READY_TO_SHIP", "IN_PROGRESS", "TRANSFERRED", "CANCELED", "OTHER"] as const;

export type HistoryFilter = "origin" | "destination" | "status";

export function buildTransferSearch(params: URLSearchParams): string | null {
  const groups: string[] = [];
  for (const [key, field] of [
    ["origin", "origin_id"], ["destination", "destination_id"], ["status", "status"],
  ] as const) {
    const values = [...new Set(params.getAll(key))];
    if (values.length === 0) continue;
    const terms = values.map((value) => {
      const valid = key === "status"
        ? TRANSFER_STATUSES.some((status) => status === value)
        : /^[1-9]\d*$/.test(value);
      if (!valid) throw new Response("絞り込み条件が無効です", { status: 400 });
      return `${field}:${value.toLowerCase()}`;
    });
    groups.push(terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);
  }
  return groups.length ? groups.join(" AND ") : null;
}

export function resetHistoryPage(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  for (const obsolete of ["cursor", "direction", "boundary", "page", "total"]) next.delete(obsolete);
  return next;
}

export function changeHistoryCriteria(params: URLSearchParams, key: HistoryFilter | "sort", values: Iterable<string>) {
  const next = resetHistoryPage(params);
  next.delete(key);
  for (const value of values) next.append(key, value);
  return next;
}
