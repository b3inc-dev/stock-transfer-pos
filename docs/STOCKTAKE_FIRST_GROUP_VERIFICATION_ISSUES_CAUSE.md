# 初めて商品グループを作って検証した際の不具合要因

## 現象

- **アプリタイル**: 商品リストを読み込まなくなっている。
- **管理画面**: 進捗状況に商品グループごとの在庫数の表示がなく、合計も件数だけになっている。

※ 補足: 「棚卸 1 件のとき一覧が空」ではなく、**商品グループ 14 件・SKU 2525 件は管理画面では表示されているが、アプリタイル側だけ商品リストが読み込めない**ケースを以下で扱う。

---

## 要因

### ① アプリタイルで商品リストを読み込まなくなる要因

**A. 棚卸が 1 件だけのとき、一覧が空になる経路（別ケース）**

- 管理画面で **棚卸を初めて 1 件だけ発行** した場合、`writeInventoryCountsChunked` では「1 件かつサイズが CHUNK_BYTES 以下」のとき **メインキー（`inventory_counts_v1`）に配列 1 件をそのまま保存** するだけで、**list 用メタフィールドもチャンク（`inventory_counts_v1_c0`）も書かない**。
- POS 側の `readInventoryCountsFirstPage` では、メインキーが **配列** のときに `writeInventoryCounts(parsed)` のあと **チャンク 0 を読む** 実装になっており、チャンク 0 が存在しないと一覧が空になる。  
  → 本件は「14 グループ・2525 SKU で管理画面では表示されている」ため、**一覧は出ているが商品リストだけ読めない**別要因を考える必要がある。

**B. 一覧は出るが、商品リストだけ読めない場合（14 グループ・2525 SKU など）**

- 一覧表示の count は **list 用メタフィールド**（`toMinimalCountForList`）由来で、**`inventoryItemIdsByGroup` は含まれない**。
- タップ後は `readInventoryCountById` で **メインチャンク** からフルデータ（`inventoryItemIdsByGroup` 含む）を取る想定。
- **想定される要因:**
  1. **`readInventoryCountById` が null を返している**  
     インデックスに該当棚卸が無い、または `readInventoryCountsRaw()` でメインチャンクから見つからない（countId 形式の違いなど）。その場合 `effectiveCount` は list の count のままとなり、`inventoryItemIdsByGroup` が無いので **コレクション経路** に依存する。
  2. **コレクション経路で POS が商品を取れない**  
     - `readProductGroups()` が POS 側で **空配列** を返している（`product_groups_v1` の取得失敗・GraphQL エラーで catch 時に `[]` を返している）。  
     - 管理画面と POS で **アプリインストールが異なる**（別アプリ／別ショップ）と、POS からは `product_groups_v1` が読めず、`targetGroups` が空になる。
  3. **`inventoryItemIdsByGroup` が保存時に省略されている**  
     発行時ペイロードが `METAFIELD_VALUE_MAX_BYTES` を超え、`inventoryItemIdsOmittedDueToSize` により `inventoryItemIdsByGroup` を付けずに保存している。その場合もコレクション経路にフォールバックするが、上記 2 の理由で POS では 0 件になる可能性がある。
  4. **list の `productGroupIds` と `product_groups_v1` のグループ id の形式不一致**  
     GID と数値 id の差で `targetGroups` が空になり、結果 0 件になる（通常は `normalizeIdForMatch` で吸収する想定だが、保存形式によっては不一致の可能性あり）。
  5. **`fetchProductsByGroups` のタイムアウト・エラー**  
     2525 件をコレクション経路で取得する際にタイムアウトや GraphQL エラーで失敗し、商品リストが 0 件のままになる。

**確認のポイント**

- POS で `readInventoryCountById(count.id)` の戻りが **null かどうか**（null なら list の count のみで商品取得している）。
- POS で `readProductGroups()` の戻りが **14 件あるか・各グループに `collectionIds` があるか**。
- 管理画面で該当棚卸作成時に **`inventoryItemIdsOmittedDueToSize` が立っていないか**（ペイロードが大きすぎて `inventoryItemIdsByGroup` を保存していないか）。
- 管理画面とアプリタイルが **同一ショップ・同一アプリ** の同じ `currentAppInstallation` を参照しているか。

---

### ② 管理画面で進捗・合計が「件数のみ」になる要因

**list 由来のデータと loader の仕様**

- 一覧用 list メタフィールドには **`toMinimalCountForList`** の項目だけが入る（id, locationId, status, countName, createdAt, productGroupIds, productGroupNames, cancelledGroupIds）。  
  **groupItems** も **inventoryItemIdsByGroup** も list には含まれない。
- さらに loader では、クライアントへ返す直前に **`inventoryItemIdsByGroup` を意図的に削除** している（39 グループ×5600SKU 等での Application Error 防止のため）。
- そのため **list 優先で表示しているとき**、クライアントが持つ棚卸データには  
  - **groupItems**（グループごとの確定済み明細・在庫数／実数）  
  - **inventoryItemIdsByGroup**（グループごとの SKU 数・母数）  
  のどちらもない。

**進捗表示で参照しているデータ**

- 進捗状況の「**商品グループごとの在庫数**」や「**合計（在庫数／実数）**」は、  
  **groupItems** や **inventoryItemIdsByGroup** を元に計算している。
- list のみのデータではこれらの項目がないため、  
  - グループごとの在庫数は計算できず表示されない、  
  - 合計も「**件数**」（例: 合計 10 件）だけになり、在庫数／実数の合計は出ない。

---

## まとめ

| 現象 | 主な要因 |
|------|----------|
| アプリタイルで商品リストを読み込まない（一覧は出るがタップ後が空） | ① 棚卸 1 件のみで一覧が空になる経路は別ケース。② **一覧は出るが商品リストだけ読めない**場合は、(1) `readInventoryCountById` が null を返して list の count のみで商品取得している、(2) POS で `readProductGroups()` が空でコレクション経路が使えない、(3) 保存時に `inventoryItemIdsByGroup` が省略されコレクション経路に依存しているが (2) で失敗、(4) id 形式不一致で `targetGroups` が空、(5) 取得タイムアウト・エラー、のいずれか。 |
| アプリタイルで一覧自体が空（1 件のみのとき） | メインが配列 1 件でチャンクを書いていないのに、POS がチャンク 0 を読もうとして一覧が空になる。 |
| 管理画面で進捗・合計が「件数のみ」 | list 用データには groupItems / inventoryItemIdsByGroup が含まれず、loader でも inventoryItemIdsByGroup を削除しているため、グループごとの在庫数や合計（在庫数／実数）を計算する元データがクライアントにない。 |

---

## 修正の方向性（参考）

1. **POS の `readInventoryCountsFirstPage`**  
   メインキーが **配列** のときは、`writeInventoryCounts` を呼んだあとでチャンク 0 を読むのではなく、**parsed をそのまま counts として利用** する（チャンク 0 が存在しない場合のフォールバック）。
2. **管理画面の進捗・合計**  
   list のみのデータでは groupItems / inventoryItemIdsByGroup がないため、  
   - list 由来の棚卸を開いたときは「商品リストを読込中...」のあと、**get_incomplete_group_products 等で取得したデータ** で進捗・合計を計算するか、  
   - 進捗・合計表示に必要な最小限の情報を list に含めるか、  
   のいずれかの仕様検討が必要。
