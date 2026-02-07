# 出庫・配送準備完了まわり不具合の要因整理（2026-02）

`REQUIREMENTS_FINAL.md` および `OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` を前提に、報告された4点の不具合について「要因」を整理したものです。修正は別タスクで行う想定です。

---

## 1. 編集モーダル「追加」→ 商品リスト追加 → 「確定する」／「配送準備完了にする」で新しいトランスファーIDが作成される

### 現象
- 履歴一覧の「配送準備完了」の「編集」→ モーダルで「追加」→ 商品リストで商品を追加 → 「確定する」または「配送準備完了にする」を押すと、**既存の Transfer ではなく新しい Transfer ID で作成されてしまう**。

### 要因

- **「確定する」**  
  - 確定処理は `handleConfirmTransfer`（確定モーダルの primary-action）内で行われている。  
  - その中で **`addingShipmentToTransferId` を先頭で判定**しており、設定されていれば `createInventoryShipmentInTransit({ movementId: addingId, ... })` で**既存 Transfer にシップメント追加**している（`ModalOutbound.jsx` 5538–5571 行付近）。  
  - 「追加」クリック時は `onAddShipment` で `addingShipmentToTransferId` に既存 Transfer ID が正しくセットされている（2675–2677 行付近）。  
  - **→ コード上は「確定する」で既存 ID に追加する分岐がある。** もし「確定する」でも新規 ID になっている場合は、確定モーダルの primary-action 実行時点で `outbound.addingShipmentToTransferId` が別処理で上書き／クリアされていないか、または OutboundList マウント時に state がリセットされていないかを確認する必要がある。

- **「配送準備完了にする」**  
  - こちらは **`createTransferAsReadyToShipOnly`** 内で処理されている（5873 行付近）。  
  - この関数では、  
    1. **`addingShipmentToTransferId` の分岐が存在しない**  
    2. その次に `editingTransferId` → `draftTransferId` → どちらも無ければ **新規 Transfer 作成**（`createTransferReadyToShipWithFallback`）  
  - 「追加」で開いたときは `onAddShipment` 内で `editingTransferId` を空にしている（2679 行）ため、  
    - `editingTransferId` は空  
    - `draftTransferId` も空  
    - その結果、**常に「新規作成」の分岐に入り、新しい Transfer が作られている**。

### 結論（要因の一言）
- **「配送準備完了にする」の処理（`createTransferAsReadyToShipOnly`）に、`addingShipmentToTransferId` がセットされているときの分岐がないこと。**  
  - 要件（`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` §3.2）では、「シップメントを追加」で「配送準備完了にする」のときは **既存 Transfer に `inventoryShipmentCreate`（DRAFT）で追加** とあるが、その分岐が未実装。

※「確定する」で新規 ID になる事象が出ている場合は、別途「確定する」側の条件（`addingShipmentToTransferId` が渡っているか・上書きされていないか）の確認が必要です。

---

## 2. 履歴一覧のレイアウトがぐちゃぐちゃ（配送数・数量の表示位置の不統一）

### 現象（画像・説明より）
- 状態の横に数量を表示したいが、**数量が改行されて表示されるものがある**。
- **配送準備完了**のとき「配送数: N」を表示すると、**数量が1行上に寄ったように見える**／行数が増えて他カードと揃わない。
- 配送リストが 1 つでも「**配送数: 1**」と表示して統一したい。

### 要因

1. **「状態｜数量」行の改行防止が不足している**  
   - 要件（REQUIREMENTS_FINAL.md 12.22）では、5 行目（状態と数量）に **`flexWrap: "nowrap"`** を付け、左「状態」に `minWidth: 0`, `flex: "1 1 0"`、右の数量を **`<s-box style={{ flexShrink: 0 }}>`** で囲むとある。  
   - 現状の履歴カード（`ModalOutbound.jsx` 2893–2900 行、`OutboundHistoryScreens.jsx` 437–444 行付近）では、**その `flexWrap: "nowrap"` および数量側の `flexShrink: 0` の s-box が付いていない**。  
   - そのため、幅が足りないときに「数量」だけが次の行に回り、**数量が改行されて表示される**事象が出ている。

2. **「配送数」が独立した行になっている**  
   - 現在は「状態｜数量」の **次の行** に `shipmentCount >= 1` のときだけ「配送数: N」を表示している（2901–2906 行、446–449 行付近）。  
   - そのため、  
     - 配送数があるカードだけ行数が 1 行増える  
     - 「状態｜数量」の行と「配送数」の行が分かれており、**「配送数」を出すと数量が上の行に残り、レイアウトがずれたように見える**。

3. **配送準備完了でも「配送数: 1」と統一されていない**  
   - 表示は **`shipmentCount >= 1` のときだけ**「配送数: N」を出している。  
   - READY_TO_SHIP で **Shipment がまだ 0 件**（Transfer の lineItems のみ）の場合は、`shipments.length === 0` のため **「配送数」行が表示されない**。  
   - 要件では「配送準備完了のステータスのものは配送リストが 1 つでも**配送数: 1 と表示させて統一**」とのことなので、**READY_TO_SHIP のときは shipmentCount が 0 でも「配送数: 1」と表示する**必要があるが、その考慮がない。

### 結論（要因の一言）
- **状態｜数量行に `flexWrap: "nowrap"` と数量側の `flexShrink: 0` がなく、改行が起きている。**
- **「配送数」が別行になっており、行数・見た目の統一が崩れている。**
- **READY_TO_SHIP 時に Shipment 0 件でも「配送数: 1」と表示する仕様になっていない。**

---

## 3. 配送リストから商品リストに行く際、下書きと同じ「履歴商品リスト表示＋フッター戻る・編集・キャンセル」になっていない

### 想定（要件）
- 配送リスト → 商品リスト に進むときも、**下書きのときと同様**に  
  **「履歴商品リスト（詳細表示）」** を一度表示し、そのフッターで **「戻る」「編集」「キャンセル」** を選ぶ流れにしたい。

### 現状の実装
- 配送リストは **`OutboundShipmentSelection`**（`ModalOutbound.jsx` 3010 行付近）。
- 配送（シップメント）をタップすると **`onSelectShipment`** が呼ばれ、  
  - `editingTransferId` / `lines` 等をセット  
  - **`historySelectedTransferId` を空にする**（3136 行）  
  - そのまま **`onOpenOutboundList()`** で **OutboundList（商品リスト編集画面）に直接遷移**している（3145 行）。
- つまり、**「履歴商品リスト（OutboundHistoryDetail のような詳細表示）」を経由せず、いきなり編集用の商品リスト（OutboundList）に飛んでいる**。

### 結論（要因の一言）
- **配送リストから商品リストへの遷移が、詳細画面（OutboundHistoryDetail）を挟まずに OutboundList に直結しているため、下書き時と同じ「履歴商品リスト表示 → 戻る／編集／キャンセル」の流れになっていない。**

---

## 4. 配送リスト → 商品リスト → 戻る で配送リストに戻ったときにリストが読み込まれない（トランスファー情報が残っていない）

### 現象
- 配送リスト → 商品リスト（OutboundList）→ フッターの「戻る」で配送リストに戻ると、**配送リストが読み込まれない**（トランスファー情報が残っていないように見える）。

### 要因

- **`OutboundShipmentSelection`** は、表示する Transfer を **`outbound.historySelectedTransferId`** で参照している（3024 行付近）。  
  - `loadTransfer()` は **`transferId` があるときだけ** `fetchInventoryTransferDetailForHistory(transferId)` を実行する（3039–3041 行）。  
  - `transferId` が空の場合は何も取得せず、`detail` は null のまま。

- **配送をタップして商品リスト（OutboundList）へ行くとき**、`onSelectShipment` 内で  
  - `editingTransferId` や `lines` などをセットした**あと**、  
  - **`historySelectedTransferId: ""`** を明示的にセットしている（3136 行）。  
  - そのため、**商品リスト画面に遷移した時点で `historySelectedTransferId` が消えている**。

- ユーザーが商品リストで「戻る」を押すと `nav.pop()` で配送リスト（OutboundShipmentSelection）に戻るが、  
  - この画面は **appState の `historySelectedTransferId` に依存**しており、  
  - すでに空にされているため **`transferId` が空** → `loadTransfer()` は何もせず、**リストが再取得されない／表示されない**。

### 結論（要因の一言）
- **配送を選択して OutboundList に遷移する際に `historySelectedTransferId` をクリアしているため、戻ったときに配送リスト側で参照する Transfer ID が残っておらず、リストが読み込まれない。**

---

## 修正の方向性（参考）

| # | 内容 | 修正の方向性 |
|---|------|----------------|
| 1 | 追加 → 配送準備完了にするで新規IDになる | `createTransferAsReadyToShipOnly` の先頭で `addingShipmentToTransferId` を判定し、セットされていれば `inventoryShipmentCreate`（DRAFT）で既存 Transfer に追加する分岐を実装する。 |
| 2 | 履歴一覧レイアウト | 状態｜数量行に `flexWrap: "nowrap"` と数量を `s-box`（`flexShrink: 0`）で囲む。配送準備完了時は「配送数」を状態・数量と同じ行にまとめるか、READY_TO_SHIP のときは shipmentCount が 0 でも「配送数: 1」と表示する。 |
| 3 | 配送リスト→商品リストの流れ | 配送リストからはいったん OutboundHistoryDetail（履歴商品リスト）に遷移し、そのフッターの「編集」で OutboundList を開くようにする。 |
| 4 | 戻ったときにリストが読めない | 配送選択で OutboundList に遷移するときに `historySelectedTransferId` をクリアしない。戻ってきたときに配送リストで使うため保持する。クリアするのは「確定」後や、コンディション画面に戻るときなどに限定する。 |

---

**コード上の主な参照箇所**

- `ModalOutbound.jsx`: 2668–2693（onAddShipment）, 2874–2970（履歴カード）, 3010–3215（OutboundShipmentSelection）, 5538–5571（確定時の addingId）, 5873–6197（createTransferAsReadyToShipOnly）
- `OutboundHistoryScreens.jsx`: 437–449, 483–495（履歴カード・状態／数量／配送数）
