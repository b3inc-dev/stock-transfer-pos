import { OUTBOUND_REQUEST_LABELS, validOutboundDate } from "../../extensions/common/outboundRequests.js";

export const REQUEST_LIST_PATH = "/app/outbound-requests";
export const REQUEST_PAGE_SIZE = 25;
export type RequestFilters = { origins: string[]; destinations: string[]; statuses: string[]; query: string; from: string; to: string; sort: "asc" | "desc" | "due"; page: number };
export function requestFilters(params: URLSearchParams): RequestFilters {
  const locations = (key: string) => [...new Set(params.getAll(key).filter(value => /^gid:\/\/shopify\/Location\/\d+$/.test(value)))].slice(0, 100);
  const from = params.get("from") || "", to = params.get("to") || "";
  const page = Number(params.get("page"));
  return {
    origins: locations("origin"), destinations: locations("destination"),
    statuses: [...new Set(params.getAll("status").filter(value => Object.hasOwn(OUTBOUND_REQUEST_LABELS, value)))],
    query: (params.get("query") || "").trim().slice(0, 100),
    from: validOutboundDate(from) ? from : "", to: validOutboundDate(to) ? to : "",
    sort: params.get("sort") === "asc" ? "asc" : params.get("sort") === "due" ? "due" : "desc",
    page: Number.isSafeInteger(page) && page >= 0 ? Math.min(page, 100000) : 0,
  };
}
export function requestListUrl(filters: RequestFilters, page = filters.page) {
  const params = new URLSearchParams();
  filters.origins.forEach(value => params.append("origin", value));
  filters.destinations.forEach(value => params.append("destination", value));
  filters.statuses.forEach(value => params.append("status", value));
  if (filters.query) params.set("query", filters.query);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.sort !== "desc") params.set("sort", filters.sort);
  if (page) params.set("page", String(page));
  return REQUEST_LIST_PATH + (params.size ? "?" + params : "");
}
// Only known list filters can be used as a return destination.
export function requestReturnTo(value: string | null | undefined) {
  if (!value?.startsWith(REQUEST_LIST_PATH)) return REQUEST_LIST_PATH;
  try {
    const url = new URL(value, "https://outbound.invalid");
    if (url.origin !== "https://outbound.invalid" || url.pathname !== REQUEST_LIST_PATH) return REQUEST_LIST_PATH;
    return requestListUrl(requestFilters(url.searchParams));
  } catch { return REQUEST_LIST_PATH; }
}
export function requestChildUrl(path: string, returnTo: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (returnTo !== REQUEST_LIST_PATH) params.set("returnTo", requestReturnTo(returnTo));
  return path + (params.size ? "?" + params : "");
}
export function requestDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll("-", "/");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
