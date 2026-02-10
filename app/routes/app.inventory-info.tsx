// app/routes/app.inventory-info.tsx
// 在庫情報画面（在庫高表示・変動履歴）
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, useFetcher } from "react-router";
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

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, session } = await authenticate.admin(request);
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
  
  const selectedDate = url.searchParams.get("date") || todayInShopTimezone;

  // 今日の場合はリアルタイムで在庫情報を取得（共通モジュールで取得・集計）
  const today = todayInShopTimezone;
  const isToday = selectedDate === today;
  
  const snapshotDates = savedSnapshots.snapshots.map((s) => s.date).sort();
  const firstSnapshotDate = snapshotDates.length > 0 ? snapshotDates[0] : todayInShopTimezone;

  const [y, m, d] = todayInShopTimezone.split("-").map(Number);
  const yesterdayDate = new Date(y, m - 1, d - 1);
  const yesterdayDateStr = yesterdayDate.toISOString().slice(0, 10);
  const hasYesterdaySnapshot = savedSnapshots.snapshots.some((s) => s.date === yesterdayDateStr);

  const snapshotForDate = savedSnapshots.snapshots
    .filter((s) => s.date === selectedDate)
    .map((s) => ({
      ...s,
      totalCompareAtPriceValue: s.totalCompareAtPriceValue ?? s.totalRetailValue ?? 0,
    }));

  let currentInventory: DailyInventorySnapshot[] = [];
  if (isToday) {
    const allItems = await fetchAllInventoryItems(adminForSnapshot);
    currentInventory = aggregateSnapshotsFromItems(allItems, todayInShopTimezone);
  }

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

    // 在庫変動履歴用のデータ取得（タブが「change-history」の場合）
    const tab = url.searchParams.get("tab") || "inventory-level";
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

    let changeHistoryLogs: any[] = [];
    if (tab === "change-history" && session) {
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

        // PrismaクライアントがInventoryChangeLogを認識しているか確認
        if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
          changeHistoryLogs = await (db as any).inventoryChangeLog.findMany({
            where: whereClause,
            orderBy: {
              timestamp: sortOrder === "asc" ? "asc" : "desc",
            },
            take: 1000, // 最大1000件まで表示
          });

          // 商品名・オプションをバリアントから一括取得して付与（一覧・CSVを他リストと同等にする）
          const variantIds = [...new Set(changeHistoryLogs.map((l: any) => l.variantId).filter(Boolean))] as string[];
          const variantInfoMap = new Map<string, { productTitle: string; barcode: string; option1: string; option2: string; option3: string }>();
          if (variantIds.length > 0 && session) {
            const CHUNK = 250;
            for (let i = 0; i < variantIds.length; i += CHUNK) {
              const chunk = variantIds.slice(i, i + CHUNK);
              try {
                const resp = await admin.graphql(VARIANTS_FOR_CHANGE_HISTORY_QUERY, { variables: { ids: chunk } });
                const data = await resp.json();
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
                console.warn("[inventory-info] Variant batch for change history failed:", e);
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
        } else {
          console.warn(
            "[inventory-info] InventoryChangeLog model not found in Prisma client. Please restart the dev server."
          );
        }
      } catch (error) {
        console.error("[inventory-info] Error fetching change history logs:", error);
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
      firstChangeHistoryDate,
      // 在庫変動履歴用のデータ
      changeHistoryLogs: changeHistoryLogs || [],
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
    console.error("Inventory info loader error:", error);
    throw new Response(
      error instanceof Error ? error.message : "在庫情報の取得中にエラーが発生しました。",
      { status: 500 }
    );
  }
}

// 商品検索用のaction関数
export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "").trim();

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
  const { locations, selectedDate, selectedLocationIds, snapshots, summary, isToday, shopId, shopName, shopTimezone, todayInShopTimezone, firstSnapshotDate, hasYesterdaySnapshot, yesterdayDateStr, firstChangeHistoryDate, changeHistoryLogs, changeHistoryFilters } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
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

  // アクティビティ種別のラベルマッピング
  const activityLabels: Record<string, string> = {
    inbound_transfer: "入庫",
    outbound_transfer: "出庫",
    loss_entry: "ロス",
    inventory_count: "棚卸",
    purchase_entry: "仕入",
    purchase_cancel: "仕入",
    admin_webhook: "管理",
    order_sales: "売上",
    refund: "返品",
  };

  // 在庫変動履歴のフィルター変更処理（開始日 > 終了日の場合は補正）
  const handleChangeHistoryFilterChange = () => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", "change-history");
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


  // 選択解除
  const handleChangeHistoryProductDeselectAll = () => {
    setChangeHistorySelectedInventoryItemIds(new Set());
    setChangeHistorySelectedProductsInfo(new Map());
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
              <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                {/* 左: フィルター領域 */}
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
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

                  {/* フィルター領域（白背景カード） */}
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
                      {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                      <s-text emphasis="bold" size="large">フィルター</s-text>
                      {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                      <s-text tone="subdued" size="small">
                        ロケーションを選ぶと一覧が絞り込まれます。
                      </s-text>
                      {/* @ts-expect-error s-divider は App Bridge の Web コンポーネント */}
                      <s-divider />
                      
                      {/* 日付選択（スマホで枠がはみ出さないよう親で幅を制約） */}
                      {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                      <s-text emphasis="bold" size="small">日付</s-text>
                      <div style={{ width: "100%", minWidth: 0, overflow: "hidden" }}>
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
                            boxSizing: "border-box",
                          }}
                        />
                      </div>
                      {/* 最初のスナップショット日付を表示 */}
                      {firstSnapshotDate && (
                        <div style={{ marginTop: "4px" }}>
                          {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
                          <s-text tone="subdued" size="small">
                            {firstSnapshotDate.replace(/-/g, "/")}以降の履歴を確認できます
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
                            fontSize: "24px",
                            fontWeight: 700,
                            color: "#202223",
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
                            fontSize: "24px",
                            fontWeight: 700,
                            color: "#202223",
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
                            fontSize: "24px",
                            fontWeight: 700,
                            color: "#202223",
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
                            fontSize: "24px",
                            fontWeight: 700,
                            color: "#202223",
                          }}
                        >
                          ¥{Math.round(summary.totalCostValue).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* 在庫高テーブル */}
                {snapshots.length > 0 && (
                  <div style={{ marginTop: "16px" }}>
                    <table
                      style={{
                        width: "100%",
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
                            <td style={{ padding: "12px 16px" }}>{snapshot.locationName}</td>
                            <td style={{ padding: "12px 16px", textAlign: "right" }}>
                              {snapshot.totalQuantity.toLocaleString()}
                            </td>
                            <td style={{ padding: "12px 16px", textAlign: "right" }}>
                              ¥{Math.round(snapshot.totalRetailValue).toLocaleString()}
                            </td>
                            <td style={{ padding: "12px 16px", textAlign: "right" }}>
                              ¥{Math.round(snapshot.totalCompareAtPriceValue).toLocaleString()}
                            </td>
                            <td style={{ padding: "12px 16px", textAlign: "right" }}>
                              ¥{Math.round(snapshot.totalCostValue).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
                        {changeHistoryLogs && changeHistoryLogs.length > 0 ? (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                              <s-text tone="subdued" size="small">
                                合計: {changeHistoryLogs.length}件
                              </s-text>
                              <button
                                onClick={() => {
                                  // CSV出力処理（商品名・オプションを含め他リストと同等の項目に）
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
                                    "変動後数量",
                                    "参照ID",
                                    "備考",
                                  ];

                                  const rows = changeHistoryLogs.map((log) => [
                                    formatDateTimeInShopTimezone(log.timestamp, shopTimezone),
                                    log.productTitle ?? log.sku ?? "",
                                    log.sku || "",
                                    log.barcode ?? "",
                                    log.option1 ?? "",
                                    log.option2 ?? "",
                                    log.option3 ?? "",
                                    log.locationName || "",
                                    activityLabels[log.activity] || log.activity || "",
                                    log.delta !== null ? String(log.delta) : "",
                                    log.quantityAfter !== null ? String(log.quantityAfter) : "",
                                    log.sourceId || "",
                                    log.note || "",
                                  ]);

                                  const csvContent = [headers, ...rows]
                                    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
                                    .join("\n");

                                  // BOM付きUTF-8でダウンロード
                                  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
                                  const url = URL.createObjectURL(blob);
                                  const link = document.createElement("a");
                                  link.href = url;
                                  const dateRange = changeHistoryStartDate === changeHistoryEndDate 
                                    ? changeHistoryStartDate 
                                    : `${changeHistoryStartDate}_${changeHistoryEndDate}`;
                                  link.download = `在庫変動履歴_${dateRange}.csv`;
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
                                    <th style={{ padding: "12px 16px", textAlign: "right", fontWeight: 600, fontSize: "12px", color: "#202223" }}>変動後数量</th>
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
                                      <td style={{ padding: "12px 16px" }}>{activityLabels[log.activity] || log.activity}</td>
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
