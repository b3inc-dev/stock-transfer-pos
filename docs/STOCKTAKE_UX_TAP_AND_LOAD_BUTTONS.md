# 棚卸：グループ一覧タップ遅延・まとめて表示の読込ボタン要因と対応

**日付**: 2026-02

---

## 1. 商品グループ一覧 → 商品リストの「タップが効かない・遅い」要因

### 要因

- **onSelectProductGroup** 内で、画面遷移（`onNext`）の**前**に次の処理を **await** していたため、その完了まで画面が切り替わらず、タップの反応が遅く感じられていました。
  - `readInventoryCounts()` で棚卸一覧を取得
  - `writeInventoryCounts(updated)` でステータスを `draft` → `in_progress` に更新
- 上記の読み書きが重い環境やネットワークだと、**タップから 1〜2 秒以上**かかり、その間は何も変わらないため「タップが効いていない」ように見えていました。

### 対応

- **先に `onNext(...)` で商品リストへ遷移**し、その**後に**ステータス更新だけを**非同期（fire-and-forget）**で実行するように変更しました。
- タップ後はすぐに商品リストに切り替わり、ステータス更新はバックグラウンドで行われます。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`  
（`onSelectProductGroup` を同期的に `onNext` を呼ぶ形にし、draft 時の書き込みは即座に起動する async IIFE で実行）

---

## 2. まとめて表示のグループ横「読込」ボタンが反応しない要因

### 想定されていた要因

- **POS の `s-button`** では、環境によって **onPress** だけではタップが届かない場合があります。**onClick** を併用すると確実に発火します。
- **disabled={loadingGroupId != null}** のときは「いずれかのグループの読込中」なので、**すべての読込ボタンが無効**になります。別のグループの読込が終わっていない、または `loadingGroupId` が何らかの理由でクリアされていないと、どの読込ボタンも押せません。
- **loadGroupProducts(groupId)** の先頭で `!groupId` などの条件で return している場合、**loadingGroupId をセットする前に return** しているため、見た目上は「押しても何も起きない」ように見えます（通常は groupId は入っている想定）。

### 対応

- まとめて表示のグループ横「読込」ボタンに **onClick** を追加し、**onPress** と **onClick** のどちらでも `loadGroupProducts(groupId)` が呼ばれるようにしました。
- 読み込み中はもともと **「読込中...」** と表示され、**disabled** になるため、そのまま「読込中はボタンが読込中... で無効」という見た目でステータスが分かります。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx`  
（該当の `s-button` に `onClick={() => loadGroupProducts(groupId)}` を追加）

---

## 3. 商品グループ一覧の「在庫数読込」ボタン位置

- **要望**: 左側の明細4行（商品グループを選択・棚卸ID・ロケーション・商品グループ数）の**上下中央**に「在庫数読込」を配置する。
- **対応**: ヘッダーを **横並び（inline）** にし、**左にボタン**、**右に上記4行のテキスト**を配置。`alignItems="center"` でボタンとテキストブロックを縦方向中央揃えにしました。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`  
（setHeader 内のレイアウトを `s-stack direction="inline" alignItems="center"` で左＝ボタン・右＝明細に変更）

---

## 4. 商品グループ一覧の「在庫数読込」ボタンが反応しない要因（ヘッダー実装のまま）

### 要因

- **ヘッダーは setHeader で別ツリーに渡して描画**されているため、POS のヘッダー領域では **onPress だけでは発火しない**環境があり、**onClick を主に**する必要があります。
- **動いているヘッダーボタン**（例: InventoryCountList の「在庫更新」「画像ON/OFF」、InventoryCountConditions の「未完了/完了済み」）は **onClick** で実装されています。在庫数読込も同じパターンに揃える必要がありました。
- **onClick / onPress の両方が同じタップで発火**すると、処理が二重に走る可能性があるため、**ref による二重発火防止**を入れると安全です。

### 対応（本文には出さずヘッダーのまま）

- 在庫数読込ボタンを **onClick / onPress の両方で「インライン呼び出し」**（`onClick={() => handleLoadQuantities()}`）にし、**動いているヘッダーボタンと同じパターン**に統一しました。
- **読み込み中は「読込中...」** に切り替え、**disabled** のまま（本文には映さずヘッダー内でそのまま表示）。
- **loadingQuantitiesRef** で二重発火を防止しています。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`

---

## 5. ヘッダー・スクロール内ボタンの統一（確実に処理されるように）

- **問題なく動いている箇所**: FixedFooterNavBar は **onClick のみ**。InventoryCountList のヘッダー（在庫更新・全数量反映・リセット・画像ON/OFF）は **onClick**。InventoryCountConditions のヘッダー（未完了/完了済み）は **onClick**。
- **対応**: 棚卸の「読込」系ボタン（在庫数読込・まとめて表示の読込・さらに読み込む）を、**onClick と onPress の両方でインライン呼び出し**に統一し、**ref で二重発火防止**を追加しました。
- 読み込み中はすべて **「読込中...」** 表示＋**disabled** で、目で見てステータスが分かります。

---

## 6. 商品リストの「さらに読み込む」が 250 件で止まる要因

### 要因

- **コレクション経路**（商品グループが「コレクション」で作られ、`inventoryItemIdsByGroup` が保存されていない場合）では、`fetchProductsByGroups` が **`collection.products(first: 250)` の1回だけ** を叩いており、**次のページ（cursor/after）を取得していません**。
- そのため `uniqueVariants` は最大 250 件で、**さらに読み込む**で `offset=250` を渡しても `slice(250, offset+limit)` が空になり、0 件しか返らず件数が増えません。
- **SKU/CSV で作ったグループ**（`inventoryItemIdsByGroup` が保存されている場合）では、保存済み ID を `slice(offset, offset+limit)` で分割取得しているため、**さらに読み込む**で 250 件を超えて増えます。

### 対応（コレクション経路のページネーション対応）

- コレクション経路でも 250 件超を読めるように、以下を実装しました。
  - **API（stocktakeApi.js）**: `collection.products` の GraphQL に **pageInfo { hasNextPage, endCursor }** を追加。初回は `after: null`、さらに読み込む時は `opts.collectionPageInfo` に前回の pageInfo を渡し、各コレクションごとに `after: endCursor` で次ページを取得。返却に **collectionPageInfo** を含め、クライアントが次回に渡せるようにした。
  - **クライアント（InventoryCountList.jsx）**: **collectionPageInfoRef** で前回レスポンスの pageInfo を保持。初回取得後にセット、さらに読み込む時に `fetchProductsByGroups` に渡す。棚卸/グループ切り替え時は ref を null にリセット。
- CSV/SKU 経路（inventoryItemIdsByGroup）は従来どおり offset/limit で継続取得。

---

## 7. 下書き復元後に「さらに読み込む」が効かなくなる要因と対応

### 要因

- 下書き復元時は **行データ（lines）だけ** を `setLines` で復元しており、**「まだ読み込んでいない分があるか」を表す `hasMoreProducts` を設定していませんでした**。
- そのため、復元後は `hasMoreProducts` が初期値の `false` のままになり、「さらに読み込む」ボタンが表示されない／押せない状態になっていました。未読込のリストがそのまま読めなくなる問題がありました。

### 対応

- 下書き復元ブロック（まとめて表示モード・単一グループモードの両方）で、復元後に **`hasMoreProducts` を再設定**するようにしました。
  - **`inventoryItemIdsByGroup` がある場合**: 対象グループの保存 ID 総数が復元した行数より多ければ `hasMoreProducts = true`。
  - **ない場合（コレクションのみ）**: 復元した行数が初回表示件数（例: 250）以上なら `hasMoreProducts = true` とし、ユーザーが「さらに読み込む」を試せるようにしました。
- あわせて **`hasMoreProductsRef.current`** も同じ値で更新し、タップ時のスタレ閉じ込め対策と整合するようにしています。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx`  
（下書き復元時の `setLines` の直後に `hasMoreProducts` / `hasMoreProductsRef` の再設定を追加）

---

## 8. 棚卸以外のタイルの「さらに読み込む」確認結果

棚卸で行った「250 で止まる」「下書き復元で未読込が読めない」対策の影響範囲を確認し、他タイルに同様の問題がないかチェックした結果です。

| タイル | 主なリスト | さらに読み込む | 確認結果 |
|--------|------------|----------------|----------|
| **入庫** | 入荷明細（shipment lineItems）・検索候補 | `loadMoreLineItems_`（pageInfo/after）・`handleLoadMoreAddSearch`（searchVariants の after） | ✅ 問題なし。API が pageInfo/after を返し、クライアントで保持・渡している。 |
| **ロス** | 検索候補のみ（スキャン/検索で行を追加） | 検索の `handleLoadMoreSearch`（searchVariants の after） | ✅ 問題なし。lossApi.searchVariants は after 対応・pageInfo 返却。検索結果が 50 件超のときボタン表示。 |
| **注文** | 検索候補・注文明細 | 検索の `handleLoadMoreSearch` | ✅ 問題なし。orderApi.searchVariants は after 対応。 |
| **調整** | 検索候補・調整明細 | 検索の `handleLoadMoreSearch` | ✅ 問題なし。adjustmentApi.searchVariants は after 対応。 |
| **発注** | 検索候補・発注明細 | 検索の `handleLoadMoreSearch` | ✅ 問題なし。purchaseApi.searchVariants は after 対応。 |
| **出庫（タイル）** | 出庫明細（transfer/shipment lineItems）・検索候補 | `loadMoreLineItems_`（fetchInventoryShipmentEnriched の after）・`handleLoadMoreSearch` | ✅ 問題なし。lineItems(first, after) と pageInfo で追加読み込み済み。 |

### 補足

- **棚卸だけ**が「コレクションから 1 回 250 件取得」の商品リストを持っており、今回の「コレクション経路の cursor 対応」と「下書き復元時の hasMoreProducts 再設定」は棚卸専用の対応です。
- 入庫・出庫は **shipment/transfer の lineItems** を pageInfo/after でページング取得しており、初回から after 対応済みです。
- ロス・注文・調整・発注は **検索候補**のみ「さらに読み込む」対象で、いずれも `productVariants(first, query, after)` と pageInfo で実装済みです。
- 履歴一覧の「さらに読み込む」（棚卸・入庫・ロス・注文・調整・発注の各 HistoryList）は、チャンク/ページ単位の取得で実装されており、今回の変更対象外です。

---

## 9. 商品グループ一覧の「在庫数読込」で件数が多いと 0件-/- になる要因と対応

### 要因

- 在庫数読込では、**未処理グループ**ごとに `fetchProductsByGroups` で商品リストを取得したあと、**全商品に対して `getCurrentQuantity` を同時に**（`Promise.all(products.map(...))`）呼んでいました。
- さらに**全グループを並列**（`Promise.all(productGroupIds.map(...))`）で処理していたため、グループ数 × 商品数（最大で 250 件/グループ）の **GraphQL 呼び出しが一斉に発生**していました。
- 件数が多い（例: 1 グループ 250 件、または複数グループで合計 200 件超）と、Shopify API の**レート制限やタイムアウト**で一部が失敗し、`Promise.all` が reject されて catch 内で **total/actual/skuCount が 0** になり、「0件 -/-」と表示されていました。

### 対応

- **グループは順次処理**に変更（`Promise.all(productGroupIds.map(...))` → `for (const groupId of productGroupIds) { ... await ... }`）。同時に複数グループの在庫取得を行わないようにしました。
- **在庫数取得を 15 件ずつバッチ化**（`stocktakeApi` の `QTY_BATCH_SIZE` と同様）。`getCurrentQuantity` を全件一括ではなく、15 件ずつ `await Promise.all(batch.map(...))` で実行するようにしました。
- 上記により、同時実行数が「最大 15 リクエスト」に抑えられ、レート制限による失敗を避けやすくしています。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`  
（`loadProductGroupQuantities` 内：グループの順次処理と getCurrentQuantity の 15 件バッチ化。あわせて `fetchProductsByGroups` の戻り値が配列／`{ products }` のどちらでも扱えるように `toProducts(raw)` を追加）

### 履歴詳細の商品リスト（初回表示件数・さらに読み込む）

- **要望**: 履歴一覧からエントリをタップして開く「詳細の商品リスト」でも、設定の**アプリ表示件数（初回読み込み）**を反映し、超過分は「さらに読み込む」で表示できるようにする。
- **対応**: ロス・注文・調整・発注の各履歴一覧で、詳細表示時の商品リストに以下を実装しました。
  - **設定の反映**: `fetchSettings()` で `productList.initialLimit`（既定 250）を取得し、詳細を開いた直後の表示件数として使用。
  - **表示**: `entry.items` を `slice(0, detailDisplayLimit)` で表示。詳細を開くたびに `detailDisplayLimit` を `detailInitialLimit` にリセット。
  - **さらに読み込む**: 表示件数が `detailDisplayLimit` を超える場合にボタンを表示し、押下で `detailDisplayLimit` を 600 件ずつ増加（棚卸の LOAD_PAGE_SIZE と同様）。
- **変更ファイル**:
  - `extensions/stock-transfer-loss/src/screens/loss/LossHistoryList.jsx`
  - `extensions/stock-transfer-order/src/screens/order/OrderHistoryList.jsx`
  - `extensions/stock-transfer-adjustment/src/screens/loss/AdjustmentHistoryList.jsx`
  - `extensions/stock-transfer-purchase/src/screens/purchase/PurchaseHistoryList.jsx`

---

## 10. まとめて表示の不具合修正（2026-02-25）

### 事象

- **まとめて表示**で「商品がありません」と表示され、グループリストや各グループの「読込」ボタンが出ず、一度も商品グループごとに表示で開いていない場合はリストを読み込めない。
- グループ横の「読込」ボタン押下時に **Can't find variable c** が表示される。
- 最上部の「読込」ボタンが、1グループだけ読み込んだあとに消えてしまう。どのグループの読込になっているか分かりにくい。

### 要因

1. **グループリスト非表示**: まとめて表示モードで `lines.length === 0` のときに「商品がありません」で早期 return しており、`targetProductGroupIds` からグループ一覧と各「読込」ボタンを描画する処理に到達していなかった。
2. **Can't find variable c**: `loadGroupProducts` 内の `setIsReadOnlyState(c?.status === ...)` で、コールバックの引数は `count` であり `c` は未定義だった。
3. **最上部の読込ボタン**: 最上部の「読込」は **「さらに読み込む」用（ページネーション）** であり、まとめて表示で 0 件のときも表示されていた。1グループだけ読んだあと `hasMoreProducts` が false になるとボタンが消え、未読込の他グループ用と誤解されていた。

### 対応

1. **グループリストを常に表示**: `lines.length === 0` でも `targetProductGroupIds.length > 0` のときは早期 return しないようにし、グループごとのセクション（未読込時は「読込」ボタン）を描画するように変更。
2. **変数名の修正**: `loadGroupProducts` 内の `c?.status` を `count?.status` に変更。
3. **最上部ボタンの表示条件**: まとめて表示のときは、**既に 1 件以上表示されているときだけ**最上部の「未読み込みの商品があります。（要読込）」を表示するようにした（`hasMoreProducts && (!isMultipleMode || lines.length > 0)`）。0 件のときは各グループ横の「読込」のみ表示され、役割が分かりやすくなる。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx`
