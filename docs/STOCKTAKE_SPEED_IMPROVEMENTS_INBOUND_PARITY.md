# 棚卸アプリタイル：入庫並みの表示速度への改善

**目的**: 棚卸の「履歴一覧・グループ一覧・商品リスト」の 3 レベルで、入庫と同様の処理・表示速度に近づける。

---

## 1. 3 レベルの差異まとめ（改善前）

| レベル | 入庫 | 棚卸（改善前） |
|--------|------|----------------|
| **履歴一覧** | Transfer 一覧を 1 回の GraphQL で取得。数量（totalQuantity/receivedQuantity）は API に含まれるため追加クエリなし。 | 一覧は readInventoryCountsFirstPage で軽量取得。ただし **未完了の全棚卸の全未完了グループ** に対して fetchProductsByGroups ＋ getCurrentQuantity（全 SKU 分）を実行しており、一覧表示が重い。 |
| **グループ一覧** | 1 Transfer に紐づく Shipments は API に含まれる。配送選択のみ。 | 棚卸 1 件を readInventoryCountById で取得。在庫数は「在庫数読込」ボタンで取得（自動読込なし）。商品グループ名は getProductGroupName（60 秒キャッシュ）で取得。 |
| **商品リスト** | 1 配送の lineItems(first: 250) を **1 回の GraphQL** で取得。予定数・受入数は lineItems に含まれるため在庫クエリ不要。 | 商品取得 ＋ **在庫フィルタで 1 SKU あたり 1 回** getCurrentQuantity（15 件バッチで約 250 回）。初回表示が遅い。 |

---

## 2. 実施した改善

### 2.1 履歴一覧（InventoryCountConditions.jsx）

- **変更**: 未完了グループの在庫数を自動取得する `loadIncompleteGroupQuantities` の **useEffect を削除**。
- **結果**: 一覧表示時は readInventoryCountsFirstPage/Page のみで、在庫のための fetchProductsByGroups / getCurrentQuantity は発生しない。入庫の履歴一覧と同様に「一覧用は追加クエリなし」になる。
- **表示**: 数量は groupItems がある場合のみ表示。未取得時は「N件 実数/—」のように「—」で表示。

### 2.2 グループ一覧（InventoryCountProductGroupSelection.jsx）

- **変更**: なし。もともと在庫数は「在庫数読込」で取得し、初回は自動読込していない。商品グループ名は getProductGroupName のキャッシュで 1 回 readProductGroups のあとはキャッシュヒット。

### 2.3 商品リスト（InventoryCountList.jsx）

- **変更**:
  1. **初回表示**: `fetchProductsByGroups(..., { filterByInventoryLevel: false })` に変更。商品マスタのみ取得し、在庫クエリは行わない。在庫数は 0 で表示し、ユーザーが「在庫更新」で取得。
  2. **さらに読み込む**: 同様に `filterByInventoryLevel: false` に変更。追加ページも在庫クエリなしで表示。
  3. **在庫更新ボタン**: 全行を一括で Promise.all していた部分を **15 件ずつバッチ** で取得するように変更。レート制限を避けつつ在庫数を更新。

- **結果**: 商品リストの初回表示は「商品取得 1〜数回」のみで完了し、入庫の 1 配送選択時（1 回の GraphQL）に近い体感になる。在庫数が必要なときだけ「在庫更新」を押す運用。

---

## 3. 変更ファイル一覧

| ファイル | 変更内容 |
|----------|----------|
| `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountConditions.jsx` | 未完了グループ在庫数自動取得の useEffect 削除。fetchProductsByGroups / getCurrentQuantity の import 削除。 |
| `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx` | 初回・追加読み込みで filterByInventoryLevel: false。在庫更新を 15 件バッチで実行。 |
| `docs/INBOUND_VS_STOCKTAKE_DISPLAY_SPEED_COMPARISON.md` | 改善後のまとめと「7. 実装した改善」を追加。 |

---

## 4. 利用上の注意

- **棚卸の商品リスト**では、初回表示時は在庫数が 0 で出ます。実在庫を反映したい場合は **「在庫更新」ボタン** を押してください。
- **履歴一覧**では、未完了の棚卸について「実数/現在」の「現在」が「—」になる場合があります。完了済みや groupItems が保存済みの棚卸は従来どおり数量が表示されます。
