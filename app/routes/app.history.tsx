// app/routes/app.history.tsx
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState, useMemo, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { getDateInShopTimezone } from "../utils/timezone";

// 入出庫履歴CSV列（設定画面の「入出庫履歴CSV出力項目設定」と一致）
const HISTORY_CSV_COLUMN_IDS = [
  "historyId", "name", "date", "origin", "destination", "status",
  "shipmentId", "shipmentStatus", "productTitle", "sku", "barcode",
  "option1", "option2", "option3", "plannedQty", "receivedQty", "kind",
] as const;
const HISTORY_CSV_LABELS: Record<string, string> = {
  historyId: "履歴ID", name: "名称", date: "日付", origin: "出庫元", destination: "入庫先", status: "ステータス",
  shipmentId: "配送ID", shipmentStatus: "配送ステータス", productTitle: "商品名", sku: "SKU", barcode: "JAN",
  option1: "オプション1", option2: "オプション2", option3: "オプション3", plannedQty: "予定数", receivedQty: "入庫数", kind: "種別",
};
const DEFAULT_HISTORY_CSV_COLUMNS = [...HISTORY_CSV_COLUMN_IDS];
const SETTINGS_NS = "stock_transfer_pos";
const SETTINGS_KEY = "settings_v1";

// メモ（note）から予定外入庫の数量合計を抽出する関数
function extractExtrasQuantityFromNote(note: string): number {
  if (!note) return 0;
  
  // メモから「予定外入庫: X件」のセクションを抽出
  const extrasSectionMatch = note.match(/予定外入庫:\s*(\d+)件\s*\n((?:  - .+(?:\n|$))+)/);
  if (!extrasSectionMatch) return 0;
  
  const extrasLines = extrasSectionMatch[2] || "";
  let totalQty = 0;
  
  // 各行をパース（"  - "で始まる行のみ）
  const lines = extrasLines.split(/\n/).filter(line => line.trim().startsWith("-"));
  lines.forEach((line) => {
    // 形式: "  - 商品名, オプション: オプション値, SKU: xxx, JAN: xxx, 予定外/数量: X"
    const lineMatch = line.match(/  - (.+?)(?:,\s*オプション:\s*(.+?))?(?:,\s*SKU:\s*(.+?))?(?:,\s*JAN:\s*(.+?))?(?:,\s*予定外\/数量:\s*(\d+))?$/);
    if (lineMatch) {
      const qty = parseInt(lineMatch[5] || "0", 10);
      totalQty += qty;
    }
  });
  
  return totalQty;
}

// メモ（note）から予定外入庫の件数を抽出する関数
function extractExtrasCountFromNote(note: string): number {
  if (!note) return 0;
  
  // メモから「予定外入庫: X件」のセクションを抽出
  const extrasSectionMatch = note.match(/予定外入庫:\s*(\d+)件/);
  if (!extrasSectionMatch) return 0;
  
  return parseInt(extrasSectionMatch[1] || "0", 10);
}

export type LocationNode = { id: string; name: string };

export type TransferLineItem = {
  id: string;
  inventoryItemId: string;
  variantId?: string;
  sku?: string;
  barcode?: string;
  title?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  quantity: number; // 予定数
  receivedQuantity?: number; // 入庫数（取得可能な場合）
  isExtra?: boolean; // 予定外入庫フラグ
  /** 複数シップメント時にどの配送に属するか（棚卸の商品グループ列と同様） */
  shipmentId?: string;
  shipmentDisplayId?: string; // 表示用 e.g. #T0127-1, #T0127-L
  /** 配送ごとのステータス（棚卸の商品グループごとの完了済み/未完了と同様） */
  shipmentStatus?: string; // DRAFT, READY_TO_SHIP, RECEIVED, TRANSFERRED, CANCELED 等
};

/** 配送単位でグループ化した明細（棚卸の groupItems と同様） */
export type GroupedLineItemsEntry = {
  shipmentMetadata: { id: string; displayId: string; status: string };
  items: TransferLineItem[];
};

export type TransferHistory = {
  id: string;
  name: string;
  status: string;
  note?: string;
  dateCreated: string;
  totalQuantity: number;
  receivedQuantity: number;
  originLocationId: string;
  originLocationName: string;
  destinationLocationId: string;
  destinationLocationName: string;
  shipmentCount: number;
  lineItems: TransferLineItem[];
  type: "outbound" | "inbound"; // 出庫 or 入庫
};

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") || null;
    const direction = url.searchParams.get("direction") || "next"; // "next" or "prev"

    // ロケーション一覧を取得
    const locationsResp = await admin.graphql(
      `#graphql
        query Locations($first: Int!) {
          locations(first: $first) {
            nodes {
              id
              name
            }
          }
        }
      `,
      { variables: { first: 250 } }
    );

    const locationsData = await locationsResp.json();
    const locations: LocationNode[] = locationsData?.data?.locations?.nodes ?? [];

    // 全履歴を1つのクエリで取得（出庫・入庫をまとめて取得）
    // ページネーション対応
    // 注意: beforeを使う場合はlast、afterを使う場合はfirstが必要
    const pageSize = 100;
    const transfersResp = await admin.graphql(
      `#graphql
        query AllTransfers($first: Int, $last: Int, $after: String, $before: String) {
          inventoryTransfers(
            first: $first
            last: $last
            after: $after
            before: $before
            sortKey: CREATED_AT
            reverse: true
          ) {
            nodes {
              id
              name
              status
              note
              dateCreated
              totalQuantity
              receivedQuantity
              origin {
                name
                location {
                  id
                  name
                }
              }
              destination {
                name
                location {
                  id
                  name
                }
              }
              shipments(first: 10) {
                nodes {
                  id
                  status
                  totalRejectedQuantity
                }
              }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          ...(cursor && direction === "next"
            ? { first: pageSize, after: cursor }
            : cursor && direction === "prev"
            ? { last: pageSize, before: cursor }
            : { first: pageSize }),
        },
      }
    );

    const transfersData = await transfersResp.json();
    const allNodes = transfersData?.data?.inventoryTransfers?.nodes ?? [];
    const pageInfo = transfersData?.data?.inventoryTransfers?.pageInfo ?? {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    };

    // 全履歴を整形（出庫・入庫を分類）
    const allHistories: TransferHistory[] = allNodes
      .map((t: any) => {
        const originId = t?.origin?.location?.id;
        const destinationId = t?.destination?.location?.id;

        // lineItemsは詳細表示時に取得するため、ここでは空配列
        const lineItems: TransferLineItem[] = [];

        // アプリ（POS）と同一ルール: receivedQuantityDisplay = receivedQuantity - rejectedQuantity + extrasQuantity
        // 拒否分: マイナス（GraphQL receivedQuantity に含まれているため引く）
        // 予定外: プラス（メモ/監査ログから取得して加算）
        // 過剰分: 加算しない（GraphQL receivedQuantity に既に含まれている）
        const extrasQuantity = extractExtrasQuantityFromNote(t.note || "");
        const rejectedQuantity = (Array.isArray(t?.shipments?.nodes) ? t.shipments.nodes : [])
          .reduce((sum: number, s: any) => sum + Math.max(0, Number(s?.totalRejectedQuantity ?? 0)), 0);
        const receivedQuantityDisplay =
          Number(t.receivedQuantity ?? 0) - Number(rejectedQuantity) + Number(extrasQuantity);

        // 出庫履歴（originLocationIdがある場合）
        if (originId) {
          return {
            id: t.id,
            name: t.name || "",
            status: t.status || "",
            note: t.note || "",
            dateCreated: t.dateCreated || "",
            totalQuantity: t.totalQuantity ?? 0,
            receivedQuantity: receivedQuantityDisplay,
            originLocationId: originId,
            originLocationName: t.origin?.location?.name || t.origin?.name || "",
            destinationLocationId: destinationId || "",
            destinationLocationName: t?.destination?.location?.name || t?.destination?.name || "",
            shipmentCount: Array.isArray(t?.shipments?.nodes) ? t.shipments.nodes.length : 0,
            lineItems,
            type: "outbound" as const,
          };
        }

        // 入庫履歴（destinationLocationIdがある場合）
        if (destinationId) {
          return {
            id: t.id,
            name: t.name || "",
            status: t.status || "",
            note: t.note || "",
            dateCreated: t.dateCreated || "",
            totalQuantity: t.totalQuantity ?? 0,
            receivedQuantity: receivedQuantityDisplay,
            originLocationId: originId || "",
            originLocationName: t?.origin?.location?.name || t?.origin?.name || "",
            destinationLocationId: destinationId,
            destinationLocationName: t?.destination?.location?.name || t?.destination?.name || "",
            shipmentCount: Array.isArray(t?.shipments?.nodes) ? t.shipments.nodes.length : 0,
            lineItems,
            type: "inbound" as const,
          };
        }

        return null;
      })
      .filter((h: TransferHistory | null): h is TransferHistory => h !== null)
      .sort((a, b) => {
        const dateA = new Date(a.dateCreated).getTime();
        const dateB = new Date(b.dateCreated).getTime();
        return dateB - dateA; // 新しい順
      });

    // 総数・表示範囲の計算
    const isPage2OrLater = Boolean(cursor && direction === "next");
    const totalFromApi =
      !pageInfo.hasNextPage && isPage2OrLater
        ? pageSize + allHistories.length
        : !pageInfo.hasNextPage && !cursor
          ? allHistories.length
          : null;
    const totalFromUrl = url.searchParams.get("total");
    const total = totalFromApi ?? (totalFromUrl ? parseInt(totalFromUrl, 10) : null);
    const startIndex = isPage2OrLater ? pageSize + 1 : 1;

    // ショップのタイムゾーンを取得
    const shopTimezoneResp = await admin.graphql(
      `#graphql
        query GetShopTimezone {
          shop {
            ianaTimezone
          }
        }
      `
    );
    const shopTimezoneData = await shopTimezoneResp.json();
    const shopTimezone = shopTimezoneData?.data?.shop?.ianaTimezone || "UTC";

    // サーバー側で「今日の日付」を計算
    const todayInShopTimezone = getDateInShopTimezone(new Date(), shopTimezone);

    // 設定から入出庫CSV出力項目を取得（設定画面の「入出庫履歴CSV出力項目設定」と連動）
    let historyCsvExportColumns: string[] = DEFAULT_HISTORY_CSV_COLUMNS;
    try {
      const mfResp = await admin.graphql(
        `#graphql
          query HistorySettings {
            currentAppInstallation {
              metafield(namespace: "${SETTINGS_NS}", key: "${SETTINGS_KEY}") { value }
            }
          }
        `,
        {}
      );
      const mfData = await mfResp.json();
      const raw = mfData?.data?.currentAppInstallation?.metafield?.value ?? null;
      if (raw && typeof raw === "string") {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed?.inbound?.csvExportColumns) ? parsed.inbound.csvExportColumns : [];
        const valid = (arr as string[]).filter((id) => HISTORY_CSV_COLUMN_IDS.includes(id as any));
        if (valid.length > 0) historyCsvExportColumns = valid;
      }
    } catch {
      // 設定取得失敗時はデフォルトの並びのまま
    }

    return {
      locations,
      histories: allHistories,
      shopTimezone,
      todayInShopTimezone, // サーバー側で計算した「今日の日付」をクライアントに渡す
      historyCsvExportColumns,
      pageInfo: {
        hasNextPage: pageInfo.hasNextPage || false,
        hasPreviousPage: pageInfo.hasPreviousPage || false,
        startCursor: pageInfo.startCursor || null,
        endCursor: pageInfo.endCursor || null,
      },
      pagination: {
        total: Number.isFinite(total) ? total : null,
        startIndex,
        pageSize,
      },
    };
  } catch (error) {
    console.error("History loader error:", error);
    throw error;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const transferId = String(formData.get("transferId") || "").trim();

    if (!transferId) {
      return { error: "transferId is required" };
    }

    // Transfer IDから商品明細を取得
    // 複数シップメント時は配送ID（shipmentDisplayId）を付与。単一シップメントで下書き・キャンセル時は Transfer の lineItems をフォールバックで使用
    const resp = await admin.graphql(
      `#graphql
        query TransferLineItems($id: ID!) {
          inventoryTransfer(id: $id) {
            id
            name
            note
            lineItems(first: 250) {
              nodes {
                id
                totalQuantity
                inventoryItem {
                  id
                  sku
                  variant {
                    id
                    title
                    barcode
                    selectedOptions {
                      name
                      value
                    }
                    product {
                      title
                    }
                  }
                }
              }
            }
            shipments(first: 50) {
              nodes {
                id
                status
                tracking { trackingNumber company trackingUrl arrivesAt }
                lineItems(first: 250) {
                  nodes {
                    id
                    quantity
                    acceptedQuantity
                    inventoryItem {
                      id
                      sku
                      variant {
                        id
                        title
                        barcode
                        selectedOptions {
                          name
                          value
                        }
                        product {
                          title
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { id: transferId } }
    );

    const data = await resp.json();
    
    // エラーチェック
    if (data?.errors) {
      console.error("Action - GraphQL errors:", data.errors);
      return { error: `GraphQL error: ${data.errors.map((e: any) => e.message).join(", ")}` };
    }
    
    const transfer = data?.data?.inventoryTransfer;

    if (!transfer) {
      return { error: "Transfer not found" };
    }

    // 配送表示IDを生成（#T0127-1, #T0127-2, #T0127-L の形式。アプリ・管理画面と統一）
    const transferName = (transfer.name || "").trim();
    const transferIdNum = transferId.replace(/^.*\/(\d+)$/, "$1") || transferId;
    const transferPrefix = transferName
      ? (transferName.startsWith("#") ? transferName : "#" + transferName.replace(/^T?/i, "T"))
      : "#T" + transferIdNum;
    const formatShipmentDisplayId = (index: number) => `${transferPrefix}-${index + 1}`;
    const transferLineDisplayId = `${transferPrefix}-L`;

    const lineItems: TransferLineItem[] = [];
    const shipmentNodes = Array.isArray(transfer?.shipments?.nodes) ? transfer.shipments.nodes : [];

    // 1) まず shipments の lineItems を集約（各明細に shipmentId / shipmentDisplayId を付与）
    for (let shipmentIdx = 0; shipmentIdx < shipmentNodes.length; shipmentIdx++) {
      const shipment = shipmentNodes[shipmentIdx];
      const shipmentId = shipment?.id || "";
      const shipmentDisplayId = formatShipmentDisplayId(shipmentIdx);
      const shipmentStatus = shipment?.status || "";
      const nodes = Array.isArray(shipment?.lineItems?.nodes) ? shipment.lineItems.nodes : [];
      for (const li of nodes) {
        const inventoryItem = li?.inventoryItem;
        const variant = inventoryItem?.variant;
        const product = variant?.product;
        const selectedOptions = Array.isArray(variant?.selectedOptions) ? variant.selectedOptions : [];
        const option1 = selectedOptions[0]?.value || "";
        const option2 = selectedOptions[1]?.value || "";
        const option3 = selectedOptions[2]?.value || "";
        const productTitle = String(product?.title || "").trim();
        const variantTitle = String(variant?.title || "").trim();
        const title = productTitle && variantTitle
          ? `${productTitle} / ${variantTitle}`
          : (variantTitle || productTitle || variant?.sku || inventoryItem?.id || "(unknown)");
        const sku = variant?.sku || inventoryItem?.sku || "";
        lineItems.push({
          id: li.id || "",
          inventoryItemId: inventoryItem?.id || "",
          variantId: variant?.id || "",
          sku,
          barcode: variant?.barcode || "",
          title,
          option1,
          option2,
          option3,
          quantity: li.quantity ?? 0,
          receivedQuantity: li.acceptedQuantity ?? li.quantity ?? 0,
          shipmentId,
          shipmentDisplayId,
          shipmentStatus,
        });
      }
    }

    // 2) 単一シップメントで下書き・キャンセル時など、shipment に lineItems が無い場合は Transfer の lineItems をフォールバック
    if (lineItems.length === 0 && Array.isArray(transfer?.lineItems?.nodes) && transfer.lineItems.nodes.length > 0) {
      const firstShipment = shipmentNodes[0];
      const firstShipmentId = firstShipment?.id || "";
      const displayId = shipmentNodes.length === 1 ? formatShipmentDisplayId(0) : transferLineDisplayId;
      const fallbackStatus = firstShipment?.status || (transfer as any)?.status || "";
      for (const li of transfer.lineItems.nodes) {
        const inventoryItem = li?.inventoryItem;
        const variant = inventoryItem?.variant;
        const product = variant?.product;
        const selectedOptions = Array.isArray(variant?.selectedOptions) ? variant.selectedOptions : [];
        const option1 = selectedOptions[0]?.value || "";
        const option2 = selectedOptions[1]?.value || "";
        const option3 = selectedOptions[2]?.value || "";
        const productTitle = String(product?.title || "").trim();
        const variantTitle = String(variant?.title || "").trim();
        const title = productTitle && variantTitle
          ? `${productTitle} / ${variantTitle}`
          : (variantTitle || productTitle || variant?.sku || inventoryItem?.id || "(unknown)");
        const sku = variant?.sku || inventoryItem?.sku || "";
        lineItems.push({
          id: li.id || "",
          inventoryItemId: inventoryItem?.id || "",
          variantId: variant?.id || "",
          sku,
          barcode: variant?.barcode || "",
          title,
          option1,
          option2,
          option3,
          quantity: li.totalQuantity ?? 0,
          receivedQuantity: li.totalQuantity ?? 0,
          shipmentId: firstShipmentId || undefined,
          shipmentDisplayId: displayId,
          shipmentStatus: fallbackStatus,
        });
      }
    }
    
    // 予定外入庫をメモ（note）から抽出
    const extrasItems: TransferLineItem[] = [];
    const note = transfer?.note || "";
    if (note) {
      // メモから「予定外入庫: X件」のセクションを抽出
      // パターン: "予定外入庫: X件" の後に続く行（"  - "で始まる行）を取得
      const extrasSectionMatch = note.match(/予定外入庫:\s*(\d+)件\s*\n((?:  - .+(?:\n|$))+)/);
      if (extrasSectionMatch) {
        const extrasLines = extrasSectionMatch[2] || "";
        
        // 各行をパース（"  - "で始まる行のみ）
        const lines = extrasLines.split(/\n/).filter(line => line.trim().startsWith("-"));
        lines.forEach((line, idx) => {
          // 形式: "  - 商品名, オプション: オプション値, SKU: xxx, JAN: xxx, 予定外/数量: X"
          // より柔軟なパターンでマッチング
          const lineMatch = line.match(/  - (.+?)(?:,\s*オプション:\s*(.+?))?(?:,\s*SKU:\s*(.+?))?(?:,\s*JAN:\s*(.+?))?(?:,\s*予定外\/数量:\s*(\d+))?$/);
          if (lineMatch) {
            const title = lineMatch[1]?.trim() || "";
            const options = lineMatch[2]?.trim() || "";
            const sku = lineMatch[3]?.trim() || "";
            const barcode = lineMatch[4]?.trim() || "";
            const qty = parseInt(lineMatch[5] || "0", 10);
            
            if (qty > 0) {
              // オプションを分割（例: "Special Selling 1 / Free" → option1: "Special Selling 1", option2: "Free"）
              const optionParts = options.split(" / ").filter(Boolean);
              
              extrasItems.push({
                id: `extra-${transferId}-${idx}`,
                inventoryItemId: "", // メモからは取得できない
                variantId: "",
                sku: sku || "",
                barcode: barcode || "",
                title: title || `予定外入庫: ${sku || `item-${idx}`}`,
                option1: optionParts[0] || "",
                option2: optionParts[1] || "",
                option3: optionParts[2] || "",
                quantity: 0, // 予定数は0
                receivedQuantity: qty, // 実際の入庫数
                isExtra: true,
              });
            }
          }
        });
      }
    }
    
    // 配送単位でグループ化（棚卸UI用・進捗表示用）
    const groupedLineItems: GroupedLineItemsEntry[] = [];
    for (let i = 0; i < shipmentNodes.length; i++) {
      const s = shipmentNodes[i];
      const items = lineItems.filter((li) => !li.isExtra && li.shipmentId === s?.id);
      groupedLineItems.push({
        shipmentMetadata: {
          id: s?.id || "",
          displayId: formatShipmentDisplayId(i),
          status: s?.status || "",
        },
        items,
      });
    }
    if (extrasItems.length > 0) {
      groupedLineItems.push({
        shipmentMetadata: { id: "extras", displayId: "予定外入庫", status: "" },
        items: extrasItems,
      });
    }

    // 予定外入庫をlineItemsに追加
    lineItems.push(...extrasItems);

    // 配送情報（先頭シップメントの tracking）
    const firstShipment = shipmentNodes[0];
    const tr = firstShipment?.tracking;
    const transferTracking = tr
      ? {
          company: String(tr?.company ?? "").trim(),
          trackingNumber: String(tr?.trackingNumber ?? "").trim(),
          arrivesAt: tr?.arrivesAt ? String(tr.arrivesAt).trim() : "",
        }
      : null;

    // React Router v7では、オブジェクトを直接返すと自動的にJSONレスポンスに変換される
    return { transferId, lineItems, groupedLineItems, transferTracking };
  } catch (error) {
    console.error("Line items action error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Line items action error details:", errorMessage);
    return { error: `Failed to load line items: ${errorMessage}` };
  }
}

export default function HistoryPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { locations, histories, shopTimezone, todayInShopTimezone, historyCsvExportColumns, pageInfo, pagination } = loaderData || {
    locations: [],
    histories: [],
    shopTimezone: "UTC",
    todayInShopTimezone: getDateInShopTimezone(new Date(), "UTC"),
    historyCsvExportColumns: DEFAULT_HISTORY_CSV_COLUMNS,
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    pagination: { total: null, startIndex: 1, pageSize: 100 },
  };
  const csvColumns = historyCsvExportColumns ?? DEFAULT_HISTORY_CSV_COLUMNS;
  const fetcher = useFetcher<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();

  // 総数をURLに永続化（2ページ目で判明した総数を1ページ目に戻ったときも表示するため）
  const totalFromLoader = pagination?.total ?? null;
  const totalFromUrl = searchParams.get("total");
  const total = totalFromLoader ?? (totalFromUrl ? parseInt(totalFromUrl, 10) : null);
  const startIndex = pagination?.startIndex ?? 1;
  const pageSize = pagination?.pageSize ?? 100;

  const isPage2OrLater = Boolean(searchParams.get("cursor") && searchParams.get("direction") === "next");
  const currentPage = isPage2OrLater ? 2 : 1; // 2ページ構成を前提。3ページ以上は将来対応
  const totalPages = total && Number.isFinite(total) ? Math.ceil(total / pageSize) : null;

  const hasPagination = pageInfo.hasPreviousPage || pageInfo.hasNextPage;

  useEffect(() => {
    if (totalFromLoader != null && !searchParams.get("total")) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("total", String(totalFromLoader));
          return next;
        },
        { replace: true }
      );
    }
  }, [totalFromLoader, searchParams.get("total"), setSearchParams]);

  // 表示範囲・総数・ページ表示の文字列
  const endIndex = startIndex + histories.length - 1;
  const rangeDisplay =
    histories.length > 0
      ? startIndex === endIndex
        ? `表示: ${startIndex}件`
        : `表示: ${startIndex}-${endIndex}件`
      : "表示: 0件";
  const totalDisplay = total != null ? `${total}件` : `${histories.length}件以上`;
  const pageDisplay = hasPagination
    ? totalPages != null
      ? `${currentPage}/${totalPages}`
      : pageInfo.hasPreviousPage && !pageInfo.hasNextPage
        ? "最終ページ"
        : !pageInfo.hasPreviousPage && pageInfo.hasNextPage
          ? "1/2+"
          : "2/3+"
    : "";

  // ステータスの日本語表記
  const STATUS_LABEL: Record<string, string> = {
    DRAFT: "下書き",
    READY_TO_SHIP: "配送準備完了",
    IN_PROGRESS: "処理中",
    IN_TRANSIT: "進行中",
    RECEIVED: "受領",
    TRANSFERRED: "入庫済み",
    CANCELED: "キャンセル",
  };

  // ステータスバッジ用スタイル（アプリと同様のバッチ表示）
  const getStatusBadgeStyle = (status: string): React.CSSProperties => {
    const base = { display: "inline-block" as const, padding: "2px 8px", borderRadius: "9999px", fontSize: "12px", fontWeight: 600 };
    if (status === "RECEIVED" || status === "TRANSFERRED") return { ...base, backgroundColor: "#d4edda", color: "#155724" };
    if (status === "CANCELED") return { ...base, backgroundColor: "#f8d7da", color: "#721c24" };
    if (status === "DRAFT") return { ...base, backgroundColor: "#e2e3e5", color: "#383d41" };
    return { ...base, backgroundColor: "#cce5ff", color: "#004085" }; // READY_TO_SHIP, IN_PROGRESS, IN_TRANSIT 等
  };

  // フィルター状態（複数選択対応）
  const [outboundLocationFilters, setOutboundLocationFilters] = useState<Set<string>>(new Set());
  const [inboundLocationFilters, setInboundLocationFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 商品リストモーダル状態（lineItems は CSV 用、grouped は UI 表示用）
  const [modalOpen, setModalOpen] = useState(false);
  const [modalHistory, setModalHistory] = useState<TransferHistory | null>(null);
  const [modalLineItems, setModalLineItems] = useState<TransferLineItem[]>([]);
  const [modalGroupedLineItems, setModalGroupedLineItems] = useState<GroupedLineItemsEntry[]>([]);

  // CSV出力処理中状態
  const [csvExporting, setCsvExporting] = useState(false);
  const [csvExportProgress, setCsvExportProgress] = useState({ current: 0, total: 0 });

  // フィルター適用後の履歴
  const filteredHistories = useMemo(() => {
    let filtered = histories;

    // 出庫ロケーションフィルター（複数選択対応）
    if (outboundLocationFilters.size > 0) {
      filtered = filtered.filter((h) => {
        if (h.type === "outbound") {
          return outboundLocationFilters.has(h.originLocationId);
        }
        return true; // 入庫履歴は出庫ロケーションフィルターの影響を受けない
      });
    }

    // 入庫ロケーションフィルター（複数選択対応）
    if (inboundLocationFilters.size > 0) {
      filtered = filtered.filter((h) => {
        if (h.type === "inbound") {
          return inboundLocationFilters.has(h.destinationLocationId);
        }
        return true; // 出庫履歴は入庫ロケーションフィルターの影響を受けない
      });
    }

    // ステータスフィルター（複数選択対応）
    if (statusFilters.size > 0) {
      filtered = filtered.filter((h) => statusFilters.has(h.status));
    }

    return filtered;
  }, [histories, outboundLocationFilters, inboundLocationFilters, statusFilters]);

  // ステータスの一覧を取得（日本語表記）
  const statuses = useMemo(() => {
    const statusSet = new Set<string>();
    histories.forEach((h) => {
      if (h.status) statusSet.add(h.status);
    });
    return Array.from(statusSet).sort();
  }, [histories]);

  // CSV出力（商品明細まで含める）
  const exportCSV = async () => {
    if (selectedIds.size === 0) {
      alert("CSV出力する履歴を選択してください");
      return;
    }

    const selectedHistories = filteredHistories.filter((h) => selectedIds.has(h.id));

    // 商品リスト数の制限チェック
    // 理論上の最大: 50シップメント × 250商品 = 12,500商品/履歴
    const MAX_ITEMS_PER_HISTORY = 12500;
    const WARNING_THRESHOLD = 50000; // 警告を表示する閾値（商品数）
    const estimatedMaxItems = selectedHistories.length * MAX_ITEMS_PER_HISTORY;
    
    if (estimatedMaxItems > WARNING_THRESHOLD) {
      alert(`ダウンロード最大数を越えていますので、フィルターなどで再調整してください。\n\n選択された履歴数: ${selectedHistories.length}件\n推定される最大商品数: 約${estimatedMaxItems.toLocaleString()}商品`);
      return;
    }

    // 処理中モーダルを表示
    setCsvExporting(true);
    setCsvExportProgress({ current: 0, total: selectedHistories.length });

    try {
      // CSVヘッダー（設定の「入出庫履歴CSV出力項目設定」の並び・項目を使用）
      const headers = csvColumns.map((id) => HISTORY_CSV_LABELS[id] ?? id);

      // CSVデータ（商品明細を展開）
      // 商品明細を取得してからCSV出力
      const rows: string[][] = [];
      
      // useFetcherを使って順次処理で商品リストを取得
      for (let i = 0; i < selectedHistories.length; i++) {
        const h = selectedHistories[i];
        setCsvExportProgress({ current: i + 1, total: selectedHistories.length });
      const locationName =
        h.type === "outbound" ? h.originLocationName : h.destinationLocationName;
      const date = h.dateCreated ? new Date(h.dateCreated).toISOString().split("T")[0] : "";
      const statusLabel = STATUS_LABEL[h.status] || h.status;

      // 商品明細を取得（fetcherを使用、モーダルと共有）
      // 注意: モーダルが開いている場合は、fetcherが使用中なので待機する
      let lineItems: TransferLineItem[] = [];
      try {
        const formData = new FormData();
        formData.set("transferId", h.id);

        // fetcherが使用中でないことを確認
        let waitCount = 0;
        while ((fetcher.state === "submitting" || fetcher.state === "loading") && waitCount < 50) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waitCount++;
        }
        
        // fetcher.submit()を呼び出して、完了を待つ
        // 前のリクエストのtransferIdを保存（変更検知用）
        const previousTransferId = (fetcher.data as any)?.transferId;
        fetcher.submit(formData, { method: "post" });
        
        // fetcher.stateが"idle"になるまで待つ（最大10秒）
        waitCount = 0;
        while ((fetcher.state === "submitting" || fetcher.state === "loading") && waitCount < 100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waitCount++;
        }
        
        // 追加の待機：fetcher.dataが更新されるまで待つ
        // モーダルと同じ方法：transferIdが変更されるか、またはlineItemsが存在することを確認
        waitCount = 0;
        let dataReceived = false;
        while (waitCount < 100) {
          if (fetcher.data) {
            const currentTransferId = (fetcher.data as any)?.transferId;
            
            // transferIdが一致する場合
            if (currentTransferId === h.id) {
              dataReceived = true;
              break;
            }
            // transferIdが前のリクエストと異なる場合（新しいデータが来た）
            else if (currentTransferId && currentTransferId !== previousTransferId) {
              // まだ期待するtransferIdではないが、新しいデータが来たので待機を続ける
              await new Promise((resolve) => setTimeout(resolve, 100));
              waitCount++;
              continue;
            }
            // transferIdがないが、lineItemsまたはerrorがある場合
            else if (!currentTransferId && ('lineItems' in fetcher.data || 'error' in fetcher.data)) {
              // transferIdがない場合は、このデータを使用（モーダルと同じ方法）
              dataReceived = true;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          waitCount++;
        }
        
        if (fetcher.data && dataReceived) {
          // transferIdが一致することを確認（transferIdがある場合のみ）
          // ただし、transferIdがない場合は、lineItemsの存在を確認（モーダルと同じ方法）
          const currentTransferId = (fetcher.data as any)?.transferId;
          if (currentTransferId && currentTransferId !== h.id) {
            lineItems = [];
          } else if ('error' in fetcher.data) {
            lineItems = [];
          } else if ('lineItems' in fetcher.data) {
            lineItems = Array.isArray(fetcher.data.lineItems) ? fetcher.data.lineItems : [];
          } else {
            lineItems = [];
          }
        } else {
          lineItems = [];
        }
      } catch {
        // エラー時も続行（商品明細なしで履歴情報のみ出力）
      }

      const originName = h.originLocationName || "";
      const destName = h.destinationLocationName || "";
      const historyName = h.name || h.id;

      const toRow = (rowObj: Record<string, string | number>) =>
        csvColumns.map((id) => String(rowObj[id] ?? ""));

      if (lineItems.length === 0) {
        rows.push(toRow({
          historyId: h.id,
          name: historyName,
          date,
          origin: originName,
          destination: destName,
          status: statusLabel,
          shipmentId: "",
          shipmentStatus: "",
          productTitle: "",
          sku: "",
          barcode: "",
          option1: "",
          option2: "",
          option3: "",
          plannedQty: "",
          receivedQty: "",
          kind: "",
        }));
      } else {
        lineItems.forEach((item) => {
          const shipmentStatusLabel = item.shipmentStatus ? (STATUS_LABEL[item.shipmentStatus] || item.shipmentStatus) : "";
          rows.push(toRow({
            historyId: h.id,
            name: historyName,
            date,
            origin: originName,
            destination: destName,
            status: statusLabel,
            shipmentId: item.shipmentDisplayId || "",
            shipmentStatus: shipmentStatusLabel,
            productTitle: item.title || "",
            sku: item.sku || "",
            barcode: item.barcode || "",
            option1: item.option1 || "",
            option2: item.option2 || "",
            option3: item.option3 || "",
            plannedQty: item.quantity,
            receivedQty: item.receivedQuantity !== undefined ? item.receivedQuantity : item.quantity,
            kind: item.isExtra ? "予定外入庫" : "通常",
          }));
        });
      }
    }

      // CSV文字列を生成
      const csvContent = [headers, ...rows]
        .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
        .join("\n");

      // BOM付きUTF-8でダウンロード
      const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `入出庫履歴_${todayInShopTimezone}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      alert(`CSV出力中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // 処理完了：モーダルを閉じる
      setCsvExporting(false);
      setCsvExportProgress({ current: 0, total: 0 });
    }
  };

  // 全選択/全解除（現在のページのみ）
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredHistories.length) {
      setSelectedIds(new Set());
    } else {
      // 現在のページの全件を選択（ページネーションを超えることはない）
      setSelectedIds(new Set(filteredHistories.map((h) => h.id)));
    }
  };

  // 個別選択
  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };


  // 商品リストを取得してモーダル表示
  const openLineItemsModal = (history: TransferHistory) => {
    setModalHistory(history);
    setModalOpen(true);
    setModalLineItems([]);

    const historyId = history.id;

    const formData = new FormData();
    formData.set("transferId", historyId);
    
    fetcher.submit(formData, { method: "post" });
  };

  // fetcherのデータが更新されたら商品リストを更新
  useEffect(() => {
    if (fetcher.data && modalHistory) {
      if ('error' in fetcher.data) {
        alert(`商品リストの取得に失敗しました: ${fetcher.data.error}`);
        setModalLineItems([]);
        setModalGroupedLineItems([]);
      } else if ('lineItems' in fetcher.data) {
        const lineItems: TransferLineItem[] = Array.isArray(fetcher.data.lineItems) ? fetcher.data.lineItems : [];
        setModalLineItems(lineItems);
        // 配送単位グループ：API が groupedLineItems を返していればそれを使い、なければ lineItems から生成
        if (Array.isArray((fetcher.data as any).groupedLineItems) && (fetcher.data as any).groupedLineItems.length > 0) {
          setModalGroupedLineItems((fetcher.data as any).groupedLineItems);
        } else {
          const grouped: GroupedLineItemsEntry[] = [];
          const seen = new Set<string>();
          const order: { id: string; displayId: string; status: string }[] = [];
          for (const li of lineItems) {
            if (li.isExtra) continue;
            const key = li.shipmentId || li.shipmentDisplayId || "";
            if (key && !seen.has(key)) {
              seen.add(key);
              order.push({
                id: li.shipmentId || "",
                displayId: li.shipmentDisplayId || key,
                status: li.shipmentStatus || "",
              });
            }
          }
          for (const meta of order) {
            const items = lineItems.filter(
              (li) => !li.isExtra && (li.shipmentId === meta.id || li.shipmentDisplayId === meta.displayId)
            );
            grouped.push({ shipmentMetadata: meta, items });
          }
          const extras = lineItems.filter((li) => li.isExtra);
          if (extras.length > 0) {
            grouped.push({
              shipmentMetadata: { id: "extras", displayId: "予定外入庫", status: "" },
              items: extras,
            });
          }
          setModalGroupedLineItems(grouped);
        }
      } else {
        setModalLineItems([]);
        setModalGroupedLineItems([]);
      }
    }
  }, [fetcher.data, modalHistory]);

  const closeLineItemsModal = () => {
    setModalOpen(false);
    setModalHistory(null);
    setModalLineItems([]);
    setModalGroupedLineItems([]);
  };

  // モーダル内の商品リストをCSV出力
  const exportModalCSV = () => {
    if (!modalHistory || modalLineItems.length === 0) {
      alert("商品リストがありません");
      return;
    }

    const headers = csvColumns.map((id) => HISTORY_CSV_LABELS[id] ?? id);
    const rows: string[][] = [];
    const originName = modalHistory.originLocationName || "";
    const destName = modalHistory.destinationLocationName || "";
    const date = modalHistory.dateCreated
      ? new Date(modalHistory.dateCreated).toISOString().split("T")[0]
      : "";
    const statusLabel = STATUS_LABEL[modalHistory.status] || modalHistory.status;
    const historyName = modalHistory.name || modalHistory.id;

    const toRow = (rowObj: Record<string, string | number>) =>
      csvColumns.map((id) => String(rowObj[id] ?? ""));

    modalLineItems.forEach((item) => {
      const shipmentStatusLabel = item.shipmentStatus ? (STATUS_LABEL[item.shipmentStatus] || item.shipmentStatus) : "";
      rows.push(toRow({
        historyId: modalHistory.id,
        name: historyName,
        date,
        origin: originName,
        destination: destName,
        status: statusLabel,
        shipmentId: item.shipmentDisplayId || "",
        shipmentStatus: shipmentStatusLabel,
        productTitle: item.title || "",
        sku: item.sku || "",
        barcode: item.barcode || "",
        option1: item.option1 || "",
        option2: item.option2 || "",
        option3: item.option3 || "",
        plannedQty: item.quantity ?? "-",
        receivedQty: item.receivedQuantity !== undefined ? item.receivedQuantity : item.quantity,
        kind: item.isExtra ? "予定外入庫" : "通常",
      }));
    });

    // CSV文字列を生成
    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    // BOM付きUTF-8でダウンロード
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // ファイル名用：表示名（#T0000など）を優先し、ファイル名に使えない文字のみ置換
    const safeFileName = String(historyName).replace(/[\\/:*?"<>|\s]/g, "_").trim() || "item";
    link.download = `入出庫履歴_${safeFileName}_${todayInShopTimezone}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };


  return (
    <s-page heading="入出庫履歴">
      <s-scroll-box padding="base">
        <s-stack gap="base">
            <s-box padding="base">
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
                        入出庫履歴
                      </div>
                      <s-text tone="subdued" size="small">
                        条件で絞り込みを行い、入出庫履歴を表示します。
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
                          ロケーション・ステータスを選ぶと一覧が絞り込まれます。
                        </s-text>
                        <s-divider />
                        <s-text emphasis="bold" size="small">出庫ロケーション</s-text>
                        <div style={{ maxHeight: "160px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                          <div onClick={() => setOutboundLocationFilters(new Set())} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: outboundLocationFilters.size === 0 ? "#eff6ff" : "transparent", border: outboundLocationFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent", display: "flex", alignItems: "center", gap: "8px" }}>
                            <input type="checkbox" checked={outboundLocationFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: outboundLocationFilters.size === 0 ? 600 : 500 }}>全て</span>
                          </div>
                          {locations.map((loc) => {
                            const isSelected = outboundLocationFilters.has(loc.id);
                            return (
                              <div
                                key={loc.id}
                                onClick={() => {
                                  const newFilters = new Set(outboundLocationFilters);
                                  if (isSelected) newFilters.delete(loc.id);
                                  else newFilters.add(loc.id);
                                  setOutboundLocationFilters(newFilters);
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
                        <s-text emphasis="bold" size="small">入庫ロケーション</s-text>
                        <div style={{ maxHeight: "160px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                          <div onClick={() => setInboundLocationFilters(new Set())} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: inboundLocationFilters.size === 0 ? "#eff6ff" : "transparent", border: inboundLocationFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent", display: "flex", alignItems: "center", gap: "8px" }}>
                            <input type="checkbox" checked={inboundLocationFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: inboundLocationFilters.size === 0 ? 600 : 500 }}>全て</span>
                          </div>
                          {locations.map((loc) => {
                            const isSelected = inboundLocationFilters.has(loc.id);
                            return (
                              <div key={loc.id} onClick={() => { const newFilters = new Set(inboundLocationFilters); if (isSelected) newFilters.delete(loc.id); else newFilters.add(loc.id); setInboundLocationFilters(newFilters); }} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: isSelected ? "#eff6ff" : "transparent", border: isSelected ? "1px solid #2563eb" : "1px solid transparent", marginTop: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
                                <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                                <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                              </div>
                            );
                          })}
                        </div>
                        <s-text emphasis="bold" size="small">ステータス</s-text>
                        <div style={{ maxHeight: "160px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                          <div onClick={() => setStatusFilters(new Set())} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: statusFilters.size === 0 ? "#eff6ff" : "transparent", border: statusFilters.size === 0 ? "1px solid #2563eb" : "1px solid transparent", display: "flex", alignItems: "center", gap: "8px" }}>
                            <input type="checkbox" checked={statusFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: statusFilters.size === 0 ? 600 : 500 }}>全て</span>
                          </div>
                          {statuses.map((status) => {
                            const statusLabel = STATUS_LABEL[status] || status;
                            const isSelected = statusFilters.has(status);
                            return (
                              <div key={status} onClick={() => { const newFilters = new Set(statusFilters); if (isSelected) newFilters.delete(status); else newFilters.add(status); setStatusFilters(newFilters); }} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: isSelected ? "#eff6ff" : "transparent", border: isSelected ? "1px solid #2563eb" : "1px solid transparent", marginTop: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
                                <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                                <span style={{ fontWeight: isSelected ? 600 : 500 }}>{statusLabel}</span>
                              </div>
                            );
                          })}
                        </div>
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
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      <s-text tone="subdued" size="small">
                        {rangeDisplay} / {totalDisplay}
                      </s-text>
                      {(pageInfo.hasPreviousPage || pageInfo.hasNextPage) && (
                        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                          <s-button
                            onClick={() => {
                              if (pageInfo.hasPreviousPage && pageInfo.startCursor) {
                                setSearchParams(
                                  (prev) => {
                                    const next = new URLSearchParams(prev);
                                    next.set("cursor", pageInfo.startCursor!);
                                    next.set("direction", "prev");
                                    if (total != null) next.set("total", String(total));
                                    return next;
                                  },
                                  { replace: true }
                                );
                              }
                            }}
                            disabled={!pageInfo.hasPreviousPage}
                          >
                            前へ
                          </s-button>
                          <span style={{ fontSize: "14px", color: "#666", lineHeight: "1.5", display: "inline-block" }}>
                            {pageDisplay}
                          </span>
                          <s-button
                            onClick={() => {
                              if (pageInfo.hasNextPage && pageInfo.endCursor) {
                                setSearchParams(
                                  (prev) => {
                                    const next = new URLSearchParams(prev);
                                    next.set("cursor", pageInfo.endCursor!);
                                    next.set("direction", "next");
                                    if (total != null) next.set("total", String(total));
                                    return next;
                                  },
                                  { replace: true }
                                );
                              }
                            }}
                            disabled={!pageInfo.hasNextPage}
                          >
                            次へ
                          </s-button>
                        </div>
                      )}
                    </div>
                    {filteredHistories.length === 0 ? (
            <s-box padding="base">
              <s-text tone="subdued">履歴がありません</s-text>
            </s-box>
          ) : (
            <s-stack gap="none">
              {filteredHistories.map((history) => {
                const isSelected = selectedIds.has(history.id);
                const locationName =
                  history.type === "outbound"
                    ? history.originLocationName
                    : history.destinationLocationName;
                const date = history.dateCreated
                  ? new Date(history.dateCreated).toISOString().split("T")[0]
                  : "";
                const originName =
                  history.type === "outbound"
                    ? history.originLocationName
                    : history.destinationLocationName;
                const destName =
                  history.type === "outbound"
                    ? history.destinationLocationName
                    : history.originLocationName;

                return (
                  <div key={history.id}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        padding: "12px",
                        cursor: "pointer",
                      }}
                      onClick={() => openLineItemsModal(history)}
                    >
                      {/* 調整中: チェックボックスを一時的に非表示 */}
                      {/* <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleSelect(history.id);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ width: "18px", height: "18px", cursor: "pointer", marginRight: "12px", marginTop: "2px" }}
                      /> */}
                      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <s-text emphasis="bold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {history.name || history.id}
                          </s-text>
                          <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", marginLeft: "8px" }}>
                            {date}
                          </s-text>
                        </div>
                        <div style={{ marginBottom: "2px" }}>
                          <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                            出庫元: {originName}
                          </s-text>
                        </div>
                        <div>
                          <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                            入庫先: {destName}
                          </s-text>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                          <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                            <span style={getStatusBadgeStyle(history.status)}>{STATUS_LABEL[history.status] || history.status}</span>
                            {(() => {
                              const extrasCount = extractExtrasCountFromNote(history.note || "");
                              if (extrasCount > 0) {
                                return (
                                  <span style={{ color: "#d32f2f", fontSize: "12px" }}>
                                    （予定外: {extrasCount}件）
                                  </span>
                                );
                              }
                              return null;
                            })()}
                          </s-text>
                          <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap" }}>
                            {history.receivedQuantity}/{history.totalQuantity}
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
      {/* CSV出力処理中モーダル */}
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
          <div
            style={{
              backgroundColor: "white",
              borderRadius: "8px",
              padding: "24px",
              minWidth: "300px",
              maxWidth: "90%",
              boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
            }}
          >
            <div style={{ marginBottom: "16px", textAlign: "center" }}>
              <h3 style={{ margin: 0, fontSize: "18px", fontWeight: "bold", marginBottom: "8px" }}>
                CSV出力処理中
              </h3>
              <div style={{ fontSize: "14px", color: "#666", marginBottom: "16px" }}>
                {csvExportProgress.total > 0
                  ? `${csvExportProgress.current}/${csvExportProgress.total}件の履歴から商品明細を取得中...`
                  : "商品明細を取得中..."}
              </div>
              <div style={{ width: "100%", height: "8px", backgroundColor: "#e0e0e0", borderRadius: "4px", overflow: "hidden" }}>
                <div
                  style={{
                    width: csvExportProgress.total > 0
                      ? `${(csvExportProgress.current / csvExportProgress.total) * 100}%`
                      : "0%",
                    height: "100%",
                    backgroundColor: "#007bff",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
            <div style={{ textAlign: "center", fontSize: "12px", color: "#999" }}>
              処理が完了すると自動的にダウンロードが開始されます
            </div>
          </div>
        </div>
      )}

      {/* 商品リストモーダル */}
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
          onClick={closeLineItemsModal}
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
              <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "bold" }}>
                商品リスト
              </h2>
              <button
                onClick={closeLineItemsModal}
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

            {modalHistory && (
              <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>履歴ID:</strong> {modalHistory.id}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>名称:</strong> {modalHistory.name || modalHistory.id}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>日付:</strong> {modalHistory.dateCreated ? new Date(modalHistory.dateCreated).toISOString().split("T")[0] : ""}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>出庫元:</strong> {modalHistory.originLocationName || "-"}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>入庫先:</strong> {modalHistory.destinationLocationName || "-"}
                </div>
                {(() => {
                  const fd = fetcher.data as { transferId?: string; transferTracking?: { company?: string; trackingNumber?: string; arrivesAt?: string } } | undefined;
                  const tr = fd?.transferId === modalHistory.id ? fd?.transferTracking : null;
                  return (
                    <>
                      <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                        <strong>配送業者:</strong> {tr?.company || "-"}
                      </div>
                      <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                        <strong>配送番号:</strong> {tr?.trackingNumber || "-"}
                      </div>
                      <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                        <strong>予定日:</strong>{" "}
                        {tr?.arrivesAt ? new Date(tr.arrivesAt).toISOString().split("T")[0] : "-"}
                      </div>
                    </>
                  );
                })()}
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>ステータス:</strong>{" "}
                  <span style={getStatusBadgeStyle(modalHistory.status)}>{STATUS_LABEL[modalHistory.status] || modalHistory.status}</span>
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>数量:</strong> {modalHistory.receivedQuantity}/{modalHistory.totalQuantity}
                </div>
                {modalGroupedLineItems.length > 0 && (
                  <div style={{ fontSize: "14px", marginTop: "8px" }}>
                    <strong>進捗状況:</strong>
                    <div style={{ marginTop: "4px", marginLeft: "16px" }}>
                      {modalGroupedLineItems.map((grp) => {
                        if (grp.shipmentMetadata.id === "extras") {
                          return (
                            <div key="extras" style={{ fontSize: "13px", color: "#666" }}>
                              {grp.shipmentMetadata.displayId}: {grp.items.length}件
                            </div>
                          );
                        }
                        const isReceived =
                          grp.shipmentMetadata.status === "RECEIVED" ||
                          grp.shipmentMetadata.status === "TRANSFERRED";
                        const statusLabel = STATUS_LABEL[grp.shipmentMetadata.status] || grp.shipmentMetadata.status || "未入庫";
                        const displayStatus = isReceived ? "入庫済み" : statusLabel;
                        const totalQty = grp.items.reduce((s, it) => s + (it.quantity ?? 0), 0);
                        const receivedQty = grp.items.reduce((s, it) => s + (it.receivedQuantity ?? 0), 0);
                        return (
                          <div
                            key={grp.shipmentMetadata.id}
                            style={{
                              fontSize: "13px",
                              color: isReceived ? "#28a745" : "#ffc107",
                            }}
                          >
                            {grp.shipmentMetadata.displayId}: {displayStatus}
                            {(totalQty > 0 || receivedQty > 0) && (
                              <span style={{ marginLeft: "8px", color: "#666" }}>
                                （{receivedQty}/{totalQty > 0 ? totalQty : "-"}）
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {fetcher.state === "submitting" || fetcher.state === "loading" ? (
              <div style={{ padding: "24px", textAlign: "center" }}>
                <div>商品リストを取得中...</div>
              </div>
            ) : modalGroupedLineItems.length > 0 || modalLineItems.length > 0 ? (
              <div>
                <div style={{ marginBottom: "12px", fontSize: "14px", color: "#666" }}>
                  合計: {modalLineItems.length}件
                  {modalGroupedLineItems.length > 1 && (
                    <span style={{ marginLeft: "8px" }}>
                      配送: {modalGroupedLineItems.filter((g) => g.shipmentMetadata.id !== "extras").length}件
                    </span>
                  )}
                </div>
                <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                  {modalGroupedLineItems.length > 0 ? (
                    modalGroupedLineItems.map((grp) => {
                      const isExtras = grp.shipmentMetadata.id === "extras";
                      const isReceived =
                        !isExtras &&
                        (grp.shipmentMetadata.status === "RECEIVED" ||
                          grp.shipmentMetadata.status === "TRANSFERRED");
                      const statusLabel = STATUS_LABEL[grp.shipmentMetadata.status] || grp.shipmentMetadata.status || "";
                      const titleLabel = isExtras
                        ? grp.shipmentMetadata.displayId
                        : `${grp.shipmentMetadata.displayId}（${statusLabel || "未入庫"}）`;
                      const totalQty = grp.items.reduce((s, it) => s + (it.quantity ?? 0), 0);
                      const receivedQty = grp.items.reduce((s, it) => s + (it.receivedQuantity ?? 0), 0);
                      const blockBg = isExtras ? "#fff5f5" : isReceived ? "#f0f8f0" : "#fff8f0";
                      const titleColor = isExtras ? "#666" : isReceived ? "#28a745" : "#ffc107";
                      return (
                        <div
                          key={grp.shipmentMetadata.id || grp.shipmentMetadata.displayId}
                          style={{
                            marginBottom: "24px",
                            padding: "12px",
                            backgroundColor: blockBg,
                            borderRadius: "4px",
                          }}
                        >
                          <div
                            style={{
                              marginBottom: "8px",
                              fontSize: "14px",
                              fontWeight: "bold",
                              color: titleColor,
                            }}
                          >
                            {titleLabel}
                            {grp.items.length > 0 && !isExtras && (
                              <span style={{ fontSize: "12px", fontWeight: "normal", marginLeft: "8px", color: "#666" }}>
                                （{receivedQty}/{totalQty > 0 ? totalQty : "-"}）
                              </span>
                            )}
                          </div>
                          {grp.items.length > 0 ? (
                            <table
                              style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                fontSize: "14px",
                                backgroundColor: "transparent",
                              }}
                            >
                              <thead>
                                <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                                  <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>商品名</th>
                                  <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>SKU</th>
                                  <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>JAN</th>
                                  <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション1</th>
                                  <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション2</th>
                                  <th style={{ padding: "8px", textAlign: "left", borderRight: "1px solid #ddd" }}>オプション3</th>
                                  <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>予定数</th>
                                  <th style={{ padding: "8px", textAlign: "right" }}>入庫数</th>
                                </tr>
                              </thead>
                              <tbody>
                                {grp.items.map((item, idx) => (
                                  <tr
                                    key={item.id || idx}
                                    style={{
                                      borderBottom: "1px solid #eee",
                                      backgroundColor: item.isExtra ? "#ffe6e6" : "transparent",
                                    }}
                                  >
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {item.title || "（商品名なし）"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {item.sku || "（SKUなし）"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {item.barcode || "（JANなし）"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {item.option1 || "-"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {item.option2 || "-"}
                                    </td>
                                    <td style={{ padding: "8px", borderRight: "1px solid #eee" }}>
                                      {item.option3 || "-"}
                                    </td>
                                    <td style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #eee" }}>
                                      {item.quantity ?? "-"}
                                    </td>
                                    <td style={{ padding: "8px", textAlign: "right" }}>
                                      {item.receivedQuantity !== undefined ? item.receivedQuantity : item.quantity}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <div style={{ padding: "12px", color: "#666", fontSize: "14px" }}>
                              この配送には商品がありません
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                      <thead>
                        <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ddd" }}>
                          <th style={{ padding: "8px", textAlign: "left" }}>配送ID</th>
                          <th style={{ padding: "8px", textAlign: "left" }}>配送ステータス</th>
                          <th style={{ padding: "8px", textAlign: "left" }}>商品名</th>
                          <th style={{ padding: "8px", textAlign: "left" }}>SKU</th>
                          <th style={{ padding: "8px", textAlign: "left" }}>JAN</th>
                          <th style={{ padding: "8px", textAlign: "left" }}>オプション1</th>
                          <th style={{ padding: "8px", textAlign: "left" }}>オプション2</th>
                          <th style={{ padding: "8px", textAlign: "left" }}>オプション3</th>
                          <th style={{ padding: "8px", textAlign: "right" }}>予定数</th>
                          <th style={{ padding: "8px", textAlign: "right" }}>入庫数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {modalLineItems.map((item, idx) => (
                          <tr key={item.id || idx} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "8px" }}>{item.shipmentDisplayId || "-"}</td>
                            <td style={{ padding: "8px" }}>
                              {item.shipmentStatus ? (STATUS_LABEL[item.shipmentStatus] || item.shipmentStatus) : "-"}
                            </td>
                            <td style={{ padding: "8px" }}>{item.title || "（商品名なし）"}</td>
                            <td style={{ padding: "8px" }}>{item.sku || "（SKUなし）"}</td>
                            <td style={{ padding: "8px" }}>{item.barcode || "（JANなし）"}</td>
                            <td style={{ padding: "8px" }}>{item.option1 || "-"}</td>
                            <td style={{ padding: "8px" }}>{item.option2 || "-"}</td>
                            <td style={{ padding: "8px" }}>{item.option3 || "-"}</td>
                            <td style={{ padding: "8px", textAlign: "right" }}>{item.quantity ?? "-"}</td>
                            <td style={{ padding: "8px", textAlign: "right" }}>
                              {item.receivedQuantity !== undefined ? item.receivedQuantity : item.quantity}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ padding: "24px", textAlign: "center", color: "#666" }}>
                商品リストがありません
              </div>
            )}

            <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              {modalLineItems.length > 0 && (
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
                onClick={closeLineItemsModal}
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
    </s-page>
  );
}
