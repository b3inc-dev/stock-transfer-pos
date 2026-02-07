# 出庫不具合の要因整理（2026-02）

## 1. 「状態｜数量」行の改行（#T0127 だけ改行される）

**結論：コード上では要因を特定できません。**

- ModalOutbound.jsx の履歴カード（約2914–2923行）と OutboundHistoryScreens.jsx（約437–445行）では、**同じレイアウト**が使われています。
  - 5行目（状態｜数量）: `flexWrap: "nowrap"`、左「状態」に `minWidth: 0`, `flex: "1 1 0"`、右を `<s-box style={{ flexShrink: 0 }}>` で囲む。
- 全カードとも同じ JSX で描画されているため、「#T0125 と同じ文字数なのに #T0127 だけ改行される」原因をコードからは切り分けできません。
- 仮説で進めず、**「わからない」**とします。再現手順や環境（デバイス・解像度・フォント）が分かれば、その情報を元にさらに調査可能です。

---

## 2. リストが1件だけのとき「（未確定：1）」が表示されない

**要因：API が `shipments` を「配列」や `nodes` 以外（単体オブジェクトや `edges`）で返す場合に、正規化が不足している。**

- 要件書（REQUIREMENTS_FINAL.md）では、`shipments` を「配列 / nodes / edges / 単体オブジェクト」のいずれでも正規化し、**処理済みでない配送が1件だけのときも「（未確定：1）」が出る**ようにするとあります。
- **ModalOutbound.jsx の一覧表示**（約2871–2880行）では、上記4パターンの正規化が入っています。
- 一方で、一覧の**元データ**は `fetchTransfersForOriginAll` で作られており、ここでは **`t.shipments.nodes` のみ**を参照して `ships` を組み立てています（約8502–8509行）。
  - GraphQL が `shipments` を **単体オブジェクト**（例: `{ id, status }`）や **edges** で返す場合、`t.shipments.nodes` は undefined となり、`ships = []` になる。
  - その結果、`unconfirmedCount` が常に 0 になり、「（未確定：1）」が付きません。
- **OutboundHistoryScreens.jsx**（約404行）でも、`shipments` は「配列 or nodes」のみで、edges・単体オブジェクトの考慮がありません。

**対応方針：**

- `fetchTransfersForOriginAll` 内で、ModalOutbound.jsx の一覧と同じルールで **shipments を正規化**する（配列 / nodes / edges / 単体オブジェクトの4パターン）。
- **OutboundHistoryScreens.jsx** の一覧表示でも、同じ正規化を適用する。

---

## 3. 配送準備完了＞編集＞配送リストからの遷移で、フッターに「戻る」がなく「キャンセル」「編集」だけになる

**要因：配送リスト経由で詳細を開いたときだけ、別仕様のフッター（左：キャンセル、右：編集）を出しているため。**

- OutboundHistoryDetail のフッターは `historyFromShipmentSelection`（配送リストから開いたかどうか）で分岐しています（ModalOutbound.jsx 約4235–4278行）。
  - **履歴一覧から開いた場合**（`fromShipmentSelection === false`）：左「戻る」、中央「編集」、右「キャンセル」の3ボタン。
  - **配送リストから開いた場合**（`fromShipmentSelection === true`）：左「キャンセル」、右「編集」の2ボタンで、「戻る」がありません。
- そのため「配送準備完了＞編集＞配送リスト」から詳細に入ると、**戻るボタンがなく、キャンセル・編集だけ**になります。下書きからの遷移（＝履歴一覧から開く想定）とは**別のフッター**を使っている状態です。

**対応方針：**

- 配送リスト経由でも、**下書き／履歴一覧経由と同じレイアウト**にそろえる。
  - 左「戻る」（押したら配送リストに戻る＝`onCancelFromShipmentSelection_`）、中央「編集」、右「キャンセル」の3ボタンに統一する。

---

## 4. 商品リストが表示されずフリーズする（配送リスト経由・下書き経由の両方）

**要因：コード上で明確な無限ループは見当たりませんが、次の可能性があります。**

- **考えられる要因**
  1. **API の遅延・未応答**  
     `fetchInventoryTransferDetailForHistory` や `fetchTransferLineItemsEnriched` / `fetchInventoryShipmentEnriched` が長時間ブロックしたり、返ってこない場合、画面が「読み込み中」のまま止まったように見える。
  2. **shipmentId の取り違え**  
     詳細取得時に `sid = selectedShipmentId || d?.shipments?.[0]?.id` としていますが、API が `shipments` を `{ nodes: [...] }` で返す場合、`d.shipments[0]` は undefined です。その場合 `sid` が空になり、shipment 経由の取得をスキップして transfer lineItems にフォールバックします。フォールバック側で失敗や遅延があると、商品が出るまで時間がかかったり、UI が固まったように見える可能性があります。
  3. **loadDetail_ の依存**  
     `loadDetail_` は `[transferId, selectedShipmentId, showImages, liteMode]` に依存し、`useEffect` で `loadDetail_()` を実行しています。`selectedShipmentId` が親で更新されると `loadDetail_` が作り直され、再実行されます。通常は1回で収まりますが、何らかの状態更新の連鎖で複数回走ると、リクエストが重なって遅く感じたり、UI が不安定になる可能性はあります。

**コード上の確認結果**

- `loadDetail_` 内で `setStateSlice(..., historySelectedShipmentId)` はコメントアウトされており、無限ループの直接要因にはなっていません。
- 商品リストの描画は `items.length > 0` のときのみリストを出し、`detailLoading` 中は「読み込み中…」を表示する実装になっています。

**対応の提案**

- 必要なら、**詳細取得のタイムアウト**や**リトライ／エラー表示**を入れると、フリーズと誤認しにくくなります。
- また、`d.shipments` が `{ nodes: [...] }` のときは `d.shipments.nodes[0]?.id` を参照するようにし、`sid` の決定を確実にすると安全です。

---

## 修正実施内容（コード側）

1. **未確定：1 の表示**  
   - `fetchTransfersForOriginAll` 内で shipments を「配列 / nodes / edges / 単体オブジェクト」の4パターンで正規化。  
   - OutboundHistoryScreens.jsx の一覧でも同様の正規化を追加。

2. **フッターの統一**  
   - 配送リスト経由時も、左「戻る」・中央「編集」・右「キャンセル」の3ボタンにし、下書き経由と同じレイアウトにする。

3. **詳細の sid 取得**  
   - `d.shipments` が `{ nodes: [...] }` の場合に `d.shipments.nodes[0]?.id` を参照するようにし、商品取得のフォールバックが確実に動くようにする。
