// app/routes/app.history.tsx
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState, useMemo, useEffect } from "react";
import { authenticate } from "../shopify.server";

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

        // 予定外入庫の数量をメモから抽出
        const extrasQuantity = extractExtrasQuantityFromNote(t.note || "");
        // receivedQuantityに予定外入庫の数量を加算
        const receivedQuantityWithExtras = (t.receivedQuantity ?? 0) + extrasQuantity;

        // 出庫履歴（originLocationIdがある場合）
        if (originId) {
          return {
            id: t.id,
            name: t.name || "",
            status: t.status || "",
            note: t.note || "",
            dateCreated: t.dateCreated || "",
            totalQuantity: t.totalQuantity ?? 0,
            receivedQuantity: receivedQuantityWithExtras,
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
            receivedQuantity: receivedQuantityWithExtras,
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

    return {
      locations,
      histories: allHistories,
      pageInfo: {
        hasNextPage: pageInfo.hasNextPage || false,
        hasPreviousPage: pageInfo.hasPreviousPage || false,
        startCursor: pageInfo.startCursor || null,
        endCursor: pageInfo.endCursor || null,
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
    // 既存の動作コード（Modal.jsx）を参考に、inventoryTransfer.lineItemsから取得
    // ただし、variant情報は取得できないため、shipments経由で取得する必要がある可能性がある
    // まずはinventoryTransfer.lineItemsから取得を試みる
    const resp = await admin.graphql(
      `#graphql
        query TransferLineItems($id: ID!) {
          inventoryTransfer(id: $id) {
            id
            note
            shipments(first: 50) {
              nodes {
                id
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

    // デバッグログ: レスポンス構造を確認
    console.log("Action - GraphQL response data:", JSON.stringify(data, null, 2));
    console.log("Action - transfer:", transfer);
    console.log("Action - transfer.shipments:", transfer?.shipments);
    console.log("Action - transfer.shipments.nodes:", transfer?.shipments?.nodes);

    if (!transfer) {
      return { error: "Transfer not found" };
    }

    // lineItemsを集約（shipments経由で取得 - 既存の動作コードに準拠）
    const lineItems: TransferLineItem[] = [];
    
    if (Array.isArray(transfer?.shipments?.nodes)) {
      console.log(`Action - Found ${transfer.shipments.nodes.length} shipments`);
      transfer.shipments.nodes.forEach((shipment: any, shipmentIdx: number) => {
        console.log(`Action - Shipment ${shipmentIdx}:`, shipment);
        
        if (Array.isArray(shipment?.lineItems?.nodes)) {
          console.log(`Action - Shipment ${shipmentIdx} has ${shipment.lineItems.nodes.length} lineItems`);
          shipment.lineItems.nodes.forEach((li: any, liIdx: number) => {
            console.log(`Action - LineItem ${shipmentIdx}-${liIdx}:`, li);
            const inventoryItem = li?.inventoryItem;
            const variant = inventoryItem?.variant;
            const product = variant?.product;

            // オプションを取得（selectedOptionsから正しく取得）
            const selectedOptions = Array.isArray(variant?.selectedOptions) ? variant.selectedOptions : [];
            const option1 = selectedOptions[0]?.value || "";
            const option2 = selectedOptions[1]?.value || "";
            const option3 = selectedOptions[2]?.value || "";

            // titleはvariantから取得（既存の動作コードに準拠）
            const productTitle = String(product?.title || "").trim();
            const variantTitle = String(variant?.title || "").trim();
            const title = productTitle && variantTitle
              ? `${productTitle} / ${variantTitle}`
              : (variantTitle || productTitle || variant?.sku || inventoryItem?.id || "(unknown)");

            // skuはvariant.skuを優先、なければinventoryItem.skuを使用
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
              quantity: li.quantity ?? 0, // 予定数
              receivedQuantity: li.acceptedQuantity ?? li.quantity ?? 0, // 実際の入庫数（acceptedQuantity、なければquantity）
            });
          });
        } else {
          console.warn(`Action - Shipment ${shipmentIdx} has no lineItems.nodes or it's not an array`);
        }
      });
    } else {
      console.warn("Action - No shipments found or shipments.nodes is not an array");
      console.warn("Action - transfer.shipments:", transfer?.shipments);
      console.warn("Action - transfer structure:", Object.keys(transfer || {}));
    }
    
    // 予定外入庫をメモ（note）から抽出
    const extrasItems: TransferLineItem[] = [];
    const note = transfer?.note || "";
    if (note) {
      console.log("Action - Parsing note for extras:", note);
      
      // メモから「予定外入庫: X件」のセクションを抽出
      // パターン: "予定外入庫: X件" の後に続く行（"  - "で始まる行）を取得
      const extrasSectionMatch = note.match(/予定外入庫:\s*(\d+)件\s*\n((?:  - .+(?:\n|$))+)/);
      if (extrasSectionMatch) {
        const extrasCount = parseInt(extrasSectionMatch[1] || "0", 10);
        const extrasLines = extrasSectionMatch[2] || "";
        
        console.log(`Action - Found ${extrasCount} extras in note`);
        
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
              
              console.log(`Action - Parsed extra item ${idx}:`, { title, sku, barcode, qty, options });
            }
          } else {
            console.warn(`Action - Failed to parse extra line: ${line}`);
          }
        });
      } else {
        console.log("Action - No extras section found in note");
      }
    }
    
    console.log(`Action - Found ${extrasItems.length} extras from note`);
    console.log(`Action - Total lineItems collected: ${lineItems.length}`);
    
    // 予定外入庫をlineItemsに追加
    lineItems.push(...extrasItems);
    
    console.log("Action - Final lineItems:", lineItems);

    // React Router v7では、オブジェクトを直接返すと自動的にJSONレスポンスに変換される
    return { transferId, lineItems };
  } catch (error) {
    console.error("Line items action error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Line items action error details:", errorMessage);
    return { error: `Failed to load line items: ${errorMessage}` };
  }
}

export default function HistoryPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { locations, histories, pageInfo } = loaderData || {
    locations: [],
    histories: [],
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
  const fetcher = useFetcher<typeof action>();
  const [searchParams] = useSearchParams();
  
  // 全件数の表示（次ページがある場合は「以上」を表示）
  const estimatedTotal = pageInfo.hasNextPage 
    ? `${histories.length}件以上` 
    : `${histories.length}件`;
  
  // ページ番号の計算（簡易版）
  const currentPageNum = searchParams.get("cursor") 
    ? (searchParams.get("direction") === "prev" ? 2 : 2) // 簡易的な計算
    : 1;
  const pageDisplay = pageInfo.hasPreviousPage || pageInfo.hasNextPage
    ? pageInfo.hasPreviousPage && !pageInfo.hasNextPage
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

  // フィルター状態（複数選択対応）
  const [outboundLocationFilters, setOutboundLocationFilters] = useState<Set<string>>(new Set());
  const [inboundLocationFilters, setInboundLocationFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 商品リストモーダル状態
  const [modalOpen, setModalOpen] = useState(false);
  const [modalHistory, setModalHistory] = useState<TransferHistory | null>(null);
  const [modalLineItems, setModalLineItems] = useState<TransferLineItem[]>([]);

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
      // CSVヘッダー（商品明細まで含める）
      const headers = [
        "履歴ID",
        "名称",
        "日付",
        "出庫元",
        "入庫先",
        "ステータス",
        "商品名",
        "SKU",
        "JAN",
        "オプション1",
        "オプション2",
        "オプション3",
        "数量",
      ];

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
        console.log(`CSV export - Fetching line items for transferId: ${h.id}`);
        
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
          console.log(`CSV export - line items response for ${h.id}:`, fetcher.data);
          console.log(`CSV export - line items response type:`, typeof fetcher.data);
          console.log(`CSV export - line items response keys:`, Object.keys(fetcher.data || {}));
          console.log(`CSV export - fetcher.data.transferId:`, (fetcher.data as any)?.transferId);
          console.log(`CSV export - expected transferId:`, h.id);
          
          // transferIdが一致することを確認（transferIdがある場合のみ）
          // ただし、transferIdがない場合は、lineItemsの存在を確認（モーダルと同じ方法）
          const currentTransferId = (fetcher.data as any)?.transferId;
          if (currentTransferId && currentTransferId !== h.id) {
            console.error(`CSV export - TransferId mismatch! Expected: ${h.id}, Got: ${currentTransferId}`);
            console.error(`CSV export - This may be data from a previous request. Skipping...`);
            // transferIdが一致しない場合は、空のlineItemsを使用
            lineItems = [];
          } else if ('error' in fetcher.data) {
            console.error(`CSV export - Error response for ${h.id}:`, fetcher.data.error);
            // エラー時も続行（商品明細なしで履歴情報のみ出力）
            lineItems = [];
          } else if ('lineItems' in fetcher.data) {
            lineItems = Array.isArray(fetcher.data.lineItems) ? fetcher.data.lineItems : [];
            console.log(`CSV export - Final lineItems length for ${h.id}:`, lineItems.length);
            
            if (lineItems.length === 0) {
              console.warn(`CSV export - No line items found for ${h.id}`);
              console.warn(`CSV export - Full response data:`, JSON.stringify(fetcher.data, null, 2));
            }
          } else {
            console.warn(`CSV export - Unexpected response format for ${h.id}:`, fetcher.data);
            lineItems = [];
          }
        } else {
          console.warn(`CSV export - No data received for ${h.id} (timeout or no response)`);
          console.warn(`CSV export - fetcher.state:`, fetcher.state);
          console.warn(`CSV export - fetcher.data:`, fetcher.data);
          console.warn(`CSV export - previousTransferId:`, previousTransferId);
          lineItems = [];
        }
      } catch (error) {
        console.error(`CSV export - Error fetching line items for ${h.id}:`, error);
        console.error(`CSV export - Error details:`, error instanceof Error ? error.message : String(error));
        // エラー時も続行（商品明細なしで履歴情報のみ出力）
      }

      const originName = h.originLocationName || "";
      const destName = h.destinationLocationName || "";
      const historyName = h.name || h.id;

      if (lineItems.length === 0) {
        // 商品明細がない場合は履歴情報のみ
        rows.push([
          h.id,
          historyName,
          date,
          originName,
          destName,
          statusLabel,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ]);
      } else {
        // 商品明細を展開
        lineItems.forEach((item) => {
          rows.push([
            h.id,
            historyName,
            date,
            originName,
            destName,
            statusLabel,
            item.title || "",
            item.sku || "",
            item.barcode || "",
            item.option1 || "",
            item.option2 || "",
            item.option3 || "",
            String(item.quantity),
          ]);
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
      link.download = `入出庫履歴_${new Date().toISOString().split("T")[0]}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("CSV export error:", error);
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
    console.log(`[検証] 商品リスト取得開始 - transferId: ${historyId}`);
    
    const formData = new FormData();
    formData.set("transferId", historyId);
    
    fetcher.submit(formData, { method: "post" });
  };

  // fetcherのデータが更新されたら商品リストを更新
  useEffect(() => {
    if (fetcher.data && modalHistory) {
      console.log(`[検証] fetcher.data受信:`, fetcher.data);
      console.log(`[検証] fetcher.dataの型:`, typeof fetcher.data);
      console.log(`[検証] fetcher.dataのキー:`, Object.keys(fetcher.data || {}));
      
      if ('error' in fetcher.data) {
        console.error(`[検証] エラーレスポンス:`, fetcher.data.error);
        alert(`商品リストの取得に失敗しました: ${fetcher.data.error}`);
        setModalLineItems([]);
      } else if ('lineItems' in fetcher.data) {
        const lineItems: TransferLineItem[] = Array.isArray(fetcher.data.lineItems) ? fetcher.data.lineItems : [];
        console.log(`[検証] 最終的なlineItemsの長さ: ${lineItems.length}`);
        console.log(`[検証] 最終的なlineItems:`, lineItems);
        setModalLineItems(lineItems);
        
        if (lineItems.length > 0) {
          console.log(`[検証] 商品リストを表示します - ${lineItems.length}件`);
        } else {
          console.warn(`[検証] 商品リストが空です`);
          console.warn(`[検証] 完全なレスポンスデータ:`, JSON.stringify(fetcher.data, null, 2));
        }
      } else {
        console.warn(`[検証] 予期しないレスポンス形式:`, fetcher.data);
        setModalLineItems([]);
      }
    }
  }, [fetcher.data, modalHistory]);

  const closeLineItemsModal = () => {
    setModalOpen(false);
    setModalHistory(null);
    setModalLineItems([]);
  };

  // モーダル内の商品リストをCSV出力
  const exportModalCSV = () => {
    if (!modalHistory || modalLineItems.length === 0) {
      alert("商品リストがありません");
      return;
    }

    // CSVヘッダー
    const headers = [
      "履歴ID",
      "名称",
      "日付",
      "出庫元",
      "入庫先",
      "ステータス",
      "商品名",
      "SKU",
      "JAN",
      "オプション1",
      "オプション2",
      "オプション3",
      "予定数",
      "入庫数",
      "種別",
    ];

    // CSVデータ
    const rows: string[][] = [];
    const originName = modalHistory.originLocationName || "";
    const destName = modalHistory.destinationLocationName || "";
    const date = modalHistory.dateCreated
      ? new Date(modalHistory.dateCreated).toISOString().split("T")[0]
      : "";
    const statusLabel = STATUS_LABEL[modalHistory.status] || modalHistory.status;
    const historyName = modalHistory.name || modalHistory.id;

    modalLineItems.forEach((item) => {
      rows.push([
        modalHistory.id,
        historyName,
        date,
        originName,
        destName,
        statusLabel,
        item.title || "",
        item.sku || "",
        item.barcode || "",
        item.option1 || "",
        item.option2 || "",
        item.option3 || "",
        String(item.quantity || "-"),
        String(item.receivedQuantity !== undefined ? item.receivedQuantity : item.quantity),
        item.isExtra ? "予定外入庫" : "通常",
      ]);
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
    // ファイル名用に特殊文字を置換
    const safeFileName = historyName.replace(/[^a-zA-Z0-9]/g, "_");
    link.download = `入出庫履歴_${safeFileName}_${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };


  return (
    <s-page heading="入出庫履歴">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          <s-section heading="入出庫履歴">
            <s-box padding="base">
              <div style={{ display: "flex", gap: "24px", alignItems: "flex-start" }}>
                <div style={{ flex: "0 0 260px" }}>
                  <s-stack gap="base">
                    <s-text emphasis="bold" size="large">フィルター</s-text>
                    <s-text tone="subdued" size="small">
                      ロケーション・ステータスを選ぶと一覧が絞り込まれます。未選択＝全て表示。
                    </s-text>
                    <s-divider />
                    <s-text emphasis="bold" size="small">出庫ロケーション</s-text>
                    <div style={{ maxHeight: "160px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                      <div onClick={() => setOutboundLocationFilters(new Set())} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: outboundLocationFilters.size === 0 ? "#f0f9f7" : "transparent", border: outboundLocationFilters.size === 0 ? "1px solid #008060" : "1px solid transparent", display: "flex", alignItems: "center", gap: "8px" }}>
                        <input type="checkbox" checked={outboundLocationFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                        <span style={{ fontWeight: outboundLocationFilters.size === 0 ? 600 : 500 }}>全て</span>
                      </div>
                      {locations.map((loc) => {
                        const isSelected = outboundLocationFilters.has(loc.id);
                        return (
                          <div key={loc.id} onClick={() => { const newFilters = new Set(outboundLocationFilters); if (isSelected) newFilters.delete(loc.id); else newFilters.add(loc.id); setOutboundLocationFilters(newFilters); }} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: isSelected ? "#f0f9f7" : "transparent", border: isSelected ? "1px solid #008060" : "1px solid transparent", marginTop: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
                            <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                          </div>
                        );
                      })}
                    </div>
                    <s-text emphasis="bold" size="small">入庫ロケーション</s-text>
                    <div style={{ maxHeight: "160px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                      <div onClick={() => setInboundLocationFilters(new Set())} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: inboundLocationFilters.size === 0 ? "#f0f9f7" : "transparent", border: inboundLocationFilters.size === 0 ? "1px solid #008060" : "1px solid transparent", display: "flex", alignItems: "center", gap: "8px" }}>
                        <input type="checkbox" checked={inboundLocationFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                        <span style={{ fontWeight: inboundLocationFilters.size === 0 ? 600 : 500 }}>全て</span>
                      </div>
                      {locations.map((loc) => {
                        const isSelected = inboundLocationFilters.has(loc.id);
                        return (
                          <div key={loc.id} onClick={() => { const newFilters = new Set(inboundLocationFilters); if (isSelected) newFilters.delete(loc.id); else newFilters.add(loc.id); setInboundLocationFilters(newFilters); }} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: isSelected ? "#f0f9f7" : "transparent", border: isSelected ? "1px solid #008060" : "1px solid transparent", marginTop: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
                            <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{loc.name}</span>
                          </div>
                        );
                      })}
                    </div>
                    <s-text emphasis="bold" size="small">ステータス</s-text>
                    <div style={{ maxHeight: "160px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                      <div onClick={() => setStatusFilters(new Set())} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: statusFilters.size === 0 ? "#f0f9f7" : "transparent", border: statusFilters.size === 0 ? "1px solid #008060" : "1px solid transparent", display: "flex", alignItems: "center", gap: "8px" }}>
                        <input type="checkbox" checked={statusFilters.size === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                        <span style={{ fontWeight: statusFilters.size === 0 ? 600 : 500 }}>全て</span>
                      </div>
                      {statuses.map((status) => {
                        const statusLabel = STATUS_LABEL[status] || status;
                        const isSelected = statusFilters.has(status);
                        return (
                          <div key={status} onClick={() => { const newFilters = new Set(statusFilters); if (isSelected) newFilters.delete(status); else newFilters.add(status); setStatusFilters(newFilters); }} style={{ padding: "10px 12px", borderRadius: "6px", cursor: "pointer", backgroundColor: isSelected ? "#f0f9f7" : "transparent", border: isSelected ? "1px solid #008060" : "1px solid transparent", marginTop: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
                            <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: isSelected ? 600 : 500 }}>{statusLabel}</span>
                          </div>
                        );
                      })}
                    </div>
                  </s-stack>
                </div>
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <s-stack gap="base">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      <s-text tone="subdued" size="small">
                        表示: {filteredHistories.length}件 / 全{estimatedTotal}
                      </s-text>
                      {(pageInfo.hasPreviousPage || pageInfo.hasNextPage) && (
                        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                          <s-button
                            onClick={() => {
                              if (pageInfo.hasPreviousPage && pageInfo.startCursor) {
                                const url = new URL(window.location.href);
                                url.searchParams.set("cursor", pageInfo.startCursor);
                                url.searchParams.set("direction", "prev");
                                window.location.href = url.toString();
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
                                const url = new URL(window.location.href);
                                url.searchParams.set("cursor", pageInfo.endCursor);
                                url.searchParams.set("direction", "next");
                                window.location.href = url.toString();
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
                            状態: {STATUS_LABEL[history.status] || history.status}
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
            </s-box>
          </s-section>

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
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>ステータス:</strong> {STATUS_LABEL[modalHistory.status] || modalHistory.status}
                </div>
                <div style={{ fontSize: "14px" }}>
                  <strong>数量:</strong> {modalHistory.receivedQuantity}/{modalHistory.totalQuantity}
                </div>
              </div>
            )}

            {fetcher.state === "submitting" || fetcher.state === "loading" ? (
              <div style={{ padding: "24px", textAlign: "center" }}>
                <div>商品リストを取得中...</div>
              </div>
            ) : modalLineItems.length > 0 ? (
              <div>
                <div style={{ marginBottom: "12px", fontSize: "14px", color: "#666" }}>
                  合計: {modalLineItems.length}件
                </div>
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
                        <th style={{ padding: "8px", textAlign: "right", borderRight: "1px solid #ddd" }}>予定数</th>
                        <th style={{ padding: "8px", textAlign: "right" }}>入庫数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalLineItems.map((item, idx) => (
                        <tr key={item.id || idx} style={{ borderBottom: "1px solid #eee", backgroundColor: item.isExtra ? "#ffe6e6" : "transparent" }}>
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
                            {item.quantity || "-"}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {item.receivedQuantity !== undefined ? item.receivedQuantity : item.quantity}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
