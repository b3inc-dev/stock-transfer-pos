// app/routes/app.loss.tsx
// ロス履歴管理画面（入出庫履歴と同じデザインと機能）
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState, useMemo, useEffect } from "react";
import { authenticate } from "../shopify.server";

const LOSS_NS = "stock_transfer_pos";
const LOSS_KEY = "loss_entries_v1";

export type LocationNode = { id: string; name: string };

export type LossEntryItem = {
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
};

export type LossEntry = {
  id: string;
  lossName?: string; // #L0001形式の名称
  locationId: string;
  locationName?: string;
  date: string;
  reason: string;
  staffMemberId?: string | null;
  staffName?: string | null;
  items: LossEntryItem[];
  status: "active" | "cancelled";
  createdAt: string;
  cancelledAt?: string;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const [locResp, appResp] = await Promise.all([
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
        query LossEntries {
          currentAppInstallation {
            id
            metafield(namespace: "${LOSS_NS}", key: "${LOSS_KEY}") { value }
          }
        }
      `
    ),
  ]);

  const locData = await locResp.json();
  const appData = await appResp.json();
  const locations: LocationNode[] = locData?.data?.locations?.nodes ?? [];

  let entries: LossEntry[] = [];
  const raw = appData?.data?.currentAppInstallation?.metafield?.value;
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      entries = [];
    }
  }

  // ✅ 既存のエントリにlossNameが設定されていない場合、createdAtの順序に基づいて連番を割り当てる
  // これにより、既存のエントリにも固定の連番が割り当てられ、新しいエントリが追加されても既存のエントリの連番は変わらなくなる
  let needsUpdate = false;
  
  // 既存のエントリのlossNameから最大の連番を取得
  const existingLossNames = new Set(
    entries
      .filter((e) => e?.lossName && /^#L\d+$/.test(String(e.lossName).trim()))
      .map((e) => String(e.lossName).trim())
  );
  
  const maxExistingNum = Array.from(existingLossNames).reduce((max, name) => {
    const match = name.match(/^#L(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      return Math.max(max, num);
    }
    return max;
  }, 0);
  
  // lossNameが設定されていないエントリをcreatedAtの順序でソート
  const entriesWithoutLossName = entries
    .filter((e) => !e?.lossName || !/^#L\d+$/.test(String(e.lossName).trim()))
    .sort((a, b) => {
      const dateA = new Date(a.createdAt || a.date || 0).getTime();
      const dateB = new Date(b.createdAt || b.date || 0).getTime();
      return dateA - dateB; // 古い順
    });
  
  // lossNameが設定されていないエントリに連番を割り当てる
  const lossNameMap = new Map<string, string>();
  entriesWithoutLossName.forEach((entry, index) => {
    const num = maxExistingNum + index + 1;
    const lossName = `#L${String(num).padStart(4, "0")}`;
    lossNameMap.set(entry.id, lossName);
    needsUpdate = true;
  });
  
  const entriesWithLossName = entries.map((entry) => {
    // 既にlossNameが設定されている場合はそのまま
    if (entry?.lossName && /^#L\d+$/.test(String(entry.lossName).trim())) {
      return entry;
    }
    
    // lossNameが設定されていない場合、割り当てた連番を使用
    const lossName = lossNameMap.get(entry.id);
    if (lossName) {
      return {
        ...entry,
        lossName,
      };
    }
    
    return entry;
  });

  // lossNameを割り当てたエントリがある場合、metafieldに保存する
  if (needsUpdate) {
    try {
      const appInstallationId = appData?.data?.currentAppInstallation?.id;
      if (appInstallationId) {
        await admin.graphql(
          `#graphql
            mutation SetLossEntries($metafields: [MetafieldsSetInput!]!) {
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
                  namespace: LOSS_NS,
                  key: LOSS_KEY,
                  type: "json",
                  value: JSON.stringify(entriesWithLossName),
                },
              ],
            },
          }
        );
      }
    } catch (error) {
      // エラーが発生しても処理を続行（既存のエントリのlossNameは表示時に計算される）
      console.error("Failed to update loss entries with lossName:", error);
    }
  }

  // ページネーション用の情報（metafieldは全件取得のため、クライアント側でページネーション）
  // 入出庫履歴と同じ形式で返す（ただし、metafieldは全件取得のため、pageInfoは常にfalse）
  return {
    locations,
    entries: needsUpdate ? entriesWithLossName : entries,
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const entryId = String(formData.get("entryId") || "").trim();

    if (!entryId) {
      return { error: "entryId is required" };
    }

    // ロスエントリを取得
    const appResp = await admin.graphql(
      `#graphql
        query LossEntries {
          currentAppInstallation {
            metafield(namespace: "${LOSS_NS}", key: "${LOSS_KEY}") { value }
          }
        }
      `
    );

    const appData = await appResp.json();
    const raw = appData?.data?.currentAppInstallation?.metafield?.value;
    let entries: LossEntry[] = [];
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

    // 商品明細を返す（itemsをそのまま返す）
    return { entryId, items: entry.items || [] };
  } catch (error) {
    console.error("Loss entry items action error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Failed to load items: ${errorMessage}` };
  }
}

// ロスIDから連番表示を生成（#L0001形式）
function formatLossName(entry: LossEntry, allEntries: LossEntry[], index: number): string {
  // 既にlossNameが設定されている場合はそれを使用（既存のエントリの名称を変更しない）
  if (entry?.lossName && /^#L\d+$/.test(String(entry.lossName).trim())) {
    return String(entry.lossName).trim();
  }
  // lossNameが設定されていないエントリに対してのみ、新しい連番を生成
  // 既存のエントリ（lossNameが設定されているもの）から最大の連番を取得
  // ただし、現在のエントリ自身は除外する（自分自身のlossNameを参照しない）
  const maxNum = allEntries.reduce((max, e) => {
    // 現在のエントリ自身は除外
    if (e.id === entry.id) return max;
    // lossNameが設定されているエントリのみを対象
    if (e?.lossName && /^#L(\d+)$/.test(String(e.lossName).trim())) {
      const match = String(e.lossName).trim().match(/^#L(\d+)$/);
      const num = parseInt(match?.[1] || "0", 10);
      return Math.max(max, num);
    }
    return max;
  }, 0);
  // 最大値+1を使用（index+1は使用しない。indexは表示順序であり、連番とは関係ない）
  const num = maxNum + 1;
  return `#L${String(num).padStart(4, "0")}`;
}

export default function LossPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { locations, entries, pageInfo } = loaderData || {
    locations: [],
    entries: [],
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
  const fetcher = useFetcher<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();

  // ステータスの日本語表記
  const STATUS_LABEL: Record<string, string> = {
    active: "登録済み",
    cancelled: "キャンセル済み",
  };

  // フィルター状態（複数選択対応、入出庫履歴と同じ）
  const [locationFilters, setLocationFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 商品リストモーダル状態
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEntry, setModalEntry] = useState<LossEntry | null>(null);
  const [modalItems, setModalItems] = useState<LossEntryItem[]>([]);

  // CSV出力処理中状態
  const [csvExporting, setCsvExporting] = useState(false);
  const [csvExportProgress, setCsvExportProgress] = useState({ current: 0, total: 0 });

  // フィルター適用後の履歴
  const filteredEntries = useMemo(() => {
    let filtered = entries;

    // ロケーションフィルター（複数選択対応）
    if (locationFilters.size > 0) {
      filtered = filtered.filter((e) => locationFilters.has(e.locationId));
    }

    // ステータスフィルター（複数選択対応）
    if (statusFilters.size > 0) {
      filtered = filtered.filter((e) => statusFilters.has(e.status));
    }

    return filtered.sort((a, b) => {
      const t1 = new Date(a.createdAt).getTime();
      const t2 = new Date(b.createdAt).getTime();
      return t2 - t1; // 新しい順
    });
  }, [entries, locationFilters, statusFilters]);

  // 全件数の表示（入出庫履歴と同じ形式）
  const estimatedTotal = pageInfo.hasNextPage
    ? `${filteredEntries.length}件以上`
    : `${filteredEntries.length}件`;

  // ページ番号の計算（簡易版、入出庫履歴と同じ）
  const currentPageNum = searchParams.get("cursor")
    ? searchParams.get("direction") === "prev"
      ? 2
      : 2 // 簡易的な計算
    : 1;
  const pageDisplay =
    pageInfo.hasPreviousPage || pageInfo.hasNextPage
      ? pageInfo.hasPreviousPage && !pageInfo.hasNextPage
        ? "最終ページ"
        : !pageInfo.hasPreviousPage && pageInfo.hasNextPage
        ? "1/2+"
        : "2/3+"
      : "";

  // CSV出力（商品明細まで含める、入出庫履歴と同じ）
  const exportCSV = async () => {
    if (selectedIds.size === 0) {
      alert("CSV出力する履歴を選択してください");
      return;
    }

    const selectedEntries = filteredEntries.filter((e) => selectedIds.has(e.id));

    // 処理中モーダルを表示
    setCsvExporting(true);
    setCsvExportProgress({ current: 0, total: selectedEntries.length });

    try {
      // CSVヘッダー（商品明細まで含める）
      const headers = [
        "履歴ID",
        "名称",
        "日付",
        "ロケーション",
        "理由",
        "担当者",
        "ステータス",
        "商品名",
        "SKU",
        "JAN",
        "数量",
      ];

      // CSVデータ（商品明細を展開）
      const rows: string[][] = [];

      for (let i = 0; i < selectedEntries.length; i++) {
        const e = selectedEntries[i];
        setCsvExportProgress({ current: i + 1, total: selectedEntries.length });

        const locationName = e.locationName || locations.find((l) => l.id === e.locationId)?.name || e.locationId;
        const date = e.date || (e.createdAt ? new Date(e.createdAt).toISOString().split("T")[0] : "");
        const statusLabel = STATUS_LABEL[e.status] || e.status;
        const staff = e.staffName || (e.staffMemberId ? `ID:${e.staffMemberId}` : "") || "";
        const lossName = e.lossName || formatLossName(e, entries, entries.findIndex((entry) => entry.id === e.id));

        if (e.items.length === 0) {
          // 商品明細がない場合は履歴情報のみ
          rows.push([
            e.id,
            lossName,
            date,
            locationName,
            e.reason || "",
            staff,
            statusLabel,
            "",
            "",
            "",
            "",
          ]);
        } else {
          // 商品明細を展開
          e.items.forEach((item) => {
            rows.push([
              e.id,
              lossName,
              date,
              locationName,
              e.reason || "",
              staff,
              statusLabel,
              item.title || "",
              item.sku || "",
              item.barcode || "",
              String(item.quantity || 0),
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
      link.download = `ロス履歴_${new Date().toISOString().split("T")[0]}.csv`;
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

  // 全選択/全解除
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredEntries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEntries.map((e) => e.id)));
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
  const openItemsModal = (entry: LossEntry) => {
    setModalEntry(entry);
    setModalOpen(true);
    setModalItems([]);

    const entryId = entry.id;
    console.log(`[検証] 商品リスト取得開始 - entryId: ${entryId}`);

    const formData = new FormData();
    formData.set("entryId", entryId);

    fetcher.submit(formData, { method: "post" });
  };

  // fetcherのデータが更新されたら商品リストを更新
  useEffect(() => {
    if (fetcher.data && modalEntry) {
      console.log(`[検証] fetcher.data受信:`, fetcher.data);

      if ("error" in fetcher.data) {
        console.error(`[検証] エラーレスポンス:`, fetcher.data.error);
        alert(`商品リストの取得に失敗しました: ${fetcher.data.error}`);
        setModalItems([]);
      } else if ("items" in fetcher.data) {
        const items: LossEntryItem[] = Array.isArray(fetcher.data.items) ? fetcher.data.items : [];
        console.log(`[検証] 最終的なitemsの長さ: ${items.length}`);
        setModalItems(items);
      } else {
        console.warn(`[検証] 予期しないレスポンス形式:`, fetcher.data);
        setModalItems([]);
      }
    }
  }, [fetcher.data, modalEntry]);

  const closeItemsModal = () => {
    setModalOpen(false);
    setModalEntry(null);
    setModalItems([]);
  };

  // モーダル内の商品リストをCSV出力
  const exportModalCSV = () => {
    if (!modalEntry || modalItems.length === 0) {
      alert("商品リストがありません");
      return;
    }

    // CSVヘッダー（入出庫履歴と同じ形式）
    const headers = [
      "履歴ID",
      "名称",
      "日付",
      "ロケーション",
      "理由",
      "担当者",
      "ステータス",
      "商品名",
      "SKU",
      "JAN",
      "オプション1",
      "オプション2",
      "オプション3",
      "数量",
    ];

    // CSVデータ
    const rows: string[][] = [];
    const locationName =
      modalEntry.locationName || locations.find((l) => l.id === modalEntry.locationId)?.name || modalEntry.locationId;
    const date = modalEntry.date || (modalEntry.createdAt ? new Date(modalEntry.createdAt).toISOString().split("T")[0] : "");
    const statusLabel = STATUS_LABEL[modalEntry.status] || modalEntry.status;
    const staff = modalEntry.staffName || (modalEntry.staffMemberId ? `ID:${modalEntry.staffMemberId}` : "") || "";
    const lossName =
      modalEntry.lossName || formatLossName(modalEntry, entries, entries.findIndex((e) => e.id === modalEntry.id));

    modalItems.forEach((item) => {
      rows.push([
        modalEntry.id,
        lossName,
        date,
        locationName,
        modalEntry.reason || "",
        staff,
        statusLabel,
        item.title || "",
        item.sku || "",
        item.barcode || "",
        item.option1 || "",
        item.option2 || "",
        item.option3 || "",
        String(item.quantity || 0),
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
    const safeFileName = lossName.replace(/[^a-zA-Z0-9]/g, "_");
    link.download = `ロス履歴_${safeFileName}_${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <s-page heading="ロス履歴">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          <s-section heading="ロス履歴">
            <s-box padding="base">
              <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
                {/* 左: フィルター（リスト選択で絞り込み） */}
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <s-stack gap="base">
                    <s-text emphasis="bold" size="large">フィルター</s-text>
                    <s-text tone="subdued" size="small">
                      ロケーション・ステータスを選ぶと一覧が絞り込まれます。未選択＝全て表示。
                    </s-text>
                    <s-divider />
                    <s-text emphasis="bold" size="small">ロケーション</s-text>
                    <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px" }}>
                      <div
                        onClick={() => setLocationFilters(new Set())}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "6px",
                          cursor: "pointer",
                          backgroundColor: locationFilters.size === 0 ? "#f0f9f7" : "transparent",
                          border: locationFilters.size === 0 ? "1px solid #008060" : "1px solid transparent",
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
                              if (isSelected) {
                                newFilters.delete(loc.id);
                              } else {
                                newFilters.add(loc.id);
                              }
                              setLocationFilters(newFilters);
                            }}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: isSelected ? "#f0f9f7" : "transparent",
                              border: isSelected ? "1px solid #008060" : "1px solid transparent",
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
                          backgroundColor: statusFilters.size === 0 ? "#f0f9f7" : "transparent",
                          border: statusFilters.size === 0 ? "1px solid #008060" : "1px solid transparent",
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
                              if (isSelected) {
                                newFilters.delete(status);
                              } else {
                                newFilters.add(status);
                              }
                              setStatusFilters(newFilters);
                            }}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: isSelected ? "#f0f9f7" : "transparent",
                              border: isSelected ? "1px solid #008060" : "1px solid transparent",
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
                  </s-stack>
                </div>

                {/* 右: 履歴一覧 */}
                <div style={{ flex: "1 1 400px", minWidth: 0, width: "100%" }}>
                  <s-stack gap="base">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                      <s-text tone="subdued" size="small">
                        表示: {filteredEntries.length}件 / {estimatedTotal}
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
                    {filteredEntries.length === 0 ? (
            <s-box padding="base">
              <s-text tone="subdued">履歴がありません</s-text>
            </s-box>
          ) : (
            <s-stack gap="none">
              {filteredEntries.map((entry) => {
                const isSelected = selectedIds.has(entry.id);
                const locationName =
                  entry.locationName || locations.find((l) => l.id === entry.locationId)?.name || entry.locationId;
                const date = entry.date || (entry.createdAt ? new Date(entry.createdAt).toISOString().split("T")[0] : "");
                const itemCount = entry.items?.length ?? 0;
                const totalQty = (entry.items ?? []).reduce((s, it) => s + (it.quantity || 0), 0);
                const lossName = entry.lossName || formatLossName(entry, entries, entries.findIndex((e) => e.id === entry.id));

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
                      {/* チェックボックスは非表示（仕様は残す） */}
                      {/* <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleSelect(entry.id);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          width: "18px",
                          height: "18px",
                          cursor: "pointer",
                          marginRight: "12px",
                          marginTop: "2px",
                        }}
                      /> */}
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
                            style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                          >
                            {lossName}
                          </s-text>
                          <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", marginLeft: "8px" }}>
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
                            ロケーション: {locationName}
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
                            理由: {entry.reason || "-"}
                          </s-text>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginTop: "4px",
                          }}
                        >
                          <s-text tone="subdued" size="small" style={{ whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                            状態: {STATUS_LABEL[entry.status] || entry.status}
                            {entry.cancelledAt && (
                              <span style={{ marginLeft: "8px" }}>
                                （キャンセル日時: {new Date(entry.cancelledAt).toISOString().split("T")[0]}）
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
                </s-box>
              </s-section>

        </s-stack>
      </s-scroll-box>

      {/* CSV出力処理中モーダル（入出庫履歴と同じ） */}
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
                  ? `${csvExportProgress.current}/${csvExportProgress.total}件の履歴を処理中...`
                  : "処理中..."}
              </div>
              <div
                style={{
                  width: "100%",
                  height: "8px",
                  backgroundColor: "#e0e0e0",
                  borderRadius: "4px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width:
                      csvExportProgress.total > 0
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

      {/* 商品リストモーダル（入出庫履歴と同じデザイン） */}
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
              <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>履歴ID:</strong> {modalEntry.id}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>名称:</strong>{" "}
                  {modalEntry.lossName ||
                    formatLossName(modalEntry, entries, entries.findIndex((e) => e.id === modalEntry.id))}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>日付:</strong>{" "}
                  {modalEntry.date ||
                    (modalEntry.createdAt ? new Date(modalEntry.createdAt).toISOString().split("T")[0] : "")}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>ロケーション:</strong>{" "}
                  {modalEntry.locationName ||
                    locations.find((l) => l.id === modalEntry.locationId)?.name ||
                    modalEntry.locationId}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>理由:</strong> {modalEntry.reason || "-"}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>担当者:</strong>{" "}
                  {modalEntry.staffName || (modalEntry.staffMemberId ? `ID:${modalEntry.staffMemberId}` : "") || "-"}
                </div>
                <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                  <strong>ステータス:</strong> {STATUS_LABEL[modalEntry.status] || modalEntry.status}
                </div>
                {modalEntry.cancelledAt && (
                  <div style={{ fontSize: "14px", marginBottom: "4px" }}>
                    <strong>キャンセル日時:</strong>{" "}
                    {new Date(modalEntry.cancelledAt).toISOString().split("T")[0]}{" "}
                    {new Date(modalEntry.cancelledAt).toTimeString().split(" ")[0]}
                  </div>
                )}
                <div style={{ fontSize: "14px" }}>
                  <strong>数量:</strong> {modalItems.reduce((s, it) => s + (it.quantity || 0), 0)}
                </div>
              </div>
            )}

            {fetcher.state === "submitting" || fetcher.state === "loading" ? (
              <div style={{ padding: "24px", textAlign: "center" }}>
                <div>商品リストを取得中...</div>
              </div>
            ) : modalItems.length > 0 ? (
              <div>
                <div style={{ marginBottom: "12px", fontSize: "14px", color: "#666" }}>
                  合計: {modalItems.length}件
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
                        <th style={{ padding: "8px", textAlign: "right" }}>数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalItems.map((item, idx) => (
                        <tr key={item.id || idx} style={{ borderBottom: "1px solid #eee" }}>
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
                          <td style={{ padding: "8px", textAlign: "right" }}>{item.quantity || "-"}</td>
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
    </s-page>
  );
}
