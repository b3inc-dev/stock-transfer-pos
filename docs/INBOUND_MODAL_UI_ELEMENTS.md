# Modal 時の入庫実装：UI・処理の正確な仕様（実コード準拠）

**参照元**: 復元した `extensions/stock-transfer-tile/src/Modal_REFERENCE.jsx`（Git HEAD から復元した分割前の Modal.jsx）  
**目的**: 実コードに基づき、入庫の処理とUI要素を正確に整理する。以前の要約で誤りがあった箇所を修正する。

---

## 0. 行番号（Modal_REFERENCE.jsx 上の実際の位置）

| 名前 | 行番号 |
|------|--------|
| InboundConditions | 7384〜 |
| InboundShipmentSelection | 7992〜 |
| InboundList | 8269〜 |
| InboundAddedLineRow | 11316〜 |
| renderInboundShipmentItems_ | 13742〜 |
| InboundCandidateRow（InboundList 内のローカル定義） | 10779〜 |

---

## 1. InboundConditions（履歴一覧）

### 1.1 処理

- **refresh** (7473〜7513): `fetchTransfersForDestinationAll` → **同期的に** `readInboundAuditLog` / `buildInboundOverIndex_` / `buildInboundExtrasIndex_` / `buildInboundRejectedIndex_` / `mergeInboundOverIntoTransfers_` を実行してから `setTransfers(patched)`。二相ロードではない。
- **listInitialLimit**: `appState?.outbound?.settings?.inbound?.listInitialLimit ?? 100`（最大250）。
- **loadMoreTransfers_** (7648〜7690): 追加ページ取得時も同様に監査ログを取得・マージしてから `setTransfers((prev) => [...prev, ...patched])`。

### 1.2 ヘッダー

- タブ2つ: 「未入庫 N件」「入庫済み N件」。
- 「さらに読み込み」: **文言は「未読み込み一覧リストがあります。（過去分）」**。`transfersPageInfo?.hasNextPage` のときのみ表示。ボタンは「読込」/「読み込み中...」。

### 1.3 フッター

- `FixedFooterNavBar`: summaryLeft＝「入庫先: {displayLocationName}」、summaryRight＝「未入庫 N件」/「入庫済み N件」、左「戻る」、中央「軽量:ON/OFF」、右「再取得」/「取得中...」。

### 1.4 一覧行

- **1シップメント**: 行全体が `s-clickable`。表示は「入庫ID名・日付・出庫元・入庫先・状態・received/total」。
- **2シップメント以上**: 左側が `s-clickable`（同じ項目＋「シップメント数: N」）、**右端に「リスト」ボタン**。  
  - `command="--show"` / `commandFor={SHIPMENT_MODE_SELECTION_MODAL_ID}`、`onClick` で `setPendingTransferForModal(t)`。

### 1.5 シップメント選択モーダル

- `s-modal id={SHIPMENT_MODE_SELECTION_MODAL_ID}` heading="処理方法を選択"。
- 内容: Transfer名、「配送ごとに選択」「まとめて表示」等（選択後に InboundList へ遷移）。

---

## 2. InboundList（商品リスト画面）

### 2.1 処理

- **pendingTransfers / allTransfers**: マウント時に `refreshPending()` と `refreshAllTransfers()` を両方実行（8392〜8398）。どちらも監査ログ取得・マージあり。
- **transferForShipment**: `pendingTransfers` / `allTransfers` から `selectedShipmentId`（または複数時は該当 Shipment）に一致する Transfer を検索（約 8968〜8988）。
- **readOnly**: shipment.status === RECEIVED、または `inbound.selectedReadOnly`、または transfer の total/received で完了判定。
- **isMultipleMode**: `inbound.shipmentMode === "multiple"` かつ `inbound.selectedShipmentIds.length > 1`。
- **loadShipment** (8510〜): 単一シップメント。下書き `loadInboundDraft` で復元。行は `plannedQty` / `alreadyAcceptedQty` / `overAcceptedQty` 等を設定。
- **loadMultipleShipments** (8655〜8800): 複数シップメントを `Promise.all` で取得し、`shipmentId`・`shipmentLabel`（`formatShipmentLabelLocal`）を各行に付与。監査ログで over を取得し、下書きは `shipmentId`＋`shipmentLineItemId` で復元。
- **DIFF_PREVIEW_LIMIT**: **1**。確定モーダル内の不足/予定外/超過は「1件だけ」表示し、残りは「…他 N 件」。

### 2.2 !selectedShipmentId のとき（フォールバックUI）

- メッセージ: **「Shipment が未選択です。前の画面で選択してください。」**
- ボタン: **「入庫予定一覧を更新（任意）」**（`refreshPending`、disabled＝pendingLoading）。
- 一覧: **「入庫予定（Transfer）」** として `pendingTransfers.slice(0, 8)` を表示。8件超は「…他 N 件」。

### 2.3 ヘッダー（headerNode）

- **1行目**: Transfer の短縮表示（headNo、例 #T0000）。
- **2行目**: 出庫元（originName）。
- **3行目**: 入庫先（inboundTo）。
- **追記**: 配送業者・配送番号・予定日（`shipment?.tracking`）。
- **右側**: 軽量ボタン、**全入庫**、**リセット**。
- **検索**: ラベル非表示の `s-text-field`、placeholder「商品名 / SKU / バーコード」。検索結果時は「検索結果：N件」、クリア用 ✕ ボタン。

※ 現在の stock-transfer-inbound のヘッダーは「Transfer名・出庫元・入庫先・全入庫」のみで、配送情報・軽量・リセット・検索は含まれていない。

### 2.4 フッター

- **FixedFooterNavBar ではない**。`s-box`（position: sticky, bottom: 0）で:
  - 左: 「戻る」。
  - 中央: footerLine1＝「予定 X / 入庫 Y」（未選択時は「未選択」）、footerLine2＝「予定外 X / 超過 Y / 不足 Z」。警告時は tone="critical"。
  - 右: **「確定」**ボタン（`command="--show"` / `commandFor={CONFIRM_RECEIVE_MODAL_ID}`）。ラベルは「確定」または「確定中...」のみ（「確定（確認画面へ）」という表記はない）。
- その下: 軽量ON 表示、Shipment 読み込み中/エラー表示。

### 2.5 商品リスト（明細行）

- **単一シップメント**: `renderInboundShipmentItems_({ rows: visibleRows, showImages, dialog, setRowQty })`。
- **複数シップメント**: `visibleRows` を `shipmentId` でグループ化（Map）。各グループに:
  - **見出し**: `s-box`（backgroundColor: `var(--s-color-bg-surface-secondary)`）、**`group.shipmentLabel`（例 #T0000-1）のみ**。行の title に shipmentLabel は付与していない。
  - 明細: `renderInboundShipmentItems_({ rows: group.rows, ... })`。
  - グループ間: `s-divider`。

### 2.6 未読み込み商品

- 文言: **「未読み込み商品リストがあります。（要読込）」**。ボタンは「読込」/「読み込み中...」。

### 2.7 InboundAddedLineRow（実装）

- **StockyRowShell** 内で:
  - 上段: **ItemLeftCompact**（showImages, imageUrl, productTitle, variantTitle, line3=skuLine）。skuLine は `SKU:xxx / JAN:xxx` 形式。
  - 下段左: **bottomLeft**（例「予定 X / 入庫 Y」）。差がある行は tone="critical"。
  - 下段右: **QtyControlCompact_3Buttons**（value, min, modalId, onDec, onInc, onSetQty, onRemove）。onRemove は任意。
- **renderInboundShipmentItems_** では、各行に `bottomLeft`／`bottomLeftTone` を渡し、**onRemove は渡していない**（予定外行では別で onRemove を渡す）。

### 2.8 予定外入荷（extras）

- **renderExtras_** (10486〜): 0件かつ予定外履歴ありのときは「予定外追加はありません」を出さず null。ありのときは `InboundAddedLineRow` で表示（bottomLeft＝「予定外 / 入庫 n」、onRemove で削除）。

### 2.9 検索UI（InboundCandidateRow）

- **検索結果ブロック**: 検索クエリが 1 文字以上のとき表示。**「検索リスト 候補： N件」**。候補は `InboundCandidateRow`。
- **InboundCandidateRow**: ItemLeftCompact（商品名・バリアント・SKU/JAN）+ 2行目に**在庫表示**（ensureInbCandidateStock）+ **数量入力**＋**「＋」ボタン**。数量指定して追加する UI（「追加」1つではない）。
- **「さらに表示」**: **「さらに表示（残り N件）」**（addCandidatesDisplayLimit を 20 ずつ増やす）。

### 2.10 確定モーダル

- heading: 「入庫を確定しますか？」。
- サマリー: 予定/入庫、予定外/超過/不足。hasWarning 時は「※ 予定外/超過/不足 があります。」。
- **不足/予定外/超過のプレビュー**: 各カテゴリ **1件のみ** 表示（DIFF_PREVIEW_LIMIT=1）、残りは「…他 N 件」。
- 理由・メモ・「確認しました」は warningAreaNode で表示。
- ボタン: 「戻る」、「一部入庫（一時保存）」、「確定する」。

---

## 3. 以前の要約との主な修正点

| 項目 | 以前の要約 | 実コード |
|------|------------|----------|
| 行番号 | 2720/3532/6401/8622 等 | InboundConditions 7384、InboundList 8269、InboundAddedLineRow 11316、renderInboundShipmentItems_ 13742 |
| DIFF_PREVIEW_LIMIT | 5 | **1** |
| 確定モーダル内リスト | 最大5件 | **1件＋「…他 N 件」** |
| !selectedShipmentId | 説明が曖昧 | 「Shipment が未選択です…」「入庫予定一覧を更新（任意）」、pendingTransfers 最大8件 |
| 複数シップメント表示 | 各行の商品名に shipmentLabel 付与 | **見出しのみ** shipmentLabel。行の title には付与しない |
| InboundList フッター | FixedFooterNavBar と記載 | **s-box（sticky）**。確定ボタンは「確定」/「確定中...」のみ |
| InboundList ヘッダー | Transfer名・出庫元・入庫先・全入庫 | 上記＋**配送業者・番号・予定日・軽量・リセット・検索フィールド** |
| 履歴「さらに読み込み」 | 「未読み込み商品があります」等 | **「未読み込み一覧リストがあります。（過去分）」** |
| 商品リスト「未読み込み」 | 「未読み込み商品があります」 | **「未読み込み商品リストがあります。（要読込）」** |
| 検索候補表示 | 「候補：N件」等 | **「検索リスト 候補： N件」**、「さらに表示（残り N件）」 |
| InboundCandidateRow | 「追加」ボタンのみ | **在庫表示＋数量入力＋「＋」ボタン**（数量指定して追加） |
| InboundConditions refresh | 二相ロードの記述あり | **同期**（監査ログ完了後に setTransfers） |

---

## 4. 現在の stock-transfer-inbound との差分（UI・処理）

- **InboundConditions**: 文言「未読み込み一覧リストがあります。（過去分）」、フッターの軽量/再取得、一覧行の「シップメント数」・「リスト」ボタンは実装済みか要確認。
- **InboundList**:
  - ヘッダーに配送業者・番号・予定日、軽量、リセット、検索フィールドがない。
  - フッターは FixedFooterNavBar 風か別構成か要確認。確定ボタン表記は「確定」でよい。
  - !selectedShipmentId 時の「入庫予定一覧を更新（任意）」と pendingTransfers 一覧（最大8件）。
  - 複数シップメント時のグループ見出し（backgroundColor＋shipmentLabel）と、見出しのみで行タイトルに shipmentLabel を付けない点。
  - DIFF_PREVIEW_LIMIT=1 に合わせた確定モーダル内の表示件数。
- **InboundAddedLineRow 相当**: 画像・StockyRowShell・QtyControlCompact_3Buttons の有無。予定外の onRemove。
- **InboundCandidateRow 相当**: 在庫表示と数量＋「＋」の有無。
- **処理**: 二相ロードは現在の inbound 側の最適化で問題なし。transferForShipment・readOnly・pendingTransfers/allTransfers の扱いが Modal と揃っているか確認。

---

## 5. 参照ファイル

- **実コード**: `extensions/stock-transfer-tile/src/Modal_REFERENCE.jsx`（本ドキュメント作成時に Git から復元した分割前 Modal.jsx のコピー）。
- **現行入庫**: `extensions/stock-transfer-inbound/src/Modal.jsx`、`extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx`。
