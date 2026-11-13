/**
 * 在庫更新の履歴日付。タイムゾーン読み取り失敗を UTC 店舗と同一視しない。
 * 日付の出し方は app/utils/timezone.ts の getDateInShopTimezone と揃える。
 */

const SHOP_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function shopCalendarDate(timestamp, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp);
}

/** 読み取り失敗を UTC 日付に落とすと、店舗の暦日と境界付近でずれる。 */
export function utcFallbackShiftsShopDate(timestamp, shopTimezone) {
  try {
    return shopCalendarDate(timestamp, shopTimezone) !== shopCalendarDate(timestamp, "UTC");
  } catch {
    return false;
  }
}

/**
 * 在庫を動かす前に店舗日付が取れなければ、在庫も履歴も書かない。
 * 在庫適用後に日付が取れなければ、履歴だけ未完了のままにし、UTC 日付では書かない。
 * @returns {{ action: "proceed", timezone: string, date: string } | { action: "abort_before_write", errorCode: "timezone_unavailable" } | { action: "defer_history", errorCode: "timezone_unavailable" }}
 */
export function planInventoryHistoryDate(opts) {
  const unavailable =
    opts.phase === "before_inventory"
      ? { action: "abort_before_write", errorCode: "timezone_unavailable" }
      : { action: "defer_history", errorCode: "timezone_unavailable" };

  if (!opts.read?.ok) return unavailable;
  const timezone = typeof opts.read.timezone === "string" ? opts.read.timezone.trim() : "";
  if (!timezone) return unavailable;

  let date;
  try {
    date = shopCalendarDate(opts.timestamp, timezone);
  } catch {
    return unavailable;
  }
  if (!SHOP_DATE.test(date)) return unavailable;
  return { action: "proceed", timezone, date };
}
