# POSアプリ：SKU数・明細の表現一覧

**目的**: 「SKU数」や「明細」（行数・件数）を表示している箇所を整理し、表現の統一確認用に使う。

---

## 1. 「明細」という語を使っている箇所

| 拡張 | ファイル | 場所（概要） | 現在の表現 |
|------|----------|--------------|------------|
| **出庫** | ModalOutbound.jsx | 出庫リスト（商品リスト）フッター中央 | `明細 {totalLines} / 合計 {totalQty}` |
| **出庫** | ModalOutbound.jsx | 確定モーダル内（ゲート情報の下） | `明細: {totalLines} / 合計: {totalQty}` |
| **ロス** | LossProductList.jsx | 商品リストフッター中央 | `明細 ${totalLines} / 合計 ${totalQty}` |
| **ロス** | LossProductList.jsx | 商品リスト内（フッター上のサマリー行） | `明細: {totalLines} / 合計ロス: {totalQty}` |
| **入庫** | InboundListScreen.jsx | 商品リストエリア（配送未読込時） | 「配送を読み込むと、ここに明細が出ます」 |

※ `totalLines` = 行数（SKU種類数）、`totalQty` = 数量合計。

---

## 2. 「SKU」という語を使っている箇所（ユーザー向け表示）

| 拡張 | ファイル | 場所（概要） | 現在の表現 |
|------|----------|--------------|------------|
| **棚卸** | InventoryCountConditions.jsx | 棚卸一覧カード（複数グループ表示時） | `{skuCount} SKU {qtyText}` （例: `5 SKU 10/10`） |
| **棚卸** | InventoryCountConditions.jsx | 棚卸一覧カード（単一グループ表示時） | 同上 `{skuCount} SKU {qtyText}` |

※ `qtyText` = 実数/在庫 の形式（例: `10/10`, `10/-`）。

---

## 3. 行数・件数を「〇件」で表示している箇所

| 拡張 | ファイル | 場所（概要） | 現在の表現 |
|------|----------|--------------|------------|
| **出庫** | ModalOutbound.jsx | 履歴詳細フッター右 | `数量: {受領数}/{予定数}` （※件数ではない） |
| **出庫** | ModalOutbound.jsx | 配送リストフッター右 | `{displayShipments.length}件` |
| **入庫** | Modal.jsx | 入庫一覧フッター右 | `入庫済み {listToShow.length}件` / `未入庫 {listToShow.length}件` |
| **入庫** | InboundListScreen.jsx | ヘッダー検索結果 | `検索結果：{addCandidates.length}件` |
| **入庫** | InboundListScreen.jsx | 検索リスト見出し | `検索リスト 候補： {addCandidates.length}件` |
| **入庫** | InboundListScreen.jsx | さらに表示ボタン | `さらに表示（残り {N}件）` |
| **入庫** | InboundListScreen.jsx | 入庫リストのグループ見出し | `{group.rows.length}件` |
| **入庫** | InboundListScreen.jsx | 確定モーダル（不足/予定外/超過） | `不足（{shortageRows.length}件）` 等 ＋ `…他 {N} 件` |
| **入庫** | InboundShipmentSelection.jsx | フッター右 | `{shipments.length}件` |
| **ロス** | LossHistoryList.jsx | 履歴カード内 | `{itemCount}件・合計{totalQty}` |
| **棚卸** | InventoryCountProductGroupSelection.jsx | フッター右 | `{productGroups.length}件` |
| **棚卸** | InventoryCountList.jsx | 確定モーダル内 | `調整対象: {itemsToAdjust.length}件`、`在庫調整対象（{itemsToAdjust.length}件）`、`…他 {N} 件` |
| **棚卸** | InventoryCountList.jsx | 商品リストヘッダー（0件時） | `0件` |

---

## 4. その他（明細・SKU数以外だが関連する表現）

| 拡張 | ファイル | 場所 | 現在の表現 |
|------|----------|------|------------|
| **棚卸** | InventoryCountList.jsx | 商品リストフッター中央 | `在庫 {currentTotal} / 実数 {actualTotal}`、`予定外 {extraCount}`、`超過 {overTotal} / 不足 {shortageTotal}` |
| **入庫** | InboundListScreen.jsx | フッター1行目 | `予定 {plannedTotal} / 入庫 {receiveTotal}` または `予定外/超過/不足` の行 |

---

## 5. トースト・コメントのみ（画面表示ではない）

- 出庫: 「明細を更新しました」「明細の inventoryItemId / qty が不正です」等（トースト）
- コード内コメント: 「SKU数と数量カウント」「調整対象の明細（1件だけ表示…）」等

---

**整理・統一する場合の例**

- 「明細」を「行数」や「品目数」に揃えるか、そのまま「明細」で統一するか。
- 棚卸の「○ SKU」を「○件」や「○品目」に揃えるか。
- ロスの「合計ロス」だけ「合計」と表記が違うので、他と揃えるかどうか。

上記一覧を元に、どの表現にそろえるか決めると整理しやすいです。
