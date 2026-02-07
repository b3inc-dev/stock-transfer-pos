# POS 棚卸アプリ：一覧の数量表示・商品リスト表示が遅い要因

**対象**: 棚卸タイル（stock-transfer-stocktake）の **POS アプリ**側のみ。管理画面（`/app/inventory-count`）は対象外。

---

## 1. 棚卸一覧の数量表示が遅い要因

**画面**: 棚卸タイルを開いたときの「棚卸ID一覧」（未完了/完了済みタブ）  
**ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountConditions.jsx`

### 1.1 未完了グループの在庫数を出している処理（主因）

- **場所**: `loadIncompleteGroupQuantities`（94–145行付近）
- **動き**:
  - 未完了の棚卸（`count`）ごと → その中の「未完了グループ」（`groupItems` が空のグループ）ごとにループ
  - 各未完了グループで:
    1. **商品リスト取得**: `fetchProductsByGroups([groupId], count.locationId, { filterByInventoryLevel: false })` を **直列**で実行
    2. **在庫数取得**: 返ってきた `products` の **1商品ずつ** `getCurrentQuantity(inventoryItemId, locationId)` を `Promise.all` で実行 → **商品数 N に対して N 回の GraphQL**
- **結果**:  
  未完了の棚卸が 5 件で、それぞれ未完了グループが 2 つ・各 50 商品あると、  
  `fetchProductsByGroups` が最大 10 回（直列）＋ 在庫クエリが 10 × 50 = **500 回**（グループ内は並列だが、グループ・棚卸は直列）となり、一覧の「数量」が揃うまで時間がかかる。

### 1.2 ロケーション名・商品グループ名の取得

- **場所**: 66–91行の `useEffect`（`loadNames`）
- **動き**:
  - 各 `count` について `getLocationName(count.locationId)` を **for 内で await** → 直列（`getLocationName` は内部で `locationCache` を使うので、実質は初回の `fetchLocations()` が 1 回）
  - 各 `count` の各 `productGroupId` について `getProductGroupName(groupId)` を **for 内で await**  
    → `getProductGroupName` は **キャッシュなし**で毎回 `readProductGroups()`（メタフィールド 1 回）を呼ぶ。  
    商品グループ数が多くなると、その分だけ GraphQL が直列で増える。
- **結果**:  
  一覧の「名前」表示のためだけに、グループ数ぶんの API が直列で走り、一覧表示全体の体感を遅くする一因になる。

### まとめ（一覧の数量）

| 要因 | 内容 |
|------|------|
| **主因** | 未完了グループごとに「商品リスト取得」＋「全商品の在庫取得（商品数＝在庫クエリ数）」を直列で実行している。Shopify の API で在庫は 1 商品 1 クエリになるため、商品数が多いとどうしても遅い。 |
| **副因** | ロケーション名はキャッシュで軽いが、商品グループ名はグループごとに `readProductGroups()` を呼んでおり、グループ数が多いと直列の API が増える。 |

---

## 2. 棚卸商品リスト表示が遅い要因

**画面**: 棚卸IDをタップして進んだ「商品リスト」画面  
**ファイル**:  
- `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx`  
- `extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeApi.js`

### 2.1 商品リスト取得＋在庫フィルタ（直列の在庫クエリ）

- **場所**: `stocktakeApi.js` の `fetchProductsByGroups`（298–484行）
- **動き**:
  - `filterByInventoryLevel: true`（商品リスト画面の初期表示で使用）のとき、  
    **在庫レベルがある商品だけ**を残すために、`uniqueVariants` の **1 商品ずつ** `getCurrentQuantity(...)` を **for ループで await**（465–478行）。
- **結果**:  
  商品 100 件なら **100 回の GraphQL が直列**で実行される。ここが商品リストの「表示まで時間がかかる」最大の要因。

### 2.2 表示用の在庫数の再取得（二重取得）

- **場所**: `InventoryCountList.jsx` の `loadProducts` 内（877–903行）
- **動き**:
  - `fetchProductsByGroups(..., { filterByInventoryLevel: true })` で「在庫ありの商品リスト」を取得（この中で上記の直列 N 回の在庫クエリが発生）
  - 返ってきた `products` には **在庫数（currentQuantity）が含まれていない**
  - そのため、表示用に **同じ商品すべて** に対して `getCurrentQuantity(p.inventoryItemId, count.locationId)` を `Promise.all` で再度実行している（887–903行）
- **結果**:  
  在庫フィルタ用に N 回 ＋ 表示用に N 回で、**実質 2N 回**の在庫クエリが発生している（フィルタは直列・表示用は並列）。

### まとめ（商品リスト）

| 要因 | 内容 |
|------|------|
| **主因** | `fetchProductsByGroups` の「在庫レベルでフィルタ」が、商品 1 件ごとに `getCurrentQuantity` を **直列**で呼んでいる。商品数に比例して時間が伸びる。 |
| **副因** | フィルタで在庫を取ったあと、表示用に同じ在庫を再度全件取得しており、在庫クエリが二重になっている。 |

---

## 3. API の制約（共通）

- Shopify Admin API では、**複数の inventoryItem の在庫を 1 クエリで一括取得**する API はない。
- 在庫（`inventoryLevel` / `quantities`）を取るには、**inventoryItem ごとに 1 クエリ**になる。
- そのため「在庫数を使う」以上、**商品数 N に対して最低 N 回のクエリ**は避けられない。  
  遅さを減らすには、「直列を並列にする」「同じ在庫を二重に取らない」「一覧用と商品リスト用で取得の仕方を分ける」などの**呼び方・設計の見直し**が中心になる。

---

## 4. 改善の方向性（表示は省略しない前提）

- **一覧の数量**
  - 未完了グループの「商品リスト取得」は現状のままでも、在庫取得を **グループ内で並列のまま、複数グループをまとめて 1 回の処理**にしたり、**一覧用は在庫を省略して件数だけ先に出し、在庫はバックグラウンドで補填**するなどの設計は、管理画面側と同様に検討できる（POS ではバックグラウンド取得の実装コストは要検討）。
- **商品リスト**
  - **二重取得の解消**: `fetchProductsByGroups` の「在庫フィルタ」のときに、取得した在庫数をそのまま返す形にし、`InventoryCountList` では再び `getCurrentQuantity` を全件呼ばないようにする。これだけで在庫クエリを約半分に減らせる。
  - **直列の在庫クエリの並列化**: `fetchProductsByGroups` 内の「在庫フィルタ」で、`for (v of uniqueVariants) { await getCurrentQuantity(...) }` を、**バッチ（例: 15 件ずつ）に分けて `Promise.all`** にする。表示はそのままで、体感が速くなる。
- **商品グループ名**
  - `getProductGroupName` で `readProductGroups()` の結果を **メモリでキャッシュ**（例: 1 画面の間だけ同じ配列を保持）すると、一覧の名前表示が軽くなる。

---

## 5. 関連ファイル一覧

| 役割 | ファイル |
|------|----------|
| 棚卸一覧（数量・名前） | `InventoryCountConditions.jsx` |
| 棚卸商品リスト | `InventoryCountList.jsx` |
| 商品取得・在庫取得 | `stocktakeApi.js`（`fetchProductsByGroups`, `getCurrentQuantity`, `readProductGroups`, `getProductGroupName`, `getLocationName`） |
