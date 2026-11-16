// app/export-change-history-csv.server.ts
// 在庫変動履歴CSVエクスポート（リソースルート用）。Remix が同一ページ POST で HTML を返す問題を避けるため専用ルートから呼ぶ。
import { historyInventoryFilterIds, historyProductBatches, historyProductKey, indexHistoryProducts, recoveredHistorySku, type HistoryProduct } from "./utils/change-history-product";
import { authenticate } from "./shopify.server";
import { withGraphQLRetry } from "./utils/graphql-with-retry";
import { formatDateTimeInShopTimezone } from "./utils/timezone";
import db from "./db.server";



const LOCATIONS_QUERY = `#graphql
  query LocationsForCsv($first: Int!) {
    locations(first: $first) {
      nodes { id name }
    }
  }
`;

const ACTIVITY_LABELS: Record<string, string> = {
  inbound_transfer: "入庫",
  outbound_transfer: "出庫",
  loss_entry: "ロス",
  inventory_count: "棚卸",
  purchase_entry: "仕入",
  purchase_cancel: "仕入",
  sale: "売上",
  order_sales: "売上",
  refund: "返品",
  order_cancel: "返品",
  admin_webhook: "管理",
  inventory_adjustment: "在庫調整",
};

function getActivityDisplayLabel(activity: string | null | undefined): string {
  if (activity == null) return "その他";
  const key = String(activity).trim();
  if (!key) return "その他";
  return ACTIVITY_LABELS[key] ?? ACTIVITY_LABELS[key.toLowerCase()] ?? "その他";
}

function normalizeLocationIdsForQuery(ids: string[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    if (!id?.trim()) continue;
    set.add(id.trim());
    const num = id.trim().replace(/^gid:\/\/shopify\/Location\//i, "");
    if (num !== id.trim()) set.add(num);
    else set.add(`gid://shopify/Location/${id.trim()}`);
  }
  return [...set];
}

function csvExportErrorAsCsv(message: string): Response {
  const headers = "発生日時,商品名,SKU,JAN,オプション1,オプション2,オプション3,ロケーション,アクティビティ,変動数,変動後在庫数,参照ID,備考";
  const safeMsg = String(message).replace(/"/g, '""');
  const csvContent = [headers, `"${safeMsg}","","","","","","","","","","","",""]`].join("\n");
  return new Response("\uFEFF" + csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"inventory_change_history_error.csv\"",
    },
  });
}

export async function exportChangeHistoryCsv(request: Request): Promise<Response> {
  let { admin, session } = await authenticate.admin(request);
  admin = withGraphQLRetry(admin);
  const formData = await request.formData();

  const startDate = String(formData.get("startDate") || "").trim();
  const endDate = String(formData.get("endDate") || "").trim();
  if (!startDate || !endDate) {
    return csvExportErrorAsCsv("期間（開始日・終了日）を指定してください。");
  }

  const changeHistoryLocationIds = String(formData.get("changeHistoryLocationIds") || "")
    .split(",")
    .filter((id) => id.trim());
  const inventoryItemIds = String(formData.get("inventoryItemIds") || "")
    .split(",")
    .filter((id) => id.trim());
  const activityTypes = String(formData.get("activityTypes") || "")
    .split(",")
    .filter((t) => t.trim());
  const sortOrder = (String(formData.get("sortOrder") || "desc").trim() === "asc" ? "asc" : "desc") as "asc" | "desc";

  const whereClause: Record<string, unknown> = {
    shop: session.shop,
    date: { gte: startDate, lte: endDate },
  };
  if (changeHistoryLocationIds.length > 0) {
    whereClause.locationId = { in: normalizeLocationIdsForQuery(changeHistoryLocationIds) };
  }
  if (inventoryItemIds.length > 0) {
    whereClause.inventoryItemId = { in: historyInventoryFilterIds(inventoryItemIds) };
  }
  if (activityTypes.length > 0) {
    whereClause.activity = { in: activityTypes };
  }

  if (!db || typeof (db as { inventoryChangeLog?: unknown }).inventoryChangeLog === "undefined") {
    return csvExportErrorAsCsv("在庫変動履歴のデータを取得できません。");
  }

  const MAX_EXPORT = 50000;
  let count: number;
  try {
    count = await (db as { inventoryChangeLog: { count: (arg: { where: unknown }) => Promise<number> } }).inventoryChangeLog.count({ where: whereClause });
  } catch (e) {
    console.error("[export-change-history-csv] count failed:", e);
    return csvExportErrorAsCsv("件数取得に失敗しました。しばらく経ってからお試しください。");
  }
  if (count > MAX_EXPORT) {
    return csvExportErrorAsCsv(
      `件数が多すぎます（${MAX_EXPORT.toLocaleString()}件まで）。期間や条件を絞ってください。（該当: ${count.toLocaleString()}件）`
    );
  }

  try {
    const allLogs = await (db as { inventoryChangeLog: { findMany: (arg: { where: unknown; orderBy: unknown; take: number }) => Promise<unknown[]> } }).inventoryChangeLog.findMany({
      where: whereClause,
      orderBy: { timestamp: sortOrder },
      take: MAX_EXPORT,
    }) as Array<{ variantId?: string; inventoryItemId?: string; sku?: string; timestamp?: string; locationId?: string; locationName?: string; activity?: string; delta?: number | null; quantityAfter?: number | null; sourceId?: string; note?: string }>;

    const locationNameByLocationId = new Map<string, string>();
    try {
      const locResp = await admin.graphql(LOCATIONS_QUERY, { variables: { first: 250 } });
      const locData = (await (locResp as { json?: () => Promise<unknown> }).json?.()) as { data?: { locations?: { nodes?: Array<{ id?: string; name?: string }> } }; errors?: unknown[] };
      const locNodes = locData?.data?.locations?.nodes ?? [];
      for (const loc of locNodes) {
        if (loc?.id && loc?.name != null) {
          locationNameByLocationId.set(String(loc.id), loc.name);
          const raw = String(loc.id).replace(/^gid:\/\/shopify\/Location\//i, "");
          if (raw && raw !== String(loc.id)) locationNameByLocationId.set(raw, loc.name);
        }
      }
    } catch (e) {
      console.warn("[export-change-history-csv] locations query failed (CSV may show GID for location):", e instanceof Error ? e.message : String(e));
    }
    const getLocationDisplayName = (log: { locationId?: string; locationName?: string }) => {
      const locName = log?.locationName != null ? String(log.locationName).trim() : "";
      if (!locName) return log?.locationId ? (locationNameByLocationId.get(String(log.locationId)) ?? String(log.locationId)) : "";
      if (locName.startsWith("gid://")) {
        const raw = locName.replace(/^gid:\/\/shopify\/Location\//i, "");
        return locationNameByLocationId.get(locName) ?? locationNameByLocationId.get(raw) ?? locName;
      }
      return locName;
    };

    const batches = historyProductBatches(allLogs, 20);
    const variantInfoMap = new Map<string, HistoryProduct>();

    if (batches.length > 0) {
      for (const { ids, query } of batches) {
        try {
          const resp = await admin.graphql(query, { variables: { ids } });
          if (!resp || typeof (resp as { json?: () => Promise<unknown> }).json !== "function") continue;
          const data = await resp.json();
          if (data?.errors?.length) {
            console.warn("[export-change-history-csv] variant batch GraphQL errors:", data.errors.length);
          }
          indexHistoryProducts(variantInfoMap, data?.data?.nodes ?? []);
        } catch (e) {
          console.warn("[export-change-history-csv] variant batch failed (skipping chunk):", e instanceof Error ? e.message : String(e));
        }
      }
    }

    let shopTimezone = "UTC";
    try {
      const shopTzQuery = "query GetShopTimezone { shop { ianaTimezone } }";
      const shopTzResp = await admin.graphql(shopTzQuery, {});
      if (shopTzResp && typeof (shopTzResp as { json?: () => Promise<unknown> }).json === "function") {
        const shopTzData = (await (shopTzResp as { json: () => Promise<{ data?: { shop?: { ianaTimezone?: string } }; errors?: unknown[] }> }).json()) as { data?: { shop?: { ianaTimezone?: string } }; errors?: unknown[] };
        shopTimezone = shopTzData?.data?.shop?.ianaTimezone ?? shopTimezone;
      }
    } catch (e) {
      console.warn("[export-change-history-csv] shop timezone failed (using UTC):", e instanceof Error ? e.message : String(e));
    }

    const headers = [
      "発生日時",
      "商品名",
      "SKU",
      "JAN",
      "オプション1",
      "オプション2",
      "オプション3",
      "ロケーション",
      "アクティビティ",
      "変動数",
      "変動後在庫数",
      "参照ID",
      "備考",
    ];
    const rows = allLogs.map((log) => {
      const info = variantInfoMap.get(historyProductKey(log));
      const recoveredSku = recoveredHistorySku(log, info);
      let dateTimeStr = "";
      try {
        dateTimeStr = log.timestamp ? formatDateTimeInShopTimezone(log.timestamp, shopTimezone) : "";
      } catch {
        dateTimeStr = log.timestamp != null ? String(log.timestamp) : "";
      }
      return [
        dateTimeStr,
        info?.productTitle ?? log.sku ?? "",
        log.sku || recoveredSku,
        info?.barcode ?? "",
        info?.option1 ?? "",
        info?.option2 ?? "",
        info?.option3 ?? "",
        getLocationDisplayName(log) || "",
        getActivityDisplayLabel(log.activity),
        log.delta !== null ? String(log.delta) : "",
        log.quantityAfter !== null ? String(log.quantityAfter) : "",
        log.sourceId || "",
        [log.note, recoveredSku ? "SKUは出力時点の商品情報" : ""].filter(Boolean).join(" / "),
      ];
    });
    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell: string) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const filename =
      startDate === endDate
        ? `在庫変動履歴_${startDate}.csv`
        : `在庫変動履歴_${startDate}_${endDate}.csv`;
    return new Response("\uFEFF" + csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[export-change-history-csv] failed:", message, stack ?? "");
    return csvExportErrorAsCsv(`CSVの作成に失敗しました。${message ? `（${message}）` : ""}`);
  }
}
