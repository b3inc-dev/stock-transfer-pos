// app/routes/app.order.tsx
// 発注履歴管理画面（入出庫履歴・ロス履歴と同じデザイン・機能を踏襲）
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useState, useMemo, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import type { SettingsV1, OrderCsvColumn, OrderDestinationOption } from "./app.settings";
import { getDateInShopTimezone, extractDateFromISO, formatDateTimeInShopTimezone, getShopTimezone } from "../utils/timezone";

const ORDER_NS = "stock_transfer_pos";
const ORDER_KEY = "order_request_entries_v1";
const PURCHASE_NS = "stock_transfer_pos";
const PURCHASE_KEY = "purchase_entries_v1";

export type LocationNode = { id: string; name: string };

export type OrderRequestItem = {
  id?: string;
  inventoryItemId: string;
  variantId?: string;
  sku?: string;
  barcode?: string;
  title?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  quantity: number;
  cost?: number; // 原価（商品情報から取得）
  price?: number; // 販売価格（商品情報から取得）
};

export type OrderRequestEntry = {
  id: string; // order_${timestamp}_${random}
  orderName?: string; // #P0001形式の名称
  locationId: string; // 発注元ロケーション
  locationName?: string;
  destination?: string; // 発注先（例: 本社）
  date: string; // YYYY-MM-DD
  desiredDeliveryDate?: string;
  note?: string;
  staffName?: string;
  items: OrderRequestItem[];
  // 承認時に実際に発注に回す商品（部分承認対応）
  approvedItems?: OrderRequestItem[];
  status: "pending" | "shipped" | "cancelled";
  createdAt: string;
  // 将来の発注書（Transfer）連携用
  linkedTransferId?: string | null;
  // 入荷日・検品日（管理画面で編集可能）
  arrivalDate?: string; // YYYY-MM-DD形式
  inspectionDate?: string; // YYYY-MM-DD形式
};

// 仕入エントリの型定義
export type PurchaseEntry = {
  id: string; // purchase_${timestamp}_${random}
  purchaseName: string; // #P0000（発注から）または #B0000（POSから）
  sourceOrderId?: string; // 発注から作成された場合の元発注ID
  locationId: string; // 入庫先ロケーション
  locationName?: string;
  supplierId?: string; // サプライヤーID（発注先マスタと連動）
  supplierName?: string; // サプライヤー名
  date: string; // YYYY-MM-DD
  desiredDeliveryDate?: string; // 希望納品日（発注から引き継ぎ）
  carrier?: string; // 配送業者
  trackingNumber?: string; // 配送番号
  expectedArrival?: string; // 到着予定日
  staffName?: string;
  note?: string;
  items: OrderRequestItem[]; // 仕入商品リスト（発注から引き継ぎ）
  status: "pending" | "received" | "cancelled"; // pending=未入庫, received=入庫済み, cancelled=キャンセル
  createdAt: string;
  receivedAt?: string; // 入庫日時
  cancelledAt?: string; // キャンセル日時（仕入キャンセル時）
};

// =========================
// Transfer（発注書）作成ヘルパー
// =========================

// locationId を GID 形式に変換（必要に応じて）
function normalizeLocationGid(locationId: string): string {
  const s = String(locationId || "").trim();
  if (!s) return "";
  if (s.startsWith("gid://shopify/Location/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Location/${s}`;
  const m = s.match(/Location\/(\d+)/);
  if (m?.[1]) return `gid://shopify/Location/${m[1]}`;
  return s; // そのまま返す（既にGID形式の可能性）
}

// inventoryItemId を GID 形式に変換（必要に応じて）
function normalizeInventoryItemGid(inventoryItemId: string): string {
  const s = String(inventoryItemId || "").trim();
  if (!s) return "";
  if (s.startsWith("gid://shopify/InventoryItem/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/InventoryItem/${s}`;
  const m = s.match(/InventoryItem\/(\d+)/);
  if (m?.[1]) return `gid://shopify/InventoryItem/${m[1]}`;
  return s; // そのまま返す（既にGID形式の可能性）
}

async function createTransferForOrder(admin: any, entry: OrderRequestEntry, approvedItems: OrderRequestItem[]): Promise<{ transferId: string | null; error: string | null }> {
  try {
    const lineItems =
      Array.isArray(approvedItems) && approvedItems.length > 0
        ? approvedItems
            .map((it) => {
              const inventoryItemId = normalizeInventoryItemGid(it.inventoryItemId);
              if (!inventoryItemId) {
                return null;
              }
              return {
                inventoryItemId,
                quantity: Math.max(1, Number(it.quantity || 0)),
              };
            })
            .filter((item): item is { inventoryItemId: string; quantity: number } => item !== null)
        : [];

    if (lineItems.length === 0) {
      return { transferId: null, error: "有効な商品がありません（inventoryItemId が不正です）" };
    }

    // 発注先ロケーション（店舗）を Transfer の入庫先として扱う
    const destinationLocationId = normalizeLocationGid(entry.locationId);
    if (!destinationLocationId) {
      return { transferId: null, error: "ロケーションIDが不正です" };
    }

    // まず inventoryTransferCreateAsReadyToShip を試す
    try {
      const resp = await admin.graphql(
        `#graphql
          mutation CreateTransferReadyForOrder($input: InventoryTransferCreateAsReadyToShipInput!) {
            inventoryTransferCreateAsReadyToShip(input: $input) {
              inventoryTransfer { id status name }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            input: {
              destinationLocationId,
              lineItems,
              note: entry.note || undefined,
            },
          },
        }
      );

      const data = await resp.json();
      
      // GraphQL エラー（ネットワークエラーなど）
      if (data.errors && data.errors.length > 0) {
        const errorMessages = data.errors.map((e: any) => e.message || String(e)).join(" / ");
        return { transferId: null, error: `GraphQLエラー: ${errorMessages}` };
      }

      const payload = data?.data?.inventoryTransferCreateAsReadyToShip;
      const userErrors = payload?.userErrors ?? [];
      if (userErrors.length) {
        const errorMessages = userErrors.map((e: any) => `${e.field || ""}: ${e.message || ""}`).join(" / ");
        return { transferId: null, error: `Transfer作成エラー: ${errorMessages}` };
      }
      
      const transferId = payload?.inventoryTransfer?.id ?? null;
      if (!transferId) {
        return { transferId: null, error: "Transfer ID が取得できませんでした" };
      }
      
      return { transferId, error: null };
    } catch (e) {
      // inventoryTransferCreateAsReadyToShip が使えない場合（APIバージョンが古いなど）、
      // Draft を作成してから ReadyToShip にマークする方法を試す
      try {
        // 1. Draft を作成
        const draftResp = await admin.graphql(
          `#graphql
            mutation CreateTransferDraft($input: InventoryTransferCreateInput!) {
              inventoryTransferCreate(input: $input) {
                inventoryTransfer { id status }
                userErrors { field message }
              }
            }
          `,
          {
            variables: {
              input: {
                destinationLocationId,
                lineItems,
                note: entry.note || undefined,
              },
            },
          }
        );

        const draftData = await draftResp.json();
        if (draftData.errors && draftData.errors.length > 0) {
          const errorMessages = draftData.errors.map((e: any) => e.message || String(e)).join(" / ");
          return { transferId: null, error: `Draft作成エラー: ${errorMessages}` };
        }

        const draftPayload = draftData?.data?.inventoryTransferCreate;
        const draftUserErrors = draftPayload?.userErrors ?? [];
        if (draftUserErrors.length) {
          const errorMessages = draftUserErrors.map((e: any) => `${e.field || ""}: ${e.message || ""}`).join(" / ");
          return { transferId: null, error: `Draft作成エラー: ${errorMessages}` };
        }

        const draftId = draftPayload?.inventoryTransfer?.id;
        if (!draftId) {
          return { transferId: null, error: "Draft Transfer ID が取得できませんでした" };
        }

        // 2. ReadyToShip にマーク
        const markResp = await admin.graphql(
          `#graphql
            mutation MarkAsReadyToShip($id: ID!) {
              inventoryTransferMarkAsReadyToShip(id: $id) {
                inventoryTransfer { id status }
                userErrors { field message }
              }
            }
          `,
          {
            variables: {
              id: draftId,
            },
          }
        );

        const markData = await markResp.json();
        if (markData.errors && markData.errors.length > 0) {
          const errorMessages = markData.errors.map((e: any) => e.message || String(e)).join(" / ");
          return { transferId: null, error: `ReadyToShipマークエラー: ${errorMessages}` };
        }

        const markPayload = markData?.data?.inventoryTransferMarkAsReadyToShip;
        const markUserErrors = markPayload?.userErrors ?? [];
        if (markUserErrors.length) {
          const errorMessages = markUserErrors.map((e: any) => `${e.field || ""}: ${e.message || ""}`).join(" / ");
          return { transferId: null, error: `ReadyToShipマークエラー: ${errorMessages}` };
        }

        const finalTransferId = markPayload?.inventoryTransfer?.id ?? draftId;
        return { transferId: finalTransferId, error: null };
      } catch (fallbackError) {
        const errorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        return { transferId: null, error: `フォールバック処理エラー: ${errorMessage}` };
      }
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return { transferId: null, error: `予期しないエラー: ${errorMessage}` };
  }
}

// =========================
// 発注から仕入予定を作成するヘルパー
// =========================

async function createPurchaseFromOrder(
  admin: any,
  orderEntry: OrderRequestEntry,
  approvedItems: OrderRequestItem[],
  appInstallationId: string
): Promise<{ purchaseId: string | null; purchaseName: string | null; error: string | null }> {
  try {
    // 既存の仕入予定を読み込む
    const purchaseResp = await admin.graphql(
      `#graphql
        query PurchaseEntries {
          currentAppInstallation {
            id
            metafield(namespace: "${PURCHASE_NS}", key: "${PURCHASE_KEY}") { value }
          }
        }
      `
    );

    const purchaseData = await purchaseResp.json();
    const purchaseRaw = purchaseData?.data?.currentAppInstallation?.metafield?.value;
    let existingPurchases: PurchaseEntry[] = [];
    if (typeof purchaseRaw === "string" && purchaseRaw) {
      try {
        const parsed = JSON.parse(purchaseRaw);
        existingPurchases = Array.isArray(parsed) ? parsed : [];
      } catch {
        existingPurchases = [];
      }
    }

    // 発注名称を引き継ぐ。同一発注から複数回「仕入に反映」した場合は -1, -2 を付与
    const orderDisplayName = orderEntry.orderName?.trim() || "";
    const maxPNum = existingPurchases
      .filter((p) => p?.purchaseName && /^#P\d+$/.test(String(p.purchaseName).trim()))
      .reduce((max, p) => {
        const m = String(p.purchaseName).trim().match(/^#P(\d+)$/);
        return m ? Math.max(max, parseInt(m[1], 10)) : max;
      }, 0);
    const baseName = orderDisplayName || `#P${String(maxPNum + 1).padStart(4, "0")}`;

    const fromSameOrder = existingPurchases.filter(
      (p) => p.sourceOrderId === orderEntry.id
    );
    const purchaseName =
      fromSameOrder.length === 0
        ? baseName
        : `${baseName}-${fromSameOrder.length}`;

    const purchaseId = `purchase_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // 発注先（destination）からサプライヤー情報を取得
    // 設定から発注先マスタを読み込んで、destinationと一致するものを探す
    const settingsResp = await admin.graphql(
      `#graphql
        query Settings {
          currentAppInstallation {
            id
            metafield(namespace: "stock_transfer_pos", key: "settings_v1") { value }
          }
        }
      `
    );

    const settingsData = await settingsResp.json();
    const settingsRaw = settingsData?.data?.currentAppInstallation?.metafield?.value;
    let supplierId: string | undefined;
    let supplierName: string | undefined;

    if (typeof settingsRaw === "string" && settingsRaw && orderEntry.destination) {
      try {
        const settings = JSON.parse(settingsRaw);
        const destinations = settings?.order?.destinations || [];
        const matchedDest = destinations.find((d: any) => d.name === orderEntry.destination);
        if (matchedDest) {
          supplierId = matchedDest.id;
          supplierName = matchedDest.name;
        }
      } catch {
        // ignore
      }
    }

    const newPurchase: PurchaseEntry = {
      id: purchaseId,
      purchaseName,
      sourceOrderId: orderEntry.id,
      locationId: orderEntry.locationId,
      locationName: orderEntry.locationName,
      supplierId,
      supplierName: supplierName || orderEntry.destination,
      date: orderEntry.date,
      desiredDeliveryDate: orderEntry.desiredDeliveryDate,
      staffName: orderEntry.staffName,
      note: orderEntry.note,
      items: approvedItems,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    // 仕入予定を保存
    const updatedPurchases = [...existingPurchases, newPurchase];

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
              value: JSON.stringify(updatedPurchases),
            },
          ],
        },
      }
    );

    return { purchaseId, purchaseName, error: null };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("[createPurchaseFromOrder] エラー:", errorMessage);
    return { purchaseId: null, purchaseName: null, error: `仕入予定作成エラー: ${errorMessage}` };
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  // ショップのタイムゾーンを取得
  const shopTimezone = await getShopTimezone(admin);

  const [locResp, appResp, settingsResp] = await Promise.all([
    admin.graphql(
      `#graphql
        query Locations($first: Int!) {
          locations(first: $first) {
            nodes { id name }
          }
        }
      `,
      { variables: { first: 250 } }
    ),
    admin.graphql(
      `#graphql
        query OrderRequests {
          currentAppInstallation {
            id
            metafield(namespace: "${ORDER_NS}", key: "${ORDER_KEY}") { value }
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

  // 設定を読み込む
  let settings: SettingsV1 | null = null;
  const settingsRaw = settingsData?.data?.currentAppInstallation?.metafield?.value;
  if (typeof settingsRaw === "string" && settingsRaw) {
    try {
      const parsed = JSON.parse(settingsRaw);
      if (parsed?.version === 1) {
        settings = parsed as SettingsV1;
      }
    } catch {
      // ignore
    }
  }

  // CSV出力項目のデフォルト
  const DEFAULT_CSV_COLUMNS: OrderCsvColumn[] = [
    "orderId", "orderName", "locationName", "destination", "destinationCode", "date", "desiredDeliveryDate",
    "staffName", "note", "status", "productTitle", "sku", "barcode",
    "option1", "option2", "option3", "quantity"
  ];
  const csvExportColumns = settings?.order?.csvExportColumns || DEFAULT_CSV_COLUMNS;

  let entries: OrderRequestEntry[] = [];
  const raw = appData?.data?.currentAppInstallation?.metafield?.value;
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      entries = [];
    }
  }

  // createdAt の新しい順にソート
  entries = [...entries].sort((a, b) => {
    const t1 = new Date(a.createdAt || a.date || 0).getTime();
    const t2 = new Date(b.createdAt || b.date || 0).getTime();
    return t2 - t1;
  });

  // ✅ 既存のエントリにorderNameが設定されていない場合、createdAtの順序に基づいて連番を割り当てる
  // これにより、既存のエントリにも固定の連番が割り当てられ、新しいエントリが追加されても既存のエントリの連番は変わらなくなる
  let needsUpdate = false;
  
  // 既存のエントリのorderNameから最大の連番を取得
  const existingOrderNames = new Set(
    entries
      .filter((e) => e?.orderName && /^#P\d+$/.test(String(e.orderName).trim()))
      .map((e) => String(e.orderName).trim())
  );
  
  const maxExistingNum = Array.from(existingOrderNames).reduce((max, name) => {
    const match = name.match(/^#P(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      return Math.max(max, num);
    }
    return max;
  }, 0);
  
  // orderNameが設定されていないエントリをcreatedAtの順序でソート
  const entriesWithoutOrderName = entries
    .filter((e) => !e?.orderName || !/^#P\d+$/.test(String(e.orderName).trim()))
    .sort((a, b) => {
      const dateA = new Date(a.createdAt || a.date || 0).getTime();
      const dateB = new Date(b.createdAt || b.date || 0).getTime();
      return dateA - dateB; // 古い順
    });
  
  // orderNameが設定されていないエントリに連番を割り当てる
  const orderNameMap = new Map<string, string>();
  entriesWithoutOrderName.forEach((entry, index) => {
    const num = maxExistingNum + index + 1;
    const orderName = `#P${String(num).padStart(4, "0")}`;
    orderNameMap.set(entry.id, orderName);
    needsUpdate = true;
  });
  
  const entriesWithOrderName = entries.map((entry) => {
    // 既にorderNameが設定されている場合はそのまま
    if (entry?.orderName && /^#P\d+$/.test(String(entry.orderName).trim())) {
      return entry;
    }
    
    // orderNameが設定されていない場合、割り当てた連番を使用
    const orderName = orderNameMap.get(entry.id);
    if (orderName) {
      return {
        ...entry,
        orderName,
      };
    }
    
    return entry;
  });

  // orderNameを割り当てたエントリがある場合、metafieldに保存する
  if (needsUpdate) {
    try {
      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (appInstallationId) {
        await admin.graphql(
          `#graphql
            mutation SetOrderEntries($metafields: [MetafieldsSetInput!]!) {
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
                  namespace: ORDER_NS,
                  key: ORDER_KEY,
                  type: "json",
                  value: JSON.stringify(entriesWithOrderName),
                },
              ],
            },
          }
        );
      }
    } catch (error) {
      console.error("Failed to update order entries with orderName:", error);
    }
  }

  // 発注先マスタを取得
  const destinations: OrderDestinationOption[] = settings?.order?.destinations || [];

  // サーバー側で「今日の日付」を計算
  const todayInShopTimezone = getDateInShopTimezone(new Date(), shopTimezone);

  // loss/history と合わせるためのダミー pageInfo（今は全件クライアント側でページング）
  return {
    locations,
    entries: entriesWithOrderName,
    csvExportColumns, // CSV出力項目設定を返す
    csvExportColumnLabels: settings?.order?.csvExportColumnLabels, // CSV出力項目のカスタムラベル
    destinations, // 発注先マスタ
    shopTimezone,
    todayInShopTimezone, // サーバー側で計算した「今日の日付」をクライアントに渡す
    useDesiredDeliveryDate: settings?.order?.useDesiredDeliveryDate ?? true,
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
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();

    const intentRaw = String(formData.get("intent") || "loadItems").trim();
    const intent = intentRaw || "loadItems";
    const entryId = String(formData.get("entryId") || "").trim();

    if (!entryId) {
      return { error: "entryId is required" };
    }

    const appResp = await admin.graphql(
      `#graphql
        query OrderRequests {
          currentAppInstallation {
            id
            metafield(namespace: "${ORDER_NS}", key: "${ORDER_KEY}") { value }
          }
        }
      `
    );

    const appData = await appResp.json();
    const raw = appData?.data?.currentAppInstallation?.metafield?.value;
    let entries: OrderRequestEntry[] = [];
    if (typeof raw === "string" && raw) {
      try {
        const parsed = JSON.parse(raw);
        entries = Array.isArray(parsed) ? parsed : [];
      } catch {
        entries = [];
      }
    }

    const entry = entries.find((e) => e.id === entryId);
    if (!entry) {
      return { error: "Entry not found" };
    }

    // 商品リスト取得（原価と販売価格も取得）
    if (intent === "loadItems") {
      const items = entry.items || [];
      
      // variantIdがある商品について、原価と販売価格を取得
      const variantIds = items
        .filter((item) => item.variantId)
        .map((item) => item.variantId!)
        .filter((id, index, self) => self.indexOf(id) === index); // 重複除去
      
      if (variantIds.length > 0) {
        // variant情報を一括取得
        const variantGids = variantIds.map((id) => {
          // idが既にGID形式かどうかチェック
          if (id.startsWith("gid://")) {
            return id;
          }
          return `gid://shopify/ProductVariant/${id}`;
        });
        
        const variantQuery = `#graphql
          query GetVariantsCostPriceBarcodeOptions($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                price
                barcode
                selectedOptions {
                  name
                  value
                }
                inventoryItem {
                  id
                  unitCost {
                    amount
                    currencyCode
                  }
                }
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
            // variant情報をマップに変換（idをキーに）。原価・販売価格・barcode・option1/2/3 を取得
            const variantMap = new Map<string, {
              cost?: number;
              price?: number;
              barcode?: string;
              option1?: string;
              option2?: string;
              option3?: string;
            }>();
            
            variantData.data.nodes.forEach((node: any) => {
              if (node && node.id) {
                const cost = node.inventoryItem?.unitCost?.amount
                  ? parseFloat(node.inventoryItem.unitCost.amount)
                  : undefined;
                const price = node.price ? parseFloat(node.price) : undefined;
                const opts = node.selectedOptions as Array<{ name?: string; value?: string }> | undefined;
                const option1 = opts?.[0]?.value ?? undefined;
                const option2 = opts?.[1]?.value ?? undefined;
                const option3 = opts?.[2]?.value ?? undefined;
                variantMap.set(node.id, {
                  cost,
                  price,
                  barcode: node.barcode ?? undefined,
                  option1,
                  option2,
                  option3,
                });
              }
            });
            
            // itemsに原価・販売価格・JAN・オプションを付与（既存の値があれば保持、なければAPIから補完）
            const itemsWithCostAndPrice = items.map((item) => {
              if (!item.variantId) return item;
              
              const variantGid = item.variantId.startsWith("gid://")
                ? item.variantId
                : `gid://shopify/ProductVariant/${item.variantId}`;
              
              const variantInfo = variantMap.get(variantGid);
              if (variantInfo) {
                return {
                  ...item,
                  cost: item.cost ?? variantInfo.cost,
                  price: item.price ?? variantInfo.price,
                  barcode: item.barcode ?? variantInfo.barcode,
                  option1: item.option1 ?? variantInfo.option1,
                  option2: item.option2 ?? variantInfo.option2,
                  option3: item.option3 ?? variantInfo.option3,
                };
              }
              return item;
            });
            
            // 原価・販売価格・barcode・オプションのいずれかが更新された場合は、エントリを保存
            const hasUpdates = itemsWithCostAndPrice.some(
              (item, idx) => {
                const prev = items[idx];
                return (
                  item.cost !== prev?.cost ||
                  item.price !== prev?.price ||
                  item.barcode !== prev?.barcode ||
                  item.option1 !== prev?.option1 ||
                  item.option2 !== prev?.option2 ||
                  item.option3 !== prev?.option3
                );
              }
            );
            
            if (hasUpdates) {
              const updatedEntries = entries.map((e) =>
                e.id === entryId
                  ? {
                      ...e,
                      items: itemsWithCostAndPrice,
                    }
                  : e
              );
              
              const appInstallationId = appData?.data?.currentAppInstallation?.id;
              if (appInstallationId) {
                await admin.graphql(
                  `#graphql
                    mutation SetOrderEntries($metafields: [MetafieldsSetInput!]!) {
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
                          namespace: ORDER_NS,
                          key: ORDER_KEY,
                          type: "json",
                          value: JSON.stringify(updatedEntries),
                        },
                      ],
                    },
                  }
                );
              }
            }
            
            return { entryId, items: itemsWithCostAndPrice };
          }
        } catch (error) {
          console.error("Failed to fetch variant cost and price:", error);
          // エラーが発生しても既存のitemsを返す
        }
      }
      
      return { entryId, items };
    }

    // 承認取り消し処理
    if (intent === "cancelApproval") {
      // 既に未処理 or キャンセルは取り消し不可
      if (entry.status !== "shipped") {
        return { error: "この発注は承認済みではないため、取り消しできません" };
      }

      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (!appInstallationId) {
        return { error: "currentAppInstallation.id が取得できません" };
      }

      // 入荷日・検品日を取得
      const arrivalDate = String(formData.get("arrivalDate") || "").trim() || undefined;
      const inspectionDate = String(formData.get("inspectionDate") || "").trim() || undefined;

      const updatedEntries: OrderRequestEntry[] = entries.map((e) =>
        e.id === entryId
          ? {
              ...e,
              status: "pending",
              approvedItems: undefined, // 承認済み商品をクリア
              arrivalDate: arrivalDate || e.arrivalDate,
              inspectionDate: inspectionDate || e.inspectionDate,
            }
          : e
      );

      // Metafield に保存
      await admin.graphql(
        `#graphql
          mutation SetOrderEntries($metafields: [MetafieldsSetInput!]!) {
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
                namespace: ORDER_NS,
                key: ORDER_KEY,
                type: "json",
                value: JSON.stringify(updatedEntries),
              },
            ],
          },
        }
      );

      return {
        ok: true,
        entryId,
        status: "pending" as const,
      };
    }

    // 承認処理（部分承認対応）
    if (intent === "approve") {
      const approvedItemsRaw = String(formData.get("approvedItems") || "").trim();
      if (!approvedItemsRaw) {
        return { error: "approvedItems is required" };
      }

      let approvedItems: OrderRequestItem[] = [];
      try {
        const parsed = JSON.parse(approvedItemsRaw);
        if (Array.isArray(parsed)) {
          approvedItems = parsed as OrderRequestItem[];
        }
      } catch {
        return { error: "approvedItems JSON が不正です" };
      }

      if (approvedItems.length === 0) {
        return { error: "承認する商品が選択されていません" };
      }

      // 既に発注済み or キャンセルは承認不可
      if (entry.status !== "pending") {
        return { error: "この発注は既に処理済みのため承認できません" };
      }

      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (!appInstallationId) {
        return { error: "currentAppInstallation.id が取得できません" };
      }

      // 「仕入に反映」フラグを取得
      const reflectToPurchase = formData.get("reflectToPurchase") === "true";

      // Shopify Transfer（発注書）を作成（失敗しても承認自体は続行）
      const transferResult = await createTransferForOrder(admin, entry, approvedItems);
      const transferId = transferResult.transferId;
      const transferError = transferResult.error;

      // Transfer作成エラーがある場合はログに記録（承認自体は続行）
      if (transferError) {
        console.error("[createTransferForOrder] Transfer作成失敗:", transferError);
        console.error("[createTransferForOrder] entry:", entry);
        console.error("[createTransferForOrder] approvedItems:", approvedItems);
      }

      // 仕入に反映する場合、仕入予定を作成
      let purchaseId: string | null = null;
      let purchaseName: string | null = null;
      let purchaseError: string | null = null;
      if (reflectToPurchase) {
        const purchaseResult = await createPurchaseFromOrder(admin, entry, approvedItems, appInstallationId);
        purchaseId = purchaseResult.purchaseId;
        purchaseName = purchaseResult.purchaseName;
        purchaseError = purchaseResult.error;
        if (purchaseError) {
          console.error("[createPurchaseFromOrder] 仕入予定作成失敗:", purchaseError);
        }
      }

      // 入荷日・検品日を取得
      const arrivalDate = String(formData.get("arrivalDate") || "").trim() || undefined;
      const inspectionDate = String(formData.get("inspectionDate") || "").trim() || undefined;

      const updatedEntries: OrderRequestEntry[] = entries.map((e) =>
        e.id === entryId
          ? {
              ...e,
              status: "shipped",
              approvedItems,
              linkedTransferId: transferId ?? e.linkedTransferId ?? null,
              arrivalDate: arrivalDate || e.arrivalDate,
              inspectionDate: inspectionDate || e.inspectionDate,
            }
          : e
      );

      // Metafield に保存
      await admin.graphql(
        `#graphql
          mutation SetOrderEntries($metafields: [MetafieldsSetInput!]!) {
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
                namespace: ORDER_NS,
                key: ORDER_KEY,
                type: "json",
                value: JSON.stringify(updatedEntries),
              },
            ],
          },
        }
      );

      return {
        ok: true,
        entryId,
        status: "shipped" as const,
        transferId: transferId ?? null,
        transferError: transferError ?? null,
        purchaseId: purchaseId ?? null,
        purchaseName: purchaseName ?? null,
        purchaseError: purchaseError ?? null,
      };
    }

    // 承認取り消し処理
    if (intent === "cancelApproval") {
      // 既に未処理 or キャンセルは取り消し不可
      if (entry.status !== "shipped") {
        return { error: "この発注は承認済みではないため、取り消しできません" };
      }

      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (!appInstallationId) {
        return { error: "currentAppInstallation.id が取得できません" };
      }

      // 入荷日・検品日を取得
      const arrivalDate = String(formData.get("arrivalDate") || "").trim() || undefined;
      const inspectionDate = String(formData.get("inspectionDate") || "").trim() || undefined;

      const updatedEntries: OrderRequestEntry[] = entries.map((e) =>
        e.id === entryId
          ? {
              ...e,
              status: "pending",
              approvedItems: undefined, // 承認済み商品をクリア
              arrivalDate: arrivalDate || e.arrivalDate,
              inspectionDate: inspectionDate || e.inspectionDate,
            }
          : e
      );

      // Metafield に保存
      await admin.graphql(
        `#graphql
          mutation SetOrderEntries($metafields: [MetafieldsSetInput!]!) {
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
                namespace: ORDER_NS,
                key: ORDER_KEY,
                type: "json",
                value: JSON.stringify(updatedEntries),
              },
            ],
          },
        }
      );

      return {
        ok: true,
        entryId,
        status: "pending" as const,
      };
    }

    // 発注先更新処理
    if (intent === "updateDestination") {
      const newDestination = String(formData.get("destination") || "").trim() || undefined;

      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (!appInstallationId) {
        return { error: "currentAppInstallation.id が取得できません" };
      }

      const updatedEntries: OrderRequestEntry[] = entries.map((e) =>
        e.id === entryId
          ? {
              ...e,
              destination: newDestination,
            }
          : e
      );

      // Metafield に保存
      await admin.graphql(
        `#graphql
          mutation SetOrderEntries($metafields: [MetafieldsSetInput!]!) {
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
                namespace: ORDER_NS,
                key: ORDER_KEY,
                type: "json",
                value: JSON.stringify(updatedEntries),
              },
            ],
          },
        }
      );

      return {
        ok: true,
        entryId,
        destination: newDestination,
      };
    }

    return { error: `Unknown intent: ${intent}` };
  } catch (error) {
    console.error("Order entry action error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Failed to handle action: ${errorMessage}` };
  }
}

export default function OrderPage() {
  const loaderData = useLoaderData<typeof loader>();
  const {
    locations,
    entries: initialEntries,
    csvExportColumns,
    csvExportColumnLabels,
    destinations,
    shopTimezone,
    todayInShopTimezone,
    useDesiredDeliveryDate = true,
  } = loaderData || {
    locations: [],
    entries: [],
    csvExportColumns: [
      "orderId", "orderName", "locationName", "destination", "destinationCode", "date", "desiredDeliveryDate",
      "staffName", "note", "status", "productTitle", "sku", "barcode",
      "option1", "option2", "option3", "quantity"
    ],
    csvExportColumnLabels: undefined,
    destinations: [],
    shopTimezone: "UTC",
    useDesiredDeliveryDate: true,
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
  // entriesをuseStateで管理（承認取り消し後の状態更新のため）
  const [entries, setEntries] = useState<OrderRequestEntry[]>(initialEntries || []);
  const fetcher = useFetcher<typeof action>();

  // loaderDataが更新されたらentriesも更新（ページリロード時など）
  useEffect(() => {
    if (initialEntries) {
      setEntries(initialEntries);
    }
  }, [initialEntries]);

  // ステータスの日本語表記
  const STATUS_LABEL: Record<string, string> = {
    pending: "未処理",
    shipped: "発注済み",
    cancelled: "キャンセル",
  };

  // ステータスバッジ用スタイル（入出庫・ロスと同じトンマナ）
  const getStatusBadgeStyle = (status: string): React.CSSProperties => {
    const base = {
      display: "inline-block" as const,
      padding: "2px 8px",
      borderRadius: "9999px",
      fontSize: "12px",
      fontWeight: 600,
    };
    if (status === "shipped") return { ...base, backgroundColor: "#d4edda", color: "#155724" };
    if (status === "cancelled") return { ...base, backgroundColor: "#f8d7da", color: "#721c24" };
    return { ...base, backgroundColor: "#e2e3e5", color: "#383d41" }; // pending
  };

  // フィルター状態（ロケーション・ステータス）
  const [locationFilters, setLocationFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());

  // モーダル状態
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEntry, setModalEntry] = useState<OrderRequestEntry | null>(null);
  const [modalItems, setModalItems] = useState<OrderRequestItem[]>([]);
  const [selectedItemIndexes, setSelectedItemIndexes] = useState<Set<number>>(new Set());
  const [reflectToPurchase, setReflectToPurchase] = useState(false); // 仕入に反映チェックボックス
  const [arrivalDate, setArrivalDate] = useState<string>(""); // 入荷日
  const [inspectionDate, setInspectionDate] = useState<string>(""); // 検品日
  // カスタムアラートモーダル状態
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string>("");
  // カスタム確認モーダル状態
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState<string>("");
  const [confirmCallback, setConfirmCallback] = useState<(() => void) | null>(null);
  // 発注先編集状態
  const [editingDestination, setEditingDestination] = useState(false);
  const [destinationSearch, setDestinationSearch] = useState<string>("");
  const [showDestinationList, setShowDestinationList] = useState(false);
  // arrivalDateとinspectionDateの最新値を保持（useEffect内で参照するため）
  const arrivalDateRef = useRef<string>("");
  const inspectionDateRef = useRef<string>("");
  // 発注先更新の処理済みを追跡（同じレスポンスを2回処理しないようにする）
  const processedDestinationUpdateRef = useRef<string | null>(null);
  // modalEntryの最新値を保持（useEffect内で参照するため）
  const modalEntryRef = useRef<OrderRequestEntry | null>(null);
  
  // arrivalDateとinspectionDateが変更されたらrefも更新
  useEffect(() => {
    arrivalDateRef.current = arrivalDate;
    inspectionDateRef.current = inspectionDate;
  }, [arrivalDate, inspectionDate]);
  
  // modalEntryが変更されたらrefも更新
  useEffect(() => {
    modalEntryRef.current = modalEntry;
  }, [modalEntry]);

  // フィルター適用後の一覧
  const filteredEntries = useMemo(() => {
    let filtered = entries;

    if (locationFilters.size > 0) {
      filtered = filtered.filter((e) => locationFilters.has(e.locationId));
    }

    if (statusFilters.size > 0) {
      filtered = filtered.filter((e) => statusFilters.has(e.status));
    }

    return filtered;
  }, [entries, locationFilters, statusFilters]);

  const estimatedTotal = `${filteredEntries.length}件`;

  // 商品リストを取得してモーダル表示
  const openItemsModal = (entry: OrderRequestEntry) => {
    // entriesから最新のentryを取得（承認取り消し後の状態更新を反映）
    const latestEntry = entries.find((e) => e.id === entry.id) || entry;
    setModalEntry(latestEntry);
    setModalOpen(true);
    setModalItems([]);
    setSelectedItemIndexes(new Set());
    setReflectToPurchase(false); // モーダルを開くたびにリセット
    // 入荷日・検品日を初期化
    setArrivalDate(latestEntry.arrivalDate || "");
    setInspectionDate(latestEntry.inspectionDate || "");
    // 発注先編集状態をリセット
    setEditingDestination(false);
    setShowDestinationList(false);
    setDestinationSearch("");
    // 発注先更新の処理済みフラグをリセット
    processedDestinationUpdateRef.current = null;

    const formData = new FormData();
    formData.set("entryId", latestEntry.id);
    fetcher.submit(formData, { method: "post" });
  };

  useEffect(() => {
    if (!fetcher.data || !modalEntryRef.current) return;
    
    const currentModalEntry = modalEntryRef.current;
    
    // 商品リスト取得の場合のみ処理（他の処理では商品リストに影響しない）
    if ("items" in fetcher.data) {
      const items: OrderRequestItem[] = Array.isArray(fetcher.data.items) ? fetcher.data.items : [];
      setModalItems(items);
      // デフォルトでは全件選択状態にする（発注済みの場合は承認済み商品を選択）
      if (currentModalEntry?.status === "shipped" && currentModalEntry?.approvedItems) {
        // 承認済み商品のインデックスを取得
        const approvedIndexes = new Set<number>();
        items.forEach((item, idx) => {
          const isApproved = currentModalEntry.approvedItems?.some(
            (approved) => approved.inventoryItemId === item.inventoryItemId && approved.quantity === item.quantity
          );
          if (isApproved) {
            approvedIndexes.add(idx);
          }
        });
        setSelectedItemIndexes(approvedIndexes);
      } else {
        setSelectedItemIndexes(new Set(items.map((_, idx) => idx)));
      }
      return; // 商品リスト取得の場合はここで終了
    }
    
    // エラーの場合
    if ("error" in fetcher.data) {
      setAlertMessage(`エラー: ${fetcher.data.error}`);
      setAlertModalOpen(true);
      setModalItems([]);
      // エラーの場合はモーダルを閉じない（ユーザーが確認できるように）
      return;
    }
    
    // 発注先更新の場合
    if ("ok" in fetcher.data && fetcher.data.ok && "destination" in fetcher.data) {
      // 発注先更新の場合（先にチェック）
      const entryId = (fetcher.data as any).entryId;
      const newDestination = (fetcher.data as any).destination;
      // 同じレスポンスを2回処理しないようにする（entryId + destinationで一意に識別）
      const responseKey = `${entryId}:${newDestination}`;
      // 編集モードが有効な場合は処理を完全にスキップ（編集ボタンを押した直後の再実行を防ぐ）
      if (processedDestinationUpdateRef.current !== responseKey && !editingDestination) {
        processedDestinationUpdateRef.current = responseKey;
        if (currentModalEntry) {
          // entriesの状態を直接更新
          setEntries((prevEntries) =>
            prevEntries.map((e) =>
              e.id === currentModalEntry.id
                ? {
                    ...e,
                    destination: newDestination,
                  }
                : e
            )
          );
          // modalEntryも更新（商品リストの再読み込みを防ぐため、destinationのみ更新）
          // ただし、useEffectの再実行を防ぐため、setTimeoutで遅延実行
          if (currentModalEntry.destination !== newDestination) {
            setTimeout(() => {
              setModalEntry((prev) => ({
                ...prev!,
                destination: newDestination,
              }));
            }, 0);
          }
          // 編集モードは既に解除されているが、念のため再度解除（状態の整合性を保つ）
          setEditingDestination(false);
          setShowDestinationList(false);
          setDestinationSearch("");
        }
      }
    } else if ("ok" in fetcher.data && fetcher.data.ok && "status" in fetcher.data) {
      // 承認処理または承認取り消し処理の結果（statusが存在する場合のみ）
      const status = (fetcher.data as any).status;
      const entryId = (fetcher.data as any).entryId;
      
      if (status === "pending") {
        // 承認取り消しの場合：entriesの状態を直接更新
        if (entryId && currentModalEntry) {
          setEntries((prevEntries) =>
            prevEntries.map((e) =>
              e.id === entryId
                ? {
                    ...e,
                    status: "pending" as const,
                    approvedItems: undefined,
                    linkedTransferId: undefined,
                    arrivalDate: currentModalEntry.arrivalDate,
                    inspectionDate: currentModalEntry.inspectionDate,
                  }
                : e
            )
          );
          // modalEntryも更新（商品リストの再読み込みを防ぐため、setTimeoutで遅延実行）
          setTimeout(() => {
            setModalEntry((prev) => ({
              ...prev!,
              status: "pending" as const,
              approvedItems: undefined,
              linkedTransferId: undefined,
            }));
          }, 0);
        }
        setAlertMessage("承認を取り消しました。発注ステータスが「未処理」に戻りました。");
        setAlertModalOpen(true);
        closeItemsModal();
        // fetcher.dataをクリアするために、fetcher.load()で再取得（ただし、実際には使用しない）
        // または、単にモーダルを閉じて状態をリセットするだけでも良い
        return; // ここで処理を終了（商品リストの再取得を防ぐ）
      } else {
        // 承認の場合
        const transferError = (fetcher.data as any).transferError;
        const purchaseId = (fetcher.data as any).purchaseId;
        const purchaseName = (fetcher.data as any).purchaseName;
        const purchaseError = (fetcher.data as any).purchaseError;
        const transferId = (fetcher.data as any).transferId;
        
        // entriesの状態を直接更新（リロードなしで反映）
        if (entryId && currentModalEntry) {
          // selectedItemIndexesからapprovedItemsを再構築
          const approvedItems: OrderRequestItem[] = Array.from(selectedItemIndexes)
            .map((idx) => modalItems[idx])
            .filter((item): item is OrderRequestItem => item !== undefined);
          
          setEntries((prevEntries) =>
            prevEntries.map((e) =>
              e.id === entryId
                ? {
                    ...e,
                    status: "shipped" as const,
                    approvedItems,
                    linkedTransferId: transferId ?? e.linkedTransferId ?? null,
                    arrivalDate: arrivalDateRef.current || e.arrivalDate,
                    inspectionDate: inspectionDateRef.current || e.inspectionDate,
                  }
                : e
            )
          );
        }
        
        let message = "選択した商品を発注済みに変更しました。";
        
        if (transferError) {
          message += `\n\nTransfer（発注書）の作成に失敗しました:\n${transferError}`;
        }
        
        if (purchaseName || purchaseId) {
          message += `\n仕入予定（${purchaseName || purchaseId}）が作成されました。`;
        } else if (purchaseError) {
          message += `\n\n仕入予定の作成に失敗しました:\n${purchaseError}`;
        }
        
        setAlertMessage(message);
        setAlertModalOpen(true);
        closeItemsModal();
      }
    }
  }, [fetcher.data]); // modalEntryを依存配列から削除（商品リストの再読み込みを防ぐため）

  // 発注先リストの外側をクリックした際に閉じる処理
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (showDestinationList && !target.closest('[data-destination-list]')) {
        setShowDestinationList(false);
      }
    };

    if (showDestinationList) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [showDestinationList]);

  const allSelected = modalItems.length > 0 && selectedItemIndexes.size === modalItems.length;
  const anySelected = selectedItemIndexes.size > 0;

  const toggleSelectAll = () => {
    if (modalItems.length === 0) return;
    if (allSelected) {
      setSelectedItemIndexes(new Set());
    } else {
      setSelectedItemIndexes(new Set(modalItems.map((_, idx) => idx)));
    }
  };

  const toggleSelectIndex = (idx: number) => {
    setSelectedItemIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const handleApproveSelected = () => {
    if (!modalEntry) return;
    
    // 承認取り消しの場合
    if (modalEntry.status === "shipped") {
      // カスタム確認モーダルを表示
      setConfirmMessage("承認を取り消しますか？\nこの操作により、発注ステータスが「未処理」に戻ります。");
      setConfirmCallback(() => {
        const formData = new FormData();
        formData.set("intent", "cancelApproval");
        formData.set("entryId", modalEntry.id);
        formData.set("arrivalDate", arrivalDate);
        formData.set("inspectionDate", inspectionDate);
        fetcher.submit(formData, { method: "post" });
        setConfirmModalOpen(false);
        setConfirmCallback(null);
      });
      setConfirmModalOpen(true);
      return;
    }
    
    // 承認の場合
    if (!anySelected) {
      setAlertMessage("承認する商品を1件以上選択してください。");
      setAlertModalOpen(true);
      return;
    }
    const approvedItems = modalItems.filter((_, idx) => selectedItemIndexes.has(idx));
    const formData = new FormData();
    formData.set("intent", "approve");
    formData.set("entryId", modalEntry.id);
    formData.set("approvedItems", JSON.stringify(approvedItems));
    formData.set("reflectToPurchase", reflectToPurchase ? "true" : "false");
    formData.set("arrivalDate", arrivalDate);
    formData.set("inspectionDate", inspectionDate);
    fetcher.submit(formData, { method: "post" });
  };

  const closeItemsModal = () => {
    setModalOpen(false);
    setModalEntry(null);
    setModalItems([]);
    setSelectedItemIndexes(new Set());
    setReflectToPurchase(false);
    setArrivalDate("");
    setInspectionDate("");
    setEditingDestination(false);
    setShowDestinationList(false);
    setDestinationSearch("");
    // 発注先更新の処理済みフラグをリセット
    processedDestinationUpdateRef.current = null;
  };

  // CSV列名のマッピング（デフォルト）
  const DEFAULT_CSV_COLUMN_LABELS: Record<OrderCsvColumn, string> = {
    orderId: "発注ID",
    orderName: "名称",
    locationName: "発注店舗",
  destination: "仕入先",
  destinationCode: "仕入先コード",
    date: "日付",
    desiredDeliveryDate: "希望納品日",
    staffName: "担当者",
    note: "備考",
    status: "ステータス",
    productTitle: "商品名",
    sku: "SKU",
    barcode: "JAN",
    option1: "オプション1",
    option2: "オプション2",
    option3: "オプション3",
    quantity: "数量",
    arrivalDate: "入荷日",
    inspectionDate: "検品日",
    cost: "原価",
    price: "販売価格",
  };

  // カスタムラベルがあればそれを使用、なければデフォルトを使用
  const getCsvColumnLabel = (col: OrderCsvColumn): string => {
    return csvExportColumnLabels?.[col] || DEFAULT_CSV_COLUMN_LABELS[col];
  };

  // モーダル内の商品リストをCSV出力
  const exportModalCSV = () => {
    if (!modalEntry || modalItems.length === 0) {
      setAlertMessage("商品リストがありません");
      setAlertModalOpen(true);
      return;
    }

    // 設定されたCSV出力項目に基づいてヘッダーとデータを生成
    const headers = csvExportColumns.map((col) => getCsvColumnLabel(col));

    const rows: string[][] = [];
    const locationName =
      modalEntry.locationName || locations.find((l) => l.id === modalEntry.locationId)?.name || modalEntry.locationId;
    const date = modalEntry.date || extractDateFromISO(modalEntry.createdAt, shopTimezone);
    const desiredDeliveryDateStr = modalEntry.desiredDeliveryDate
      ? (modalEntry.desiredDeliveryDate.includes("T")
          ? modalEntry.desiredDeliveryDate.split("T")[0]
          : modalEntry.desiredDeliveryDate)
      : "";
    const statusLabel = STATUS_LABEL[modalEntry.status] || modalEntry.status;

    // データ行を生成（設定された項目のみ）
    modalItems.forEach((item) => {
      const row: string[] = [];
      csvExportColumns.forEach((col) => {
        switch (col) {
          case "orderId":
            row.push(modalEntry.id);
            break;
          case "orderName":
            row.push(modalEntry.orderName || "");
            break;
          case "locationName":
            row.push(locationName);
            break;
          case "destination":
            row.push(modalEntry.destination || "");
            break;
          case "destinationCode":
            row.push(destinations.find((d) => d.name === modalEntry.destination)?.code ?? "");
            break;
          case "date":
            row.push(date);
            break;
          case "desiredDeliveryDate":
            row.push(desiredDeliveryDateStr);
            break;
          case "staffName":
            row.push(modalEntry.staffName || "");
            break;
          case "note":
            row.push(modalEntry.note || "");
            break;
          case "status":
            row.push(statusLabel);
            break;
          case "productTitle":
            row.push(item.title || "");
            break;
          case "sku":
            row.push(item.sku || "");
            break;
          case "barcode":
            row.push(item.barcode || "");
            break;
          case "option1":
            row.push(item.option1 || "");
            break;
          case "option2":
            row.push(item.option2 || "");
            break;
          case "option3":
            row.push(item.option3 || "");
            break;
          case "quantity":
            row.push(String(item.quantity || 0));
            break;
          case "arrivalDate":
            row.push(""); // 入荷日（将来の仕入機能で設定）
            break;
          case "inspectionDate":
            row.push(""); // 検品日（将来の仕入機能で設定）
            break;
          case "cost":
            row.push(item.cost !== undefined ? String(item.cost) : "");
            break;
          case "price":
            row.push(item.price !== undefined ? String(item.price) : "");
            break;
          default:
            row.push("");
        }
      });
      rows.push(row);
    });

    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // ファイル名用：表示名（#P0001など）を優先し、ファイル名に使えない文字のみ置換（複雑なIDは表示しない）
    const displayName = modalEntry.orderName || modalEntry.id;
    const safeFileName = String(displayName).replace(/[\\/:*?"<>|\s]/g, "_").trim() || "item";
    link.download = `発注_${safeFileName}_${todayInShopTimezone}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <s-page heading="発注">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          <s-box padding="base">
            <div
              style={{
                display: "flex",
                gap: "24px",
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              {/* 左: タイトル＋説明 ＋ フィルター（白カード） */}
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <s-stack gap="base">
                  {/* タイトル＋説明 */}
                  <div>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        marginBottom: 4,
                      }}
                    >
                      発注履歴
                    </div>
                    <s-text tone="subdued" size="small">
                      条件で絞り込みを行い、発注履歴を表示します。
                    </s-text>
                  </div>

                  {/* フィルターカード */}
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: 12,
                      boxShadow: "0 0 0 1px #e1e3e5",
                      padding: 16,
                    }}
                  >
                    <s-stack gap="base">
                      <s-text emphasis="bold" size="large">
                        フィルター
                      </s-text>
                      <s-text tone="subdued" size="small">
                        発注店舗・ステータスを選ぶと一覧が絞り込まれます。
                      </s-text>
                      <s-divider />
                      <s-text emphasis="bold" size="small">
                        発注店舗（ロケーション）
                      </s-text>
                      <div
                        style={{
                          maxHeight: "200px",
                          overflowY: "auto",
                          border: "1px solid #e1e3e5",
                          borderRadius: "8px",
                          padding: "6px",
                        }}
                      >
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
                          <input
                            type="checkbox"
                            checked={locationFilters.size === 0}
                            readOnly
                            style={{ width: "16px", height: "16px", flexShrink: 0 }}
                          />
                          <span style={{ fontWeight: locationFilters.size === 0 ? 600 : 500 }}>全て</span>
                        </div>
                        {locations.map((loc) => {
                          const isSelected = locationFilters.has(loc.id);
                          return (
                            <div
                              key={loc.id}
                              onClick={() => {
                                const next = new Set(locationFilters);
                                if (isSelected) next.delete(loc.id);
                                else next.add(loc.id);
                                setLocationFilters(next);
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
                              <span
                                style={{
                                  fontWeight: isSelected ? 600 : 500,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {loc.name}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <s-text emphasis="bold" size="small">
                        ステータス
                      </s-text>
                      <div
                        style={{
                          maxHeight: "160px",
                          overflowY: "auto",
                          border: "1px solid #e1e3e5",
                          borderRadius: "8px",
                          padding: "6px",
                        }}
                      >
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
                          <input
                            type="checkbox"
                            checked={statusFilters.size === 0}
                            readOnly
                            style={{ width: "16px", height: "16px", flexShrink: 0 }}
                          />
                          <span style={{ fontWeight: statusFilters.size === 0 ? 600 : 500 }}>全て</span>
                        </div>
                        {Object.entries(STATUS_LABEL).map(([status, label]) => {
                          const isSelected = statusFilters.has(status);
                          return (
                            <div
                              key={status}
                              onClick={() => {
                                const next = new Set(statusFilters);
                                if (isSelected) next.delete(status);
                                else next.add(status);
                                setStatusFilters(next);
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
                              <span style={{ fontWeight: isSelected ? 600 : 500 }}>{label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </s-stack>
                  </div>
                </s-stack>
              </div>

              {/* 右: 発注履歴一覧（白カード） */}
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
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: "8px",
                      }}
                    >
                      <s-text tone="subdued" size="small">
                        表示: {filteredEntries.length}件 / {estimatedTotal}
                      </s-text>
                    </div>

                    {filteredEntries.length === 0 ? (
                      <s-box padding="base">
                        <s-text tone="subdued">履歴がありません</s-text>
                      </s-box>
                    ) : (
                      <s-stack gap="none">
                        {filteredEntries.map((entry) => {
                          const locationName =
                            entry.locationName ||
                            locations.find((l) => l.id === entry.locationId)?.name ||
                            entry.locationId;
                          const date =
                            entry.date ||
                            extractDateFromISO(entry.createdAt, shopTimezone);
                          const itemCount = entry.items?.length ?? 0;
                          const totalQty = (entry.items ?? []).reduce(
                            (sum, it) => sum + (it.quantity || 0),
                            0
                          );

                          return (
                            <div key={entry.id}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "flex-start",
                                  padding: "12px",
                                  cursor: "pointer",
                                }}
                                onClick={() => openItemsModal(entry)}
                              >
                                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "center",
                                      marginBottom: "4px",
                                    }}
                                  >
                                    <s-text
                                      emphasis="bold"
                                      style={{
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                      }}
                                    >
                                      {entry.orderName || entry.id}
                                    </s-text>
                                    <s-text
                                      tone="subdued"
                                      size="small"
                                      style={{ whiteSpace: "nowrap", marginLeft: "8px" }}
                                    >
                                      {date}
                                    </s-text>
                                  </div>
                                  <div style={{ marginBottom: "2px" }}>
                                    <s-text
                                      tone="subdued"
                                      size="small"
                                      style={{
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        display: "block",
                                      }}
                                    >
                                      発注店舗: {locationName}
                                    </s-text>
                                  </div>
                                  <div>
                                    <s-text
                                      tone="subdued"
                                      size="small"
                                      style={{
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        display: "block",
                                      }}
                                    >
                                      仕入先: {entry.destination || "-"}
                                    </s-text>
                                  </div>
                                  {useDesiredDeliveryDate && entry.desiredDeliveryDate && (
                                    <div>
                                      <s-text
                                        tone="subdued"
                                        size="small"
                                        style={{
                                          whiteSpace: "nowrap",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          display: "block",
                                        }}
                                      >
                                        希望納品日: {entry.desiredDeliveryDate.includes("T") ? entry.desiredDeliveryDate.split("T")[0] : entry.desiredDeliveryDate}
                                      </s-text>
                                    </div>
                                  )}
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "spaceBetween",
                                      alignItems: "center",
                                      marginTop: "4px",
                                    }}
                                  >
                                    <s-text
                                      tone="subdued"
                                      size="small"
                                      style={{
                                        whiteSpace: "nowrap",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "4px",
                                      }}
                                    >
                                      <span style={getStatusBadgeStyle(entry.status)}>
                                        {STATUS_LABEL[entry.status] || entry.status}
                                      </span>
                                    </s-text>
                                    <s-text
                                      tone="subdued"
                                      size="small"
                                      style={{ whiteSpace: "nowrap" }}
                                    >
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
        </s-stack>
      </s-scroll-box>

      {/* 商品リストモーダル（loss/history と同じ構成） */}
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
            <div
              style={{
                marginBottom: "16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "bold" }}>商品リスト</h2>
              <button
                onClick={closeItemsModal}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "24px",
                  cursor: "pointer",
                  padding: "0",
                  width: "32px",
                  height: "32px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ×
              </button>
            </div>

            {modalEntry && (
              <div
                style={{
                  marginBottom: "16px",
                  padding: "12px",
                  backgroundColor: "#f5f5f5",
                  borderRadius: "4px",
                }}
              >
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>発注ID:</strong> {modalEntry.id}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>名称:</strong> {modalEntry.orderName || "-"}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>発注店舗:</strong>{" "}
                  {modalEntry.locationName ||
                    locations.find((l) => l.id === modalEntry.locationId)?.name ||
                    modalEntry.locationId}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px", position: "relative" }}>
                  <strong>仕入先:</strong>{" "}
                  {editingDestination ? (
                    <div data-destination-list style={{ display: "inline-block", marginLeft: "8px", position: "relative", width: "100%" }}>
                      <input
                        type="text"
                        value={destinationSearch}
                        onChange={(e) => {
                          setDestinationSearch(e.target.value);
                          setShowDestinationList(true);
                        }}
                        onFocus={() => setShowDestinationList(true)}
                        placeholder="仕入先を検索または入力"
                        style={{
                          padding: "4px 8px",
                          border: "1px solid #ccc",
                          borderRadius: "4px",
                          fontSize: "14px",
                          width: "300px",
                        }}
                      />
                      {showDestinationList && (
                        <div
                          data-destination-list
                          style={{
                            position: "absolute",
                            top: "100%",
                            left: 0,
                            zIndex: 1000,
                            backgroundColor: "white",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                            marginTop: "4px",
                            maxHeight: "200px",
                            overflowY: "auto",
                            boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                            minWidth: "300px",
                          }}
                        >
                          {destinations
                            .filter((d) =>
                              d.name.toLowerCase().includes(destinationSearch.toLowerCase()) ||
                              (d.code && d.code.toLowerCase().includes(destinationSearch.toLowerCase()))
                            )
                            .map((dest) => (
                              <div
                                key={dest.id}
                                onClick={() => {
                                  const formData = new FormData();
                                  formData.set("intent", "updateDestination");
                                  formData.set("entryId", modalEntry.id);
                                  formData.set("destination", dest.name);
                                  fetcher.submit(formData, { method: "post" });
                                  // 即座に編集モードを解除（レスポンス待たずに）
                                  setEditingDestination(false);
                                  setShowDestinationList(false);
                                  setDestinationSearch("");
                                }}
                                style={{
                                  padding: "8px 12px",
                                  cursor: "pointer",
                                  borderBottom: "1px solid #eee",
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.backgroundColor = "#f5f5f5";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.backgroundColor = "white";
                                }}
                              >
                                {dest.name}
                                {dest.code && (
                                  <span style={{ color: "#666", fontSize: "12px", marginLeft: "8px" }}>
                                    ({dest.code})
                                  </span>
                                )}
                              </div>
                            ))}
                          {destinationSearch && !destinations.some((d) => d.name === destinationSearch) && (
                            <div
                              onClick={() => {
                                const formData = new FormData();
                                formData.set("intent", "updateDestination");
                                formData.set("entryId", modalEntry.id);
                                formData.set("destination", destinationSearch);
                                fetcher.submit(formData, { method: "post" });
                                // 即座に編集モードを解除（レスポンス待たずに）
                                setEditingDestination(false);
                                setShowDestinationList(false);
                                setDestinationSearch("");
                              }}
                              style={{
                                padding: "8px 12px",
                                cursor: "pointer",
                                borderTop: "1px solid #eee",
                                backgroundColor: "#f9f9f9",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = "#f0f0f0";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = "#f9f9f9";
                              }}
                            >
                              「{destinationSearch}」を設定
                            </div>
                          )}
                        </div>
                      )}
                      <button
                        onClick={() => {
                          const formData = new FormData();
                          formData.set("intent", "updateDestination");
                          formData.set("entryId", modalEntry.id);
                          formData.set("destination", destinationSearch || "");
                          fetcher.submit(formData, { method: "post" });
                          // 即座に編集モードを解除（レスポンス待たずに）
                          setEditingDestination(false);
                          setShowDestinationList(false);
                          setDestinationSearch("");
                        }}
                        style={{
                          marginLeft: "8px",
                          padding: "4px 12px",
                          backgroundColor: "#2563eb",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                          fontSize: "12px",
                        }}
                      >
                        保存
                      </button>
                      <button
                        onClick={() => {
                          setEditingDestination(false);
                          setShowDestinationList(false);
                          setDestinationSearch("");
                        }}
                        style={{
                          marginLeft: "4px",
                          padding: "4px 12px",
                          backgroundColor: "#6c757d",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                          fontSize: "12px",
                        }}
                      >
                        キャンセル
                      </button>
                    </div>
                  ) : (
                    <>
                      <span>{modalEntry.destination || "-"}</span>
                      <button
                        onClick={() => {
                          setEditingDestination(true);
                          setDestinationSearch(modalEntry.destination || "");
                          // 編集モードに入る際は、処理済みフラグはリセットしない
                          // （保存後のレスポンスが再度処理されないようにするため）
                        }}
                        style={{
                          marginLeft: "8px",
                          padding: "2px 8px",
                          backgroundColor: "#f0f0f0",
                          border: "1px solid #ccc",
                          borderRadius: "4px",
                          cursor: "pointer",
                          fontSize: "12px",
                        }}
                      >
                        編集
                      </button>
                    </>
                  )}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>日付:</strong>{" "}
                  {modalEntry.date ||
                    extractDateFromISO(modalEntry.createdAt, shopTimezone)}
                </div>
                {useDesiredDeliveryDate && (
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                    <strong>希望納品日:</strong>{" "}
                    {modalEntry.desiredDeliveryDate
                      ? (modalEntry.desiredDeliveryDate.includes("T")
                          ? modalEntry.desiredDeliveryDate.split("T")[0]
                          : modalEntry.desiredDeliveryDate)
                      : "-"}
                  </div>
                )}
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>担当者:</strong> {modalEntry.staffName || "-"}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>備考:</strong> {modalEntry.note || "-"}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>ステータス:</strong>{" "}
                  <span style={getStatusBadgeStyle(modalEntry.status)}>
                    {STATUS_LABEL[modalEntry.status] || modalEntry.status}
                  </span>
                </div>
                <div style={{ fontSize: "14px" }}>
                  <strong>数量合計:</strong>{" "}
                  {(modalEntry.items ?? []).reduce((sum, it) => sum + (it.quantity || 0), 0)}
                </div>
              </div>
            )}

            {/* 入荷日・検品日の入力欄（上部情報とリストの間） */}
            {modalEntry && (
              <div
                style={{
                  marginBottom: "16px",
                  padding: "12px",
                  backgroundColor: "#f9f9f9",
                  borderRadius: "4px",
                  border: "1px solid #e1e3e5",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: "12px",
                  }}
                >
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "13px",
                        fontWeight: 600,
                        marginBottom: "4px",
                      }}
                    >
                      入荷日
                    </label>
                    <input
                      type="date"
                      value={arrivalDate}
                      onChange={(e) => setArrivalDate(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "6px 8px",
                        fontSize: "13px",
                        border: "1px solid #e1e3e5",
                        borderRadius: "4px",
                      }}
                    />
                  </div>
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "13px",
                        fontWeight: 600,
                        marginBottom: "4px",
                      }}
                    >
                      検品日
                    </label>
                    <input
                      type="date"
                      value={inspectionDate}
                      onChange={(e) => setInspectionDate(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "6px 8px",
                        fontSize: "13px",
                        border: "1px solid #e1e3e5",
                        borderRadius: "4px",
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {fetcher.state === "submitting" || fetcher.state === "loading" ? (
              <div style={{ padding: "24px", textAlign: "center" }}>
                <div>商品リストを取得中...</div>
              </div>
            ) : modalItems.length > 0 ? (
              <div>
                <div
                  style={{
                    marginBottom: "12px",
                    fontSize: "14px",
                    color: "#666",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    合計: {modalItems.length}件
                    {modalEntry?.status === "pending" && `（選択中: ${selectedItemIndexes.size}件）`}
                  </span>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    {/* 未処理の場合のみ商品選択と仕入に反映を表示 */}
                    {modalEntry?.status === "pending" && (
                      <>
                        <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "13px" }}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleSelectAll}
                          />
                          <span>すべて選択</span>
                        </label>
                        <label
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            fontSize: "13px",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={reflectToPurchase}
                            onChange={(e) => setReflectToPurchase(e.target.checked)}
                          />
                          <span>仕入に反映</span>
                        </label>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={handleApproveSelected}
                      disabled={!modalEntry || fetcher.state === "submitting" || (modalEntry.status === "pending" && !anySelected)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: "4px",
                        border: "none",
                        backgroundColor:
                          !modalEntry ||
                          fetcher.state === "submitting" ||
                          (modalEntry.status === "pending" && !anySelected)
                            ? "#ccc"
                            : modalEntry.status === "shipped"
                            ? "#dc3545"
                            : "#2563eb",
                        color: "white",
                        cursor:
                          !modalEntry ||
                          fetcher.state === "submitting" ||
                          (modalEntry.status === "pending" && !anySelected)
                            ? "default"
                            : "pointer",
                        fontSize: "13px",
                      }}
                    >
                      {fetcher.state === "submitting"
                        ? "処理中..."
                        : modalEntry?.status === "shipped"
                        ? "承認を取り消す"
                        : "選択した商品を承認"}
                    </button>
                  </div>
                </div>
                <div style={{ maxHeight: "400px", overflowY: "auto" }}>
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
                          backgroundColor: "#f5f5f5",
                          borderBottom: "2px solid #ddd",
                        }}
                      >
                        {modalEntry?.status === "pending" && (
                          <th
                            style={{
                              padding: "8px",
                              textAlign: "center",
                              borderRight: "1px solid #ddd",
                              width: "48px",
                            }}
                          >
                            選択
                          </th>
                        )}
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "left",
                            borderRight: "1px solid #ddd",
                          }}
                        >
                          商品名
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "left",
                            borderRight: "1px solid #ddd",
                          }}
                        >
                          SKU
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "left",
                            borderRight: "1px solid #ddd",
                          }}
                        >
                          JAN
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "left",
                            borderRight: "1px solid #ddd",
                          }}
                        >
                          オプション1
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "left",
                            borderRight: "1px solid #ddd",
                          }}
                        >
                          オプション2
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "left",
                            borderRight: "1px solid #ddd",
                          }}
                        >
                          オプション3
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalItems.map((item, idx) => (
                        <tr
                          key={item.id || idx}
                          style={{ borderBottom: "1px solid #eee" }}
                        >
                          {modalEntry?.status === "pending" && (
                            <td
                              style={{
                                padding: "8px",
                                borderRight: "1px solid #eee",
                                textAlign: "center",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={selectedItemIndexes.has(idx)}
                                onChange={() => toggleSelectIndex(idx)}
                              />
                            </td>
                          )}
                          <td
                            style={{
                              padding: "8px",
                              borderRight: "1px solid #eee",
                            }}
                          >
                            {item.title || "（商品名なし）"}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderRight: "1px solid #eee",
                            }}
                          >
                            {item.sku || "（SKUなし）"}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderRight: "1px solid #eee",
                            }}
                          >
                            {item.barcode || "（JANなし）"}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderRight: "1px solid #eee",
                            }}
                          >
                            {item.option1 || "-"}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderRight: "1px solid #eee",
                            }}
                          >
                            {item.option2 || "-"}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderRight: "1px solid #eee",
                            }}
                          >
                            {item.option3 || "-"}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {item.quantity || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div
                style={{
                  padding: "24px",
                  textAlign: "center",
                  color: "#666",
                }}
              >
                商品リストがありません
              </div>
            )}

            <div
              style={{
                marginTop: "16px",
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
              }}
            >
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

      {/* カスタムアラートモーダル */}
      {alertModalOpen && (
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
          onClick={() => setAlertModalOpen(false)}
        >
          <div
            style={{
              backgroundColor: "white",
              borderRadius: "8px",
              padding: "24px",
              maxWidth: "500px",
              width: "90%",
              boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                marginBottom: "16px",
                fontSize: "18px",
                fontWeight: "bold",
              }}
            >
              発注管理
            </div>
            <div
              style={{
                marginBottom: "24px",
                fontSize: "14px",
                whiteSpace: "pre-line",
                lineHeight: "1.6",
              }}
            >
              {alertMessage}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => setAlertModalOpen(false)}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#2563eb",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* カスタム確認モーダル */}
      {confirmModalOpen && (
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
          onClick={() => {
            setConfirmModalOpen(false);
            setConfirmCallback(null);
          }}
        >
          <div
            style={{
              backgroundColor: "white",
              borderRadius: "8px",
              padding: "24px",
              maxWidth: "500px",
              width: "90%",
              boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                marginBottom: "16px",
                fontSize: "18px",
                fontWeight: "bold",
              }}
            >
              発注管理
            </div>
            <div
              style={{
                marginBottom: "24px",
                fontSize: "14px",
                whiteSpace: "pre-line",
                lineHeight: "1.6",
              }}
            >
              {confirmMessage}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => {
                  setConfirmModalOpen(false);
                  setConfirmCallback(null);
                }}
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
                キャンセル
              </button>
              <button
                onClick={() => {
                  if (confirmCallback) {
                    confirmCallback();
                  }
                }}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#2563eb",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}

