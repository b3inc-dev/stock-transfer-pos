// app/utils/timezone.ts
// タイムゾーン関連のユーティリティ関数

const GET_SHOP_TIMEZONE_QUERY = `#graphql
  query GetShopTimezone {
    shop { id ianaTimezone }
  }
`;

/**
 * ショップのタイムゾーンに基づいて日付を取得する（YYYY-MM-DD）
 */
export function getDateInShopTimezone(date: Date = new Date(), timezone: string = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * ISO文字列からショップのタイムゾーンに基づいて日付を抽出する（YYYY-MM-DD）
 */
export function extractDateFromISO(isoString: string | undefined | null, timezone: string = "UTC"): string {
  if (!isoString) return "";
  try {
    return getDateInShopTimezone(new Date(isoString), timezone);
  } catch {
    return "";
  }
}

/**
 * ISO文字列をショップのタイムゾーンでフォーマットした日時文字列を返す
 */
export function formatDateTimeInShopTimezone(
  isoString: string | undefined | null,
  timezone: string = "UTC",
  locale: string = "ja-JP"
): string {
  if (!isoString) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(isoString));
  } catch {
    return "";
  }
}

/**
 * 指定タイムゾーンでの現在の時（0-23）を返す。
 * 日次スナップショットを「前日終了時点」として保存するため、深夜帯チェックに使用。
 */
export function getHourInShopTimezone(date: Date = new Date(), timezone: string = "UTC"): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour");
  return hour ? parseInt(hour.value, 10) : 0;
}

/**
 * ショップのタイムゾーンを取得する（loader内で使用）
 * @returns タイムゾーン文字列（IANA形式）、取得失敗時は"UTC"
 */
export async function getShopTimezone(
  admin: { graphql: (q: string, v?: Record<string, unknown>) => Promise<Response> }
): Promise<string> {
  try {
    const resp = await admin.graphql(GET_SHOP_TIMEZONE_QUERY);
    const { data } = await resp.json() as { data?: { shop?: { ianaTimezone?: string } } };
    return data?.shop?.ianaTimezone ?? "UTC";
  } catch (error) {
    console.error("[getShopTimezone] Failed:", error);
    return "UTC";
  }
}
