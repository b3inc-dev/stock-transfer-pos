# 在庫情報：日別在庫高「数量以外が0で保存される」要因分析

**作成日**: 2026年2月7日  
**対象**: 管理画面「在庫情報」の日別スナップショット（`api.inventory-snapshot-daily` および `app.inventory-info` の今日のリアルタイム表示）

---

## 現象

- **日別在庫高の「数量」**は正しく保存・表示されている。
- **販売価格合計（totalRetailValue）・割引前価格合計（totalCompareAtPriceValue）・原価合計（totalCostValue）**が 0 で保存・表示されることがある。
- **リアルタイム（今日）**では数量・金額とも正しく表示されるが、**前日など過去日を選ぶと金額が 0** になる。

---

## 根本原因（2026-02-07 修正）

**日次スナップショットAPI（`api.inventory-snapshot-daily`）で GraphQL の呼び出し形式が誤っていた。**

- `shopify.clients.Graphql` の `request` メソッドの正しい形式は **`request(クエリ文字列, { variables })`**（第1引数＝クエリ文字列、第2引数＝オプション）。
- 従来は **`request({ data: クエリ, variables })`** と1つのオブジェクトで渡しており、内部で `query: operation` として送信されると **`query` にオブジェクトが入る**形になっていた。
- その結果、Shopify API に送られるクエリが不正となり、**価格・原価に相当するフィールド（variant.price / unitCost 等）が返ってこない、またはレスポンス構造が期待と異なる**状態になり、集計時に 0 になっていた。
- 管理画面の「今日」は `authenticate.admin(request)` 経由の **`admin.graphql(クエリ文字列, { variables })`** で正しく呼んでいるため、リアルタイム表示だけ金額が正しかった。

**対応**: `api.inventory-snapshot-daily.tsx` で次の3箇所を修正した。

1. スナップショット取得: `admin.request(GET_SNAPSHOTS_QUERY)`（第1引数をクエリ文字列に）
2. 在庫アイテム取得: `admin.request(INVENTORY_ITEMS_QUERY, { variables: { first: 50, after: cursor } })`
3. Metafield 保存: `admin.request(SAVE_SNAPSHOTS_MUTATION, { variables: { metafields: [...] } })`

あわせて、`request` の戻り値が Response ではなくオブジェクトの場合にも対応するため、`resp.json()` の代わりに「`resp.json` が関数なら `await resp.json()`、そうでなければ `resp` をそのまま使う」ようにレスポンスの取り扱いを統一した。

---

## 保存・集計の流れ

1. **日次スナップショットの保存**  
   Cron から `api.inventory-snapshot-daily` を呼び出し、**前日**の在庫を `inventoryItems` GraphQL で取得し、ロケーション別に「数量・販売価格合計・割引前価格合計・原価合計」を集計して Metafield に保存する。

2. **集計ロジック（共通）**  
   `app/routes/api.inventory-snapshot-daily.tsx` および `app/routes/app.inventory-info.tsx` の loader（今日のリアルタイム表示）では、次のように計算している。

   - `quantity` = `inventoryLevel.quantities(name: "available")` の値（在庫数）
   - `retailPrice` = `variant?.price ?? "0"` を `parseFloat`
   - `compareAtPrice` = `variant?.compareAtPrice ?? "0"` を `parseFloat`
   - `unitCost` = `item.unitCost?.amount ?? "0"` を `parseFloat`
   - ロケーションごとに  
     `totalQuantity += quantity`  
     `totalRetailValue += quantity * retailPrice`  
     `totalCompareAtPriceValue += quantity * (compareAtPrice || retailPrice)`  
     `totalCostValue += quantity * unitCost`

---

## 要因（数量は正しく、金額系が 0 になる理由）

### 1. 原価（totalCostValue）が 0 になる

- **原因**: 商品の**原価（コスト）をストアで設定していない**場合が多い。
- Shopify の在庫アイテムには `unitCost` があり、管理画面の「原価」で設定する。未設定の場合は API でも `unitCost` が null/未設定となり、コードでは `"0"` として扱うため、**原価合計は常に 0** になる。
- **対応**: 商品・在庫管理で原価を入力すると、次回以降の日次スナップショットから原価合計が反映される。コード側の不具合ではない。

### 2. 販売価格合計・割引前価格合計（totalRetailValue / totalCompareAtPriceValue）が 0 になる

- **原因候補**:
  1. **在庫アイテムに紐づく `variant` が null**  
     商品削除後も在庫レコードが残っている場合など、`inventoryItem.variant` が null になることがある。このとき `variant?.price` は undefined となり、`retailPrice` は 0 で集計される。
  2. **バリアントに価格が設定されていない**  
     価格未設定のバリアントでは `variant.price` が null/空の可能性がある。
  3. **GraphQL の取得範囲**  
     現在のクエリでは `variant { id, sku, price, compareAtPrice, product { id, title } }` を取得している。通常はここで価格は取れるが、販売チャネル・Market によっては別価格になる場合があり、Admin API のデフォルト価格が想定と異なる可能性はある（多くの場合は 0 の主因にはならない）。

- **確認方法**:
  - 管理画面の「商品」で、対象ロケーションに在庫がある商品の「価格」が設定されているか確認する。
  - 削除済み商品の在庫が残っていないか確認する（在庫調整で 0 にするか、不要なら無視してよい）。

### 3. まとめ

| 項目 | 原因 | 対応 |
|------|------|------|
| 数量だけ正しい | 数量は `inventoryLevel.quantities("available")` から取得しており、価格に依存しないため常に集計される。 | 特になし（仕様どおり）。 |
| 原価合計が 0 | 商品の「原価」をストアで設定していない。 | 管理画面で原価を入力すると反映される。 |
| 販売・割引前価格合計が 0 | ① variant が null（削除済み商品の在庫など）② バリアントの価格未設定。 | 価格設定の確認。variant が null の在庫は集計で 0 として扱われる（現状の仕様）。 |

---

## コード上の注意点

- `app.inventory-info.tsx` の loader と `api.inventory-snapshot-daily.tsx` の集計ロジックは同じ前提（`variant?.price` / `item.unitCost?.amount`）で計算している。
- **今日**の在庫高は loader でリアルタイムに同じロジックで集計しているため、「今日」も過去の日別スナップショットも、金額が 0 になる条件は同じ。
- デバッグする場合は、取得した `item.variant` や `item.unitCost` の有無をログ出力すると、自店舗でどれが効いているか確認しやすい。

---

## 今後の改善案（任意）

- variant が null の在庫アイテムをスキップするか、別ラベルで「価格未設定」として件数だけ表示するなどの運用を検討できる。
- 原価が未設定の商品が多い旨を、在庫情報画面に注釈で表示するのもよい。
