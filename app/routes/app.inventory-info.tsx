// app/routes/app.inventory-info.tsx
// 在庫情報画面（在庫高表示・変動履歴）
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, useFetcher, useLocation } from "react-router";
import { useState, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import { getDateInShopTimezone, formatDateTimeInShopTimezone } from "../utils/timezone";
import db from "../db.server";
import {
  type DailyInventorySnapshot,
  type InventorySnapshotsData,
  getSavedSnapshots,
  fetchAllInventoryItems,
  aggregateSnapshotsFromItems,
  fetchAndSaveSnapshotsForDate,
  saveSnapshotsForDate,
} from "../utils/inventory-snapshot";

// 型の再エクスポート（他ルートで参照している場合に備える）
export type { DailyInventorySnapshot, InventorySnapshotsData };

// ロケーション一覧を取得するクエリ
const LOCATIONS_QUERY = `#graphql
  query Locations($first: Int!) {
    locations(first: $first) {
      nodes {
        id
        name
      }
    }
  }
`;

// 変動履歴一覧用：バリアントの商品名・オプション・JANを一括取得（最大250件/回）
const VARIANTS_FOR_CHANGE_HISTORY_QUERY = `#graphql
  query VariantsForChangeHistory($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        displayName
        barcode
        selectedOptions { name value }
        product { title }
      }
    }
  }
`;

// 在庫変動履歴のアクティビティ種別ラベル（一覧・CSV・フィルターで共通）
// 仕入キャンセル・キャンセル戻りは「仕入」「返品」に振り分けて表示
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

/** DBのactivity値を表示用日本語ラベルに変換。大文字小文字・前後の空白に強くする */
function getActivityDisplayLabel(activity: string | null | undefined): string {
  if (activity == null) return "その他";
  const key = String(activity).trim();
  if (!key) return "その他";
  return ACTIVITY_LABELS[key] ?? ACTIVITY_LABELS[key.toLowerCase()] ?? "その他";
}

/** 在庫変動履歴CSV出力でエラー時に、別タブ用のHTMLレスポンスを返す */
function csvExportErrorResponse(message: string): Response {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CSV出力エラー</title></head><body><p>${escaped}</p><button onclick="window.close()">閉じる</button></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, session } = await authenticate.admin(request);

    // 日次スナップショット用トークンの有効期限（ストア別・画面表示用）
    const offlineSession = await db.session.findFirst({
      where: { shop: session.shop, isOnline: false },
      select: { refreshTokenExpires: true },
    });
    const snapshotRefreshTokenExpires = offlineSession?.refreshTokenExpires
      ? offlineSession.refreshTokenExpires.toISOString()
      : null;

  const url = new URL(request.url);
  // 複数ロケーションIDを取得（カンマ区切り）
  const locationIdsParam = url.searchParams.get("locationIds") || "";
  const selectedLocationIds = locationIdsParam
    ? new Set(locationIdsParam.split(",").filter((id) => id.trim()))
    : new Set<string>();

    // ロケーション一覧を取得
    const locationsResp = await admin.graphql(LOCATIONS_QUERY, {
      variables: { first: 250 },
    });
    const locationsData = await locationsResp.json();
    
    if (locationsData.errors) {
      console.error("Locations query errors:", locationsData.errors);
      const errList = Array.isArray(locationsData.errors)
        ? locationsData.errors.map((e: any) => e?.message ?? String(e))
        : [String(locationsData.errors)];
      throw new Error(`ロケーション取得エラー: ${errList.join(", ")}`);
    }
    
    const locations = locationsData?.data?.locations?.nodes ?? [];

    // 共通モジュール用に admin を request 形式でラップ
    const adminForSnapshot = {
      request: async (opts: { data: string; variables?: Record<string, unknown> }) =>
        admin.graphql(opts.data, { variables: opts.variables ?? {} }),
    };

    // Metafieldから日次スナップショットを読み取る（共通モジュール）
    const { shopId, shopName, shopTimezone, savedSnapshots } = await getSavedSnapshots(adminForSnapshot);

  // ショップのタイムゾーンに基づいて今日の日付を取得
  const now = new Date();
  const todayInShopTimezone = getDateInShopTimezone(now, shopTimezone);
  
  const snapshotDates = savedSnapshots.snapshots.map((s) => s.date).sort();
  const firstSnapshotDate = snapshotDates.length > 0 ? snapshotDates[0] : todayInShopTimezone;

  const [y, m, d] = todayInShopTimezone.split("-").map(Number);
  const yesterdayDate = new Date(y, m - 1, d - 1);
  const yesterdayDateStr = yesterdayDate.toISOString().slice(0, 10);
  const hasYesterdaySnapshot = savedSnapshots.snapshots.some((s) => s.date === yesterdayDateStr);
  const todaySnapshot = savedSnapshots.snapshots.find((s) => s.date === todayInShopTimezone);

  // デフォルト日付: URLパラメータがあればそれを使用。本日集計未実施の場合は前日を指定して前日の内容を表示する。
  const defaultDate =
    url.searchParams.get("date") ||
    (todaySnapshot ? todayInShopTimezone : (hasYesterdaySnapshot ? yesterdayDateStr : todayInShopTimezone));
  const selectedDate = defaultDate;

  const today = todayInShopTimezone;
  const isToday = selectedDate === today;

  const snapshotForDate = savedSnapshots.snapshots
    .filter((s) => s.date === selectedDate)
    .map((s) => ({
      ...s,
      totalCompareAtPriceValue: s.totalCompareAtPriceValue ?? s.totalRetailValue ?? 0,
    }));

  // 今日のスナップショットが存在するかチェック（表示用・備考用）
  const todaySnapshotUpdatedAt = todaySnapshot?.updatedAt || null;

  // 開くたびに集計すると重いため、常に保存済みスナップショットのみ表示する。
  // 本日を選択時は「本日集計」で保存済みならその内容を表示し、未保存なら空で「本日集計」実行を促す。
  // 本日分は「日付が今日のスナップショット」をすべて使う（.find()だと1ロケーション分しか取れないため .filter で全件取得）
  let currentInventory: DailyInventorySnapshot[] = [];
  if (isToday && todaySnapshot) {
    currentInventory = savedSnapshots.snapshots
      .filter((s) => s.date === todayInShopTimezone)
      .map((s) => ({
        ...s,
        totalCompareAtPriceValue: s.totalCompareAtPriceValue ?? s.totalRetailValue ?? 0,
      }));
  }
  // 表示中のスナップショットの保存日時（備考表示用）
  const snapshotDisplayUpdatedAt =
    isToday ? (todaySnapshot?.updatedAt ?? null) : (snapshotForDate[0]?.updatedAt ?? null);

  // 選択されたロケーションでフィルター（複数選択対応）
  const filteredSnapshots =
    selectedLocationIds.size > 0
      ? (isToday ? currentInventory : snapshotForDate).filter((s) =>
          selectedLocationIds.has(s.locationId)
        )
      : isToday
      ? currentInventory
      : snapshotForDate;

  // 全ロケーション合計のサマリーを計算
  const summary = filteredSnapshots.reduce(
    (acc, snapshot) => ({
      totalQuantity: acc.totalQuantity + snapshot.totalQuantity,
      totalRetailValue: acc.totalRetailValue + snapshot.totalRetailValue,
      totalCompareAtPriceValue: acc.totalCompareAtPriceValue + snapshot.totalCompareAtPriceValue,
      totalCostValue: acc.totalCostValue + snapshot.totalCostValue,
    }),
    {
      totalQuantity: 0,
      totalRetailValue: 0,
      totalCompareAtPriceValue: 0,
      totalCostValue: 0,
    }
  );

    // 在庫変動履歴用のデータ取得（タブが「change-history」の場合のみ）
    const tab = url.searchParams.get("tab") || "inventory-level";
    
    // 在庫高タブの場合はバリアント取得をスキップ（パフォーマンス対策）
    const isChangeHistoryTab = tab === "change-history";
    
    const startDateParam = url.searchParams.get("startDate");
    const endDateParam = url.searchParams.get("endDate");

    // ログ全体の最初の日付（この日より前は選択不可にする）
    let firstChangeHistoryDate: string | null = null;
    if (session && db && typeof (db as any).inventoryChangeLog !== "undefined") {
      try {
        const firstLog = await (db as any).inventoryChangeLog.findFirst({
          where: { shop: session.shop },
          orderBy: { date: "asc" },
          select: { date: true },
        });
        firstChangeHistoryDate = firstLog?.date ?? null;
      } catch (error) {
        console.error("Error fetching first change history date:", error);
        firstChangeHistoryDate = null;
      }
    }

    // 期間フィルターのデフォルト値（サーバー側で計算した「今日の日付」を使用）
    const defaultEndForHistory = todayInShopTimezone;
    // 30日前の日付を計算
    const thirtyDaysAgoDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let defaultStartForHistory = getDateInShopTimezone(thirtyDaysAgoDate, shopTimezone);

    // ログが1件もない場合は、開始日の初期値も「今日」に揃える
    if (!firstChangeHistoryDate) {
      defaultStartForHistory = defaultEndForHistory;
    } else if (defaultStartForHistory < firstChangeHistoryDate) {
      // ログの最初の日付より前は開始日にしない
      defaultStartForHistory = firstChangeHistoryDate;
    }

    // フィルターが明示的に適用されているかチェック（URLパラメータにstartDateまたはendDateがある場合のみデータを取得）
    const hasExplicitFilters = startDateParam !== null || endDateParam !== null;
    
    let startDate = startDateParam || defaultStartForHistory;
    let endDate = endDateParam || defaultEndForHistory;

    // 開始日が終了日より後の場合は補正（URLやブックマークで逆転している場合）
    if (startDate > endDate) {
      startDate = endDate;
    }
    // URLパラメータで指定された開始日がログの最初の日付より前の場合は調整
    if (firstChangeHistoryDate && startDate < firstChangeHistoryDate) {
      startDate = firstChangeHistoryDate;
    }

    const changeHistoryLocationIds =
      url.searchParams
        .get("changeHistoryLocationIds")
        ?.split(",")
        .filter((id) => id.trim()) || [];
    const inventoryItemIds =
      url.searchParams
        .get("inventoryItemIds")
        ?.split(",")
        .filter((id) => id.trim()) || [];
    const activityTypes =
      url.searchParams
        .get("activityTypes")
        ?.split(",")
        .filter((t) => t.trim()) || [];
    const sortOrder = url.searchParams.get("sortOrder") || "desc";
    const changeHistoryPage = Math.max(1, parseInt(url.searchParams.get("changeHistoryPage") ?? "1", 10) || 1);
    const CHANGE_HISTORY_PAGE_SIZE = 5000;

    let changeHistoryLogs: any[] = [];
    let changeHistoryPagination: {
      total: number;
      startIndex: number;
      pageSize: number;
      currentPage: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    } = {
      total: 0,
      startIndex: 0,
      pageSize: CHANGE_HISTORY_PAGE_SIZE,
      currentPage: 1,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    };

    // フィルターが明示的に適用されている場合のみデータを取得（初回表示時のパフォーマンス改善）
    if (isChangeHistoryTab && session && hasExplicitFilters) {
      try {
        const whereClause: any = {
          shop: session.shop,
          date: {
            gte: startDate,
            lte: endDate,
          },
        };

        if (changeHistoryLocationIds.length > 0) {
          whereClause.locationId = { in: changeHistoryLocationIds };
        }

        if (inventoryItemIds.length > 0) {
          whereClause.inventoryItemId = { in: inventoryItemIds };
        }

        if (activityTypes.length > 0) {
          whereClause.activity = { in: activityTypes };
        }

        // タイムアウト対策：データベースクエリ全体に30秒のタイムアウトを設定
        const dbQueryPromise = (async () => {
          if (!db || typeof (db as any).inventoryChangeLog === "undefined") {
            return { logs: [], total: 0 };
          }
          const [logs, total] = await Promise.all([
            (db as any).inventoryChangeLog.findMany({
              where: whereClause,
              orderBy: {
                timestamp: sortOrder === "asc" ? "asc" : "desc",
              },
              skip: (changeHistoryPage - 1) * CHANGE_HISTORY_PAGE_SIZE,
              take: CHANGE_HISTORY_PAGE_SIZE,
            }),
            (db as any).inventoryChangeLog.count({ where: whereClause }),
          ]);
          return { logs, total };
        })();

        const timeoutPromise = new Promise<{ logs: any[]; total: number }>((_, reject) =>
          setTimeout(() => reject(new Error("Database query timeout (30s)")), 30000)
        );

        const { logs, total } = await Promise.race([dbQueryPromise, timeoutPromise]);
        changeHistoryLogs = logs;
        const totalPages = Math.max(1, Math.ceil(total / CHANGE_HISTORY_PAGE_SIZE));
        const currentPage = Math.min(changeHistoryPage, totalPages);
        changeHistoryPagination = {
          total,
          startIndex: total === 0 ? 0 : (currentPage - 1) * CHANGE_HISTORY_PAGE_SIZE + 1,
          pageSize: CHANGE_HISTORY_PAGE_SIZE,
          currentPage,
          totalPages,
          hasNextPage: currentPage < totalPages,
          hasPreviousPage: currentPage > 1,
        };

        // 商品名・オプションをバリアントから一括取得して付与（一覧・CSVを他リストと同等にする）
        const variantIds = [...new Set(changeHistoryLogs.map((l: any) => l.variantId).filter(Boolean))] as string[];
        const MAX_VARIANTS = 1500; // 商品名表示用：最大1500バリアントまで取得（制限撤廃に合わせて緩和）
        const limitedVariantIds = variantIds.slice(0, MAX_VARIANTS);
        
        if (limitedVariantIds.length < variantIds.length) {
          console.warn(`[inventory-info] Variant IDs limited to ${MAX_VARIANTS} out of ${variantIds.length} total variants`);
        }
        
        const variantInfoMap = new Map<string, { productTitle: string; barcode: string; option1: string; option2: string; option3: string }>();
        if (limitedVariantIds.length > 0 && session) {
          const CHUNK = 250;
          const MAX_CHUNKS = 6; // 最大6チャンク（1500件）まで処理（件数制限撤廃に合わせて緩和）
          const chunksToProcess = Math.min(Math.ceil(limitedVariantIds.length / CHUNK), MAX_CHUNKS);
          
          for (let i = 0; i < chunksToProcess * CHUNK && i < limitedVariantIds.length; i += CHUNK) {
            const chunk = limitedVariantIds.slice(i, i + CHUNK);
            try {
              // タイムアウト対策：各クエリに20秒のタイムアウトを設定（30秒→20秒に短縮）
              const queryPromise = admin.graphql(VARIANTS_FOR_CHANGE_HISTORY_QUERY, { variables: { ids: chunk } });
              const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error("GraphQL query timeout (20s)")), 20000)
              );
              
              const resp = await Promise.race([queryPromise, timeoutPromise]) as Response;
              const data = await resp.json();
              
              // GraphQLエラーをチェック
              if (data?.errors) {
                const errorMessages = Array.isArray(data.errors)
                  ? data.errors.map((e: any) => e?.message ?? String(e)).join(", ")
                  : String(data.errors);
                console.error("[inventory-info] GraphQL error fetching variants:", errorMessages);
                // エラーが発生しても処理を続行（商品名なしで表示）
                break; // エラーが発生したら残りもスキップ
              }
              
              const nodes = (data?.data?.nodes ?? []).filter(Boolean);
              for (const node of nodes) {
                if (!node?.id) continue;
                const opts = (node.selectedOptions as Array<{ name?: string; value?: string }>) ?? [];
                const productTitle = (node.product?.title ?? node.displayName ?? "") as string;
                variantInfoMap.set(node.id, {
                  productTitle,
                  barcode: (node.barcode as string) ?? "",
                  option1: opts[0]?.value ?? "",
                  option2: opts[1]?.value ?? "",
                  option3: opts[2]?.value ?? "",
                });
              }
            } catch (e) {
              console.error(`[inventory-info] Variant batch ${i / CHUNK + 1} failed:`, e);
              // エラーが発生しても処理を続行（商品名なしで表示）
              // タイムアウトやエラーが発生した場合は、残りのチャンクもスキップして続行
              if (e instanceof Error && (e.message.includes("timeout") || e.message.includes("Timeout"))) {
                console.warn(`[inventory-info] Timeout detected, skipping remaining variant batches`);
                break;
              }
            }
          }
        }
        changeHistoryLogs = changeHistoryLogs.map((log: any) => {
          const info = log.variantId ? variantInfoMap.get(log.variantId) : null;
          return {
            ...log,
            productTitle: info?.productTitle ?? null,
            barcode: info?.barcode ?? null,
            option1: info?.option1 ?? null,
            option2: info?.option2 ?? null,
            option3: info?.option3 ?? null,
          };
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        console.error("[inventory-info] Error fetching change history logs:", errorMessage, errorStack);
        // タイムアウトエラーの場合は詳細をログに記録
        if (errorMessage.includes("timeout") || errorMessage.includes("Timeout")) {
          console.error("[inventory-info] Change history query timed out. This may be due to large dataset or slow database connection.");
        }
        // エラーが発生しても空配列を返して処理を続行（画面は表示されるがデータは空）
        changeHistoryLogs = [];
      }
    }

    return {
      locations,
      selectedDate,
      selectedLocationIds: Array.from(selectedLocationIds),
      snapshots: filteredSnapshots,
      summary,
      isToday,
      shopId,
      shopName,
      shopTimezone,
      todayInShopTimezone, // サーバー側で計算した「今日の日付」をクライアントに渡す
      firstSnapshotDate, // 最初のスナップショット日付（日付選択のmin属性用）
      hasYesterdaySnapshot, // 前日分のスナップショットが既に保存されているか
      yesterdayDateStr, // 前日の日付（YYYY-MM-DD）
      snapshotRefreshTokenExpires, // 日次スナップショット用リフレッシュトークン有効期限（ISO文字列 or null）
      todaySnapshotUpdatedAt, // 今日のスナップショットの最終更新時刻（ISO文字列 or null）
      snapshotDisplayUpdatedAt, // 表示中スナップショットの保存日時（備考「保存日時」表示用）
      firstChangeHistoryDate,
      // 在庫変動履歴用のデータ
      changeHistoryLogs: changeHistoryLogs || [],
      changeHistoryPagination,
      hasExplicitFilters, // フィルターが明示的に適用されているか（初回表示時のパフォーマンス改善用）
      changeHistoryFilters: {
        startDate,
        endDate,
        locationIds: changeHistoryLocationIds || [],
        inventoryItemIds: inventoryItemIds || [],
        activityTypes: activityTypes || [],
        sortOrder: sortOrder || "desc",
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error("[inventory-info] Loader error:", errorMessage, errorStack);
    
    // JSONレスポンスを返す（React RouterのloaderはJSONを期待している）
    // エラーが発生しても、可能な限りデータを返して画面を表示できるようにする
    return {
      locations: [],
      selectedDate: new Date().toISOString().slice(0, 10),
      selectedLocationIds: [],
      snapshots: [],
      summary: {
        totalQuantity: 0,
        totalRetailValue: 0,
        totalCompareAtPriceValue: 0,
        totalCostValue: 0,
      },
      isToday: false,
      shopId: "",
      shopName: "",
      shopTimezone: "UTC",
      todayInShopTimezone: new Date().toISOString().slice(0, 10),
      firstSnapshotDate: new Date().toISOString().slice(0, 10),
      hasYesterdaySnapshot: false,
      yesterdayDateStr: new Date().toISOString().slice(0, 10),
      snapshotRefreshTokenExpires: null,
      todaySnapshotUpdatedAt: null,
      snapshotDisplayUpdatedAt: null,
      firstChangeHistoryDate: null,
      changeHistoryLogs: [],
      changeHistoryPagination: {
        total: 0,
        startIndex: 0,
        pageSize: 5000,
        currentPage: 1,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
      hasExplicitFilters: false,
      changeHistoryFilters: {
        startDate: new Date().toISOString().slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
        locationIds: [],
        inventoryItemIds: [],
        activityTypes: [],
        sortOrder: "desc",
      },
      error: errorMessage, // エラーメッセージを追加
    };
  }
}

// 商品検索用のaction関数
export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "").trim();

    // 在庫変動履歴：検索結果の全件CSV出力
    if (intent === "exportChangeHistoryCsv") {
      const startDate = String(formData.get("startDate") || "").trim();
      const endDate = String(formData.get("endDate") || "").trim();
      if (!startDate || !endDate) {
        return csvExportErrorResponse("期間（開始日・終了日）を指定してください。");
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

      const whereClause: any = {
        shop: session.shop,
        date: { gte: startDate, lte: endDate },
      };
      if (changeHistoryLocationIds.length > 0) {
        whereClause.locationId = { in: changeHistoryLocationIds };
      }
      if (inventoryItemIds.length > 0) {
        whereClause.inventoryItemId = { in: inventoryItemIds };
      }
      if (activityTypes.length > 0) {
        whereClause.activity = { in: activityTypes };
      }

      if (!db || typeof (db as any).inventoryChangeLog === "undefined") {
        return csvExportErrorResponse("在庫変動履歴のデータを取得できません。");
      }

      const MAX_EXPORT = 50000;
      let count: number;
      try {
        count = await (db as any).inventoryChangeLog.count({ where: whereClause });
      } catch (e) {
        console.error("[inventory-info] Export CSV count failed:", e);
        return csvExportErrorResponse("件数取得に失敗しました。しばらく経ってからお試しください。");
      }
      if (count > MAX_EXPORT) {
        return csvExportErrorResponse(
          `件数が多すぎます（${MAX_EXPORT.toLocaleString()}件まで）。期間や条件を絞ってください。（該当: ${count.toLocaleString()}件）`
        );
      }

      try {
        const allLogs = await (db as any).inventoryChangeLog.findMany({
          where: whereClause,
          orderBy: { timestamp: sortOrder },
          take: MAX_EXPORT,
        });

        const variantIds = [...new Set(allLogs.map((l: any) => l.variantId).filter(Boolean))] as string[];
        const MAX_VARIANTS_FOR_EXPORT = 5000;
        const limitedVariantIds = variantIds.slice(0, MAX_VARIANTS_FOR_EXPORT);
        const variantInfoMap = new Map<string, { productTitle: string; barcode: string; option1: string; option2: string; option3: string }>();

        if (limitedVariantIds.length > 0) {
          const CHUNK = 250;
          for (let i = 0; i < limitedVariantIds.length; i += CHUNK) {
            const chunk = limitedVariantIds.slice(i, i + CHUNK);
            try {
              const resp = await admin.graphql(VARIANTS_FOR_CHANGE_HISTORY_QUERY, { variables: { ids: chunk } });
              const data = await resp.json();
              const nodes = (data?.data?.nodes ?? []).filter(Boolean);
              for (const node of nodes) {
                if (!node?.id) continue;
                const opts = (node.selectedOptions as Array<{ name?: string; value?: string }>) ?? [];
                variantInfoMap.set(node.id, {
                  productTitle: (node.product?.title ?? node.displayName ?? "") as string,
                  barcode: (node.barcode as string) ?? "",
                  option1: opts[0]?.value ?? "",
                  option2: opts[1]?.value ?? "",
                  option3: opts[2]?.value ?? "",
                });
              }
            } catch (e) {
              console.error("[inventory-info] Export CSV variant batch failed:", e);
            }
          }
        }

        // タイムゾーン取得はCSV出力を止めないよう失敗時はUTCのまま続行（GraphQLの syntax error 等で落ちない）
        let shopTimezone = "UTC";
        try {
          const shopTzQuery = "query GetShopTimezone { shop { ianaTimezone } }";
          const shopTzResp = await admin.graphql(shopTzQuery, {});
          if (shopTzResp && typeof shopTzResp.json === "function") {
            const shopTzData = (await shopTzResp.json()) as { data?: { shop?: { ianaTimezone?: string } }; errors?: Array<{ message?: string }> };
            if (shopTzData?.data?.shop?.ianaTimezone) {
              shopTimezone = shopTzData.data.shop.ianaTimezone;
            }
          }
        } catch (e) {
          console.warn("[inventory-info] Export CSV shop timezone failed (using UTC):", e instanceof Error ? e.message : String(e));
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
        const rows = allLogs.map((log: any) => {
          const info = log.variantId ? variantInfoMap.get(log.variantId) : null;
          return [
            formatDateTimeInShopTimezone(log.timestamp, shopTimezone),
            info?.productTitle ?? log.sku ?? "",
            log.sku || "",
            info?.barcode ?? "",
            info?.option1 ?? "",
            info?.option2 ?? "",
            info?.option3 ?? "",
            log.locationName || "",
            getActivityDisplayLabel(log.activity),
            log.delta !== null ? String(log.delta) : "",
            log.quantityAfter !== null ? String(log.quantityAfter) : "",
            log.sourceId || "",
            log.note || "",
          ];
        });
        const csvContent = [headers, ...rows]
          .map((row) => row.map((cell: string) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
          .join("\n");
        const filename =
          startDate === endDate
            ? `在庫変動履歴_${startDate}.csv`
            : `在庫変動履歴_${startDate}_${endDate}.csv`;
        // 大量件数でJSONに載せるとレスポンスが途切れ「syntax error, unexpected end of file」になるため、CSVをそのままResponseで返す
        return new Response("\uFEFF" + csvContent, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
          },
        });
      } catch (e) {
        console.error("[inventory-info] Export CSV failed:", e);
        const message = e instanceof Error ? e.message : String(e);
        return csvExportErrorResponse(`CSVの作成に失敗しました。${message ? `（${message}）` : ""}`);
      }
    }

    // 前日分スナップショットが無い場合に保存（共通モジュールで取得・保存）
    if (intent === "ensureYesterdaySnapshot") {
      const adminForSnapshot = {
        request: async (opts: { data: string; variables?: Record<string, unknown> }) =>
          admin.graphql(opts.data, { variables: opts.variables ?? {} }),
      };
      const { shopTimezone, savedSnapshots } = await getSavedSnapshots(adminForSnapshot);
      const now = new Date();
      const todayStr = getDateInShopTimezone(now, shopTimezone);
      const [y, m, d] = todayStr.split("-").map(Number);
      const yesterdayDate = new Date(y, m - 1, d - 1);
      const dateToSaveStr = yesterdayDate.toISOString().slice(0, 10);
      if (savedSnapshots.snapshots.some((s) => s.date === dateToSaveStr)) {
        return { ok: true, skipped: true, message: "前日分は既に保存済みです。" };
      }
      const result = await fetchAndSaveSnapshotsForDate(adminForSnapshot, dateToSaveStr);
      if (!result.ok && result.userErrors?.length) {
        return { ok: false, error: result.userErrors.join(", ") };
      }
      return { ok: true, saved: true, date: dateToSaveStr, message: "前日分のスナップショットを保存しました。" };
    }

    // 本日集計ボタンがクリックされた場合、今日のスナップショットを保存
    if (intent === "saveTodaySnapshot") {
      const adminForSnapshot = {
        request: async (opts: { data: string; variables?: Record<string, unknown> }) =>
          admin.graphql(opts.data, { variables: opts.variables ?? {} }),
      };
      const { shopId, shopTimezone, savedSnapshots } = await getSavedSnapshots(adminForSnapshot);
      const now = new Date();
      const todayStr = getDateInShopTimezone(now, shopTimezone);
      // リアルタイムで在庫情報を取得
      const allItems = await fetchAllInventoryItems(adminForSnapshot);
      const newSnapshots = aggregateSnapshotsFromItems(allItems, todayStr);
      // スナップショットを保存
      const { userErrors } = await saveSnapshotsForDate(adminForSnapshot, shopId, savedSnapshots, newSnapshots, todayStr);
      if (userErrors.length > 0) {
        return { ok: false, error: userErrors.map((e: any) => e.message).join(", ") };
      }
      return { ok: true, saved: true, date: todayStr, message: "本日のスナップショットを保存しました。" };
    }

    // SKU・商品名で検索（在庫変動履歴の商品検索用）
    if (intent === "searchVariantsForChangeHistory") {
      const query = String(formData.get("query") || "").trim();
      if (!query) return { ok: true, variants: [] };
      const gql = `#graphql
        query SearchVariantsForChangeHistory($first: Int!, $query: String!) {
          productVariants(first: $first, query: $query) {
            nodes {
              id
              sku
              displayName
              barcode
              selectedOptions { name value }
              inventoryItem { id }
            }
          }
        }`;
      const escaped = query.replace(/"/g, '\\"');
      const resp = await admin.graphql(gql, {
        variables: { first: 50, query: `sku:*${escaped}* OR title:*${escaped}*` },
      });
      const data = await resp.json();
      const nodes = data?.data?.productVariants?.nodes ?? [];
      const variants = nodes.map((v: { id: string; sku?: string; displayName?: string; barcode?: string; selectedOptions?: Array<{ value?: string }>; inventoryItem?: { id: string } }) => {
        const opts = (v.selectedOptions as Array<{ value?: string }>) ?? [];
        return {
          variantId: v.id,
          inventoryItemId: v.inventoryItem?.id ?? "",
          sku: v.sku ?? "",
          title: v.displayName ?? "",
          barcode: v.barcode ?? "",
          option1: opts[0]?.value ?? "",
          option2: opts[1]?.value ?? "",
          option3: opts[2]?.value ?? "",
        };
      });
      return { ok: true, variants };
    }

    return { ok: false, error: "Unknown intent" };
  } catch (error) {
    console.error("Action error:", error);
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export default function InventoryInfoPage() {
  const { locations, selectedDate, selectedLocationIds, snapshots, summary, isToday, shopId, shopName, shopTimezone, todayInShopTimezone, firstSnapshotDate, hasYesterdaySnapshot, yesterdayDateStr, snapshotRefreshTokenExpires, todaySnapshotUpdatedAt, snapshotDisplayUpdatedAt, firstChangeHistoryDate, changeHistoryLogs, changeHistoryPagination, hasExplicitFilters, changeHistoryFilters } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const fetcher = useFetcher<typeof action>();
  const ensuredYesterdayRef = useRef(false);

  // タブ管理（URLパラメータから取得、デフォルトは在庫高）
  type InventoryTabId = "inventory-level" | "change-history";
  const tabFromUrl = searchParams.get("tab") || "inventory-level";
  const [activeTab, setActiveTab] = useState<InventoryTabId>(tabFromUrl as InventoryTabId);

  // タブ変更時の処理
  const handleTabChange = (tabId: InventoryTabId) => {
    setActiveTab(tabId);
    const params = new URLSearchParams(searchParams);
    params.set("tab", tabId);
    setSearchParams(params);
  };

  const [dateValue, setDateValue] = useState(selectedDate);
  const [locationFilters, setLocationFilters] = useState<Set<string>>(
    new Set(selectedLocationIds)
  );

  // 在庫変動履歴用のフィルター状態（デフォルト値の計算）
  // サーバー側で計算した「今日の日付」を使用（クライアント側でnew Date()を使わない）
  const defaultEndDate = todayInShopTimezone;
  // 30日前の日付を計算（サーバー側で計算した方が正確だが、クライアント側でも計算可能）
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let defaultStartDate = getDateInShopTimezone(thirtyDaysAgo, shopTimezone);
  // ログの最初の日付より前は開始日にしない
  if (firstChangeHistoryDate) {
    if (defaultStartDate < firstChangeHistoryDate) {
      defaultStartDate = firstChangeHistoryDate;
    }
  } else {
    // ログが1件もない場合は、開始日の初期値も「今日」に揃える
    defaultStartDate = defaultEndDate;
  }

  const [changeHistoryStartDate, setChangeHistoryStartDate] = useState(
    changeHistoryFilters?.startDate || defaultStartDate
  );
  const [changeHistoryCsvExporting, setChangeHistoryCsvExporting] = useState(false);
  const [changeHistoryEndDate, setChangeHistoryEndDate] = useState(
    changeHistoryFilters?.endDate || defaultEndDate
  );
  const [changeHistoryLocationFilters, setChangeHistoryLocationFilters] = useState<Set<string>>(
    new Set(changeHistoryFilters?.locationIds || [])
  );
  const [changeHistoryActivityTypes, setChangeHistoryActivityTypes] = useState<Set<string>>(
    new Set(changeHistoryFilters?.activityTypes || [])
  );
  const [changeHistorySortOrder, setChangeHistorySortOrder] = useState<"asc" | "desc">(
    (changeHistoryFilters?.sortOrder as "asc" | "desc") || "desc"
  );

  // 前日分スナップショットが無い場合に1回だけ保存を試みる（Cronが無くても管理画面を開けば前日分を補完）
  useEffect(() => {
    if (activeTab !== "inventory-level" || hasYesterdaySnapshot || ensuredYesterdayRef.current || fetcher.state !== "idle") return;
    ensuredYesterdayRef.current = true;
    fetcher.submit(
      { intent: "ensureYesterdaySnapshot" },
      { method: "post" }
    );
  }, [activeTab, hasYesterdaySnapshot, fetcher.state]);

  // 商品検索用のstate
  const [changeHistoryProductSearchQuery, setChangeHistoryProductSearchQuery] = useState("");
  const [changeHistorySearchVariants, setChangeHistorySearchVariants] = useState<Array<{
    variantId: string;
    inventoryItemId: string;
    sku: string;
    title: string;
    barcode: string;
    option1: string;
    option2: string;
    option3: string;
  }>>([]);
  const [changeHistorySelectedInventoryItemIds, setChangeHistorySelectedInventoryItemIds] = useState<Set<string>>(new Set());
  // 選択済み商品の情報を保持（検索結果に含まれていない商品も表示するため）
  const [changeHistorySelectedProductsInfo, setChangeHistorySelectedProductsInfo] = useState<Map<string, {
    variantId: string;
    inventoryItemId: string;
    sku: string;
    title: string;
    barcode: string;
    option1: string;
    option2: string;
    option3: string;
  }>>(new Map());
  // 選択済み商品を検索結果リストに表示するかどうか
  const [changeHistoryShowSelectedProducts, setChangeHistoryShowSelectedProducts] = useState(false);
  
  // 前回のURLパラメータのinventoryItemIdsを記録（選択状態のリセットを防ぐため）
  const prevInventoryItemIdsRef = useRef<string>("");

  useEffect(() => {
    setDateValue(selectedDate);
    setLocationFilters(new Set(selectedLocationIds));
  }, [selectedDate, selectedLocationIds]);

  // 在庫変動履歴CSVは form target=_blank で送信し、action が Response でファイルを返すため、fetcher のレスポンス処理は不要

  useEffect(() => {
    if (changeHistoryFilters) {
      setChangeHistoryStartDate(changeHistoryFilters.startDate);
      setChangeHistoryEndDate(changeHistoryFilters.endDate);
      setChangeHistoryLocationFilters(new Set(changeHistoryFilters.locationIds));
      
      // URLパラメータのinventoryItemIdsを文字列として比較
      const currentInventoryItemIds = (changeHistoryFilters.inventoryItemIds || []).join(",");
      
      // URLパラメータが実際に変更された場合のみ選択状態を更新
      // （フィルター適用時など、URLパラメータが明示的に変更された場合）
      if (currentInventoryItemIds !== prevInventoryItemIdsRef.current) {
        prevInventoryItemIdsRef.current = currentInventoryItemIds;
        // URLパラメータに選択がある場合は、それを使用（フィルター適用時）
        // URLパラメータに選択がない場合は、空のSetにリセット（フィルター解除時）
        setChangeHistorySelectedInventoryItemIds(new Set(changeHistoryFilters.inventoryItemIds || []));
      }
      // URLパラメータが変更されていない場合は、現在の選択状態を保持（商品検索中など）
      
      setChangeHistoryActivityTypes(new Set(changeHistoryFilters.activityTypes));
      setChangeHistorySortOrder((changeHistoryFilters.sortOrder as "asc" | "desc") || "desc");
    }
  }, [changeHistoryFilters]);

  // 在庫変動履歴：表示範囲・ページ表示（入出庫履歴と同様のUI）
  const chPagination = changeHistoryPagination ?? {
    total: 0, startIndex: 0, pageSize: 5000, currentPage: 1, totalPages: 0, hasNextPage: false, hasPreviousPage: false,
  };
  const chEndIndex = chPagination.startIndex + (changeHistoryLogs?.length ?? 0) - 1;
  const chRangeDisplay = (changeHistoryLogs?.length ?? 0) > 0
    ? chPagination.startIndex === chEndIndex
      ? `表示: ${chPagination.startIndex}件`
      : `表示: ${chPagination.startIndex}-${chEndIndex}件`
    : "表示: 0件";
  const chTotalDisplay = chPagination.total > 0 ? `${chPagination.total}件` : "0件";
  const chPageDisplay = (chPagination.hasNextPage || chPagination.hasPreviousPage) && chPagination.totalPages != null
    ? `${chPagination.currentPage}/${chPagination.totalPages}`
    : "";
  const chHasPagination = chPagination.hasNextPage || chPagination.hasPreviousPage;

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setDateValue(value);
    const params = new URLSearchParams(searchParams);
    params.set("date", value);
    setSearchParams(params);
  };

  // ロケーションフィルター変更時の処理
  const handleLocationFilterChange = (locationId: string) => {
    const newFilters = new Set(locationFilters);
    if (newFilters.has(locationId)) {
      newFilters.delete(locationId);
    } else {
      newFilters.add(locationId);
    }
    setLocationFilters(newFilters);
    
    // URLパラメータを更新
    const params = new URLSearchParams(searchParams);
    if (newFilters.size === 0) {
      params.delete("locationIds");
    } else {
      params.set("locationIds", Array.from(newFilters).join(","));
    }
    setSearchParams(params);
  };

  // 「全て」選択時の処理
  const handleSelectAllLocations = () => {
    setLocationFilters(new Set());
    const params = new URLSearchParams(searchParams);
    params.delete("locationIds");
    setSearchParams(params);
  };

  // 在庫変動履歴のフィルター変更処理（開始日 > 終了日の場合は補正）。フィルター適用時は1ページ目へ。
  const handleChangeHistoryFilterChange = () => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", "change-history");
    params.delete("changeHistoryPage"); // 1ページ目にリセット
    const start = changeHistoryStartDate > changeHistoryEndDate ? changeHistoryEndDate : changeHistoryStartDate;
    const end = changeHistoryStartDate > changeHistoryEndDate ? changeHistoryStartDate : changeHistoryEndDate;
    params.set("startDate", start);
    params.set("endDate", end);
    if (changeHistoryLocationFilters.size > 0) {
      params.set("changeHistoryLocationIds", Array.from(changeHistoryLocationFilters).join(","));
    } else {
      params.delete("changeHistoryLocationIds");
    }
    // 選択された商品のinventoryItemIdをURLパラメータに設定
    if (changeHistorySelectedInventoryItemIds.size > 0) {
      params.set("inventoryItemIds", Array.from(changeHistorySelectedInventoryItemIds).join(","));
    } else {
      params.delete("inventoryItemIds");
    }
    if (changeHistoryActivityTypes.size > 0) {
      params.set("activityTypes", Array.from(changeHistoryActivityTypes).join(","));
    } else {
      params.delete("activityTypes");
    }
    params.set("sortOrder", changeHistorySortOrder);
    setSearchParams(params);
  };

  // 在庫変動履歴のロケーションフィルター変更
  const handleChangeHistoryLocationFilterChange = (locationId: string) => {
    const newFilters = new Set(changeHistoryLocationFilters);
    if (newFilters.has(locationId)) {
      newFilters.delete(locationId);
    } else {
      newFilters.add(locationId);
    }
    setChangeHistoryLocationFilters(newFilters);
  };

  // 在庫変動履歴のアクティビティフィルター変更
  const handleChangeHistoryActivityFilterChange = (activityType: string) => {
    const newFilters = new Set(changeHistoryActivityTypes);
    if (newFilters.has(activityType)) {
      newFilters.delete(activityType);
    } else {
      newFilters.add(activityType);
    }
    setChangeHistoryActivityTypes(newFilters);
  };

  // 商品検索の実行
  const handleChangeHistoryProductSearch = () => {
    if (!changeHistoryProductSearchQuery.trim()) return;
    const fd = new FormData();
    fd.set("intent", "searchVariantsForChangeHistory");
    fd.set("query", changeHistoryProductSearchQuery.trim());
    fetcher.submit(fd, { method: "post" });
  };

  // 商品検索結果の処理
  useEffect(() => {
    if (fetcher.data && (fetcher.data as any).ok && (fetcher.data as any).variants) {
      const variants = (fetcher.data as any).variants;
      setChangeHistorySearchVariants(variants);
      
      // 検索結果に含まれる選択済み商品の情報を更新
      setChangeHistorySelectedProductsInfo((prevInfo) => {
        const newInfo = new Map(prevInfo);
        variants.forEach((v: any) => {
          if (changeHistorySelectedInventoryItemIds.has(v.inventoryItemId)) {
            newInfo.set(v.inventoryItemId, v);
          }
        });
        return newInfo;
      });
    }
  }, [fetcher.data]);

  // 商品選択の変更（関数型の更新を使用して常に最新の状態を参照）
  const handleChangeHistoryProductSelect = (inventoryItemId: string, productInfo?: {
    variantId: string;
    inventoryItemId: string;
    sku: string;
    title: string;
    barcode: string;
    option1: string;
    option2: string;
    option3: string;
  }) => {
    setChangeHistorySelectedInventoryItemIds((prevSelected) => {
      const newSelected = new Set(prevSelected);
      if (newSelected.has(inventoryItemId)) {
        newSelected.delete(inventoryItemId);
        // 選択解除時は商品情報も削除
        setChangeHistorySelectedProductsInfo((prevInfo) => {
          const newInfo = new Map(prevInfo);
          newInfo.delete(inventoryItemId);
          return newInfo;
        });
      } else {
        newSelected.add(inventoryItemId);
        // 選択時は商品情報も保存
        if (productInfo) {
          setChangeHistorySelectedProductsInfo((prevInfo) => {
            const newInfo = new Map(prevInfo);
            newInfo.set(inventoryItemId, productInfo);
            return newInfo;
          });
        }
      }
      return newSelected;
    });
  };


  // 選択解除（「選択済み」表示も解除して検索結果一覧に戻す）
  const handleChangeHistoryProductDeselectAll = () => {
    setChangeHistorySelectedInventoryItemIds(new Set());
    setChangeHistorySelectedProductsInfo(new Map());
    setChangeHistoryShowSelectedProducts(false);
  };


  return (
    <>
      {/* @ts-expect-error s-page は App Bridge の Web コンポーネント */}
      <s-page heading="在庫情報">
      {/* @ts-expect-error s-scroll-box は App Bridge の Web コンポーネント */}
      <s-scroll-box padding="base">
        {/* @ts-expect-error s-stack は App Bridge の Web コンポーネント */}
        <s-stack gap="base">
          {/* 上部タブナビゲーション（設定画面と同様のスタイル） */}
          {/* @ts-expect-error s-box は App Bridge の Web コンポーネント */}
          <s-box padding="none">
            <div
              style={{
                display: "flex",
                gap: "8px",
                padding: "0 16px 8px",
                borderBottom: "1px solid #e1e3e5",
                flexWrap: "wrap",
              }}
            >
              {[
                { id: "inventory-level" as InventoryTabId, label: "在庫高" },
                { id: "change-history" as InventoryTabId, label: "在庫変動履歴" },
              ].map((tab) => {
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => handleTabChange(tab.id)}
                    style={{
                      border: "none",
                      backgroundColor: selected ? "#e5e7eb" : "transparent",
                      borderRadius: 8,
                      padding: "6px 12px",
                      cursor: "pointer",
                      fontSize: 14,
                      fontWeight: selected ? 600 : 500,
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </s-box>

          {/* タブごとの内容 */}
          {/* @ts-expect-error s-box は App Bridge の Web コンポーネント */}
          <s-box padding="base">
            {/* タブごとの内容 */}
            {activeTab === "inventory-level" && (
              <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}>
                {/* 左: フィルター領域（スマホで日付欄がはみ出さないよう overflow を効かせる） */}
                <div style={{ flex: "1 1 260px", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
                  {/* @ts-expect-error s-stack は App Bridge の Web コンポーネント */}
                  <s-stack gap="base">
                    {/* 画面タイトル */}
                    <div>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        在庫高
                      </div>
                      {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                      <s-text tone="subdued" size="small">
                        条件で絞り込みを行い、在庫高を表示します。
                      </s-text>
                    </div>

                    {/* 日次スナップショット用トークン有効期限（ストア別・90日の説明） */}
                    {snapshotRefreshTokenExpires && (() => {
                      const exp = new Date(snapshotRefreshTokenExpires);
                      const expStr = `${exp.getFullYear()}/${exp.getMonth() + 1}/${exp.getDate()}`;
                      return (
                        <div style={{ marginTop: 8, padding: "10px 12px", background: "#f6f6f7", borderRadius: 8, border: "1px solid #e1e3e5" }}>
                          {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                          <s-text tone="subdued" size="small">
                            <strong>在庫高自動保存のトークン有効期限：{expStr}</strong>
                            <br />
                            管理画面を開くと自動で延長更新されます。
                            <br />
                            期限を過ぎた場合のデータ保証はいたしかねますので、あらかじめご了承ください。
                          </s-text>
                        </div>
                      );
                    })()}

                  {/* フィルター領域（白背景カード） */}
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: 12,
                      boxShadow: "0 0 0 1px #e1e3e5",
                      padding: 16,
                      minWidth: 0,
                      overflow: "hidden",
                    }}
                  >
                    {/* @ts-expect-error s-stack は App Bridge の Web コンポーネント */}
                    <s-stack gap="base">
                      {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                      <s-text emphasis="bold" size="large">フィルター</s-text>
                      {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                      <s-text tone="subdued" size="small">
                        ロケーションを選ぶと一覧が絞り込まれます。
                      </s-text>
                      {/* @ts-expect-error s-divider は App Bridge の Web コンポーネント */}
                      <s-divider />
                      
                      {/* 日付選択＋本日集計（同一行・改行なし・スマホではみ出さない） */}
                      {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                      <s-text emphasis="bold" size="small">日付</s-text>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "row",
                          flexWrap: "nowrap",
                          gap: "8px",
                          width: "100%",
                          maxWidth: "100%",
                          minWidth: 0,
                          overflow: "hidden",
                          alignItems: "center",
                        }}
                      >
                        <div style={{ flex: "1 1 0", minWidth: 0, overflow: "hidden" }}>
                          <input
                            type="date"
                            value={dateValue}
                            onChange={handleDateChange}
                            min={firstSnapshotDate}
                            max={todayInShopTimezone}
                            style={{
                              padding: "8px 12px",
                              border: "1px solid #d1d5db",
                              borderRadius: "6px",
                              fontSize: "14px",
                              width: "100%",
                              maxWidth: "100%",
                              minWidth: 0,
                              boxSizing: "border-box",
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            fetcher.submit(
                              { intent: "saveTodaySnapshot" },
                              { method: "post" }
                            );
                            const params = new URLSearchParams(searchParams);
                            params.set("date", todayInShopTimezone);
                            setSearchParams(params);
                            setDateValue(todayInShopTimezone);
                          }}
                          disabled={fetcher.state === "submitting"}
                          style={{
                            padding: "8px 16px",
                            backgroundColor: fetcher.state === "submitting" ? "#9ca3af" : "#2563eb",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            fontSize: "14px",
                            fontWeight: 600,
                            cursor: fetcher.state === "submitting" ? "not-allowed" : "pointer",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                        >
                          {fetcher.state === "submitting" ? "保存中..." : "本日集計"}
                        </button>
                      </div>
                      {/* 本日集計の注釈 */}
                      <div style={{ marginTop: "4px" }}>
                        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                        <s-text tone="subdued" size="small">
                          本日集計表示はSKU数ロケーション数により時間を要する可能性があります。
                        </s-text>
                      </div>
                      {/* 最初のスナップショット日付を表示 */}
                      {firstSnapshotDate && (
                        <div style={{ marginTop: "4px" }}>
                          {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                          <s-text tone="subdued" size="small">
                            {firstSnapshotDate.replace(/-/g, "/")}以降の履歴を確認できます。
                          </s-text>
                        </div>
                      )}
                      
                      {/* ロケーション選択 */}
                      {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                      <s-text emphasis="bold" size="small">ロケーション</s-text>
                      <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                        <div
                          onClick={handleSelectAllLocations}
                          style={{
                            padding: "10px 12px",
                            borderRadius: "6px",
                            cursor: "pointer",
                            backgroundColor: locationFilters.size === 0 ? "#eff6ff" : "transparent",
                            border: locationFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <input type="checkbox" checked={locationFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                          <span style={{ fontWeight: locationFilters.size === 0 ? 600 : 500 }}>全て</span>
                        </div>
                        {locations.map((loc) => {
                          const isSelected = locationFilters.has(loc.id);
                          return (
                            <div
                              key={loc.id}
                              onClick={() => handleLocationFilterChange(loc.id)}
                              style={{
                                padding: "10px 12px",
                                borderRadius: "6px",
                                cursor: "pointer",
                                backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                marginTop: "4px",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                              <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                            </div>
                          );
                        })}
                      </div>
                    </s-stack>
                  </div>
                </s-stack>
              </div>

              {/* 右: 在庫高表示領域 */}
              <div style={{ flex: "1 1 400px", minWidth: 0, width: "100%" }}>
                <div
                  style={{
                    background: "#ffffff",
                    borderRadius: 12,
                    boxShadow: "0 0 0 1px #e1e3e5",
                    padding: 16,
                  }}
                >
                  {/* @ts-expect-error s-stack は App Bridge の Web コンポーネント */}
                  <s-stack gap="base">

                {!isToday && snapshots.length === 0 && (
                  <div
                    style={{
                      padding: "12px 16px",
                      backgroundColor: "#fff3cd",
                      border: "1px solid #ffc107",
                      borderRadius: "8px",
                      color: "#856404",
                      fontSize: "14px",
                    }}
                  >
                    <div>{selectedDate.replace(/-/g, "/")}の在庫高データが見つかりませんでした。</div>
                  </div>
                )}

                {/* サマリーカード */}
                {snapshots.length > 0 && (
                  <div style={{ marginTop: "16px" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "12px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#202223",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                        }}
                      >
                        合計
                      </div>
                      <button
                        onClick={() => {
                          // CSV出力処理
                          const headers = [
                            "日付",
                            "モード",
                            "ショップ",
                            "ロケーションID",
                            "ロケーション名",
                            "合計数量",
                            "販売価格合計",
                            "割引前価格合計",
                            "原価合計",
                          ];

                          const rows = snapshots.map((snapshot) => [
                            selectedDate,
                            isToday ? "現在" : "確定",
                            shopName,
                            snapshot.locationId.replace("gid://shopify/Location/", ""),
                            snapshot.locationName,
                            String(snapshot.totalQuantity),
                            String(snapshot.totalRetailValue),
                            String(snapshot.totalCompareAtPriceValue),
                            String(snapshot.totalCostValue),
                          ]);

                          // 合計行を追加
                          const totalRow = [
                            selectedDate,
                            isToday ? "現在" : "確定",
                            shopName,
                            "",
                            "合計",
                            String(summary.totalQuantity),
                            String(summary.totalRetailValue),
                            String(summary.totalCompareAtPriceValue),
                            String(summary.totalCostValue),
                          ];

                          const csvContent = [headers, ...rows, totalRow]
                            .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
                            .join("\n");

                          // BOM付きUTF-8でダウンロード
                          const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
                          const url = URL.createObjectURL(blob);
                          const link = document.createElement("a");
                          link.href = url;
                          link.download = `在庫情報_${selectedDate}.csv`;
                          link.click();
                          URL.revokeObjectURL(url);
                        }}
                        style={{
                          padding: "8px 16px",
                          backgroundColor: "#2563eb",
                          color: "#ffffff",
                          border: "none",
                          borderRadius: "6px",
                          fontSize: "14px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        CSV出力
                      </button>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                        gap: "16px",
                      }}
                    >
                      {/* 合計数量 */}
                      <div
                        style={{
                          padding: "16px 20px",
                          borderRadius: "8px",
                          border: "1px solid #e1e3e5",
                          backgroundColor: "#ffffff",
                          minWidth: 0,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#6b7280",
                            marginBottom: "8px",
                          }}
                        >
                          合計数量
                        </div>
                        <div
                          style={{
                            fontSize: "clamp(12px, 2.5vw, 20px)",
                            fontWeight: 700,
                            color: "#202223",
                            lineHeight: "1.2",
                            wordBreak: "break-all",
                            overflowWrap: "break-word",
                          }}
                        >
                          {summary.totalQuantity.toLocaleString()}
                        </div>
                      </div>
                      
                      {/* 販売価格合計 */}
                      <div
                        style={{
                          padding: "16px 20px",
                          borderRadius: "8px",
                          border: "1px solid #e1e3e5",
                          backgroundColor: "#ffffff",
                          minWidth: 0,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#6b7280",
                            marginBottom: "8px",
                          }}
                        >
                          販売価格合計
                        </div>
                        <div
                          style={{
                            fontSize: "clamp(12px, 2.5vw, 20px)",
                            fontWeight: 700,
                            color: "#202223",
                            lineHeight: "1.2",
                            wordBreak: "break-all",
                            overflowWrap: "break-word",
                          }}
                        >
                          ¥{Math.round(summary.totalRetailValue).toLocaleString()}
                        </div>
                      </div>
                      
                      {/* 割引前価格合計 */}
                      <div
                        style={{
                          padding: "16px 20px",
                          borderRadius: "8px",
                          border: "1px solid #e1e3e5",
                          backgroundColor: "#ffffff",
                          minWidth: 0,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#6b7280",
                            marginBottom: "8px",
                          }}
                        >
                          割引前価格合計
                        </div>
                        <div
                          style={{
                            fontSize: "clamp(12px, 2.5vw, 20px)",
                            fontWeight: 700,
                            color: "#202223",
                            lineHeight: "1.2",
                            wordBreak: "break-all",
                            overflowWrap: "break-word",
                          }}
                        >
                          ¥{Math.round(summary.totalCompareAtPriceValue).toLocaleString()}
                        </div>
                      </div>
                      
                      {/* 原価合計 */}
                      <div
                        style={{
                          padding: "16px 20px",
                          borderRadius: "8px",
                          border: "1px solid #e1e3e5",
                          backgroundColor: "#ffffff",
                          minWidth: 0,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#6b7280",
                            marginBottom: "8px",
                          }}
                        >
                          原価合計
                        </div>
                        <div
                          style={{
                            fontSize: "clamp(12px, 2.5vw, 20px)",
                            fontWeight: 700,
                            color: "#202223",
                            lineHeight: "1.2",
                            wordBreak: "break-all",
                            overflowWrap: "break-word",
                          }}
                        >
                          ¥{Math.round(summary.totalCostValue).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* 本日選択かつ未集計時はメッセージのみ表示 */}
                {snapshots.length === 0 && isToday && (
                  <div style={{ marginTop: "16px", padding: "16px", background: "#f6f6f7", borderRadius: "8px", border: "1px solid #e1e3e5" }}>
                    {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                    <s-text tone="subdued" size="small">
                      本日集計を実行すると表示されます。上記フィルターの「本日集計」ボタンを押してください。
                    </s-text>
                  </div>
                )}
                {/* 在庫高テーブル */}
                {snapshots.length > 0 && (
                  <div style={{ marginTop: "16px", width: "100%", overflowX: "auto", overflowY: "visible" }}>
                    <table
                      style={{
                        width: "100%",
                        minWidth: "600px",
                        borderCollapse: "collapse",
                        fontSize: "14px",
                      }}
                    >
                      <thead>
                        <tr
                          style={{
                            backgroundColor: "#f6f6f7",
                            borderBottom: "2px solid #e1e3e5",
                          }}
                        >
                          <th
                            style={{
                              padding: "12px 16px",
                              textAlign: "left",
                              fontWeight: 600,
                              fontSize: "12px",
                              color: "#202223",
                              whiteSpace: "nowrap",
                            }}
                          >
                            ロケーション
                          </th>
                          <th
                            style={{
                              padding: "12px 16px",
                              textAlign: "right",
                              fontWeight: 600,
                              fontSize: "12px",
                              color: "#202223",
                              whiteSpace: "nowrap",
                            }}
                          >
                            合計数量
                          </th>
                          <th
                            style={{
                              padding: "12px 16px",
                              textAlign: "right",
                              fontWeight: 600,
                              fontSize: "12px",
                              color: "#202223",
                              whiteSpace: "nowrap",
                            }}
                          >
                            販売価格合計
                          </th>
                          <th
                            style={{
                              padding: "12px 16px",
                              textAlign: "right",
                              fontWeight: 600,
                              fontSize: "12px",
                              color: "#202223",
                              whiteSpace: "nowrap",
                            }}
                          >
                            割引前価格合計
                          </th>
                          <th
                            style={{
                              padding: "12px 16px",
                              textAlign: "right",
                              fontWeight: 600,
                              fontSize: "12px",
                              color: "#202223",
                              whiteSpace: "nowrap",
                            }}
                          >
                            原価合計
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshots.map((snapshot, index) => (
                          <tr
                            key={snapshot.locationId}
                            style={{
                              borderBottom: index < snapshots.length - 1 ? "1px solid #e1e3e5" : "none",
                            }}
                          >
                            <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>{snapshot.locationName}</td>
                            <td style={{ padding: "12px 16px", textAlign: "right", whiteSpace: "nowrap" }}>
                              {snapshot.totalQuantity.toLocaleString()}
                            </td>
                            <td style={{ padding: "12px 16px", textAlign: "right", whiteSpace: "nowrap" }}>
                              ¥{Math.round(snapshot.totalRetailValue).toLocaleString()}
                            </td>
                            <td style={{ padding: "12px 16px", textAlign: "right", whiteSpace: "nowrap" }}>
                              ¥{Math.round(snapshot.totalCompareAtPriceValue).toLocaleString()}
                            </td>
                            <td style={{ padding: "12px 16px", textAlign: "right", whiteSpace: "nowrap" }}>
                              ¥{Math.round(snapshot.totalCostValue).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {/* 表示中のスナップショットの保存日時（今日・過去日とも選択日付の保存情報を表示） */}
                    {snapshotDisplayUpdatedAt && (() => {
                      const date = new Date(snapshotDisplayUpdatedAt);
                      const formatted = new Intl.DateTimeFormat("ja-JP", {
                        timeZone: shopTimezone,
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(date).replace(/\//g, "/").replace(/,/g, "");
                      const parts = formatted.split(" ");
                      const datePart = parts[0] || "";
                      const timePart = parts[1] || "";
                      const displayTime = `${datePart} ${timePart}`;
                      return (
                        <div style={{ marginTop: "12px", textAlign: "left" }}>
                          {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                          <s-text tone="subdued" size="small" style={{ fontSize: "12px" }}>
                            保存日時：{displayTime}
                          </s-text>
                        </div>
                      );
                    })()}
                  </div>
                )}
                  </s-stack>
                </div>
              </div>
            </div>
            )}

            {/* 在庫変動履歴タブ */}
            {activeTab === "change-history" && (
              <div>
                <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                  {/* 左：タイトル＋説明 ＋ フィルター（カード内を白背景に） */}
                  <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                    <s-stack gap="base">
                      {/* 画面タイトル（太字）＋説明テキスト */}
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 14,
                            marginBottom: 4,
                          }}
                        >
                          在庫変動履歴
                        </div>
                        <s-text tone="subdued" size="small">
                          条件で絞り込みを行い、在庫変動履歴を表示します。
                        </s-text>
                      </div>

                      {/* トークン有効期限（在庫高と同じトークンを履歴記録にも使用） */}
                      {snapshotRefreshTokenExpires && (() => {
                        const exp = new Date(snapshotRefreshTokenExpires);
                        const expStr = `${exp.getFullYear()}/${exp.getMonth() + 1}/${exp.getDate()}`;
                        return (
                          <div style={{ marginTop: 8, padding: "10px 12px", background: "#f6f6f7", borderRadius: 8, border: "1px solid #e1e3e5" }}>
                            {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                            <s-text tone="subdued" size="small">
                              <strong>在庫変動履歴自動保存のトークン有効期限：{expStr}</strong>
                              <br />
                              管理画面を開くと自動で延長更新されます。
                              <br />
                              期限を過ぎた場合のデータ保証はいたしかねますので、あらかじめご了承ください。
                            </s-text>
                          </div>
                        );
                      })()}

                      {/* フィルター領域（ここだけ白背景カード） */}
                      <div
                        style={{
                          background: "#ffffff",
                          borderRadius: 12,
                          boxShadow: "0 0 0 1px #e1e3e5",
                          padding: 16,
                        }}
                      >
                        <s-stack gap="base">
                          <s-text emphasis="bold" size="large">フィルター</s-text>
                          <s-text tone="subdued" size="small">
                            条件を選ぶと一覧が絞り込まれます。
                          </s-text>
                          <s-divider />

                          {/* 期間選択 */}
                          <s-text emphasis="bold" size="small">期間</s-text>
                          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                              <label style={{ fontSize: "14px", fontWeight: 500, flexShrink: 0, minWidth: "70px" }}>開始日:</label>
                              <input
                                type="date"
                                value={changeHistoryStartDate}
                                onChange={(e) => setChangeHistoryStartDate(e.target.value)}
                                min={firstChangeHistoryDate || todayInShopTimezone}
                                max={todayInShopTimezone}
                                style={{
                                  padding: "8px 12px",
                                  border: "1px solid #d1d5db",
                                  borderRadius: "6px",
                                  fontSize: "14px",
                                  boxSizing: "border-box",
                                  flex: "1 1 0",
                                  minWidth: 0,
                                }}
                              />
                            </div>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                              <label style={{ fontSize: "14px", fontWeight: 500, flexShrink: 0, minWidth: "70px" }}>終了日:</label>
                              <input
                                type="date"
                                value={changeHistoryEndDate}
                                onChange={(e) => setChangeHistoryEndDate(e.target.value)}
                                min={firstChangeHistoryDate || todayInShopTimezone}
                                max={todayInShopTimezone}
                                style={{
                                  padding: "8px 12px",
                                  border: "1px solid #d1d5db",
                                  borderRadius: "6px",
                                  fontSize: "14px",
                                  boxSizing: "border-box",
                                  flex: "1 1 0",
                                  minWidth: 0,
                                }}
                              />
                            </div>
                          </div>

                          {/* ロケーション選択 */}
                          <s-text emphasis="bold" size="small">ロケーション</s-text>
                          <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                            <div
                              onClick={() => {
                                setChangeHistoryLocationFilters(new Set());
                              }}
                              style={{
                                padding: "10px 12px",
                                borderRadius: "6px",
                                cursor: "pointer",
                                backgroundColor: changeHistoryLocationFilters.size === 0 ? "#eff6ff" : "transparent",
                                border: changeHistoryLocationFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <input type="checkbox" checked={changeHistoryLocationFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                              <span style={{ fontWeight: changeHistoryLocationFilters.size === 0 ? 600 : 500 }}>全て</span>
                            </div>
                            {locations.map((location) => {
                              const isSelected = changeHistoryLocationFilters.has(location.id);
                              return (
                                <div
                                  key={location.id}
                                  onClick={() => handleChangeHistoryLocationFilterChange(location.id)}
                                  style={{
                                    padding: "10px 12px",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                    border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                    marginTop: "4px",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                  }}
                                >
                                  <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                                  <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{location.name}</span>
                                </div>
                              );
                            })}
                          </div>

                          {/* 商品検索 */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <s-text emphasis="bold" size="small">商品検索</s-text>
                            <div style={{ display: "flex", gap: "8px" }}>
                              <button
                                type="button"
                                onClick={() => setChangeHistoryShowSelectedProducts(!changeHistoryShowSelectedProducts)}
                                disabled={changeHistorySelectedInventoryItemIds.size === 0}
                                style={{
                                  padding: "4px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #d1d5db",
                                  backgroundColor: changeHistoryShowSelectedProducts && changeHistorySelectedInventoryItemIds.size > 0 ? "#eff6ff" : (changeHistorySelectedInventoryItemIds.size === 0 ? "#f3f4f6" : "#ffffff"),
                                  color: changeHistorySelectedInventoryItemIds.size === 0 ? "#9ca3af" : "#202223",
                                  fontSize: "12px",
                                  fontWeight: 500,
                                  cursor: changeHistorySelectedInventoryItemIds.size === 0 ? "not-allowed" : "pointer",
                                }}
                              >
                                選択済み ({changeHistorySelectedInventoryItemIds.size})
                              </button>
                              <button
                                type="button"
                                onClick={handleChangeHistoryProductDeselectAll}
                                disabled={changeHistorySelectedInventoryItemIds.size === 0}
                                style={{
                                  padding: "4px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #d1d5db",
                                  backgroundColor: changeHistorySelectedInventoryItemIds.size === 0 ? "#f3f4f6" : "#ffffff",
                                  color: changeHistorySelectedInventoryItemIds.size === 0 ? "#9ca3af" : "#d72c0d",
                                  fontSize: "12px",
                                  fontWeight: 500,
                                  cursor: changeHistorySelectedInventoryItemIds.size === 0 ? "not-allowed" : "pointer",
                                }}
                              >
                                選択解除
                              </button>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <input
                              type="text"
                              value={changeHistoryProductSearchQuery}
                              onChange={(e) => setChangeHistoryProductSearchQuery(e.target.value)}
                              placeholder="SKU・商品名・JANの一部を入力"
                              style={{
                                padding: "8px 12px",
                                border: "1px solid #d1d5db",
                                borderRadius: "6px",
                                fontSize: "14px",
                                flex: "1 1 auto",
                                boxSizing: "border-box",
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  handleChangeHistoryProductSearch();
                                }
                              }}
                            />
                            <button
                              type="button"
                              onClick={handleChangeHistoryProductSearch}
                              disabled={!changeHistoryProductSearchQuery.trim() || fetcher.state === "submitting"}
                              style={{
                                padding: "6px 12px",
                                backgroundColor: !changeHistoryProductSearchQuery.trim() || fetcher.state === "submitting" ? "#d1d5db" : "#2563eb",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "6px",
                                fontSize: "13px",
                                fontWeight: 500,
                                cursor: !changeHistoryProductSearchQuery.trim() || fetcher.state === "submitting" ? "not-allowed" : "pointer",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {fetcher.state === "submitting" ? "検索中..." : "検索"}
                            </button>
                          </div>
                          {(changeHistorySearchVariants.length > 0 || (changeHistoryShowSelectedProducts && changeHistorySelectedProductsInfo.size > 0)) && (
                            <>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                <s-text tone="subdued" size="small">
                                  {changeHistorySelectedInventoryItemIds.size > 0
                                    ? `選択中: ${changeHistorySelectedInventoryItemIds.size}件 / 表示: ${changeHistoryShowSelectedProducts ? Array.from(changeHistorySelectedProductsInfo.values()).length : changeHistorySearchVariants.length}件`
                                    : `表示: ${changeHistorySearchVariants.length}件`}
                                </s-text>
                              </div>
                              <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                                {/* 選択済みボタンが押されている場合は選択済み商品のみ表示、押されていない場合は検索結果を表示 */}
                                {changeHistoryShowSelectedProducts ? (
                                  /* 選択済み商品のみ表示 */
                                  Array.from(changeHistorySelectedProductsInfo.values()).map((v) => {
                                    const isSelected = changeHistorySelectedInventoryItemIds.has(v.inventoryItemId);
                                    return (
                                      <div
                                        key={`selected-${v.inventoryItemId}`}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => handleChangeHistoryProductSelect(v.inventoryItemId, v)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            handleChangeHistoryProductSelect(v.inventoryItemId, v);
                                          }
                                        }}
                                        style={{
                                          padding: "10px 12px",
                                          borderRadius: "6px",
                                          cursor: "pointer",
                                          backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                          border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                          marginTop: "4px",
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "8px",
                                        }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isSelected}
                                          readOnly
                                          style={{ width: "16px", height: "16px", flexShrink: 0 }}
                                        />
                                        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                          <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                                            {v.title || "(商品名なし)"}
                                          </span>
                                          {v.sku ? (
                                            <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>SKU：{v.sku}</span>
                                          ) : null}
                                          {v.barcode ? (
                                            <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>JAN：{v.barcode}</span>
                                          ) : null}
                                        </div>
                                      </div>
                                    );
                                  })
                                ) : (
                                  /* 検索結果を表示 */
                                  changeHistorySearchVariants.map((v) => {
                                    const isSelected = changeHistorySelectedInventoryItemIds.has(v.inventoryItemId);
                                    return (
                                      <div
                                        key={v.variantId}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => handleChangeHistoryProductSelect(v.inventoryItemId, v)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            handleChangeHistoryProductSelect(v.inventoryItemId, v);
                                          }
                                        }}
                                        style={{
                                          padding: "10px 12px",
                                          borderRadius: "6px",
                                          cursor: "pointer",
                                          backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                          border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                          marginTop: "4px",
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "8px",
                                        }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isSelected}
                                          readOnly
                                          style={{ width: "16px", height: "16px", flexShrink: 0 }}
                                        />
                                        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                          <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                                            {v.title || "(商品名なし)"}
                                          </span>
                                          {v.sku ? (
                                            <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>SKU：{v.sku}</span>
                                          ) : null}
                                          {v.barcode ? (
                                            <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>JAN：{v.barcode}</span>
                                          ) : null}
                                        </div>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            </>
                          )}

                          {/* アクティビティ種別 */}
                          <s-text emphasis="bold" size="small">アクティビティ種別</s-text>
                          <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                            <div
                              onClick={() => setChangeHistoryActivityTypes(new Set())}
                              style={{
                                padding: "10px 12px",
                                borderRadius: "6px",
                                cursor: "pointer",
                                backgroundColor: changeHistoryActivityTypes.size === 0 ? "#eff6ff" : "transparent",
                                border: changeHistoryActivityTypes.size === 0 ? "1px solid #2563eb" : "1px solid transparent",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <input type="checkbox" checked={changeHistoryActivityTypes.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                              <span style={{ fontWeight: changeHistoryActivityTypes.size === 0 ? 600 : 500 }}>全て</span>
                            </div>
                            {[
                              { value: "inbound_transfer", label: "入庫" },
                              { value: "outbound_transfer", label: "出庫" },
                              { value: "loss_entry", label: "ロス" },
                              { value: "inventory_count", label: "棚卸" },
                              { value: "purchase_entry", label: "仕入" },
                              { value: "purchase_cancel", label: "仕入" },
                              { value: "order_sales", label: "売上" },
                              { value: "refund", label: "返品" },
                              { value: "order_cancel", label: "返品" },
                              { value: "admin_webhook", label: "管理" },
                            ].map((activity) => {
                              const isSelected = changeHistoryActivityTypes.has(activity.value);
                              return (
                                <div
                                  key={activity.value}
                                  onClick={() => handleChangeHistoryActivityFilterChange(activity.value)}
                                  style={{
                                    padding: "10px 12px",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                    border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                    marginTop: "4px",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                  }}
                                >
                                  <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                                  <span style={{ fontWeight: isSelected ? 600 : 500 }}>{activity.label}</span>
                                </div>
                              );
                            })}
                          </div>

                          {/* 並び順 */}
                          <s-text emphasis="bold" size="small">並び順</s-text>
                          <div style={{ display: "flex", gap: "12px" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                              <input
                                type="radio"
                                name="sortOrder"
                                value="desc"
                                checked={changeHistorySortOrder === "desc"}
                                onChange={(e) => setChangeHistorySortOrder(e.target.value as "asc" | "desc")}
                              />
                              <span>新しい順</span>
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                              <input
                                type="radio"
                                name="sortOrder"
                                value="asc"
                                checked={changeHistorySortOrder === "asc"}
                                onChange={(e) => setChangeHistorySortOrder(e.target.value as "asc" | "desc")}
                              />
                              <span>古い順</span>
                            </label>
                          </div>

                          {/* フィルター適用ボタン */}
                          <button
                            onClick={handleChangeHistoryFilterChange}
                            style={{
                              padding: "8px 16px",
                              backgroundColor: "#2563eb",
                              color: "#ffffff",
                              border: "none",
                              borderRadius: "6px",
                              fontSize: "14px",
                              fontWeight: 600,
                              cursor: "pointer",
                              width: "100%",
                            }}
                          >
                            フィルター適用
                          </button>
                        </s-stack>
                      </div>
                    </s-stack>
                  </div>

                  {/* 右：履歴リスト（白カードで囲む） */}
                  <div style={{ flex: "1 1 400px", minWidth: 0, width: "100%" }}>
                    <div
                      style={{
                        background: "#ffffff",
                        borderRadius: 12,
                        boxShadow: "0 0 0 1px #e1e3e5",
                        padding: 16,
                      }}
                    >
                      <s-stack gap="base">
                        {/* 一覧表示 */}
                        {!hasExplicitFilters ? (
                          <div style={{ padding: "24px", textAlign: "center" }}>
                            <s-text tone="subdued" size="large">
                              フィルターを設定して「フィルター適用」ボタンを押すと、在庫変動履歴が表示されます。
                            </s-text>
                          </div>
                        ) : changeHistoryLogs && changeHistoryLogs.length > 0 ? (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                              <s-text tone="subdued" size="small">
                                {chRangeDisplay} / {chTotalDisplay}
                              </s-text>
                              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                                {chHasPagination && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (chPagination.hasPreviousPage && chPagination.currentPage > 1) {
                                          const params = new URLSearchParams(searchParams);
                                          params.set("changeHistoryPage", String(chPagination.currentPage - 1));
                                          setSearchParams(params, { replace: true });
                                        }
                                      }}
                                      disabled={!chPagination.hasPreviousPage}
                                      style={{
                                        padding: "6px 12px",
                                        backgroundColor: chPagination.hasPreviousPage ? "#f6f6f7" : "#f3f4f6",
                                        color: chPagination.hasPreviousPage ? "#202223" : "#9ca3af",
                                        border: "1px solid #e1e3e5",
                                        borderRadius: "6px",
                                        fontSize: "14px",
                                        cursor: chPagination.hasPreviousPage ? "pointer" : "not-allowed",
                                      }}
                                    >
                                      前へ
                                    </button>
                                    <span style={{ fontSize: "14px", color: "#666", lineHeight: "1.5" }}>
                                      {chPageDisplay}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (chPagination.hasNextPage) {
                                          const params = new URLSearchParams(searchParams);
                                          params.set("changeHistoryPage", String(chPagination.currentPage + 1));
                                          setSearchParams(params, { replace: true });
                                        }
                                      }}
                                      disabled={!chPagination.hasNextPage}
                                      style={{
                                        padding: "6px 12px",
                                        backgroundColor: chPagination.hasNextPage ? "#f6f6f7" : "#f3f4f6",
                                        color: chPagination.hasNextPage ? "#202223" : "#9ca3af",
                                        border: "1px solid #e1e3e5",
                                        borderRadius: "6px",
                                        fontSize: "14px",
                                        cursor: chPagination.hasNextPage ? "pointer" : "not-allowed",
                                      }}
                                    >
                                      次へ
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  disabled={changeHistoryCsvExporting}
                                  onClick={async () => {
                                    // 埋め込みアプリでは別タブのPOSTが認証されず同じページが開くため、同一コンテキストでfetchしてダウンロードする
                                    setChangeHistoryCsvExporting(true);
                                    const formData = new FormData();
                                    formData.set("intent", "exportChangeHistoryCsv");
                                    formData.set("startDate", changeHistoryStartDate);
                                    formData.set("endDate", changeHistoryEndDate);
                                    formData.set("sortOrder", changeHistorySortOrder);
                                    if (changeHistoryLocationFilters.size > 0) {
                                      formData.set("changeHistoryLocationIds", Array.from(changeHistoryLocationFilters).join(","));
                                    }
                                    if (changeHistorySelectedInventoryItemIds.size > 0) {
                                      formData.set("inventoryItemIds", Array.from(changeHistorySelectedInventoryItemIds).join(","));
                                    }
                                    if (changeHistoryActivityTypes.size > 0) {
                                      formData.set("activityTypes", Array.from(changeHistoryActivityTypes).join(","));
                                    }
                                    try {
                                      const res = await fetch(location.pathname + (location.search || ""), {
                                        method: "POST",
                                        body: formData,
                                        credentials: "include",
                                      });
                                      const contentType = res.headers.get("Content-Type") || "";
                                      if (res.ok && contentType.includes("text/csv")) {
                                        const blob = await res.blob();
                                        const disp = res.headers.get("Content-Disposition");
                                        const match = disp && /filename\*?=(?:UTF-8'')?([^;]+)/i.exec(disp);
                                        const raw = match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
                                        const filename = raw ? (raw.startsWith("%") ? decodeURIComponent(raw) : raw) : `在庫変動履歴_${changeHistoryStartDate}_${changeHistoryEndDate}.csv`;
                                        const a = document.createElement("a");
                                        a.href = URL.createObjectURL(blob);
                                        a.download = filename;
                                        a.click();
                                        URL.revokeObjectURL(a.href);
                                      } else {
                                        const text = await res.text();
                                        const errMsg = text.includes("CSV出力エラー") || text.includes("<!DOCTYPE") ? (text.match(/<p[^>]*>([^<]+)</)?.[1] || "CSVの出力に失敗しました。") : text.slice(0, 200);
                                        alert(errMsg);
                                      }
                                    } catch (e) {
                                      console.error("[inventory-info] CSV export fetch failed:", e);
                                      alert("CSVの出力に失敗しました。");
                                    } finally {
                                      setChangeHistoryCsvExporting(false);
                                    }
                                  }}
                                  style={{
                                    padding: "8px 16px",
                                    backgroundColor: changeHistoryCsvExporting ? "#9ca3af" : "#2563eb",
                                    color: "#ffffff",
                                    border: "none",
                                    borderRadius: "6px",
                                    fontSize: "14px",
                                    fontWeight: 600,
                                    cursor: changeHistoryCsvExporting ? "not-allowed" : "pointer",
                                  }}
                                >
                                  {changeHistoryCsvExporting ? "出力中…" : "CSV出力"}
                                </button>
                            </div>
                            </div>
                            <div style={{ maxHeight: "600px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                                <thead>
                                  <tr style={{ backgroundColor: "#f6f6f7", borderBottom: "2px solid #e1e3e5" }}>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>発生日時</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>商品名</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>SKU</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>JAN</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>オプション1</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>オプション2</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>オプション3</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>ロケーション</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>アクティビティ</th>
                                    <th style={{ padding: "12px 16px", textAlign: "right", fontWeight: 600, fontSize: "12px", color: "#202223" }}>変動数</th>
                                    <th style={{ padding: "12px 16px", textAlign: "right", fontWeight: 600, fontSize: "12px", color: "#202223" }}>変動後在庫数</th>
                                    <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, fontSize: "12px", color: "#202223" }}>参照ID</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {changeHistoryLogs.map((log) => (
                                    <tr key={log.id} style={{ borderBottom: "1px solid #e1e3e5" }}>
                                      <td style={{ padding: "12px 16px" }}>
                                        {formatDateTimeInShopTimezone(log.timestamp, shopTimezone)}
                                      </td>
                                      <td style={{ padding: "12px 16px" }}>{log.productTitle || log.sku || "-"}</td>
                                      <td style={{ padding: "12px 16px" }}>{log.sku || "-"}</td>
                                      <td style={{ padding: "12px 16px" }}>{log.barcode || "-"}</td>
                                      <td style={{ padding: "12px 16px" }}>{log.option1 || "-"}</td>
                                      <td style={{ padding: "12px 16px" }}>{log.option2 || "-"}</td>
                                      <td style={{ padding: "12px 16px" }}>{log.option3 || "-"}</td>
                                      <td style={{ padding: "12px 16px" }}>{log.locationName}</td>
                                      <td style={{ padding: "12px 16px" }}>{getActivityDisplayLabel(log.activity)}</td>
                                      <td style={{ padding: "12px 16px", textAlign: "right", color: log.delta != null && log.delta > 0 ? "#008060" : log.delta != null && log.delta < 0 ? "#d72c0d" : "#202223" }}>
                                        {log.delta !== null ? (log.delta > 0 ? `+${log.delta}` : String(log.delta)) : "-"}
                                      </td>
                                      <td style={{ padding: "12px 16px", textAlign: "right" }}>
                                        {log.quantityAfter !== null ? String(log.quantityAfter) : "-"}
                                      </td>
                                      <td style={{ padding: "12px 16px", fontSize: "12px", color: "#666" }}>
                                        {log.sourceId ? (log.sourceId.length > 30 ? `${log.sourceId.substring(0, 30)}...` : log.sourceId) : "-"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {/* 注釈情報 */}
                            <div style={{ marginTop: "12px", padding: "8px 12px", backgroundColor: "#f6f6f7", borderRadius: "6px", border: "1px solid #e1e3e5" }}>
                              <s-text tone="subdued" size="small" style={{ fontSize: "11px", lineHeight: "1.4" }}>
                                管理画面からの在庫数量変更：対象SKUとロケーションの変動が初回の場合は変動数が「-」表記になります。
                                <br />
                                CSVダウンロード制限：一括処理最大50,000件となっています。超過する場合は検索条件にて件数のご調整をお願いします。
                              </s-text>
                            </div>
                          </>
                        ) : (
                          <div style={{ padding: "24px", textAlign: "center" }}>
                            <s-text tone="subdued" size="large">
                              在庫変動履歴が見つかりませんでした
                            </s-text>
                          </div>
                        )}
                      </s-stack>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </s-box>
        </s-stack>
      </s-scroll-box>
      </s-page>
    </>
  );
}
