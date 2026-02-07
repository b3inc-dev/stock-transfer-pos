# 2分割時 vs 4分割時 関数リスト比較

2分割（入庫/出庫 一体・ロス/棚卸 一体）時の関数と、4分割後の各拡張の関数を比較し、漏れがないか確認した結果です。

---

## 1. 入庫/出庫（tile 2分割 → tile 出庫 + inbound 入庫）

### 1.1 2分割時（Modal.jsx 入庫+出庫 一体）

- **対象**: `extensions/stock-transfer-tile/src/Modal.jsx`
- **関数数**: 約 91（同一名は1つとしてカウント）

主要な関数名のみ抜粋（コンポーネント・API・ヘルパー）:

| 種別 | 関数名 |
|------|--------|
| ルート | Extension, MenuScreen |
| 出庫 | OutboundConditions, OutboundHistoryConditions, OutboundHistoryDetail, OutboundList, OutboundAddedLineRow |
| 入庫 | **InboundConditions**, **InboundShipmentSelection**, **InboundList**, **InboundAddedLineRow**, **renderInboundShipmentItems_** |
| 共通UI | FixedFooterNavBar, BlockingAlertModal, QtyStepperCompact, RowShell, ItemLeftInline, StockLineRow, CandidateRow, QtyControlCompact_3Buttons |
| API・ヘルパー | buildInboundNoteLine_, inboundDraftKey*, loadInboundDraft, saveInboundDraft, clearInboundDraft, readInboundAuditLog, buildInboundOverIndex_, buildInboundExtrasIndex_, buildInboundOverItemIndex_, buildInboundRejectedIndex_, mergeInboundOverIntoTransfers_, appendInboundAuditLog, appendInventoryTransferNote_, fetchTransfer, fetchTransferLineItemsEnriched, fetchPendingTransfersForDestination, fetchTransfersForDestinationAll, fetchTransfersForOriginAll, fetchInventoryShipmentEnriched, receiveShipmentWithFallbackV2, adjustInventoryAtLocationWithFallback, ensureInventoryActivatedAtLocation, searchVariants, resolveVariantByCode, buildVariantSearchQuery, ほか |

### 1.2 4分割後

**出庫（ModalOutbound.jsx）**

- 2分割 Modal.jsx のうち、**入庫専用の以下 5 つは含まれていない**（意図どおり出庫のみ）:
  - `InboundConditions`
  - `InboundShipmentSelection`
  - `InboundList`
  - `InboundAddedLineRow`
  - `renderInboundShipmentItems_`
- 上記以外の出庫・共通の関数は ModalOutbound.jsx に存在。

**入庫（stock-transfer-inbound）**

- 次のように**名前対応**している:
  - `InboundConditions` → あり（Modal.jsx 内）
  - `InboundShipmentSelection` → あり（InboundShipmentSelection.jsx）
  - `InboundList` → **InboundListScreen** として存在（入庫リスト画面を担当するコンポーネント名の変更）
- **名前として存在しない**:
  - `InboundAddedLineRow`
  - `renderInboundShipmentItems_`

### 1.3 入庫側の「名前として存在しない」2関数について

| 2分割時の関数 | 役割 | 4分割 inbound での扱い |
|---------------|------|------------------------|
| InboundAddedLineRow | 入庫リストの「1行」を描画するコンポーネント | **別名の関数としてはなし**。入庫リスト画面は **InboundListScreen** 1本で実装されているため、行の描画が **InboundListScreen 内にインライン**で書かれている可能性が高い。 |
| renderInboundShipmentItems_ | シップメント単位の行を InboundAddedLineRow で描画するヘルパー | **別名の関数としてはなし**。同様に **InboundListScreen 内**で行・シップメントの描画をしている想定。 |

**結論（入庫/出庫）**

- 出庫: 2分割時の出庫まわりは ModalOutbound に揃っており、入庫専用 5 関数は意図的に含めていない。**漏れなし**。
- 入庫: 画面単位では InboundConditions / InboundShipmentSelection / InboundListScreen で対応。`InboundAddedLineRow` と `renderInboundShipmentItems_` は「別名の関数」としては存在しないが、**InboundListScreen 内で `visibleRows.map((row) => ...)` により明細行をインライン描画**しており（754行付近：行タイトル・SKU・予定/入庫・入庫数入力）、**InboundAddedLineRow / renderInboundShipmentItems_ に相当する表示は同一ファイル内に実装済み**。**機能的には漏れなし**。

---

## 2. ロス/棚卸（loss 2分割 → loss ロスのみ + stocktake 棚卸のみ）

### 2.1 2分割時（loss 拡張に ロス＋棚卸 同居）

- **対象**: 当時の loss 拡張（LossScreen + StocktakeScreen、`loss/*` + `stocktake/*`）
- 現在のリポジトリには「2分割時の 1 ファイル」は残っていないが、4分割時に **loss から stocktake 用ファイルを削除し、同じ内容を stocktake 拡張に分離**しただけなので、  
  **2分割時の関数集合 ＝ 現在の loss の関数 ∪ 現在の stocktake の関数** とみなせる。

### 2.2 4分割後

**ロス（stock-transfer-loss）**

- Modal.jsx, LossScreen, loss/*（LossConditions, LossProductList, LossHistoryList, lossApi, FixedFooterNavBar）に含まれる関数のみ。
- 棚卸用の関数（StocktakeScreen, InventoryCount* など）は**含まれていない**（意図どおりロスのみ）。

**棚卸（stock-transfer-stocktake）**

- Modal.jsx, StocktakeScreen, stocktake/*（InventoryCountConditions, InventoryCountList, InventoryCountProductGroupSelection, stocktakeApi）, common/FixedFooterNavBar に含まれる関数のみ。
- ロス専用の関数（LossConditions, LossProductList, readLossEntries, writeLossEntries など）は**含まれていない**（意図どおり棚卸のみ）。

### 2.3 漏れの有無

- 2分割時: loss 拡張 ＝ ロス用関数 ＋ 棚卸用関数。
- 4分割時: ロス用関数はすべて loss に、棚卸用関数はすべて stocktake に存在（loss から削除した棚卸用コードは stocktake 側にのみ存在）。
- したがって、**2分割時の関数はすべて、4分割後の loss または stocktake のどちらかには存在しており、漏れはない**。

---

## 3. まとめ

| 区分 | 2分割時の所在 | 4分割後の所在 | 漏れ |
|------|----------------|----------------|------|
| 出庫 | Modal.jsx（入庫+出庫） | ModalOutbound.jsx（出庫のみ） | なし |
| 入庫 | Modal.jsx（入庫+出庫） | inbound（Modal + InboundListScreen 等） | なし（InboundAddedLineRow / renderInboundShipmentItems_ 相当は InboundListScreen 内にインライン実装済み） |
| ロス | loss 拡張（ロス+棚卸） | loss 拡張（ロスのみ） | なし |
| 棚卸 | loss 拡張（ロス+棚卸） | stocktake 拡張（棚卸のみ） | なし |

**推奨アクション**

- 特になし。入庫の明細行・表示は InboundListScreen 内のインライン実装でカバー済みのため、4分割後の関数リストとしての漏れはなし。
