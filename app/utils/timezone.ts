// app/utils/timezone.ts
// タイムゾーン関連のユーティリティ関数

/**
 * ショップのタイムゾーンを取得するGraphQLクエリ
 */
export const GET_SHOP_TIMEZONE_QUERY = `#graphql
  query GetShopTimezone {
    shop {
      id
      ianaTimezone
    }
  }
`;

/**
 * ショップのタイムゾーンに基づいて日付を取得する関数
 * @param date 日付オブジェクト（省略時は現在の日時）
 * @param timezone タイムゾーン（IANA形式、例: "Asia/Tokyo"）
 * @returns YYYY-MM-DD形式の日付文字列
 */
export function getDateInShopTimezone(date: Date = new Date(), timezone: string = "UTC"): string {
  // デバッグ: タイムゾーンと日付を確認
  const result = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  
  // デバッグログ（本番環境では削除）
  if (process.env.NODE_ENV !== "production") {
    console.log(`[getDateInShopTimezone] date=${date.toISOString()}, timezone=${timezone}, result=${result}`);
  }
  
  return result;
}

/**
 * ISO文字列からショップのタイムゾーンに基づいて日付を抽出する関数
 * @param isoString ISO 8601形式の日時文字列（例: "2024-01-01T12:00:00Z"）
 * @param timezone タイムゾーン（IANA形式、例: "Asia/Tokyo"）
 * @returns YYYY-MM-DD形式の日付文字列、または空文字列
 */
export function extractDateFromISO(isoString: string | undefined | null, timezone: string = "UTC"): string {
  if (!isoString) return "";
  try {
    const date = new Date(isoString);
    return getDateInShopTimezone(date, timezone);
  } catch {
    return "";
  }
}

/**
 * ショップのタイムゾーンに基づいて日時を表示する関数
 * @param isoString ISO 8601形式の日時文字列（例: "2024-01-01T12:00:00Z"）
 * @param timezone タイムゾーン（IANA形式、例: "Asia/Tokyo"）
 * @param locale ロケール（デフォルト: "ja-JP"）
 * @returns フォーマットされた日時文字列
 */
export function formatDateTimeInShopTimezone(
  isoString: string | undefined | null,
  timezone: string = "UTC",
  locale: string = "ja-JP"
): string {
  if (!isoString) return "";
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
}

/**
 * 指定タイムゾーンでの「現在」の時（0-23）を返す。
 * 日次スナップショットを「前日終了時点」として保存するため、深夜帯（0-5時）のみ保存許可するチェックに使用。
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
 * ショップのタイムゾーンを取得する関数（loader内で使用）
 * @param admin Shopify Admin APIクライアント
 * @returns タイムゾーン文字列（IANA形式）、取得失敗時は"UTC"
 */
export async function getShopTimezone(admin: { graphql: (q: string, v?: any) => Promise<any> }): Promise<string> {
  try {
    const resp = await admin.graphql(GET_SHOP_TIMEZONE_QUERY);
    const data = await resp.json();
    return data?.data?.shop?.ianaTimezone || "UTC";
  } catch (error) {
    console.error("Failed to get shop timezone:", error);
    return "UTC";
  }
}
