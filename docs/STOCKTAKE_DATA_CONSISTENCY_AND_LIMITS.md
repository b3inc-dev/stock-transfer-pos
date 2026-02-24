# 棚卸：保存明細・在庫数の読み込み根拠と 250/600 件数について

**日付**: 2026-02

---

## 1. 保存されている明細と在庫数が「不備なく読み込める」根拠

### 1.1 単一の保存先（正しい情報源）

| 項目 | 内容 |
|------|------|
| **保存先** | Shopify メタフィールド `currentAppInstallation.metafield(namespace: "stock_transfer_pos", key: "inventory_counts_v1")` |
| **中身** | 棚卸一覧の JSON 配列。各要素に `id`, `groupItems`, `items`, `productGroupIds`, `status` 等が含まれる。 |
| **確定済みの明細・在庫** | `groupItems` が `{ [groupId]: Array<{ inventoryItemId, currentQuantity, actualQuantity, ... }> }` の形で保存される。 |

- **管理画面**も**アプリタイル**も、この**同じメタフィールド**を読んでいる。
- 確定処理は POS から `writeInventoryCounts(updated)` でメタフィールドを更新するだけなので、**保存経路は1つ**。

### 1.2 読み込み経路の対応関係

| 画面 | 取得処理 | groupItems の参照方法 |
|------|----------|------------------------|
| **管理画面** | loader（GraphQL でメタフィールド取得） | `getGroupItemsByKey(groupItemsMap, id)`（正規化キー照合） |
| **アプリタイル（一覧）** | `readInventoryCounts()` → メタフィールド取得 | `getGroupItemsByKey(groupItemsMap, id)`（同上） |
| **アプリタイル（商品リスト）** | 上記の `count` を props で受け取る | 同上 |
| **アプリタイル（確定処理）** | 既存の `count.groupItems` を参照してスキップ判定 | 同上 |

- 管理画面: `app/routes/app.inventory-count.tsx` で `normalizeIdForMatch` と `getGroupItemsByKey` を定義し、loader・一覧・モーダル・CSV の**すべての groupItems 参照**で使用。
- アプリタイル: `extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeApi.js` で `getGroupItemsByKey` を export。`readInventoryCounts()` の**完了判定**と、`InventoryCountConditions.jsx`・`InventoryCountList.jsx`・`InventoryCountProductGroupSelection.jsx` の**すべての groupItems 参照**で使用。

### 1.3 キー照合の正規化（不備を防ぐ根拠）

- メタフィールドや API 経路によって、**グループ ID が GID（`gid://shopify/.../123`）と数値・文字列（`"123"`）で混在**することがある。
- **getGroupItemsByKey** は `normalizeIdForMatch(id)` で「最後のセグメント」（例: `123`）に揃えてから `groupItemsMap` のキーと照合する。
- そのため、**どちらの形式で保存されていても、読み取り側で同じグループの明細を欠けずに取得できる**。これが「明細数・在庫数が不足したりずれたりしない」ための**コード上の根拠**。

### 1.4 実装箇所の一覧（参照時はすべて getGroupItemsByKey）

- **stocktakeApi.js**
  - `readInventoryCounts()`: 完了判定で `getGroupItemsByKey(groupItemsMap, id)` を使用。
- **app.inventory-count.tsx**
  - loader の完了判定、未完了グループ取得、一覧の itemsFromGroup、モーダル・CSV の groupItems 参照で `getGroupItemsByKey` を使用。
- **InventoryCountConditions.jsx**
  - 未完了タスク収集、一覧の「○件・在庫数」算出（itemsFromGroup と currentQty 加算）で `getGroupItemsByKey` を使用。
- **InventoryCountList.jsx**
  - loadProducts（単一/まとめて）、loadGroupProducts、確定時の「確定済みスキップ」判定、表示時の groupItemsFromMap で `getGroupItemsByKey` を使用。
- **InventoryCountProductGroupSelection.jsx**
  - 在庫数取得と完了判定で `getGroupItemsByKey` を使用。

上記のとおり、**保存されている groupItems を参照する箇所は、管理画面・アプリタイルとも getGroupItemsByKey に統一**されている。  
したがって、「保存されている明細と在庫数を、管理画面・アプリタイルのどちらでも欠けずに読む」という仕様は、**実装とコードで担保されている**。

---

## 2. API 制限・読み込み速度から見た 250 と 600 の根拠

以下は **Shopify 公式の API 制限** と **実装のバッチ・タイムアウト** に基づく根拠である（ドキュメントの「方針」ではなく、API と速度の事実に基づく）。

---

### 2.1 Shopify GraphQL Admin API の制限（公式）

| 制限 | 値 | 出典・意味 |
|------|-----|------------|
| **入力配列の最大サイズ** | **250 件** | [Shopify API rate limits](https://shopify.dev/docs/api/usage/rate-limits): "Input arguments that accept an array have a maximum size of 250. Queries and mutations return an error if an input array exceeds 250 items." |
| **1 クエリあたりのコスト上限** | **1,000 ポイント** | 同上: "A single query may not exceed a cost of 1,000 points." |
| **Connection の first** | 多くのリソースで **最大 250** | ページネーション: 1 リクエストあたり取得件数は 250 が上限となることが多い。 |

したがって、**1 回のリクエストで「配列として渡す ID の数」や「connection の first」は 250 が上限**であり、これを超えるとエラーになる。

---

### 2.2 入庫・出庫で 250 を使う根拠（API 制限との一致）

- **250 は API の入力・connection の上限に合わせた値**である。
- 実装例:
  - 出庫タイル: `first = Math.max(1, Math.min(250, Number(opts.first ?? 250)))`（商品リスト 1 ページあたり）。
  - 棚卸の `stocktakeApi.js`: `productFirst = Math.min(250, ...)`、`variants(first: 250)` で **GraphQL の first を 250 にキャップ**。
- **根拠**: 「1 度に 250」にすることで、**入力配列 250 以下**・**connection first 250 以下** を満たし、**1 リクエストでエラーにならない**。入庫・出庫はこの「1 リクエストあたり最大 250」で統一している。

---

### 2.3 棚卸で「600」が API 制限に触れない根拠

棚卸の **600 は「1 回の GraphQL リクエストに渡す件数」ではない**。内部で **250 以下に分割してリクエスト**している。

- **商品取得（バリアント一覧）**
  - **nodes(ids)** を使う経路: `stocktakeApi.js` で **batchSize = 50**（344–346 行）。600 件なら 12 バッチで、**各リクエストの ids は 50 件（250 以下）**。
  - **collection.products** を使う経路: `productFirst = Math.min(250, ...)`、`variants(first: 250)`（461, 427, 447 行）。**1 リクエストあたりの first は 250**。
- **返却件数**: 上記で集めた `uniqueVariants` を **slice(offset, offset + limit)** している（500 行）。`limit: 600` は「**クライアントに返す 1 ページあたりの件数**」であり、**1 クエリの入力や first を 600 にしているわけではない**。

したがって、**600 は API の「入力 250」「connection first 250」を破っていない**。根拠は「実装が 50 件バッチ・first 250 に分割していること」である。

---

### 2.4 読み込み速度から 600 が「上限付近」である根拠

- **在庫数取得（getCurrentQuantity）**
  - 実装: **QTY_BATCH_SIZE = 15**（504 行）。バリアント N 件に対し、在庫は **N/15 回** の GraphQL リクエスト（各 1 クエリ）で取得している。
  - **250 件**: 250/15 ≈ **17 リクエスト**。1 リクエスト 200–500 ms と仮定すると **約 3.4–8.5 秒**。
  - **600 件**: 600/15 = **40 リクエスト**。同様に **約 8–20 秒**。
- **クライアント側タイムアウト**
  - `stocktakeApi.js` の `graphql()`: **timeoutMs = 20000**（10 行）。1 リクエストあたり 20 秒で打ち切り。
  - 40 リクエストが直列に近い形で実行されるため、**600 件は「全体で 20 秒前後になりうる上限付近」** の件数である。これ以上（例: 900 件）にすると 60 リクエストとなり、**読み込み時間が 20 秒を超えやすく、タイムアウト・体感悪化のリスク**が増える。

したがって、**600 は「API 制限を守ったうえで、1 ページあたりの在庫取得リクエスト数（40 回）と 20 秒タイムアウトのバランスから決めた上限付近の値」** として説明できる。

---

### 2.5 まとめ（API・速度の観点のみ）

| 項目 | 250（入庫・出庫） | 600（棚卸 1 ページ） |
|------|-------------------|----------------------|
| **API 入力/connection** | 1 リクエストあたり **最大 250**（公式上限に一致） | **1 リクエストは 250 以下**。600 は「複数バッチの結果をまとめた 1 ページあたりの表示件数」。 |
| **在庫取得リクエスト数** | 250/15 ≈ **17 回** | 600/15 = **40 回** |
| **想定読み込み時間** | 約 3–8 秒 | 約 8–20 秒（20 秒タイムアウトの範囲内） |
| **根拠** | Shopify の **Input/Pagination 上限 250** に合わせた値 | **入力 250 はバッチで遵守**。600 は **20 秒タイムアウトと 40 回リクエストから許容できる上限付近**。 |

**結論**: 250 は **API 制限そのもの**（入力・connection の最大 250）に合わせた根拠がある。600 は **API では 250 以下に分割している** ため制限違反にならず、**読み込み速度と 20 秒タイムアウト** から「1 ページ 600 件まで」が同等の根拠（許容上限）として説明できる。
