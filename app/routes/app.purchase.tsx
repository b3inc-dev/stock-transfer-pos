// app/routes/app.purchase.tsx
// 仕入履歴管理画面（ロス履歴・発注履歴と同じデザインと機能）
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator, useLocation } from "react-router";
import { useState, useMemo, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import shopify from "../shopify.server";
import type { PurchaseEntry, OrderRequestItem, LocationNode } from "./app.order";
import { getDateInShopTimezone, extractDateFromISO, formatDateTimeInShopTimezone, getShopTimezone } from "../utils/timezone";
import { logInventoryChangesFromAdjustment } from "../utils/inventory-change-log";

const PURCHASE_NS = "stock_transfer_pos";
const PURCHASE_KEY = "purchase_entries_v1";

// 仕入履歴CSV列（設定の「仕入履歴CSV出力項目設定」と一致）
const PURCHASE_CSV_COLUMN_IDS = [
  "purchaseId", "name", "date", "location", "supplier", "carrier", "trackingNumber", "status",
  "productTitle", "sku", "barcode", "option1", "option2", "option3", "quantity",
] as const;
const PURCHASE_CSV_LABELS: Record<string, string> = {
  purchaseId: "仕入ID", name: "名称", date: "日付", location: "入庫先ロケーション", supplier: "仕入先",
  carrier: "配送業者", trackingNumber: "配送番号", status: "ステータス", productTitle: "商品名", sku: "SKU",
  barcode: "JAN", option1: "オプション1", option2: "オプション2", option3: "オプション3", quantity: "数量",
};
const DEFAULT_PURCHASE_CSV_COLUMNS = [...PURCHASE_CSV_COLUMN_IDS];

function normalizeLocationGid(locationId: string): string {
  const s = String(locationId || "").trim();
  if (!s) return "";
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  const m = s.match(/Location\/(\d+)/);
  if (m?.[1]) return `gid://shopify/Location/${m[1]}`;
  return s;
}

function normalizeInventoryItemGid(inventoryItemId: string): string {
  const s = String(inventoryItemId || "").trim();
  if (!s) return "";
  if (s.startsWith("gid://shopify/InventoryItem/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/InventoryItem/${s}`;
  const m = s.match(/InventoryItem\/(\d+)/);
  if (m?.[1]) return `gid://shopify/InventoryItem/${m[1]}`;
  return s;
}

/** 仕入確定：在庫プラス調整を行う。失敗時はエラーを返し metafield は更新しない。 */
async function executePurchaseReceive(
  admin: { graphql: (q: string, v?: any) => Promise<any>; request: (options: { data: string; variables?: any }) => Promise<any> },
  entry: PurchaseEntry,
  shop: string
): Promise<{ ok: boolean; error?: string; adjustmentGroupId?: string | null }> {
  const locationGid = normalizeLocationGid(entry.locationId);
  if (!locationGid) return { ok: false, error: "入庫先ロケーションIDが不正です" };
  const items = entry.items || [];
  if (items.length === 0) return { ok: false, error: "商品がありません" };

  const changes = items
    .map((item) => {
      const invId = normalizeInventoryItemGid(item.inventoryItemId);
      const qty = Math.max(0, Number(item.quantity || 0));
      if (!invId || qty === 0) return null;
      return { inventoryItemId: invId, locationId: locationGid, delta: qty };
    })
    .filter((c): c is { inventoryItemId: string; locationId: string; delta: number } => c !== null);

  if (changes.length === 0) return { ok: false, error: "有効な在庫変更がありません" };

  const mutation = `#graphql
    mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`;
  
  // デバッグ: 送信する変数を確認
  const variables = {
    input: { reason: "correction", name: "available", changes },
  };
  console.log(`[executePurchaseReceive] Sending mutation with variables:`, JSON.stringify(variables, null, 2));
  console.log(`[executePurchaseReceive] Changes count: ${changes.length}, first change:`, changes[0] ? JSON.stringify(changes[0], null, 2) : "none");
  
  let resp: Response;
  let data: any;
  
  try {
    // admin.graphqlは第2引数に { variables: { ... } } 形式を期待する
    resp = await admin.graphql(mutation, { variables });
    data = await resp.json();
    
    // デバッグ: レスポンス全体を確認
    console.log(`[executePurchaseReceive] Response status: ${resp.status}`);
    console.log(`[executePurchaseReceive] Response data:`, JSON.stringify(data, null, 2));
    
    // デバッグ: エラーを確認
    if (data?.errors) {
      console.error(`[executePurchaseReceive] GraphQL errors:`, JSON.stringify(data.errors, null, 2));
    }
    if (data?.data?.inventoryAdjustQuantities?.userErrors?.length > 0) {
      console.error(`[executePurchaseReceive] User errors:`, JSON.stringify(data.data.inventoryAdjustQuantities.userErrors, null, 2));
    }
  } catch (error: any) {
    // エラーの詳細を確認
    console.error(`[executePurchaseReceive] Exception caught:`, error);
    if (error?.response) {
      try {
        const errorData = await error.response.json();
        console.error(`[executePurchaseReceive] Error response data:`, JSON.stringify(errorData, null, 2));
      } catch {
        console.error(`[executePurchaseReceive] Could not parse error response`);
      }
    }
    if (error?.body?.errors) {
      console.error(`[executePurchaseReceive] Error body errors:`, JSON.stringify(error.body.errors, null, 2));
    }
    throw error;
  }
  
  const userErrors = data?.data?.inventoryAdjustQuantities?.userErrors ?? [];
  if (userErrors.length) {
    return { ok: false, error: userErrors.map((e: { message?: string }) => e.message).join(" / ") };
  }
  
  const adjustmentGroupId = data?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup?.id || null;

  // 在庫変動履歴を記録
  try {
    await logInventoryChangesFromAdjustment(
      admin,
      shop,
      changes,
      "purchase_entry",
      entry.id,
      adjustmentGroupId,
      entry.note || null
    );
  } catch (error) {
    console.error("Error logging inventory changes for purchase receive:", error);
    // ログ記録の失敗は無視して続行（在庫調整は成功している）
  }

  return { ok: true, adjustmentGroupId };
}

/** 仕入キャンセル：在庫を戻す（received のときのみ）。冪等：既に cancelled なら何もしない。 */
async function executePurchaseCancel(
  admin: { graphql: (q: string, v?: any) => Promise<any>; request: (options: { data: string; variables?: any }) => Promise<any> },
  entry: PurchaseEntry,
  shop: string
): Promise<{ ok: boolean; error?: string; adjustmentGroupId?: string | null }> {
  if (entry.status === "cancelled") return { ok: true };
  if (entry.status !== "received") return { ok: true }; // pending の場合は在庫増していないのでメタフィールド更新のみ

  const locationGid = normalizeLocationGid(entry.locationId);
  if (!locationGid) return { ok: false, error: "入庫先ロケーションIDが不正です" };
  const items = entry.items || [];
  const changes = items
    .map((item) => {
      const invId = normalizeInventoryItemGid(item.inventoryItemId);
      const qty = Math.max(0, Number(item.quantity || 0));
      if (!invId || qty === 0) return null;
      return { inventoryItemId: invId, locationId: locationGid, delta: -qty };
    })
    .filter((c): c is { inventoryItemId: string; locationId: string; delta: number } => c !== null);

  if (changes.length === 0) return { ok: true };

  const mutation = `#graphql
    mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`;
  
  // デバッグ: 送信する変数を確認
  const variables = {
    input: { reason: "correction", name: "available", changes },
  };
  console.log(`[executePurchaseCancel] Sending mutation with variables:`, JSON.stringify(variables, null, 2));
  console.log(`[executePurchaseCancel] Changes count: ${changes.length}, first change:`, changes[0] ? JSON.stringify(changes[0], null, 2) : "none");
  
  let resp: Response;
  let data: any;
  
  try {
    // admin.graphqlは第2引数に { variables: { ... } } 形式を期待する
    resp = await admin.graphql(mutation, { variables });
    data = await resp.json();
    
    // デバッグ: レスポンス全体を確認
    console.log(`[executePurchaseCancel] Response status: ${resp.status}`);
    console.log(`[executePurchaseCancel] Response data:`, JSON.stringify(data, null, 2));
    
    // デバッグ: エラーを確認
    if (data?.errors) {
      console.error(`[executePurchaseCancel] GraphQL errors:`, JSON.stringify(data.errors, null, 2));
    }
    if (data?.data?.inventoryAdjustQuantities?.userErrors?.length > 0) {
      console.error(`[executePurchaseCancel] User errors:`, JSON.stringify(data.data.inventoryAdjustQuantities.userErrors, null, 2));
    }
  } catch (error: any) {
    // エラーの詳細を確認
    console.error(`[executePurchaseCancel] Exception caught:`, error);
    if (error?.response) {
      try {
        const errorData = await error.response.json();
        console.error(`[executePurchaseCancel] Error response data:`, JSON.stringify(errorData, null, 2));
      } catch {
        console.error(`[executePurchaseCancel] Could not parse error response`);
      }
    }
    if (error?.body?.errors) {
      console.error(`[executePurchaseCancel] Error body errors:`, JSON.stringify(error.body.errors, null, 2));
    }
    throw error;
  }
  
  const userErrors = data?.data?.inventoryAdjustQuantities?.userErrors ?? [];
  if (userErrors.length) {
    return { ok: false, error: userErrors.map((e: { message?: string }) => e.message).join(" / ") };
  }
  
  const adjustmentGroupId = data?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup?.id || null;

  // 在庫変動履歴を記録
  try {
    await logInventoryChangesFromAdjustment(
      admin,
      shop,
      changes,
      "purchase_cancel",
      entry.id,
      adjustmentGroupId,
      entry.note || null
    );
  } catch (error) {
    console.error("Error logging inventory changes for purchase cancel:", error);
    // ログ記録の失敗は無視して続行（在庫調整は成功している）
  }

  return { ok: true, adjustmentGroupId };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  // ショップのタイムゾーンを取得
  const shopTimezone = await getShopTimezone(admin);

  const [locResp, appResp, settingsResp] = await Promise.all([
    admin.graphql(
      `#graphql
        query Locations($first: Int!) {
          locations(first: $first) { nodes { id name } }
        }
      `,
      { variables: { first: 250 } }
    ),
    admin.graphql(
      `#graphql
        query PurchaseEntries {
          currentAppInstallation {
            id
            metafield(namespace: "${PURCHASE_NS}", key: "${PURCHASE_KEY}") { value }
          }
        }
      `
    ),
    admin.graphql(
      `#graphql
        query Settings {
          currentAppInstallation {
            id
            metafield(namespace: "stock_transfer_pos", key: "settings_v1") { value }
          }
        }
      `
    ),
  ]);

  const locData = await locResp.json();
  const appData = await appResp.json();
  const settingsData = await settingsResp.json();
  const locations: LocationNode[] = locData?.data?.locations?.nodes ?? [];

  let entries: PurchaseEntry[] = [];
  const raw = appData?.data?.currentAppInstallation?.metafield?.value;
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      entries = [];
    }
  }

  // 仕入先マスタ・配送業者マスタ・CSV出力項目（設定から取得）
  let suppliers: Array<{ id: string; name: string; code?: string }> = [];
  let carriers: Array<{ id: string; label: string; company: string; sortOrder?: number }> = [];
  let purchaseCsvExportColumns: string[] = DEFAULT_PURCHASE_CSV_COLUMNS;
  const settingsRaw = settingsData?.data?.currentAppInstallation?.metafield?.value;
  if (typeof settingsRaw === "string" && settingsRaw) {
    try {
      const parsed = JSON.parse(settingsRaw);
      const list = parsed?.purchase?.suppliers ?? parsed?.suppliers ?? [];
      if (Array.isArray(list)) {
        suppliers = list
          .map((sp: any) => ({
            id: String(sp?.id ?? "").trim(),
            name: String(sp?.name ?? "").trim(),
            code: sp?.code ? String(sp.code).trim() : undefined,
          }))
          .filter((sp: any) => sp.id && sp.name);
      }

      const carrierList = parsed?.carriers ?? [];
      if (Array.isArray(carrierList)) {
        carriers = carrierList
          .map((c: any) => ({
            id: String(c?.id ?? "").trim(),
            label: String(c?.label ?? "").trim(),
            company: String(c?.company ?? "").trim(),
            sortOrder: Number.isFinite(Number(c?.sortOrder)) ? Number(c.sortOrder) : undefined,
          }))
          .filter((c: any) => c.id && c.label && c.company)
          .sort((a: any, b: any) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
      }

      const cols = Array.isArray(parsed?.purchase?.csvExportColumns) ? parsed.purchase.csvExportColumns : [];
      const valid = (cols as string[]).filter((id: string) => PURCHASE_CSV_COLUMN_IDS.includes(id as any));
      if (valid.length > 0) purchaseCsvExportColumns = valid;
    } catch {
      suppliers = [];
      carriers = [];
    }
  }

  // サーバー側で「今日の日付」を計算
  const todayInShopTimezone = getDateInShopTimezone(new Date(), shopTimezone);

  return {
    locations,
    entries,
    suppliers,
    carriers,
    shopTimezone,
    todayInShopTimezone, // サーバー側で計算した「今日の日付」をクライアントに渡す
    purchaseCsvExportColumns,
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null as string | null,
      endCursor: null as string | null,
    },
  };
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session?.shop || "";
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "").trim();
    const entryId = String(formData.get("entryId") || "").trim();

    const appResp = await admin.graphql(
      `#graphql
        query PurchaseEntries {
          currentAppInstallation {
            id
            metafield(namespace: "${PURCHASE_NS}", key: "${PURCHASE_KEY}") { value }
          }
        }
      `
    );

    const appData = await appResp.json();
    const raw = appData?.data?.currentAppInstallation?.metafield?.value;
    let entries: PurchaseEntry[] = [];
    if (typeof raw === "string" && raw) {
      try {
        const parsed = JSON.parse(raw);
        entries = Array.isArray(parsed) ? parsed : [];
      } catch {
        entries = [];
      }
    }

    // SKU からバリアント情報を取得（新規仕入の商品追加用）
    if (intent === "resolveSku") {
      const sku = String(formData.get("sku") || "").trim();
      if (!sku) return { error: "SKUを入力してください" };
      const query = `#graphql
        query ResolveSku($first: Int!, $query: String!) {
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
      const resp = await admin.graphql(query, {
        variables: { first: 5, query: `sku:${sku}` },
      });
      const data = await resp.json();
      const nodes = data?.data?.productVariants?.nodes ?? [];
      if (nodes.length === 0) return { error: `SKU「${sku}」に一致する商品が見つかりません` };
      const v = nodes[0];
      const opts = (v.selectedOptions as Array<{ value?: string }>) ?? [];
      return {
        ok: true,
        variant: {
          variantId: v.id,
          inventoryItemId: v.inventoryItem?.id ?? "",
          sku: v.sku ?? "",
          title: v.displayName ?? "",
          barcode: v.barcode ?? "",
          option1: opts[0]?.value ?? "",
          option2: opts[1]?.value ?? "",
          option3: opts[2]?.value ?? "",
        },
      };
    }

    // SKU・商品名で検索（新規仕入の「SKUから選択」用）
    if (intent === "searchVariantsForPurchase") {
      const query = String(formData.get("query") || "").trim();
      if (!query) return { ok: true, variants: [] };
      const gql = `#graphql
        query SearchVariantsForPurchase($first: Int!, $query: String!) {
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

    // コレクション検索（新規仕入の「コレクション」タブ用）
    if (intent === "searchCollectionsForPurchase") {
      const query = String(formData.get("query") || "").trim();
      try {
        const gql = `#graphql
          query SearchCollections($first: Int!, $query: String) {
            collections(first: $first, query: $query) {
              nodes {
                id
                title
              }
            }
          }
        `;
        const variables: { first: number; query?: string } = { first: 50 };
        if (query) variables.query = `title:${query.replace(/"/g, '\\"').trim()}`;
        const resp = await admin.graphql(gql, { variables });
        const data = await resp.json();
        const nodes = data?.data?.collections?.nodes ?? [];
        const collections = nodes.map((c: { id: string; title?: string }) => ({ id: c.id, title: c.title ?? "" }));
        return { ok: true, collections };
      } catch {
        return { ok: true, collections: [] };
      }
    }

    // コレクション内商品取得（新規仕入の「コレクション」タブで選択後）
    if (intent === "getCollectionProductsForPurchase") {
      const collectionId = String(formData.get("collectionId") || "").trim();
      if (!collectionId) return { ok: false, error: "コレクションIDがありません" };
      try {
        const gql = `#graphql
          query CollectionProductsForPurchase($id: ID!, $first: Int!) {
            collection(id: $id) {
              id
              title
              products(first: $first) {
                nodes {
                  id
                  title
                  variants(first: 250) {
                    nodes {
                      id
                      sku
                      displayName
                      barcode
                      inventoryItem { id }
                      selectedOptions { name value }
                    }
                  }
                }
              }
            }
          }
        `;
        const resp = await admin.graphql(gql, { variables: { id: collectionId, first: 250 } });
        const data = await resp.json();
        const collection = data?.data?.collection;
        if (!collection?.products?.nodes) return { ok: true, products: [] };
        const products: Array<{ variantId: string; inventoryItemId: string; sku: string; title: string; barcode?: string; quantity: number }> = [];
        for (const p of collection.products.nodes) {
          const productTitle = p.title ?? "";
          for (const v of p.variants?.nodes ?? []) {
            const invId = v.inventoryItem?.id;
            if (!invId) continue;
            const opts = (v.selectedOptions as Array<{ value?: string }>) ?? [];
            const variantTitle = v.displayName ?? v.title ?? "";
            products.push({
              variantId: v.id,
              inventoryItemId: invId,
              sku: v.sku ?? "",
              title: productTitle + (variantTitle && variantTitle !== "Default Title" ? ` / ${variantTitle}` : ""),
              barcode: v.barcode ?? "",
              quantity: 1,
            });
          }
        }
        return { ok: true, products, collectionTitle: collection.title ?? "" };
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    }

    // CSVで商品を一括解決（新規仕入の「CSVで追加」用）。形式: SKU,数量 または SKU のみ（数量1）
    if (intent === "resolveCsvForPurchase") {
      const csvRaw = String(formData.get("csv") || "").trim();
      if (!csvRaw) return { error: "CSVデータが空です" };
      const lines = csvRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const rows: { sku: string; quantity: number }[] = [];
      for (const line of lines) {
        const parts = line.split(",").map((p) => p.trim());
        const sku = parts[0] || "";
        if (!sku) continue;
        const qty = Math.max(0, parseInt(parts[1], 10) || 1);
        rows.push({ sku, quantity: qty });
      }
      if (rows.length === 0) return { error: "有効な行（SKU,数量）がありません" };
      const BATCH = 25;
      const items: OrderRequestItem[] = [];
      const errors: string[] = [];
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const skuList = batch.map((r) => r.sku).filter((s, idx, arr) => arr.indexOf(s) === idx);
        const queryPart = skuList.map((s) => `sku:${s.replace(/"/g, '\\"')}`).join(" OR ");
        const gql = `#graphql
          query ResolveSkusBatch($first: Int!, $query: String!) {
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
        const resp = await admin.graphql(gql, {
          variables: { first: BATCH, query: queryPart },
        });
        const data = await resp.json();
        const nodes = data?.data?.productVariants?.nodes ?? [];
        const variantBySku = new Map<string, { variantId: string; inventoryItemId: string; sku: string; title: string; barcode?: string; option1?: string; option2?: string; option3?: string }>();
        for (const v of nodes) {
          const opts = (v.selectedOptions as Array<{ value?: string }>) ?? [];
          const sku = (v.sku ?? "").trim();
          if (sku) {
            variantBySku.set(sku, {
              variantId: v.id,
              inventoryItemId: v.inventoryItem?.id ?? "",
              sku,
              title: v.displayName ?? "",
              barcode: v.barcode ?? "",
              option1: opts[0]?.value ?? "",
              option2: opts[1]?.value ?? "",
              option3: opts[2]?.value ?? "",
            });
          }
        }
        for (const row of batch) {
          const variant = variantBySku.get(row.sku);
          if (variant) {
            items.push({ ...variant, quantity: row.quantity });
          } else {
            errors.push(`SKU「${row.sku}」に一致する商品が見つかりません`);
          }
        }
      }
      return { ok: true, items, errors };
    }

    // 新規仕入を登録（管理画面から仕入IDを立ち上げる）
    if (intent === "createPurchase") {
      const locationId = String(formData.get("locationId") || "").trim();
      const date = String(formData.get("date") || "").trim();
      const itemsJson = String(formData.get("items") || "[]").trim();
      if (!locationId || !date) return { error: "入庫先と日付は必須です" };
      let items: OrderRequestItem[] = [];
      try {
        items = JSON.parse(itemsJson);
        if (!Array.isArray(items)) items = [];
      } catch {
        return { error: "商品データの形式が不正です" };
      }
      if (items.length === 0) return { error: "商品を1件以上追加してください" };

      const locationName = String(formData.get("locationName") || "").trim() || locationId;
      // 名称は #B0001（BUYのB）で採番
      const maxB = entries
        .map((e) => e.purchaseName?.match(/^#B(\d+)$/))
        .filter(Boolean)
        .reduce((max, m) => Math.max(max, parseInt(m![1], 10)), 0);
      const purchaseName = `#B${String(maxB + 1).padStart(4, "0")}`;
      const id = `purchase_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const newEntry: PurchaseEntry = {
        id,
        purchaseName,
        locationId,
        locationName,
        supplierName: String(formData.get("supplierName") || "").trim() || undefined,
        date,
        carrier: String(formData.get("carrier") || "").trim() || undefined,
        trackingNumber: String(formData.get("trackingNumber") || "").trim() || undefined,
        expectedArrival: String(formData.get("expectedArrival") || "").trim() || undefined,
        staffName: String(formData.get("staffName") || "").trim() || undefined,
        note: String(formData.get("note") || "").trim() || undefined,
        items: items.map((it) => ({
          inventoryItemId: it.inventoryItemId,
          variantId: it.variantId,
          sku: it.sku,
          title: it.title,
          barcode: it.barcode,
          option1: it.option1,
          option2: it.option2,
          option3: it.option3,
          quantity: Math.max(0, Number(it.quantity) || 0),
        })),
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (!appInstallationId) return { error: "アプリインストールIDが取得できません" };
      const updated = [newEntry, ...entries];
      await admin.graphql(
        `#graphql
          mutation SetPurchaseEntries($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id namespace key }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: appInstallationId,
                namespace: PURCHASE_NS,
                key: PURCHASE_KEY,
                type: "json",
                value: JSON.stringify(updated),
              },
            ],
          },
        }
      );
      return { ok: true, purchaseId: id, purchaseName, revalidate: true };
    }

    const entry = entries.find((e) => e.id === entryId);
    if (!entry) {
      return { error: "仕入が見つかりません" };
    }

    if (intent === "loadItems") {
      const items = entry.items || [];
      const variantIds = items
        .filter((item: OrderRequestItem) => item.variantId)
        .map((item: OrderRequestItem) => item.variantId!)
        .filter((id: string, index: number, self: string[]) => self.indexOf(id) === index);

      if (variantIds.length > 0) {
        const variantGids = variantIds.map((id: string) =>
          id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`
        );
        const variantQuery = `#graphql
          query GetVariantsBarcodeOptions($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                barcode
                selectedOptions { name value }
              }
            }
          }
        `;
        try {
          const variantResp = await admin.graphql(variantQuery, {
            variables: { ids: variantGids },
          });
          const variantData = await variantResp.json();
          if (variantData?.data?.nodes) {
            const variantMap = new Map<string, { barcode?: string; option1?: string; option2?: string; option3?: string }>();
            (variantData.data.nodes as any[]).forEach((node: any) => {
              if (node?.id) {
                const opts = node.selectedOptions as Array<{ value?: string }> | undefined;
                variantMap.set(node.id, {
                  barcode: node.barcode ?? undefined,
                  option1: opts?.[0]?.value,
                  option2: opts?.[1]?.value,
                  option3: opts?.[2]?.value,
                });
              }
            });
            const enriched = items.map((item: OrderRequestItem) => {
              if (!item.variantId) return item;
              const gid = item.variantId.startsWith("gid://") ? item.variantId : `gid://shopify/ProductVariant/${item.variantId}`;
              const info = variantMap.get(gid);
              if (!info) return item;
              return {
                ...item,
                barcode: item.barcode ?? info.barcode,
                option1: item.option1 ?? info.option1,
                option2: item.option2 ?? info.option2,
                option3: item.option3 ?? info.option3,
              };
            });
            return { entryId, items: enriched };
          }
        } catch (err) {
          console.error("Purchase loadItems variant fetch:", err);
        }
      }
      return { entryId, items };
    }

    if (intent === "receive") {
      if (entry.status !== "pending") {
        return { error: "未入庫の仕入のみ入庫確定できます" };
      }
      // adminオブジェクトにrequestメソッドを追加（logInventoryChangesFromAdjustment用）
      const adminWithRequest = {
        graphql: admin.graphql.bind(admin),
        request: async (options: { data: string; variables?: any }) => {
          // admin.graphqlをラップしてrequestメソッドとして使用
          // admin.graphqlはResponseオブジェクトを返すので、そのまま返す
          const resp = await admin.graphql(options.data, { variables: options.variables });
          return resp;
        },
      };
      let receiveResult;
      try {
        receiveResult = await executePurchaseReceive(adminWithRequest, entry, shop);
      } catch (error: any) {
        console.error("[action receive] Error in executePurchaseReceive:", error);
        // エラーオブジェクトから詳細を取得
        const errorMessage = error?.message || error?.body?.errors?.[0]?.message || String(error);
        return { error: `在庫調整に失敗しました: ${errorMessage}` };
      }
      if (!receiveResult.ok) {
        return { error: receiveResult.error ?? "在庫調整に失敗しました" };
      }
      const now = new Date().toISOString();
      const updated = entries.map((e) =>
        e.id === entryId
          ? { ...e, status: "received" as const, receivedAt: now }
          : e
      );
      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (!appInstallationId) {
        return { error: "アプリインストールIDが取得できません" };
      }
      await admin.graphql(
        `#graphql
          mutation SetPurchaseEntries($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id namespace key }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: appInstallationId,
                namespace: PURCHASE_NS,
                key: PURCHASE_KEY,
                type: "json",
                value: JSON.stringify(updated),
              },
            ],
          },
        }
      );
      return { ok: true };
    }

    if (intent === "cancel") {
      if (entry.status === "cancelled") {
        return { ok: true, message: "既にキャンセル済みです" };
      }
      // adminオブジェクトにrequestメソッドを追加（logInventoryChangesFromAdjustment用）
      const adminWithRequest = {
        graphql: admin.graphql.bind(admin),
        request: async (options: { data: string; variables?: any }) => {
          // admin.graphqlをラップしてrequestメソッドとして使用
          // admin.graphqlはResponseオブジェクトを返すので、そのまま返す
          const resp = await admin.graphql(options.data, { variables: options.variables });
          return resp;
        },
      };
      const cancelResult = await executePurchaseCancel(adminWithRequest, entry, shop);
      if (!cancelResult.ok) {
        return { error: cancelResult.error ?? "在庫の戻しに失敗しました" };
      }
      const updated = entries.map((e) =>
        e.id === entryId
          ? {
              ...e,
              status: "cancelled" as const,
              cancelledAt: new Date().toISOString(),
            }
          : e
      );
      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (!appInstallationId) {
        return { error: "アプリインストールIDが取得できません" };
      }
      await admin.graphql(
        `#graphql
          mutation SetPurchaseEntries($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id namespace key }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: appInstallationId,
                namespace: PURCHASE_NS,
                key: PURCHASE_KEY,
                type: "json",
                value: JSON.stringify(updated),
              },
            ],
          },
        }
      );
      return { ok: true };
    }

    return { error: "不明な操作です" };
  } catch (error) {
    console.error("Purchase action error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `処理に失敗しました: ${errorMessage}` };
  }
}

export default function PurchasePage() {
  const loaderData = useLoaderData<typeof loader>();
  const { locations, entries, pageInfo, suppliers, carriers, shopTimezone, todayInShopTimezone, purchaseCsvExportColumns } = loaderData || {
    locations: [] as LocationNode[],
    entries: [] as PurchaseEntry[],
    suppliers: [] as Array<{ id: string; name: string; code?: string }>,
    carriers: [] as Array<{ id: string; label: string; company: string; sortOrder?: number }>,
    shopTimezone: "UTC",
    todayInShopTimezone: getDateInShopTimezone(new Date(), "UTC"),
    purchaseCsvExportColumns: DEFAULT_PURCHASE_CSV_COLUMNS,
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
  const csvColumns = purchaseCsvExportColumns ?? DEFAULT_PURCHASE_CSV_COLUMNS;
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const processedFetcherDataRef = useRef<any>(null);

  const STATUS_LABEL: Record<string, string> = {
    pending: "未入庫",
    received: "入庫済み",
    cancelled: "キャンセル済み",
  };

  const getStatusBadgeStyle = (status: string): React.CSSProperties => {
    const base = { display: "inline-block" as const, padding: "2px 8px", borderRadius: "9999px", fontSize: "12px", fontWeight: 600 };
    if (status === "received") return { ...base, backgroundColor: "#d4edda", color: "#155724" };
    if (status === "pending") return { ...base, backgroundColor: "#cce5ff", color: "#004085" };
    return { ...base, backgroundColor: "#e2e3e5", color: "#383d41" };
  };

  const [locationFilters, setLocationFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());
  const [supplierFilters, setSupplierFilters] = useState<Set<string>>(new Set());
  // 作成元フィルター: "order"（発注から作成）, "b"（#B系＝POS/新規作成）
  const [sourceFilters, setSourceFilters] = useState<Set<string>>(new Set());

  const [modalOpen, setModalOpen] = useState(false);
  const [modalEntry, setModalEntry] = useState<PurchaseEntry | null>(null);
  const [modalItems, setModalItems] = useState<OrderRequestItem[]>([]);

  const [csvExporting, setCsvExporting] = useState(false);
  const [csvExportProgress, setCsvExportProgress] = useState({ current: 0, total: 0 });

  // 新規仕入（履歴の上に表示するセクション。モーダルは使わない）
  const [newPurchaseLocationId, setNewPurchaseLocationId] = useState("");
  const [newPurchaseDate, setNewPurchaseDate] = useState(todayInShopTimezone);
  const [newPurchaseSupplierName, setNewPurchaseSupplierName] = useState("");
  const [newPurchaseCarrier, setNewPurchaseCarrier] = useState("");
  const [newPurchaseTrackingNumber, setNewPurchaseTrackingNumber] = useState("");
  const [newPurchaseExpectedArrival, setNewPurchaseExpectedArrival] = useState("");
  const [newPurchaseStaffName, setNewPurchaseStaffName] = useState("");
  const [newPurchaseNote, setNewPurchaseNote] = useState("");
  const [newPurchaseItems, setNewPurchaseItems] = useState<OrderRequestItem[]>([]);
  const [newPurchaseError, setNewPurchaseError] = useState("");
  // 棚卸同様: SKU・商品名で検索→一覧から選択して追加
  const [newPurchaseSearchQuery, setNewPurchaseSearchQuery] = useState("");
  const [newPurchaseSearchVariants, setNewPurchaseSearchVariants] = useState<Array<{ variantId: string; inventoryItemId: string; sku: string; title: string; barcode?: string; option1?: string; option2?: string; option3?: string }>>([]);
  const [newPurchaseSearchQuantities, setNewPurchaseSearchQuantities] = useState<Record<string, number>>({}); // variantId -> 数量
  // 検索タブ: 棚卸同様チェックボックスで選択した行だけ「商品を追加」で追加
  const [newPurchaseSearchSelectedIds, setNewPurchaseSearchSelectedIds] = useState<Set<string>>(new Set());
  // 選択済み商品の情報を保持（検索結果に含まれていない商品も表示するため、数量も含む）
  const [newPurchaseSelectedProductsInfo, setNewPurchaseSelectedProductsInfo] = useState<Map<string, {
    variantId: string;
    inventoryItemId: string;
    sku: string;
    title: string;
    barcode?: string;
    option1?: string;
    option2?: string;
    option3?: string;
    quantity: number;
  }>>(new Map());
  // 選択済み商品を検索結果リストに表示するかどうか
  const [newPurchaseShowSelectedProducts, setNewPurchaseShowSelectedProducts] = useState(false);
  // CSVタブ: アップロードしたCSVのプレビュー（チェックした行だけ「商品を追加」で追加）
  const [newPurchaseCsvPreviewItems, setNewPurchaseCsvPreviewItems] = useState<OrderRequestItem[]>([]);
  const [newPurchaseCsvSelectedIds, setNewPurchaseCsvSelectedIds] = useState<Set<string>>(new Set()); // inventoryItemId で選択
  const newPurchaseCsvFileInputRef = useRef<HTMLInputElement>(null);

  // 仕入先（マスタ＋その他）選択
  const [newPurchaseSupplierId, setNewPurchaseSupplierId] = useState("");
  const [newPurchaseSupplierCustom, setNewPurchaseSupplierCustom] = useState("");
  const [showSupplierPicker, setShowSupplierPicker] = useState(false);
  const [supplierSearchQuery, setSupplierSearchQuery] = useState("");
  const [showSupplierCustomInput, setShowSupplierCustomInput] = useState(false);

  // 配送業者（マスタ＋その他）選択
  const [newPurchaseCarrierId, setNewPurchaseCarrierId] = useState("");
  const [newPurchaseCarrierCustom, setNewPurchaseCarrierCustom] = useState("");
  const [showCarrierPicker, setShowCarrierPicker] = useState(false);
  const [carrierSearchQuery, setCarrierSearchQuery] = useState("");
  const [showCarrierCustomInput, setShowCarrierCustomInput] = useState(false);

  // キャンセル確認モーダル（発注と同じ出し方）
  const [purchaseActiveTab, setPurchaseActiveTab] = useState<"create" | "history">("create");
  const [newPurchaseProductMethod, setNewPurchaseProductMethod] = useState<"search" | "collection" | "csv">("search");
  // コレクションタブ用
  const [newPurchaseCollectionSearchQuery, setNewPurchaseCollectionSearchQuery] = useState("");
  const [newPurchaseCollectionSearchResults, setNewPurchaseCollectionSearchResults] = useState<Array<{ id: string; title: string }>>([]);
  const [newPurchaseSelectedCollectionId, setNewPurchaseSelectedCollectionId] = useState("");
  const [newPurchaseCollectionProducts, setNewPurchaseCollectionProducts] = useState<Array<{ variantId: string; inventoryItemId: string; sku: string; title: string; barcode?: string; quantity: number }>>([]);
  const [newPurchaseCollectionSelectedIds, setNewPurchaseCollectionSelectedIds] = useState<Set<string>>(new Set());
  const [newPurchaseCollectionShowSelected, setNewPurchaseCollectionShowSelected] = useState(false);
  const [newPurchaseCollectionQuantities, setNewPurchaseCollectionQuantities] = useState<Record<string, number>>({});
  const newPurchaseCollectionSearchFetcher = useFetcher<typeof action>();
  const newPurchaseCollectionProductsFetcher = useFetcher<typeof action>();
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState("");
  const [confirmCallback, setConfirmCallback] = useState<(() => void) | null>(null);
  // OKを押したときだけ submit するため、対象 entryId を state で保持（Portal 内では ref が読めない場合があるため state で渡す）
  const [pendingCancelEntryId, setPendingCancelEntryId] = useState<string | null>(null);
  // OK クリックが iframe 等で奪われる場合に備え、送信用に ref でも保持（onMouseDown で確実に送信するため）
  const pendingCancelEntryIdRef = useRef<string | null>(null);
  // オーバーレイ等でクリアされないよう、送信専用 ref は handleCancel でだけセットし handleConfirmOk でだけ読んでクリアする
  const confirmSubmitEntryIdRef = useRef<string | null>(null);

  const readValue = (e: unknown) => String((e as { currentTarget?: { value?: string }; currentValue?: { value?: string } })?.currentTarget?.value ?? (e as { currentValue?: { value?: string } })?.currentValue?.value ?? "");

  const filteredSuppliersForPicker = useMemo(() => {
    const q = supplierSearchQuery.trim().toLowerCase();
    const base = Array.isArray(suppliers) ? suppliers : [];
    if (!q) return base;
    return base.filter((sp) => {
      const name = String(sp.name ?? "").toLowerCase();
      const code = String(sp.code ?? "").toLowerCase();
      return name.includes(q) || code.includes(q);
    });
  }, [supplierSearchQuery, suppliers]);

  const finalNewPurchaseSupplierName = useMemo(() => {
    if (newPurchaseSupplierId) {
      const hit = (suppliers ?? []).find((sp) => sp.id === newPurchaseSupplierId);
      return hit?.name ?? "";
    }
    return newPurchaseSupplierCustom.trim();
  }, [newPurchaseSupplierCustom, newPurchaseSupplierId, suppliers]);

  const filteredCarriersForPicker = useMemo(() => {
    const q = carrierSearchQuery.trim().toLowerCase();
    const base = Array.isArray(carriers) ? carriers : [];
    if (!q) return base;
    return base.filter((c) => {
      const label = String(c.label ?? "").toLowerCase();
      const company = String(c.company ?? "").toLowerCase();
      return label.includes(q) || company.includes(q);
    });
  }, [carrierSearchQuery, carriers]);

  const finalNewPurchaseCarrierLabel = useMemo(() => {
    if (newPurchaseCarrierId) {
      const hit = (carriers ?? []).find((c) => c.id === newPurchaseCarrierId);
      return hit?.label ?? "";
    }
    return newPurchaseCarrierCustom.trim();
  }, [carriers, newPurchaseCarrierCustom, newPurchaseCarrierId]);

  const handlePurchaseCsvTemplateDownload = () => {
    // ✅ Excel で「数量」が文字化けしないように UTF-8 BOM を付与
    const csv = "\uFEFFSKU,数量\r\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "purchase_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredEntries = useMemo(() => {
    let filtered = entries;

    // 入庫先ロケーション
    if (locationFilters.size > 0) {
      filtered = filtered.filter((e) => locationFilters.has(e.locationId));
    }

    // ステータス
    if (statusFilters.size > 0) {
      filtered = filtered.filter((e) => statusFilters.has(e.status));
    }

    // 仕入先
    if (supplierFilters.size > 0) {
      filtered = filtered.filter((e) => {
        const name = e.supplierName || "";
        return name && supplierFilters.has(name);
      });
    }

    // 作成元（発注 or #B系）
    if (sourceFilters.size > 0) {
      filtered = filtered.filter((e) => {
        const tag = e.sourceOrderId ? "order" : "b";
        return sourceFilters.has(tag);
      });
    }

    return filtered.sort((a, b) => {
      const t1 = new Date(a.createdAt).getTime();
      const t2 = new Date(b.createdAt).getTime();
      return t2 - t1;
    });
  }, [entries, locationFilters, statusFilters, supplierFilters, sourceFilters]);

  const estimatedTotal = pageInfo.hasNextPage ? `${filteredEntries.length}件以上` : `${filteredEntries.length}件`;

  const exportCSV = async () => {
    if (filteredEntries.length === 0) {
      alert("表示する仕入履歴がありません");
      return;
    }
    const selectedEntries = filteredEntries;
    setCsvExporting(true);
    setCsvExportProgress({ current: 0, total: selectedEntries.length });

    try {
      const headers = csvColumns.map((id) => PURCHASE_CSV_LABELS[id] ?? id);
      const toRow = (rowObj: Record<string, string | number>) =>
        csvColumns.map((id) => String(rowObj[id] ?? ""));

      const rows: string[][] = [];
      for (let i = 0; i < selectedEntries.length; i++) {
        const e = selectedEntries[i];
        setCsvExportProgress({ current: i + 1, total: selectedEntries.length });
        const locationName = e.locationName || locations.find((l) => l.id === e.locationId)?.name || e.locationId;
        const date = e.date || extractDateFromISO(e.createdAt, shopTimezone);
        const statusLabel = STATUS_LABEL[e.status] || e.status;

        if (e.items.length === 0) {
          rows.push(toRow({
            purchaseId: e.id,
            name: e.purchaseName || e.id,
            date,
            location: locationName,
            supplier: e.supplierName || "",
            carrier: e.carrier || "",
            trackingNumber: e.trackingNumber || "",
            status: statusLabel,
            productTitle: "",
            sku: "",
            barcode: "",
            option1: "",
            option2: "",
            option3: "",
            quantity: "",
          }));
        } else {
          e.items.forEach((item) => {
            rows.push(toRow({
              purchaseId: e.id,
              name: e.purchaseName || e.id,
              date,
              location: locationName,
              supplier: e.supplierName || "",
              carrier: e.carrier || "",
              trackingNumber: e.trackingNumber || "",
              status: statusLabel,
              productTitle: item.title || "",
              sku: item.sku || "",
              barcode: item.barcode || "",
              option1: item.option1 || "",
              option2: item.option2 || "",
              option3: item.option3 || "",
              quantity: item.quantity || 0,
            }));
          });
        }
      }

      const csvContent = [headers, ...rows]
        .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
        .join("\n");

      const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `仕入履歴_${todayInShopTimezone}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("CSV export error:", error);
      alert(`CSV出力中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCsvExporting(false);
      setCsvExportProgress({ current: 0, total: 0 });
    }
  };

  const openItemsModal = (entry: PurchaseEntry) => {
    setModalEntry(entry);
    setModalOpen(true);
    setModalItems([]);
    const formData = new FormData();
    formData.set("intent", "loadItems");
    formData.set("entryId", entry.id);
    fetcher.submit(formData, { method: "post" });
  };

  useEffect(() => {
    if (fetcher.data && modalEntry) {
      if ("error" in fetcher.data) {
        alert(fetcher.data.error);
        setModalItems([]);
      } else if ("items" in fetcher.data) {
        const items: OrderRequestItem[] = Array.isArray(fetcher.data.items) ? fetcher.data.items : [];
        setModalItems(items);
      } else {
        setModalItems([]);
      }
    }
  }, [fetcher.data, modalEntry]);

  useEffect(() => {
    if (fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      // 既に処理済みのデータの場合はスキップ（無限ループを防ぐ）
      if (processedFetcherDataRef.current === fetcher.data) {
        return;
      }
      processedFetcherDataRef.current = fetcher.data;
      
      if ("purchaseName" in fetcher.data && fetcher.data.purchaseName) {
        setNewPurchaseItems([]);
        setNewPurchaseError("");
        setNewPurchaseSearchVariants([]);
        setNewPurchaseSearchQuery("");
        setNewPurchaseSearchQuantities({});
        setNewPurchaseSearchSelectedIds(new Set());
        setNewPurchaseSelectedProductsInfo(new Map());
        setNewPurchaseShowSelectedProducts(false);
        setNewPurchaseCsvPreviewItems([]);
        setNewPurchaseCsvSelectedIds(new Set());
      } else {
        setModalOpen(false);
        setModalEntry(null);
        setModalItems([]);
      }
      // 一度だけ再検証を実行
      revalidator.revalidate();
    } else if (fetcher.data && "error" in fetcher.data) {
      // エラーの場合は処理済みフラグをリセット
      processedFetcherDataRef.current = null;
    }
  }, [fetcher.data]);

  // 棚卸同様: 検索結果を表示用 state に反映
  useEffect(() => {
    if (fetcher.data && "variants" in fetcher.data && Array.isArray((fetcher.data as { variants?: unknown }).variants)) {
      const list = (fetcher.data as { variants: Array<{ variantId: string; inventoryItemId: string; sku: string; title: string; barcode?: string; option1?: string; option2?: string; option3?: string }> }).variants;
      setNewPurchaseSearchVariants(list);
      // 検索結果に含まれる選択済み商品の情報を更新（数量は保持）
      setNewPurchaseSelectedProductsInfo((prevInfo) => {
        const newInfo = new Map(prevInfo);
        list.forEach((v) => {
          if (newPurchaseSearchSelectedIds.has(v.variantId)) {
            const existing = newInfo.get(v.variantId);
            const quantity = existing?.quantity ?? newPurchaseSearchQuantities[v.variantId] ?? 1;
            newInfo.set(v.variantId, {
              ...v,
              quantity,
            });
          }
        });
        return newInfo;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  // 棚卸同様: CSVで追加の結果を商品リストに反映
  useEffect(() => {
    if (fetcher.data && "items" in fetcher.data && Array.isArray((fetcher.data as { items?: unknown }).items)) {
      const payload = fetcher.data as { items: OrderRequestItem[]; errors?: string[] };
      if (payload.items.length > 0) {
        // CSVタブの「プレビュー」に入れて、チェックで選んでから追加する（棚卸の選択式に合わせる）
        setNewPurchaseCsvPreviewItems(payload.items);
        setNewPurchaseCsvSelectedIds(new Set(payload.items.map((it) => String(it.inventoryItemId ?? ""))));
      }
      if (payload.errors && payload.errors.length > 0) {
        setNewPurchaseError(payload.errors.join("\n"));
      } else {
        setNewPurchaseError("");
      }
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      setNewPurchaseError(String((fetcher.data as { error?: string }).error ?? ""));
    }
  }, [fetcher.data]);

  // コレクション検索結果の反映
  useEffect(() => {
    const d = newPurchaseCollectionSearchFetcher.data;
    if (d && (d as { ok?: boolean }).ok && Array.isArray((d as { collections?: Array<{ id: string; title: string }> }).collections)) {
      setNewPurchaseCollectionSearchResults((d as { collections: Array<{ id: string; title: string }> }).collections);
    }
  }, [newPurchaseCollectionSearchFetcher.data]);

  // コレクション商品一覧の反映
  useEffect(() => {
    const d = newPurchaseCollectionProductsFetcher.data;
    if (d && (d as { ok?: boolean }).ok && Array.isArray((d as { products?: unknown }).products)) {
      setNewPurchaseCollectionProducts((d as { products: Array<{ variantId: string; inventoryItemId: string; sku: string; title: string; barcode?: string; quantity: number }> }).products);
      setNewPurchaseCollectionSelectedIds(new Set());
      setNewPurchaseCollectionQuantities({});
    }
  }, [newPurchaseCollectionProductsFetcher.data]);

  const closeItemsModal = () => {
    setModalOpen(false);
    setModalEntry(null);
    setModalItems([]);
  };

  const handleCancel = (entry: PurchaseEntry) => {
    if (entry.status === "cancelled") return;
    const name = entry.purchaseName || entry.id;
    setConfirmMessage(`この仕入（${name}）をキャンセルします。よろしいですか？`);
    setPendingCancelEntryId(entry.id);
    pendingCancelEntryIdRef.current = entry.id;
    confirmSubmitEntryIdRef.current = entry.id;
    setConfirmCallback(() => {
      setConfirmModalOpen(false);
      setConfirmCallback(null);
      setPendingCancelEntryId(null);
    });
    // 次のティックで開く（親オーバーレイの onClick が先に走って状態が競合しないようにする）
    setTimeout(() => setConfirmModalOpen(true), 0);
  };

  const handleConfirmOk = () => {
    const entryId = confirmSubmitEntryIdRef.current ?? pendingCancelEntryIdRef.current ?? pendingCancelEntryId;
    confirmSubmitEntryIdRef.current = null;
    pendingCancelEntryIdRef.current = null;
    setConfirmModalOpen(false);
    setConfirmCallback(null);
    setPendingCancelEntryId(null);
    if (entryId) {
      const formData = new FormData();
      formData.set("intent", "cancel");
      formData.set("entryId", entryId);
      fetcher.submit(formData, { method: "post", action: location.pathname });
    }
  };

  const exportModalCSV = () => {
    if (!modalEntry || modalItems.length === 0) {
      alert("商品リストがありません");
      return;
    }
    const headers = csvColumns.map((id) => PURCHASE_CSV_LABELS[id] ?? id);
    const toRow = (rowObj: Record<string, string | number>) =>
      csvColumns.map((id) => String(rowObj[id] ?? ""));
    const locationName =
      modalEntry.locationName || locations.find((l) => l.id === modalEntry.locationId)?.name || modalEntry.locationId;
    const date = modalEntry.date || extractDateFromISO(modalEntry.createdAt, shopTimezone);
    const statusLabel = STATUS_LABEL[modalEntry.status] || modalEntry.status;

    const rows: string[][] = [];
    modalItems.forEach((item) => {
      rows.push(toRow({
        purchaseId: modalEntry.id,
        name: modalEntry.purchaseName || modalEntry.id,
        date,
        location: locationName,
        supplier: modalEntry.supplierName || "",
        carrier: modalEntry.carrier || "",
        trackingNumber: modalEntry.trackingNumber || "",
        status: statusLabel,
        productTitle: item.title || "",
        sku: item.sku || "",
        barcode: item.barcode || "",
        option1: item.option1 || "",
        option2: item.option2 || "",
        option3: item.option3 || "",
        quantity: item.quantity || 0,
      }));
    });

    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // ファイル名用：表示名（#P0000など）を優先し、ファイル名に使えない文字のみ置換（複雑なIDは表示しない）
    const displayName = modalEntry.purchaseName || modalEntry.id;
    const safeName = String(displayName).replace(/[\\/:*?"<>|\s]/g, "_").trim() || "item";
    link.download = `仕入履歴_${safeName}_${todayInShopTimezone}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <s-page heading="仕入履歴">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          {/* 上部タブ（棚卸と同じ見た目・大きさ） */}
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
                { id: "create" as const, label: "作成" },
                { id: "history" as const, label: "履歴" },
              ].map((tab) => {
                const selected = purchaseActiveTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setPurchaseActiveTab(tab.id)}
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

            {purchaseActiveTab === "create" && (
            <s-box padding="base">
              <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                {/* 左：タイトル＋説明＋白カード（設定 or 商品を追加をボタンで切り替え・棚卸踏襲） */}
                <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                  <s-stack gap="base">
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>新規仕入</div>
                      <s-text tone="subdued" size="small">
                        入庫先・日付・設定を入力し、商品を追加。一覧で内容を確認して「仕入ID発行確定」で仕入IDを発行します。
                      </s-text>
                    </div>
                    {newPurchaseError && (
                      <div style={{ padding: "8px 12px", backgroundColor: "#fff5f5", color: "#c00", borderRadius: 4, fontSize: 14 }}>
                        {newPurchaseError}
                      </div>
                    )}
                    <div style={{ background: "#ffffff", borderRadius: 12, boxShadow: "0 0 0 1px #e1e3e5", padding: 16 }}>
                      <s-stack gap="base">
                        <s-text emphasis="bold" size="large">設定</s-text>
                        {/* 1カラムで縦並び（SP/PCとも同じ並び） */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          <div>
                            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>入庫先 <span style={{ color: "#c00" }}>*</span></label>
                            <select
                              value={newPurchaseLocationId}
                              onChange={(e) => setNewPurchaseLocationId(e.target.value)}
                              style={{ width: "100%", padding: 8, fontSize: 14, border: "1px solid #ccc", borderRadius: 4 }}
                            >
                              <option value="">選択</option>
                              {locations.map((loc) => (
                                <option key={loc.id} value={loc.id}>{loc.name}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>日付 <span style={{ color: "#c00" }}>*</span></label>
                            <input
                              type="date"
                              value={newPurchaseDate}
                              onChange={(e) => setNewPurchaseDate(e.target.value)}
                              style={{ width: "100%", padding: 8, fontSize: 14, border: "1px solid #ccc", borderRadius: 4, boxSizing: "border-box", maxWidth: "100%" }}
                            />
                          </div>
                          <div>
                            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>仕入先</label>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, border: "1px solid #ccc", borderRadius: 4, padding: "8px 10px" }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {finalNewPurchaseSupplierName || "未選択"}
                                </div>
                                <div style={{ fontSize: 12, color: "#6d7175" }}>
                                  {suppliers.length > 0 ? "リストから選択、またはその他で自由入力" : "（設定 → 仕入設定で仕入先リストを追加できます）"}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowSupplierPicker((v) => !v);
                                  if (showSupplierPicker) {
                                    setSupplierSearchQuery("");
                                    setShowSupplierCustomInput(false);
                                  }
                                }}
                                style={{ padding: "6px 12px", border: "1px solid #c9cccf", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, flexShrink: 0 }}
                              >
                                {showSupplierPicker ? "閉じる" : "選択"}
                              </button>
                            </div>

                            {showSupplierPicker && (
                              <div style={{ marginTop: 8, border: "1px solid #e1e3e5", borderRadius: 8, padding: 8 }}>
                                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                                  <input
                                    type="text"
                                    value={supplierSearchQuery}
                                    onChange={(e) => setSupplierSearchQuery(e.target.value)}
                                    placeholder="検索（仕入先名 / コード）"
                                    style={{ flex: 1, minWidth: 0, padding: 8, fontSize: 14, border: "1px solid #ccc", borderRadius: 4 }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setNewPurchaseSupplierId("");
                                      setNewPurchaseSupplierCustom("");
                                      setNewPurchaseSupplierName("");
                                      setShowSupplierPicker(false);
                                      setSupplierSearchQuery("");
                                      setShowSupplierCustomInput(false);
                                    }}
                                    style={{ padding: "8px 12px", border: "1px solid #c9cccf", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 }}
                                  >
                                    クリア
                                  </button>
                                </div>

                                <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: 8, padding: 6 }}>
                                  {filteredSuppliersForPicker.length === 0 ? (
                                    <div style={{ padding: "10px 12px", color: "#6d7175", fontSize: 13 }}>該当する仕入先がありません</div>
                                  ) : (
                                    filteredSuppliersForPicker.map((sp) => {
                                      const selected = sp.id === newPurchaseSupplierId;
                                      return (
                                        <div
                                          key={sp.id}
                                          onClick={() => {
                                            setNewPurchaseSupplierId(sp.id);
                                            setNewPurchaseSupplierCustom("");
                                            setNewPurchaseSupplierName(sp.name);
                                            setShowSupplierPicker(false);
                                            setSupplierSearchQuery("");
                                            setShowSupplierCustomInput(false);
                                          }}
                                          style={{
                                            padding: "10px 12px",
                                            borderRadius: 6,
                                            cursor: "pointer",
                                            backgroundColor: selected ? "#eff6ff" : "transparent",
                                            border: selected ? "1px solid #2563eb" : "1px solid transparent",
                                            borderBottom: selected ? undefined : "1px solid #e5e7eb",
                                            marginTop: 4,
                                          }}
                                        >
                                          <div style={{ fontWeight: selected ? 600 : 500, fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                                            {sp.name}
                                            {sp.code ? <span style={{ color: "#6d7175", fontSize: 12 }}>({sp.code})</span> : null}
                                          </div>
                                        </div>
                                      );
                                    })
                                  )}
                                </div>

                                <div style={{ marginTop: 8 }}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setShowSupplierCustomInput((v) => !v);
                                      if (!showSupplierCustomInput) {
                                        setNewPurchaseSupplierId("");
                                        setNewPurchaseSupplierName("");
                                      } else {
                                        setNewPurchaseSupplierCustom("");
                                        setNewPurchaseSupplierName("");
                                      }
                                    }}
                                    style={{ padding: "6px 12px", border: "1px solid #c9cccf", borderRadius: 6, background: showSupplierCustomInput ? "#eff6ff" : "#fff", cursor: "pointer", fontSize: 13 }}
                                  >
                                    その他
                                  </button>
                                </div>

                                {showSupplierCustomInput && (
                                  <div style={{ marginTop: 8 }}>
                                    <input
                                      type="text"
                                      value={newPurchaseSupplierCustom}
                                      onChange={(e) => {
                                        setNewPurchaseSupplierCustom(e.target.value);
                                        setNewPurchaseSupplierName(e.target.value);
                                      }}
                                      placeholder="マスタにない仕入先を入力"
                                      style={{ width: "100%", padding: 8, fontSize: 14, border: "1px solid #ccc", borderRadius: 4 }}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          <div>
                            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>配送業者</label>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, border: "1px solid #ccc", borderRadius: 4, padding: "8px 10px" }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {finalNewPurchaseCarrierLabel || "未選択"}
                                </div>
                                <div style={{ fontSize: 12, color: "#6d7175" }}>
                                  {carriers.length > 0 ? "リストから選択、またはその他で自由入力" : "（設定 → 配送業者設定で登録できます）"}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowCarrierPicker((v) => !v);
                                  if (showCarrierPicker) {
                                    setCarrierSearchQuery("");
                                    setShowCarrierCustomInput(false);
                                  }
                                }}
                                style={{ padding: "6px 12px", border: "1px solid #c9cccf", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, flexShrink: 0 }}
                              >
                                {showCarrierPicker ? "閉じる" : "選択"}
                              </button>
                            </div>

                            {showCarrierPicker && (
                              <div style={{ marginTop: 8, border: "1px solid #e1e3e5", borderRadius: 8, padding: 8 }}>
                                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                                  <input
                                    type="text"
                                    value={carrierSearchQuery}
                                    onChange={(e) => setCarrierSearchQuery(e.target.value)}
                                    placeholder="検索（配送業者名）"
                                    style={{ flex: 1, minWidth: 0, padding: 8, fontSize: 14, border: "1px solid #ccc", borderRadius: 4 }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setNewPurchaseCarrierId("");
                                      setNewPurchaseCarrierCustom("");
                                      setNewPurchaseCarrier("");
                                      setShowCarrierPicker(false);
                                      setCarrierSearchQuery("");
                                      setShowCarrierCustomInput(false);
                                    }}
                                    style={{ padding: "8px 12px", border: "1px solid #c9cccf", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 }}
                                  >
                                    クリア
                                  </button>
                                </div>

                                <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: 8, padding: 6 }}>
                                  {filteredCarriersForPicker.length === 0 ? (
                                    <div style={{ padding: "10px 12px", color: "#6d7175", fontSize: 13 }}>該当する配送業者がありません</div>
                                  ) : (
                                    filteredCarriersForPicker.map((c) => {
                                      const selected = c.id === newPurchaseCarrierId;
                                      return (
                                        <div
                                          key={c.id}
                                          onClick={() => {
                                            setNewPurchaseCarrierId(c.id);
                                            setNewPurchaseCarrierCustom("");
                                            setNewPurchaseCarrier(c.label);
                                            setShowCarrierPicker(false);
                                            setCarrierSearchQuery("");
                                            setShowCarrierCustomInput(false);
                                          }}
                                          style={{
                                            padding: "10px 12px",
                                            borderRadius: 6,
                                            cursor: "pointer",
                                            backgroundColor: selected ? "#eff6ff" : "transparent",
                                            border: selected ? "1px solid #2563eb" : "1px solid transparent",
                                            borderBottom: selected ? undefined : "1px solid #e5e7eb",
                                            marginTop: 4,
                                          }}
                                        >
                                          <div style={{ fontWeight: selected ? 600 : 500, fontSize: 13 }}>
                                            {c.label}
                                          </div>
                                        </div>
                                      );
                                    })
                                  )}
                                </div>

                                <div style={{ marginTop: 8 }}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setShowCarrierCustomInput((v) => !v);
                                      if (!showCarrierCustomInput) {
                                        setNewPurchaseCarrierId("");
                                        setNewPurchaseCarrier("");
                                      } else {
                                        setNewPurchaseCarrierCustom("");
                                        setNewPurchaseCarrier("");
                                      }
                                    }}
                                    style={{ padding: "6px 12px", border: "1px solid #c9cccf", borderRadius: 6, background: showCarrierCustomInput ? "#eff6ff" : "#fff", cursor: "pointer", fontSize: 13 }}
                                  >
                                    その他
                                  </button>
                                </div>

                                {showCarrierCustomInput && (
                                  <div style={{ marginTop: 8 }}>
                                    <input
                                      type="text"
                                      value={newPurchaseCarrierCustom}
                                      onChange={(e) => {
                                        setNewPurchaseCarrierCustom(e.target.value);
                                        setNewPurchaseCarrier(e.target.value);
                                      }}
                                      placeholder="マスタにない配送業者を入力"
                                      style={{ width: "100%", padding: 8, fontSize: 14, border: "1px solid #ccc", borderRadius: 4 }}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          <div>
                            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>配送番号</label>
                            <input
                              type="text"
                              value={newPurchaseTrackingNumber}
                              onChange={(e) => setNewPurchaseTrackingNumber(e.target.value)}
                              style={{ width: "100%", padding: 8, fontSize: 14, border: "1px solid #ccc", borderRadius: 4, boxSizing: "border-box", maxWidth: "100%" }}
                            />
                          </div>

                          <div>
                            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>備考</label>
                            <input
                              type="text"
                              value={newPurchaseNote}
                              onChange={(e) => setNewPurchaseNote(e.target.value)}
                              style={{ width: "100%", padding: 8, fontSize: 14, border: "1px solid #ccc", borderRadius: 4, boxSizing: "border-box", maxWidth: "100%" }}
                            />
                          </div>
                        </div>

                        <s-divider />
                        <s-text emphasis="bold" size="large">商品</s-text>
                        <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
                          <button type="button" onClick={() => setNewPurchaseProductMethod("search")} style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: newPurchaseProductMethod === "search" ? "#e5e7eb" : "transparent", color: "#202223", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>商品検索</button>
                          <button type="button" onClick={() => setNewPurchaseProductMethod("collection")} style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: newPurchaseProductMethod === "collection" ? "#e5e7eb" : "transparent", color: "#202223", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>コレクション検索</button>
                          <button type="button" onClick={() => setNewPurchaseProductMethod("csv")} style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: newPurchaseProductMethod === "csv" ? "#e5e7eb" : "transparent", color: "#202223", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>CSVアップロード</button>
                        </div>
                        <s-divider />

                        {newPurchaseProductMethod === "collection" && (
                          <s-stack gap="base">
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <s-text emphasis="bold" size="small">コレクションから追加</s-text>
                              <div style={{ display: "flex", gap: "8px" }}>
                                <button
                                  type="button"
                                  onClick={() => setNewPurchaseCollectionShowSelected(!newPurchaseCollectionShowSelected)}
                                  disabled={newPurchaseCollectionSelectedIds.size === 0}
                                  style={{
                                    padding: "4px 12px",
                                    borderRadius: "6px",
                                    border: "1px solid #d1d5db",
                                    backgroundColor: newPurchaseCollectionShowSelected && newPurchaseCollectionSelectedIds.size > 0 ? "#eff6ff" : newPurchaseCollectionSelectedIds.size === 0 ? "#f3f4f6" : "#ffffff",
                                    color: newPurchaseCollectionSelectedIds.size === 0 ? "#9ca3af" : "#202223",
                                    fontSize: "12px",
                                    fontWeight: 500,
                                    cursor: newPurchaseCollectionSelectedIds.size === 0 ? "not-allowed" : "pointer",
                                  }}
                                >
                                  選択済み ({newPurchaseCollectionSelectedIds.size})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setNewPurchaseCollectionSelectedIds(new Set());
                                    setNewPurchaseCollectionQuantities({});
                                  }}
                                  disabled={newPurchaseCollectionSelectedIds.size === 0}
                                  style={{
                                    padding: "4px 12px",
                                    borderRadius: "6px",
                                    border: "1px solid #d1d5db",
                                    backgroundColor: newPurchaseCollectionSelectedIds.size === 0 ? "#f3f4f6" : "#ffffff",
                                    color: newPurchaseCollectionSelectedIds.size === 0 ? "#9ca3af" : "#d72c0d",
                                    fontSize: "12px",
                                    fontWeight: 500,
                                    cursor: newPurchaseCollectionSelectedIds.size === 0 ? "not-allowed" : "pointer",
                                  }}
                                >
                                  選択解除
                                </button>
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                              <input
                                type="text"
                                value={newPurchaseCollectionSearchQuery}
                                onChange={(e) => setNewPurchaseCollectionSearchQuery(e.target.value)}
                                placeholder="コレクション名で検索"
                                style={{ padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: "6px", fontSize: "14px", flex: "1 1 200px", minWidth: 0 }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    if (newPurchaseCollectionSearchQuery.trim() && newPurchaseCollectionSearchFetcher.state !== "submitting") {
                                      const fd = new FormData();
                                      fd.set("intent", "searchCollectionsForPurchase");
                                      fd.set("query", newPurchaseCollectionSearchQuery.trim());
                                      newPurchaseCollectionSearchFetcher.submit(fd, { method: "post", action: location.pathname });
                                    }
                                  }
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  if (!newPurchaseCollectionSearchQuery.trim() || newPurchaseCollectionSearchFetcher.state === "submitting") return;
                                  const fd = new FormData();
                                  fd.set("intent", "searchCollectionsForPurchase");
                                  fd.set("query", newPurchaseCollectionSearchQuery.trim());
                                  newPurchaseCollectionSearchFetcher.submit(fd, { method: "post", action: location.pathname });
                                }}
                                disabled={!newPurchaseCollectionSearchQuery.trim() || newPurchaseCollectionSearchFetcher.state === "submitting"}
                                style={{ padding: "6px 12px", backgroundColor: !newPurchaseCollectionSearchQuery.trim() || newPurchaseCollectionSearchFetcher.state === "submitting" ? "#d1d5db" : "#2563eb", color: "#fff", border: "none", borderRadius: "6px", fontSize: "13px", cursor: !newPurchaseCollectionSearchQuery.trim() || newPurchaseCollectionSearchFetcher.state === "submitting" ? "not-allowed" : "pointer" }}
                              >
                                {newPurchaseCollectionSearchFetcher.state === "submitting" ? "検索中..." : "検索"}
                              </button>
                            </div>
                            {newPurchaseCollectionSearchResults.length > 0 && !newPurchaseSelectedCollectionId && (
                              <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                                {newPurchaseCollectionSearchResults.map((c) => (
                                  <div
                                    key={c.id}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => {
                                      setNewPurchaseSelectedCollectionId(c.id);
                                      const fd = new FormData();
                                      fd.set("intent", "getCollectionProductsForPurchase");
                                      fd.set("collectionId", c.id);
                                      newPurchaseCollectionProductsFetcher.submit(fd, { method: "post", action: location.pathname });
                                    }}
                                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setNewPurchaseSelectedCollectionId(c.id); const fd = new FormData(); fd.set("intent", "getCollectionProductsForPurchase"); fd.set("collectionId", c.id); newPurchaseCollectionProductsFetcher.submit(fd, { method: "post", action: location.pathname }); } }}
                                    style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", border: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: "8px" }}
                                  >
                                    <span style={{ fontWeight: 500 }}>{c.title}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {newPurchaseSelectedCollectionId && (
                              <>
                                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                  <span style={{ fontSize: "13px", color: "#6d7175" }}>選択中: {newPurchaseCollectionSearchResults.find((c) => c.id === newPurchaseSelectedCollectionId)?.title ?? newPurchaseSelectedCollectionId}</span>
                                  <button
                                    type="button"
                                    onClick={() => { setNewPurchaseSelectedCollectionId(""); setNewPurchaseCollectionProducts([]); setNewPurchaseCollectionSelectedIds(new Set()); }}
                                    style={{ padding: "4px 8px", fontSize: "12px", border: "1px solid #d1d5db", borderRadius: "6px", background: "#fff", cursor: "pointer" }}
                                  >
                                    別のコレクションを選ぶ
                                  </button>
                                </div>
                                {newPurchaseCollectionProductsFetcher.state === "submitting" ? (
                                  <div style={{ padding: "12px", color: "#6d7175", fontSize: "13px" }}>商品を読み込み中...</div>
                                ) : newPurchaseCollectionProducts.length > 0 ? (
                                  <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                                    {(newPurchaseCollectionShowSelected ? newPurchaseCollectionProducts.filter((p) => newPurchaseCollectionSelectedIds.has(p.variantId)) : newPurchaseCollectionProducts).map((p) => {
                                      const isSelected = newPurchaseCollectionSelectedIds.has(p.variantId);
                                      const qty = newPurchaseCollectionQuantities[p.variantId] ?? 1;
                                      return (
                                        <div
                                          key={p.variantId}
                                          role="button"
                                          tabIndex={0}
                                          onClick={() => {
                                            setNewPurchaseCollectionSelectedIds((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(p.variantId)) next.delete(p.variantId);
                                              else next.add(p.variantId);
                                              return next;
                                            });
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                              e.preventDefault();
                                              setNewPurchaseCollectionSelectedIds((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(p.variantId)) next.delete(p.variantId);
                                                else next.add(p.variantId);
                                                return next;
                                              });
                                            }
                                          }}
                                          style={{
                                            padding: "10px 12px",
                                            borderRadius: "6px",
                                            cursor: "pointer",
                                            backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                            border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "8px",
                                          }}
                                        >
                                          <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                                          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                            <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{p.title || "(商品名なし)"}</span>
                                            {p.sku ? <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>SKU：{p.sku}</span> : null}
                                          </div>
                                          <input
                                            type="number"
                                            min={1}
                                            value={qty}
                                            onChange={(e) => { e.stopPropagation(); const n = Math.max(1, parseInt(e.target.value, 10) || 1); setNewPurchaseCollectionQuantities((prev) => ({ ...prev, [p.variantId]: n })); }}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ width: 56, padding: "4px 8px", fontSize: 13, border: "1px solid #c9cccf", borderRadius: "6px" }}
                                          />
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div style={{ padding: "12px", color: "#6d7175", fontSize: "13px" }}>このコレクションに商品はありません</div>
                                )}
                              </>
                            )}
                            <s-text tone="subdued" size="small">
                              {newPurchaseCollectionSearchResults.length === 0 && !newPurchaseCollectionSearchQuery && "コレクション名を入力して検索してください。"}
                              {newPurchaseCollectionSearchResults.length > 0 && !newPurchaseSelectedCollectionId && "コレクションをクリックして商品一覧を表示し、チェックして「商品を追加」で追加します。"}
                            </s-text>
                          </s-stack>
                        )}
                        {newPurchaseProductMethod === "search" && (
                          <s-stack gap="base">
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <s-text emphasis="bold" size="small">商品検索</s-text>
                              <div style={{ display: "flex", gap: "8px" }}>
                                <button
                                  type="button"
                                  onClick={() => setNewPurchaseShowSelectedProducts(!newPurchaseShowSelectedProducts)}
                                  disabled={newPurchaseSearchSelectedIds.size === 0}
                                  style={{
                                    padding: "4px 12px",
                                    borderRadius: "6px",
                                    border: "1px solid #d1d5db",
                                    backgroundColor: newPurchaseShowSelectedProducts && newPurchaseSearchSelectedIds.size > 0 ? "#eff6ff" : (newPurchaseSearchSelectedIds.size === 0 ? "#f3f4f6" : "#ffffff"),
                                    color: newPurchaseSearchSelectedIds.size === 0 ? "#9ca3af" : "#202223",
                                    fontSize: "12px",
                                    fontWeight: 500,
                                    cursor: newPurchaseSearchSelectedIds.size === 0 ? "not-allowed" : "pointer",
                                  }}
                                >
                                  選択済み ({newPurchaseSearchSelectedIds.size})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setNewPurchaseSearchSelectedIds(new Set());
                                    setNewPurchaseSelectedProductsInfo(new Map());
                                    setNewPurchaseSearchQuantities({});
                                  }}
                                  disabled={newPurchaseSearchSelectedIds.size === 0}
                                  style={{
                                    padding: "4px 12px",
                                    borderRadius: "6px",
                                    border: "1px solid #d1d5db",
                                    backgroundColor: newPurchaseSearchSelectedIds.size === 0 ? "#f3f4f6" : "#ffffff",
                                    color: newPurchaseSearchSelectedIds.size === 0 ? "#9ca3af" : "#d72c0d",
                                    fontSize: "12px",
                                    fontWeight: 500,
                                    cursor: newPurchaseSearchSelectedIds.size === 0 ? "not-allowed" : "pointer",
                                  }}
                                >
                                  選択解除
                                </button>
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                              <input
                                type="text"
                                value={newPurchaseSearchQuery}
                                onChange={(e) => setNewPurchaseSearchQuery(e.target.value)}
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
                                    if (newPurchaseSearchQuery.trim() && fetcher.state !== "submitting") {
                                      setNewPurchaseError("");
                                      const fd = new FormData();
                                      fd.set("intent", "searchVariantsForPurchase");
                                      fd.set("query", newPurchaseSearchQuery.trim());
                                      fetcher.submit(fd, { method: "post", action: location.pathname });
                                    }
                                  }
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  if (!newPurchaseSearchQuery.trim() || fetcher.state === "submitting") return;
                                  setNewPurchaseError("");
                                  const fd = new FormData();
                                  fd.set("intent", "searchVariantsForPurchase");
                                  fd.set("query", newPurchaseSearchQuery.trim());
                                  fetcher.submit(fd, { method: "post", action: location.pathname });
                                }}
                                disabled={!newPurchaseSearchQuery.trim() || fetcher.state === "submitting"}
                                style={{
                                  padding: "6px 12px",
                                  backgroundColor: !newPurchaseSearchQuery.trim() || fetcher.state === "submitting" ? "#d1d5db" : "#2563eb",
                                  color: "#ffffff",
                                  border: "none",
                                  borderRadius: "6px",
                                  fontSize: "13px",
                                  fontWeight: 500,
                                  cursor: !newPurchaseSearchQuery.trim() || fetcher.state === "submitting" ? "not-allowed" : "pointer",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {fetcher.state === "submitting" ? "検索中..." : "検索"}
                              </button>
                            </div>
                            {(newPurchaseSearchVariants.length > 0 || (newPurchaseShowSelectedProducts && newPurchaseSelectedProductsInfo.size > 0)) && (
                              <>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                  <s-text tone="subdued" size="small">
                                    {newPurchaseSearchSelectedIds.size > 0
                                      ? `選択中: ${newPurchaseSearchSelectedIds.size}件 / 表示: ${newPurchaseShowSelectedProducts ? Array.from(newPurchaseSelectedProductsInfo.values()).length : newPurchaseSearchVariants.length}件`
                                      : `表示: ${newPurchaseSearchVariants.length}件`}
                                  </s-text>
                                </div>
                                <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                                  {/* 選択済みボタンが押されている場合は選択済み商品のみ表示、押されていない場合は検索結果を表示 */}
                                  {newPurchaseShowSelectedProducts ? (
                                    /* 選択済み商品のみ表示 */
                                    Array.from(newPurchaseSelectedProductsInfo.values()).map((v) => {
                                      const isSelected = newPurchaseSearchSelectedIds.has(v.variantId);
                                      return (
                                        <div
                                          key={`selected-${v.variantId}`}
                                          role="button"
                                          tabIndex={0}
                                          onClick={() => {
                                            setNewPurchaseSearchSelectedIds((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(v.variantId)) {
                                                next.delete(v.variantId);
                                                setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                  const newInfo = new Map(prevInfo);
                                                  newInfo.delete(v.variantId);
                                                  return newInfo;
                                                });
                                              } else {
                                                next.add(v.variantId);
                                                setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                  const newInfo = new Map(prevInfo);
                                                  newInfo.set(v.variantId, v);
                                                  return newInfo;
                                                });
                                              }
                                              return next;
                                            });
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                              e.preventDefault();
                                              setNewPurchaseSearchSelectedIds((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(v.variantId)) {
                                                  next.delete(v.variantId);
                                                  setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                    const newInfo = new Map(prevInfo);
                                                    newInfo.delete(v.variantId);
                                                    return newInfo;
                                                  });
                                                } else {
                                                  next.add(v.variantId);
                                                  setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                    const newInfo = new Map(prevInfo);
                                                    newInfo.set(v.variantId, v);
                                                    return newInfo;
                                                  });
                                                }
                                                return next;
                                              });
                                            }
                                          }}
                                          style={{
                                            padding: "10px 12px",
                                            borderRadius: "6px",
                                            cursor: "pointer",
                                            backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                            border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
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
                                          <input
                                            type="number"
                                            min={1}
                                            value={v.quantity ?? 1}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              const n = Math.max(1, parseInt(e.target.value, 10) || 1);
                                              setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                const newInfo = new Map(prevInfo);
                                                const existing = newInfo.get(v.variantId);
                                                if (existing) {
                                                  newInfo.set(v.variantId, { ...existing, quantity: n });
                                                }
                                                return newInfo;
                                              });
                                              setNewPurchaseSearchQuantities((prev) => ({ ...prev, [v.variantId]: n }));
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ width: 56, padding: "4px 8px", fontSize: 13, border: "1px solid #c9cccf", borderRadius: "6px" }}
                                          />
                                        </div>
                                      );
                                    })
                                  ) : (
                                    /* 検索結果を表示 */
                                    newPurchaseSearchVariants.map((v) => {
                                      const isSelected = newPurchaseSearchSelectedIds.has(v.variantId);
                                      return (
                                        <div
                                          key={v.variantId}
                                          role="button"
                                          tabIndex={0}
                                          onClick={() => {
                                            setNewPurchaseSearchSelectedIds((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(v.variantId)) {
                                                next.delete(v.variantId);
                                                setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                  const newInfo = new Map(prevInfo);
                                                  newInfo.delete(v.variantId);
                                                  return newInfo;
                                                });
                                              } else {
                                                next.add(v.variantId);
                                                const quantity = newPurchaseSearchQuantities[v.variantId] ?? 1;
                                                setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                  const newInfo = new Map(prevInfo);
                                                  newInfo.set(v.variantId, { ...v, quantity });
                                                  return newInfo;
                                                });
                                              }
                                              return next;
                                            });
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                              e.preventDefault();
                                              setNewPurchaseSearchSelectedIds((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(v.variantId)) {
                                                  next.delete(v.variantId);
                                                  setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                    const newInfo = new Map(prevInfo);
                                                    newInfo.delete(v.variantId);
                                                    return newInfo;
                                                  });
                                                } else {
                                                  next.add(v.variantId);
                                                  const quantity = newPurchaseSearchQuantities[v.variantId] ?? 1;
                                                  setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                    const newInfo = new Map(prevInfo);
                                                    newInfo.set(v.variantId, { ...v, quantity });
                                                    return newInfo;
                                                  });
                                                }
                                                return next;
                                              });
                                            }
                                          }}
                                          style={{
                                            padding: "10px 12px",
                                            borderRadius: "6px",
                                            cursor: "pointer",
                                            backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                            border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
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
                                          <input
                                            type="number"
                                            min={1}
                                            value={newPurchaseSearchQuantities[v.variantId] ?? 1}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              const n = Math.max(1, parseInt(e.target.value, 10) || 1);
                                              setNewPurchaseSearchQuantities((prev) => ({ ...prev, [v.variantId]: n }));
                                              // 選択済み商品の情報も更新
                                              if (isSelected) {
                                                setNewPurchaseSelectedProductsInfo((prevInfo) => {
                                                  const newInfo = new Map(prevInfo);
                                                  const existing = newInfo.get(v.variantId);
                                                  if (existing) {
                                                    newInfo.set(v.variantId, { ...existing, quantity: n });
                                                  }
                                                  return newInfo;
                                                });
                                              }
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ width: 56, padding: "4px 8px", fontSize: 13, border: "1px solid #c9cccf", borderRadius: "6px" }}
                                          />
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              </>
                            )}
                          </s-stack>
                        )}
                        {newPurchaseProductMethod === "csv" && (
                          <s-stack gap="base">
                            <s-text emphasis="bold" size="small">CSVアップロード</s-text>
                            <s-text tone="subdued" size="small">
                              テンプレートをダウンロードしてCSVを作成し、アップロードしてください。アップ後にプレビューが出るので、チェックした商品だけ「商品を追加」で追加します。
                            </s-text>
                            <input
                              type="file"
                              ref={newPurchaseCsvFileInputRef}
                              accept=".csv,text/csv"
                              style={{ display: "none" }}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const reader = new FileReader();
                                reader.onload = () => {
                                  const text = typeof reader.result === "string" ? reader.result : "";
                                  if (!text.trim()) {
                                    setNewPurchaseError("CSVが空です。");
                                    return;
                                  }
                                  setNewPurchaseError("");
                                  const fd = new FormData();
                                  fd.set("intent", "resolveCsvForPurchase");
                                  fd.set("csv", text.trim());
                                  fetcher.submit(fd, { method: "post", action: location.pathname });
                                };
                                reader.readAsText(file, "UTF-8");
                                e.target.value = "";
                              }}
                            />
                            <s-stack direction="inline" gap="base">
                              <s-button
                                tone="secondary"
                                disabled={fetcher.state === "submitting"}
                                onClick={() => {
                                  setNewPurchaseError("");
                                  setNewPurchaseCsvPreviewItems([]);
                                  setNewPurchaseCsvSelectedIds(new Set());
                                  newPurchaseCsvFileInputRef.current?.click();
                                }}
                              >
                                CSVアップロード
                              </s-button>
                              <s-button tone="secondary" onClick={handlePurchaseCsvTemplateDownload}>
                                テンプレートダウンロード
                              </s-button>
                            </s-stack>

                            {newPurchaseCsvPreviewItems.length > 0 && (
                              <>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                  <s-text tone="subdued" size="small">
                                    {newPurchaseCsvSelectedIds.size > 0
                                      ? `選択中: ${newPurchaseCsvSelectedIds.size}件 / プレビュー: ${newPurchaseCsvPreviewItems.length}件`
                                      : `プレビュー: ${newPurchaseCsvPreviewItems.length}件`}
                                  </s-text>
                                </div>
                                <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                                  {newPurchaseCsvPreviewItems.map((it) => {
                                    const invId = String(it.inventoryItemId ?? "");
                                    const isSelected = invId ? newPurchaseCsvSelectedIds.has(invId) : false;
                                    return (
                                      <div
                                        key={`${invId}-${it.variantId ?? ""}-${it.sku ?? ""}-${it.title ?? ""}`}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => {
                                          if (!invId) return;
                                          setNewPurchaseCsvSelectedIds((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(invId)) next.delete(invId);
                                            else next.add(invId);
                                            return next;
                                          });
                                        }}
                                        onKeyDown={(e) => {
                                          if (!invId) return;
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            setNewPurchaseCsvSelectedIds((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(invId)) next.delete(invId);
                                              else next.add(invId);
                                              return next;
                                            });
                                          }
                                        }}
                                        style={{
                                          padding: "10px 12px",
                                          borderRadius: "6px",
                                          cursor: invId ? "pointer" : "not-allowed",
                                          backgroundColor: isSelected ? "#eff6ff" : "transparent",
                                          border: isSelected ? "1px solid #2563eb" : "1px solid transparent",
                                          borderBottom: isSelected ? undefined : "1px solid #e5e7eb",
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "8px",
                                          opacity: invId ? 1 : 0.6,
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
                                            {it.title || "(商品名なし)"}
                                          </span>
                                          {it.sku ? (
                                            <span style={{ fontSize: "12px", color: "#6d7175", display: "block" }}>SKU：{it.sku}</span>
                                          ) : null}
                                        </div>
                                        <span style={{ fontSize: 13, color: "#202223" }}>× {it.quantity}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </>
                            )}
                          </s-stack>
                        )}

                        <div style={{ marginTop: 8 }}>
                          <button
                            type="button"
                            disabled={
                              fetcher.state === "submitting" ||
                              (newPurchaseProductMethod === "search" && newPurchaseSearchSelectedIds.size === 0) ||
                              (newPurchaseProductMethod === "collection" && newPurchaseCollectionSelectedIds.size === 0) ||
                              (newPurchaseProductMethod === "csv" && newPurchaseCsvSelectedIds.size === 0)
                            }
                            onClick={() => {
                              setNewPurchaseError("");
                              if (newPurchaseProductMethod === "search") {
                                const toAdd = newPurchaseSearchVariants
                                  .filter((v) => newPurchaseSearchSelectedIds.has(v.variantId))
                                  .map((v) => ({ v, qty: Math.max(1, newPurchaseSearchQuantities[v.variantId] ?? 1) }))
                                  .filter((x) => x.qty > 0);
                                if (toAdd.length > 0) {
                                  setNewPurchaseItems((prev) => [...prev, ...toAdd.map(({ v, qty }) => ({ ...v, quantity: qty }))]);
                                  setNewPurchaseSearchSelectedIds(new Set());
                                  setNewPurchaseError("");
                                }
                              } else if (newPurchaseProductMethod === "collection") {
                                const toAdd = newPurchaseCollectionProducts
                                  .filter((p) => newPurchaseCollectionSelectedIds.has(p.variantId))
                                  .map((p) => ({ ...p, quantity: Math.max(1, newPurchaseCollectionQuantities[p.variantId] ?? 1) }));
                                if (toAdd.length > 0) {
                                  setNewPurchaseItems((prev) => [...prev, ...toAdd.map(({ variantId, inventoryItemId, sku, title, barcode, quantity }) => ({ variantId, inventoryItemId, sku, title, barcode, quantity }))]);
                                  setNewPurchaseCollectionSelectedIds(new Set());
                                  setNewPurchaseCollectionQuantities({});
                                  setNewPurchaseError("");
                                }
                              } else if (newPurchaseProductMethod === "csv") {
                                const toAdd = newPurchaseCsvPreviewItems.filter((it) => {
                                  const invId = String(it.inventoryItemId ?? "");
                                  return invId && newPurchaseCsvSelectedIds.has(invId);
                                });
                                if (toAdd.length > 0) {
                                  setNewPurchaseItems((prev) => [...prev, ...toAdd]);
                                  setNewPurchaseCsvPreviewItems([]);
                                  setNewPurchaseCsvSelectedIds(new Set());
                                  setNewPurchaseError("");
                                }
                              }
                            }}
                            style={{
                              padding: "8px 16px",
                              backgroundColor: (fetcher.state === "submitting" ||
                                (newPurchaseProductMethod === "search" && newPurchaseSearchSelectedIds.size === 0) ||
                                (newPurchaseProductMethod === "collection" && newPurchaseCollectionSelectedIds.size === 0) ||
                                (newPurchaseProductMethod === "csv" && newPurchaseCsvSelectedIds.size === 0)) ? "#d1d5db" : "#2563eb",
                              color: "#ffffff",
                              border: "none",
                              borderRadius: "6px",
                              fontSize: "14px",
                              fontWeight: 600,
                              cursor: (fetcher.state === "submitting" ||
                                (newPurchaseProductMethod === "search" && newPurchaseSearchSelectedIds.size === 0) ||
                                (newPurchaseProductMethod === "collection" && newPurchaseCollectionSelectedIds.size === 0) ||
                                (newPurchaseProductMethod === "csv" && newPurchaseCsvSelectedIds.size === 0)) ? "not-allowed" : "pointer",
                              width: "100%",
                            }}
                          >
                            商品を追加
                          </button>
                        </div>
                      </s-stack>
                    </div>
                  </s-stack>
                </div>

                {/* 右：追加された商品一覧＋確定（棚卸と同じ白カード・スクロールなし） */}
                <div style={{ flex: "1 1 400px", minWidth: 0, width: "100%" }}>
                  <div style={{ background: "#ffffff", borderRadius: 12, boxShadow: "0 0 0 1px #e1e3e5", padding: 16 }}>
                    <s-stack gap="base">
                      {newPurchaseItems.length > 0 ? (
                          <>
                            <s-text tone="subdued" size="small">合計 {newPurchaseItems.length} 件</s-text>
                            <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: 8, marginBottom: 16 }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                                <thead>
                                  <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "1px solid #ddd" }}>
                                    <th style={{ padding: 8, textAlign: "left" }}>商品名</th>
                                    <th style={{ padding: 8, textAlign: "left" }}>SKU</th>
                                    <th style={{ padding: 8, textAlign: "right" }}>数量</th>
                                    <th style={{ padding: 8, width: 52 }}></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {newPurchaseItems.map((item, idx) => (
                                    <tr key={idx} style={{ borderBottom: "1px solid #eee" }}>
                                      <td style={{ padding: 8 }}>{item.title || "—"}</td>
                                      <td style={{ padding: 8 }}>{item.sku || "—"}</td>
                                      <td style={{ padding: 8, textAlign: "right" }}>
                                        <input
                                          type="number"
                                          min={1}
                                          value={Number(item.quantity ?? 1)}
                                          onChange={(e) => {
                                            const n = Math.max(1, parseInt(e.target.value, 10) || 1);
                                            setNewPurchaseItems((prev) => prev.map((p, i) => (i === idx ? { ...p, quantity: n } : p)));
                                          }}
                                          style={{
                                            width: 72,
                                            padding: "4px 8px",
                                            fontSize: 13,
                                            border: "1px solid #c9cccf",
                                            borderRadius: "6px",
                                            textAlign: "right",
                                          }}
                                        />
                                      </td>
                                      <td style={{ padding: 8 }}>
                                        <button type="button" onClick={() => setNewPurchaseItems((prev) => prev.filter((_, i) => i !== idx))} style={{ background: "none", border: "none", color: "#c00", cursor: "pointer", fontSize: 13 }}>削除</button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                              <button
                                type="button"
                                disabled={!newPurchaseLocationId || !newPurchaseDate || newPurchaseItems.length === 0 || fetcher.state === "submitting"}
                                onClick={() => {
                                  setNewPurchaseError("");
                                  const loc = locations.find((l) => l.id === newPurchaseLocationId);
                                  const fd = new FormData();
                                  fd.set("intent", "createPurchase");
                                  fd.set("locationId", newPurchaseLocationId);
                                  fd.set("locationName", loc?.name ?? "");
                                  fd.set("date", newPurchaseDate);
                                  fd.set("supplierName", finalNewPurchaseSupplierName);
                                  fd.set("carrier", finalNewPurchaseCarrierLabel);
                                  fd.set("trackingNumber", newPurchaseTrackingNumber);
                                  fd.set("expectedArrival", newPurchaseExpectedArrival);
                                  fd.set("staffName", newPurchaseStaffName);
                                  fd.set("note", newPurchaseNote);
                                  fd.set("items", JSON.stringify(newPurchaseItems));
                                  fetcher.submit(fd, { method: "post", action: location.pathname });
                                }}
                                style={{
                                  padding: "8px 16px",
                                  backgroundColor: (!newPurchaseLocationId || !newPurchaseDate || newPurchaseItems.length === 0 || fetcher.state === "submitting") ? "#d1d5db" : "#2563eb",
                                  color: "#ffffff",
                                  border: "none",
                                  borderRadius: "6px",
                                  fontSize: "14px",
                                  fontWeight: 600,
                                  cursor: (!newPurchaseLocationId || !newPurchaseDate || newPurchaseItems.length === 0 || fetcher.state === "submitting") ? "not-allowed" : "pointer",
                                }}
                              >
                                {fetcher.state === "submitting" ? "登録中..." : "仕入ID発行確定"}
                              </button>
                            </div>
                          </>
                        ) : (
                          <s-box padding="base">
                            <s-text tone="subdued" size="small">「商品を追加」から追加すると、ここに一覧が表示されます。</s-text>
                          </s-box>
                        )}
                    </s-stack>
                      </div>
                    </div>
              </div>
            </s-box>
            )}

            {purchaseActiveTab === "history" && (
            <s-box padding="base">
            <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <s-stack gap="base">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>仕入履歴</div>
                    <s-text tone="subdued" size="small">
                      条件で絞り込みを行い、仕入履歴を表示します。
                      <br />
                      発注から作成したリスト（#P0000）や POS や新規作成から作成した（#B0000）が確認できます。
                    </s-text>
                  </div>

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
                        ロケーション・ステータス・仕入先・作成元を選ぶと一覧が絞り込まれます。
                      </s-text>
                      <s-divider />
                      <s-text emphasis="bold" size="small">入庫先ロケーション</s-text>
                      <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                        <div
                          onClick={() => setLocationFilters(new Set())}
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
                              onClick={() => {
                                const newFilters = new Set(locationFilters);
                                if (isSelected) newFilters.delete(loc.id);
                                else newFilters.add(loc.id);
                                setLocationFilters(newFilters);
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
                              <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                              <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                            </div>
                          );
                        })}
                      </div>
                      <s-text emphasis="bold" size="small">ステータス</s-text>
                      <div style={{ maxHeight: "180px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                        <div
                          onClick={() => setStatusFilters(new Set())}
                          style={{
                            padding: "10px 12px",
                            borderRadius: "6px",
                            cursor: "pointer",
                            backgroundColor: statusFilters.size === 0 ? "#eff6ff" : "transparent",
                            border: statusFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <input type="checkbox" checked={statusFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                          <span style={{ fontWeight: statusFilters.size === 0 ? 600 : 500 }}>全て</span>
                        </div>
                        {Object.entries(STATUS_LABEL).map(([status, label]) => {
                          const isSelected = statusFilters.has(status);
                          return (
                            <div
                              key={status}
                              onClick={() => {
                                const newFilters = new Set(statusFilters);
                                if (isSelected) newFilters.delete(status);
                                else newFilters.add(status);
                                setStatusFilters(newFilters);
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
                              <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                              <span style={{ fontWeight: isSelected ? 600 : 500 }}>{label}</span>
                            </div>
                          );
                        })}
                      </div>
                      <s-text emphasis="bold" size="small">仕入先</s-text>
                      <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                        <div
                          onClick={() => setSupplierFilters(new Set())}
                          style={{
                            padding: "10px 12px",
                            borderRadius: "6px",
                            cursor: "pointer",
                            backgroundColor: supplierFilters.size === 0 ? "#eff6ff" : "transparent",
                            border: supplierFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <input type="checkbox" checked={supplierFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                          <span style={{ fontWeight: supplierFilters.size === 0 ? 600 : 500 }}>全て</span>
                        </div>
                        {Array.from(
                          new Map(
                            entries
                              .map((e) => e.supplierName || "")
                              .filter((name) => name.trim())
                              .map((name) => [name, name])
                          ).values()
                        ).map((name) => {
                          const isSelected = supplierFilters.has(name);
                          return (
                            <div
                              key={name}
                              onClick={() => {
                                const next = new Set(supplierFilters);
                                if (isSelected) next.delete(name);
                                else next.add(name);
                                setSupplierFilters(next);
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
                              <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                              <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                            </div>
                          );
                        })}
                      </div>

                      <s-text emphasis="bold" size="small">作成元</s-text>
                      <div style={{ maxHeight: "160px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                        <div
                          onClick={() => setSourceFilters(new Set())}
                          style={{
                            padding: "10px 12px",
                            borderRadius: "6px",
                            cursor: "pointer",
                            backgroundColor: sourceFilters.size === 0 ? "#eff6ff" : "transparent",
                            border: sourceFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <input type="checkbox" checked={sourceFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                          <span style={{ fontWeight: sourceFilters.size === 0 ? 600 : 500 }}>全て</span>
                        </div>
                        {[
                          { key: "order", label: "発注から作成（#P...）" },
                          { key: "b", label: "POS / 新規作成（#B...）" },
                        ].map((opt) => {
                          const isSelected = sourceFilters.has(opt.key);
                          return (
                            <div
                              key={opt.key}
                              onClick={() => {
                                const next = new Set(sourceFilters);
                                if (isSelected) next.delete(opt.key);
                                else next.add(opt.key);
                                setSourceFilters(next);
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
                              <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                              <span style={{ fontWeight: isSelected ? 600 : 500 }}>{opt.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </s-stack>
                  </div>
                </s-stack>
              </div>

              <div style={{ flex: "1 1 400px", minWidth: 0, width: "100%" }}>
                <div style={{ background: "#ffffff", borderRadius: 12, boxShadow: "0 0 0 1px #e1e3e5", padding: 16 }}>
                  <s-stack gap="base">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      <s-text tone="subdued" size="small">
                        表示: {filteredEntries.length}件 / {estimatedTotal}
                      </s-text>
                      {/* 一覧のCSV一括ダウンロードは非表示（モーダル内のCSV出力のみ利用可能） */}
                    </div>
                    {filteredEntries.length === 0 ? (
                      <s-box padding="base">
                        <s-text tone="subdued">仕入履歴がありません。発注画面で「仕入に反映」すると #P0000 がここに表示されます。</s-text>
                      </s-box>
                    ) : (
                      <s-stack gap="none">
                        {filteredEntries.map((entry) => {
                          const locationName =
                            entry.locationName || locations.find((l) => l.id === entry.locationId)?.name || entry.locationId;
                          const date = entry.date || extractDateFromISO(entry.createdAt, shopTimezone);
                          const itemCount = entry.items?.length ?? 0;
                          const totalQty = (entry.items ?? []).reduce((s, it) => s + (it.quantity || 0), 0);

                          return (
                            <div key={entry.id}>
                              <div
                                style={{ display: "flex", alignItems: "flex-start", padding: "12px", cursor: "pointer" }}
                                onClick={() => openItemsModal(entry)}
                              >
                                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                                    <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      {entry.purchaseName || entry.id}
                                    </s-text>
                                    <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", marginLeft: "8px" }}>
                                      {date}
                                    </s-text>
                                  </div>
                                  <div style={{ marginBottom: "2px" }}>
                                    <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                                      入庫先: {locationName}
                                    </s-text>
                                  </div>
                                  {entry.supplierName && (
                                    <div style={{ marginBottom: "2px" }}>
                                      <s-text tone="subdued" size="small" style={{ display: "block" }}>
                                        仕入先: {entry.supplierName}
                                      </s-text>
                                    </div>
                                  )}
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                                    <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                                      <span style={getStatusBadgeStyle(entry.status)}>{STATUS_LABEL[entry.status] || entry.status}</span>
                                      {entry.cancelledAt && (
                                        <span style={{ marginLeft: "8px" }}>
                                          （キャンセル: {new Date(entry.cancelledAt).toISOString().split("T")[0]}）
                                        </span>
                                      )}
                                    </s-text>
                                    <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                                      {itemCount}件・合計{totalQty}
                                    </s-text>
                                  </div>
                                </div>
                              </div>
                              <s-divider />
                            </div>
                          );
                        })}
                      </s-stack>
                    )}
                  </s-stack>
                </div>
              </div>
            </div>
            </s-box>
            )}
        </s-stack>
      </s-scroll-box>

      {csvExporting && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
          }}
        >
          <div style={{ backgroundColor: "white", borderRadius: "8px", padding: "24px", minWidth: "300px", maxWidth: "90%", boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)" }}>
            <div style={{ marginBottom: "16px", textAlign: "center" }}>
              <h3 style={{ margin: 0, fontSize: "18px", fontWeight: "bold", marginBottom: "8px" }}>CSV出力処理中</h3>
              <div style={{ fontSize: "14px", color: "#666", marginBottom: "16px" }}>
                {csvExportProgress.total > 0 ? `${csvExportProgress.current}/${csvExportProgress.total}件を処理中...` : "処理中..."}
              </div>
              <div style={{ width: "100%", height: "8px", backgroundColor: "#e0e0e0", borderRadius: "4px", overflow: "hidden" }}>
                <div
                  style={{
                    width: csvExportProgress.total > 0 ? `${(csvExportProgress.current / csvExportProgress.total) * 100}%` : "0%",
                    height: "100%",
                    backgroundColor: "#007bff",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={closeItemsModal}
        >
          <div
            style={{
              backgroundColor: "white",
              borderRadius: "8px",
              padding: "24px",
              maxWidth: "90%",
              maxHeight: "90%",
              overflow: "auto",
              boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "bold" }}>商品リスト</h2>
              <button
                onClick={closeItemsModal}
                style={{ background: "none", border: "none", fontSize: "24px", cursor: "pointer", padding: 0, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                ×
              </button>
            </div>

            {modalEntry && (
              <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}><strong>仕入ID:</strong> {modalEntry.id}</div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}><strong>名称:</strong> {modalEntry.purchaseName || modalEntry.id}</div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}><strong>日付:</strong> {modalEntry.date || extractDateFromISO(modalEntry.createdAt, shopTimezone)}</div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>入庫先:</strong>{" "}
                  {modalEntry.locationName || locations.find((l) => l.id === modalEntry.locationId)?.name || modalEntry.locationId}
                </div>
                {modalEntry.supplierName && (
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}><strong>仕入先:</strong> {modalEntry.supplierName}</div>
                )}
                {(modalEntry.carrier || modalEntry.trackingNumber) && (
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                    <strong>配送:</strong> {[modalEntry.carrier, modalEntry.trackingNumber].filter(Boolean).join(" / ")}
                  </div>
                )}
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>ステータス:</strong>{" "}
                  <span style={getStatusBadgeStyle(modalEntry.status)}>{STATUS_LABEL[modalEntry.status] || modalEntry.status}</span>
                </div>
                {modalEntry.cancelledAt && (
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                    <strong>キャンセル日時:</strong>{" "}
                    {formatDateTimeInShopTimezone(modalEntry.cancelledAt, shopTimezone)}
                  </div>
                )}
                <div style={{ fontSize: "14px" }}><strong>数量合計:</strong> {modalItems.reduce((s, it) => s + (it.quantity || 0), 0)}</div>
              </div>
            )}

            {fetcher.state === "submitting" || fetcher.state === "loading" ? (
              <div style={{ padding: "24px", textAlign: "center" }}>商品リストを取得中...</div>
            ) : modalItems.length > 0 ? (
              <div>
                <div style={{ marginBottom: "12px", fontSize: "14px", color: "#666" }}>合計: {modalItems.length}件</div>
                <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                    <thead>
                      <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品名</th>
                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>SKU</th>
                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>JAN</th>
                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション1</th>
                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション2</th>
                        <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション3</th>
                        <th style={{ padding: "8px", textAlign: "right" }}>数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalItems.map((item, idx) => (
                        <tr key={item.id || idx} style={{ borderBottom: "1px solid #eee" }}>
                          <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>{item.title || "（商品名なし）"}</td>
                          <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>{item.sku || "（SKUなし）"}</td>
                          <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>{item.barcode || "（JANなし）"}</td>
                          <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>{item.option1 || "-"}</td>
                          <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>{item.option2 || "-"}</td>
                          <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>{item.option3 || "-"}</td>
                          <td style={{ padding: "8px", textAlign: "right" }}>{item.quantity || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div style={{ padding: "24px", textAlign: "center", color: "#666" }}>商品リストがありません</div>
            )}

            <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
              {modalEntry && modalEntry.status === "pending" && modalItems.length > 0 && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const fd = new FormData();
                    fd.set("intent", "receive");
                    fd.set("entryId", modalEntry.id);
                    fetcher.submit(fd, { method: "post", action: location.pathname });
                  }}
                  disabled={fetcher.state === "submitting"}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#2563eb",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    cursor: fetcher.state === "submitting" ? "not-allowed" : "pointer",
                    fontWeight: 600,
                  }}
                >
                  {fetcher.state === "submitting" ? "処理中..." : "入庫確定"}
                </button>
              )}
              {modalEntry && modalEntry.status !== "cancelled" && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCancel(modalEntry);
                  }}
                  disabled={fetcher.state === "submitting"}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#dc3545",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    cursor: fetcher.state === "submitting" ? "wait" : "pointer",
                    fontSize: "14px",
                  }}
                >
                  {fetcher.state === "submitting" ? "処理中..." : "キャンセルする"}
                </button>
              )}
              {modalItems.length > 0 && (
                <button
                  onClick={exportModalCSV}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#007bff",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  CSV出力
                </button>
              )}
              <button
                onClick={closeItemsModal}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#6c757d",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* キャンセル確認モーダル（Portal は使わず同一ツリーで表示・OK クリックが届くようにする） */}
      {confirmModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="purchase-confirm-title"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2147483647,
            pointerEvents: "auto",
          }}
          onClick={() => {
            setConfirmModalOpen(false);
            setConfirmCallback(null);
            setPendingCancelEntryId(null);
          }}
        >
          <div
            role="document"
            style={{
              backgroundColor: "white",
              borderRadius: "8px",
              padding: "24px",
              maxWidth: "500px",
              width: "90%",
              boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
              pointerEvents: "auto",
              position: "relative",
              zIndex: 2147483647,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div id="purchase-confirm-title" style={{ marginBottom: "16px", fontSize: "18px", fontWeight: "bold" }}>
              仕入管理
            </div>
            <div style={{ marginBottom: "24px", fontSize: "14px", whiteSpace: "pre-line", lineHeight: "1.6" }}>
              {confirmMessage}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", position: "relative", zIndex: 2147483647 }}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleConfirmOk();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                style={{
                  padding: "8px 16px",
                  minWidth: "100px",
                  backgroundColor: "#2563eb",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "14px",
                  position: "relative",
                  zIndex: 2147483647,
                }}
              >
                OK
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmModalOpen(false);
                  setConfirmCallback(null);
                  setPendingCancelEntryId(null);
                }}
                style={{
                  padding: "8px 16px",
                  minWidth: "100px",
                  backgroundColor: "#6c757d",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "14px",
                  position: "relative",
                  zIndex: 2147483647,
                }}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}
