# 配送業者・配送番号・予定日の表示条件

入庫・出庫・出庫履歴の商品リストヘッダー上部に表示する「配送業者」「配送番号」「予定日」の条件です。

---

## 表示ルール（共通）

- **3行は常に表示**します（ラベル「配送業者：」「配送番号：」「予定日：」は必ず出る）。
- **値が未登録のときは空白**（スペース）を表示し、レイアウトが崩れないようにしています。

---

## 1. 入庫（InboundList）

| 項目     | データの出どころ                         | 表示される条件                         |
|----------|------------------------------------------|----------------------------------------|
| 配送業者 | `shipment.tracking.company`              | その入庫（Shipment）に配送業者が登録されている |
| 配送番号 | `shipment.tracking.trackingNumber`       | その入庫に追跡番号が登録されている     |
| 予定日   | `shipment.tracking.arrivesAt`            | その入庫に到着予定日が登録されている   |

- **データ取得**: 選択した入庫ID（Shipment）を `fetchInventoryShipmentEnriched` で取得。このAPIは `tracking { trackingNumber company trackingUrl arrivesAt }` を含みます。
- 出庫側で「配送業者」「配送番号」「予定日」を登録してから入庫すると、入庫画面で表示されます。

---

## 2. 出庫（OutboundList：新規・編集）

| 項目     | データの出どころ           | 表示される条件                         |
|----------|----------------------------|----------------------------------------|
| 配送業者 | `resolvedCompany`          | 設定で配送業者を選んでいる、または手入力している |
| 配送番号 | `outbound.trackingNumber`  | 配送番号フィールドに入力している       |
| 予定日   | `outbound.arrivesAtIso`    | 到着予定日を入力している               |

- **データ取得**: 画面上のフォーム／下書き（localStorage）の値。出庫確定前に入力した内容がそのまま表示されます。

---

## 3. 出庫履歴（OutboundHistoryDetail）

| 項目     | データの出どころ                              | 表示される条件                         |
|----------|-----------------------------------------------|----------------------------------------|
| 配送業者 | `detail.shipments[0].tracking.company`        | その履歴の先頭 Shipment に配送業者が登録されている |
| 配送番号 | `detail.shipments[0].tracking.trackingNumber`  | その履歴の先頭 Shipment に追跡番号が登録されている |
| 予定日   | `detail.shipments[0].tracking.arrivesAt`      | その履歴の先頭 Shipment に到着予定日が登録されている |

- **データ取得**: `fetchInventoryTransferDetailForHistory` で Transfer 詳細を取得。**修正後**は `shipments.nodes` に `tracking { trackingNumber company trackingUrl arrivesAt }` を含めて取得するため、登録されていれば表示されます。
- Shipment が複数ある場合は、**先頭 1 件（index 0）** の tracking を表示します。

---

## 修正内容（表示されなかった原因）

- **出庫履歴**で「配送業者」「配送番号」「予定日」がずっと出ていなかった原因は、**出庫履歴詳細取得API（`fetchInventoryTransferDetailForHistory`）が `tracking` を取得していなかった**ことです。
- クエリの `shipments(first: 10) { nodes { id status } }` に  
  `tracking { trackingNumber company trackingUrl arrivesAt }` を追加し、  
  返却オブジェクトの `shipments` にも `tracking` を含めるように修正しました。
- この修正後、出庫履歴詳細を開いたときに、登録済みの配送業者・配送番号・予定日が表示されます。

---

## まとめ

- **入庫**: 出庫時に登録した tracking が Shipment に含まれていれば表示（APIはもともと取得済み）。
- **出庫**: 画面上で入力した値／下書きの値がそのまま表示される。
- **出庫履歴**: APIで `tracking` を取得するように修正したので、登録されていれば表示される。

どの画面でも「値が未登録のときは空白」で、3行のラベルは常に表示されます。
