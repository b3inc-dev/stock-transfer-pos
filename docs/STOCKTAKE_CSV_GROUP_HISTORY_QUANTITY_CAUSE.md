# CSVから作成した商品グループで棚卸ID発行後、履歴に数量母数・商品リストが表示されない要因

**日付**: 2026-02-17

## 事象

- CSVからグループを作成し、棚卸IDを発行したあと、
  - **管理画面・アプリタイルともに** 履歴一覧に **数量母数**（件数・実数/在庫数）が表示されない。
  - **管理画面**では、モーダルを開いたときに **商品リストが出ないグループ** がある。

## 商品検索・コレクションから作成した場合は同様にならない理由

- **コレクションから作成**: 保存時に `collectionIds`（と必要なら `collectionConfigs`）が入るため、`get_incomplete_group_products` の **パターン2（コレクションから取得）** で商品が取得され、数量・商品リストが表示される。
- **商品検索（SKU選択）から作成**: 保存時に `inventoryItemIds`（と任意で `skus`）が渡って保存されるため、**パターン1（inventoryItemIds から取得）** で商品が取得される。
- いずれも「`inventoryItemIds` も `collectionIds` も無い」状態にならないため、同じ要因では事象にならない。問題になるのは **CSV で `skus` のみが保存され、`inventoryItemIds` が空のまま** のケースのみ。

## 要因

### 1. 管理画面：未完了グループの商品取得が「inventoryItemIds のみ」を前提にしている

履歴一覧の「〇件・実数 X/在庫数 Y」と、モーダル内の商品リストは、**未完了**のとき次のようにして作られています。

- 一覧・モーダルとも、未完了グループ用に **action `get_incomplete_group_products`** を呼ぶ。
- この action は **メタフィールドの商品グループ（productGroups）** を読んで、  
  `productGroup.inventoryItemIds` または `productGroup.collectionIds` から商品を取得している。

**現在の分岐:**

1. **パターン1**: `collectionIds` が無く、`inventoryItemIds` がある  
   → その ID で GraphQL 取得 → 商品リスト・数量を表示できる。
2. **パターン2**: `collectionIds` がある  
   → コレクションから商品取得。
3. **上記以外**（`collectionIds` も `inventoryItemIds` も無い、または空）  
   → **`return { ok: true, products: [] }`** のため、商品 0 件のままになる。

CSV で作ったグループは次のような状態になり得ます。

- **`skus` だけが入っている**
- **`inventoryItemIds` は未設定、または空**
  - CSV インポート時に `resolveSkusToInventoryItemIds` が失敗 or 0 件
  - または「グループ名＋SKU」だけ保存して、ID 解決していない など

この場合、

- 棚卸ID**発行時**の `getInventoryItemIdsForGroup` では **`group.skus` をフォールバック**で使うため、  
  **count の `inventoryItemIdsByGroup` には正しく ID が入る**。
- 一方、**履歴表示時**の `get_incomplete_group_products` には **`group.skus` のフォールバックが無い**ため、  
  「inventoryItemIds なし・collectionIds なし」と判断され、`products: []` が返る。

その結果、

- 一覧では「件数・実数/在庫数」の元になる `allGroupItems` が空 → **数量母数が表示されない**。
- モーダルでは未完了グループの `displayItems` が空 → **そのグループの商品リストが出ない**。

まとめ: **管理画面では「CSV 由来で skus のみのグループ」に対する未完了用の商品取得が未実装**なことが、履歴の数量母数なし・商品リストなしの主因です。

### 2. アプリタイル（POS）側の数量表示

POS の履歴一覧（商品グループ選択画面）の数量は、

- `count.groupItems`（完了済み）  
  または  
- `fetchProductsByGroups(..., { inventoryItemIdsByGroup: count.inventoryItemIdsByGroup })`（未完了）

で商品を取って、その件数・在庫合計で「実数 X / 在庫数 Y」などを出しています。

- 発行時に `inventoryItemIdsByGroup` にそのグループが入っていれば、通常は `fetchProductsByGroups` で商品が取れ、数量も表示される。
- 次の場合は POS でも数量が出ない・0 になる可能性がある。
  - 発行時の **502 やタイムアウト**で、そのグループ分の ID 取得がスキップされ、`inventoryItemIdsByGroup` にそのグループが入っていない。
  - **グループ ID の形式差**（GID と数値など）で、`inventoryItemIdsByGroup` のキーと `count.productGroupIds` の ID が一致せず、フォールバックでも 0 件になる。

管理画面と同様、「発行直後は未完了」なので、**管理画面で未完了用の商品取得が 0 件だと、一覧の数量母数も出ない**という点は同じです。POS は count の `inventoryItemIdsByGroup` に依存しているため、**発行時に ID が入っていない／キー不一致**だと、こちらも数量が表示されません。

### 3. 管理画面で「商品リストも出ないグループがある」理由

- モーダルでは、グループごとに「完了なら `groupItems`、未完了なら `incompleteGroupProducts`（= `get_incomplete_group_products` の結果）」で表示している。
- CSV 由来で **skus のみ・inventoryItemIds なし**のグループは、上記のとおり `get_incomplete_group_products` が `products: []` を返す。
- そのため、**そのグループだけ**「商品リストが出ない」状態になる。

## 対応方針

### 管理画面（推奨）

**`get_incomplete_group_products` に、`group.skus` のフォールバックを追加する。**

- `productGroup.collectionIds` が無く、`productGroup.inventoryItemIds` も無い（または空）場合に、
  - `productGroup.skus` があれば、**発行時と同じく** `resolveSkusToInventoryItemIds(admin, productGroup.skus)` で ID を解決し、
  - その ID を使って、パターン1と同様に「商品情報＋在庫数」を取得して返す。

これにより、

- 履歴一覧で「〇件・実数 X/在庫数 Y」が表示され、
- モーダルで CSV 由来の未完了グループも商品リストが表示されるようになります。

### 発行時・POS

- 発行時はすでに `getInventoryItemIdsForGroup` で `group.skus` を見ているため、**発行が成功していれば** `inventoryItemIdsByGroup` には入っている想定。
- 502 等で一部グループがスキップされた場合は、**棚卸IDの再発行**や、商品グループ設定で該当グループを編集保存してから再発行すると、`inventoryItemIdsByGroup` が揃い、POS の数量表示も安定しやすい。

## 実装した修正内容（2026-02-17）

- **ファイル**: `app/routes/app.inventory-count.tsx`
- **内容**: `get_incomplete_group_products` に **パターン1b** を追加した。
  - 条件: `collectionIds` が無く、`inventoryItemIds` も無い（または空）だが、**`skus` が存在する**場合。
  - 処理: `resolveSkusToInventoryItemIds(admin, productGroup.skus)` で ID を解決し、解決した ID でパターン1と同様に「商品情報＋在庫数」をバッチ取得して返す。
- これにより、CSV で作成したグループ（skus のみ保存）でも、履歴一覧の数量母数とモーダル内の商品リストが表示される。

## 確認方法

1. CSV で「グループ名, SKU」のみのグループを作成し、棚卸IDを発行する。
2. **管理画面**の棚卸履歴で、該当棚卸の行に「件数・実数/在庫数」が表示されるか、モーダルで該当グループに商品リストが出るかを確認する。
3. 商品検索・コレクションから作成したグループでは、従来どおり表示されることを確認する。
