# 下書きシップメントと下書きトランスファーの違い（データの持ち方・編集処理）

## 用語

- **下書きトランスファー**: Transfer の status が `DRAFT`。まだ「配送準備完了」にしていない状態。
- **下書きシップメント**: Transfer は `READY_TO_SHIP` などでも、その中の **Shipment** の status が `DRAFT` のもの。1 Transfer に複数 Shipment がある場合の「まだ確定していない配送」も含む。

---

## 1. データの持ち方の違い

### 下書きトランスファー（Transfer = DRAFT）

| 項目 | 内容 |
|------|------|
| **明細の保存先** | **Transfer** の `lineItems` のみ（Shipment はまだ作られていないか、作られていても DRAFT） |
| **取得 API** | `inventoryTransfer(id)` → `lineItems.nodes` に `id`, `title`, `shippableQuantity`, `processableQuantity`, `inventoryItem { id, sku }` など |
| **商品名** | Transfer の lineItems に **title** が入る（API が返す） |
| **数量** | `shippableQuantity` / `processableQuantity` で取得 |

- 編集時は「Transfer の lineItems」をそのまま使うため、商品名・数量とも揃いやすい。

### 下書きシップメント（Shipment = DRAFT）

| 項目 | 内容 |
|------|------|
| **明細の保存先** | **Shipment** の `lineItems`（と、元になる Transfer の lineItems） |
| **取得 API** | `inventoryShipment(id)` → `lineItems.nodes` に `id`, `quantity`, `inventoryItem { id, variant { id, sku, title, product { title } } }` など |
| **商品名** | DRAFT の Shipment では **variant が null になりやすく**、`productTitle` / `variantTitle` が空で返ることがある |
| **数量** | `quantity` で取得。ただし DRAFT では 1 件だけ・数量が 1 だけなど、意図と違う形で返ることがある |

- 編集時は「Shipment の lineItems」を主に使うが、商品名・数量が欠けたり違ったりしやすい。
- そのため **Transfer の lineItems**（`fetchInventoryTransferDetailForHistory` の `d.lineItems` の **title** や、`fetchTransferLineItemsEnriched` の結果）で補完している。

---

## 2. 編集処理の流れの違い

### 画面の分岐

1. **履歴一覧** で 1 件の Transfer をタップ  
   → **詳細（OutboundHistoryDetail）** に遷移  
   → このとき **historyFromShipmentSelection = false**（配送リスト経由ではない）

2. **配送を選択** 画面で 1 つの Shipment をタップ  
   → **詳細（OutboundHistoryDetail）** に遷移  
   → このとき **historyFromShipmentSelection = true**

### 編集ボタン押下後の分岐（openEditAndOpen_）

| 条件 | 使うデータ | lines の組み立て方 |
|------|------------|---------------------|
| **historyFromShipmentSelection === true** | 選択した **Shipment** と **detail（Transfer 詳細）** | 1. `fetchInventoryShipmentEnriched(shipmentId)` で lineItems 取得 → nextLines 作成<br>2. **detail.lineItems**（または再取得した Transfer 詳細）で数量・商品名を補完<br>3. Shipment の lineItems が空なら、detail.lineItems だけで nextLines を組み立て |
| **historyFromShipmentSelection === false** | **items**（詳細画面の loadDetail_ で作った一覧） | 1. **items** をそのまま OutboundList 用の **lines** に変換<br>2. 各 line に `productTitle`, `label`, `title` を設定 |

### 詳細画面の items の組み立て方（loadDetail_）

- **selectedShipmentId があるとき**
  1. `fetchInventoryShipmentEnriched(shipmentId)` で Shipment の lineItems を取得
  2. それを **map** に詰めて **items** の元にする
  3. **DRAFT で商品名が空**なら:
     - `fetchTransferLineItemsEnriched(transferId)` で Transfer の lineItems（variant 由来の productTitle）を取得
     - **d.lineItems**（`fetchInventoryTransferDetailForHistory` の **title**）も使って productTitle を補完
     - 数量は Transfer の `processableQuantity` などで補正
- **Shipment の lineItems が空**なら
  - `fetchTransferLineItemsEnriched` と **d.lineItems**（数量は `shippableQuantity` / `processableQuantity`）で items を組み立て

---

## 3. 表示されない原因になり得る点（下書きシップメント）

1. **Shipment API**  
   DRAFT の `inventoryShipment.lineItems` で `inventoryItem.variant` が null だと、商品名が取れない。

2. **Transfer 側の補完**  
   - `fetchTransferLineItemsEnriched` は **variant.product.title** に依存。DRAFT の Transfer で variant が null だとここも空。
   - そのため **d.lineItems の title**（Transfer 詳細 API の `lineItems.nodes.title`）でさらに補完するようにしている。

3. **編集時に渡す lines**  
   詳細 → 編集 では **items** を lines に変換している。items に `productTitle` / `label` / `title` が入っていないと、商品リストで「(unknown)」になる。  
   → loadDetail_ で d.lineItems の title まで使って productTitle を埋めるようにした。

---

## 4. コード上の対応まとめ

- **複数シップメントの Transfer**  
  - `inventoryTransfer(id).lineItems.nodes` に **全商品の title / sku / inventoryItemId** が入る。  
  - 各 Shipment の lineItems は **inventoryItemId + quantity** を持つので、Transfer の lineItems と **inventoryItemId で照合**すれば、その Shipment に含まれる商品だけ title/sku を引ける。

- **loadDetail_**（詳細の items 組み立て）  
  - Shipment から商品名が取れないとき、`fetchTransferLineItemsEnriched` に加え **d.lineItems の title** で productTitle を補完。  
  - tl が無い場合でも、detailLineItems の title があれば it.productTitle に設定。

- **openEditAndOpen_**（編集で開くときの lines）  
  - **配送リスト経由**:  
    1. **必ず** `fetchInventoryTransferDetailForHistory(detail.id)` で Transfer 詳細を再取得し、`lineItems`（全商品の title/sku）を取得。  
    2. Shipment の lineItems から nextLines を作り、**inventoryItemId で** Transfer の lineItems と照合して productTitle/sku/数量を補完。  
    3. 各 line に `label` / `title` を設定。  
  - **履歴詳細経由**:  
    1. items のうち商品名が空の行があれば、**必ず** `fetchInventoryTransferDetailForHistory(detail.id)` で Transfer の lineItems を取得し、**inventoryItemId で**照合して productTitle/sku を補完。  
    2. 補完後の items から lines を作り、`productTitle` / `label` / `title` を設定。

これにより、複数シップメントの Transfer に商品情報が入っていれば、選択した Shipment に含まれる行だけ inventoryItemId で引いて、編集画面の商品リストに表示される想定です。

---

## 5. 下書きシップメントの編集で OutboundList に引き継げない問題（2026-02 修正）

### 現象
- 下書きトランスファー商品リストからの編集 → OutboundList に引き継げる ✅
- 配送準備完了シップメントからの編集 → 引き継げる ✅
- **下書きシップメント**からの編集 → 商品情報・数量が OutboundList に引き継げない ❌

### 原因
- 配送リスト経由（`historyFromShipmentSelection === true`）で編集ボタンを押したとき、`openEditAndOpen_` は API を再取得して lines を組み立てていた。
- DRAFT の Shipment API は `inventoryItem.variant` が null になりやすく、商品名や数量が欠損・不正になる。
- Transfer の lineItems で補完するロジックも、DRAFT シップメント専用の商品が Transfer 側に含まれていないケースでは補完できない。

### 解決策
- **詳細画面に既に表示されている `items` を優先して使用する。**
- `loadDetail_` は商品リスト表示の時点で、Shipment API ＋ Transfer／fetchTransferLineItemsEnriched で productTitle や数量を補完して `items` を組み立てている。
- そのため、「商品リストに表示できている」＝ `items` に正しいデータが入っている。
- 編集ボタン押下時、配送リスト経由でも `items.length > 0` なら **`items` を lines に変換して OutboundList に渡す**ように変更。API 再取得は `items` が空のときのみフォールバックとして実行。

### 修正箇所
- `ModalOutbound.jsx` の `openEditAndOpen_`：配送リスト経由の分岐の先頭で、`items` が存在する場合は `items` から lines を組み立て、OutboundList に渡す処理を追加。
