# 棚卸：管理画面の商品リスト「まだ処理されていません」と 完了/処理中 の不整合

**日付**: 2026-02-24

## 事象

1. **管理画面の商品リスト読み込みが不安定**  
   履歴モーダルで「この商品グループはまだ処理されていません」と表示されるグループがある。  
   **「読み込み中...」のまま変わらない**（特に未完了ステータスで一番上のリスト）こともある。
2. **管理画面では「完了」なのにアプリでは「処理中」**  
   特に「差分がなかった」「リスト全て0個で0個のまま確定した」ケースで、アプリ側では完了扱いになっていない。
3. **商品リストの数量が読み込めず（0/-）のまま**  
   未完了・完了どちらのグループでも、在庫数／実数が 0 や「-」のまま表示されることが多い。

---

## 要因1: モーダルで「この商品グループはまだ処理されていません」になる理由

### 表示条件

管理画面の棚卸履歴モーダルでは、**グループごとのブロック**で商品を表示している。  
そのグループの **通常商品（normalItems）が 1 件もない** ときに、「この商品グループはまだ処理されていません」と表示される。

- 実装: `app.inventory-count.tsx` 4660–4714 行（複数グループ）、4844–4848 行（単一グループ）
- 条件: `normalItems.length === 0` のときメッセージ表示、それ以外はテーブル表示。

### normalItems が 0 件になるパターン

| グループの扱い | データ元 | 0 件になるケース |
|----------------|----------|------------------|
| **完了** | `groupItems[groupId]` | そのグループの `groupItems` が空（下記「要因2」のケースなど） |
| **未完了** | `incompleteGroupProducts`（= `get_incomplete_group_products` の結果） | API が商品を返していない、または取得がまだ終わっていない |

つまり、

- 完了グループなのに `groupItems` にデータが無い  
  → 未完了として扱われ、`incompleteGroupProducts` に依存する。
- 未完了グループで `get_incomplete_group_products` が 0 件、または取得タイミングでまだ 0 件  
  → いずれも「まだ処理されていません」になる。

### 商品リストが不安定になる要因

1. **get_incomplete_group_products が 0 件を返す場合**
   - **パターン1b（skus のみ）**: `inventoryItemIds` が無く `skus` のみのグループでは、`resolveSkusToInventoryItemIds` で ID 解決してから取得。解決失敗や 0 件だと `products: []`。
   - **コレクション未設定**: `collectionIds` が無く、かつ `inventoryItemIds` / `skus` も無い、またはパターン1b を通らない場合は `return { ok: true, products: [] }`（1557–1559 行）。
   - **GraphQL の一時失敗**: 各商品取得で `catch` で null になり、有効な結果だけ集めると 0 件になることがある。

2. **モーダルオープン時の順次取得**
   - 未完了グループを **1 つずつ** `get_incomplete_group_products` で取得している（1966–1996 行）。
   - ネットワーク遅延やフェッチャーの状態で、**あるグループの結果がまだ入っていないタイミング**でレンダーされると、そのグループは 0 件として「まだ処理されていません」になる。

3. **要因2 との組み合わせ**
   - 「全て0・差分なしで確定」したグループは、アプリが `groupItems` に保存しない（後述）。
   - 管理画面ではそのグループに `groupItems` が無いため「未完了」と判定され、表示は `incompleteGroupProducts` 任せになる。
   - ここで取得失敗や遅延があると、「まだ処理されていません」になりやすい。

---

## 要因2: 管理画面で「完了」なのにアプリで「処理中」になる理由

### 管理画面の完了判定（loader）

- ファイル: `app.inventory-count.tsx` 154–220 行付近。
- 基本: **全グループ**で `groupItems[groupId].length > 0` なら `status = "completed"`。
- **後方互換**: **単一グループ** かつ **items にデータあり** かつ **groupItems が空** の場合も「完了」とみなす。

```ts
// 199 行付近
const isCompleted = allDone || (isSingleGroup && hasItems && hasNoGroupItems);
```

そのため、「単一グループ」「items にだけデータがある」「groupItems は空」という状態だと、**管理画面だけ「完了」**になる。

### アプリ（POS）の保存・完了判定

- ファイル: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx` 1316–1422 行付近。
- 「在庫調整なし」で確定するとき:
  - **「カウントした商品がある」グループだけ** `groupItems` に保存する。
  - 「カウントした」の定義:
    - `actualQty > 0` または `currentQty !== actualQty`
  - つまり **実数が 0 かつ 在庫数＝実数（差分なし）** の行しかないグループは「カウントした商品が無い」とみなし、**そのグループは groupItems に保存しない**（1336–1345 行で `hasCountedItems === false` なら `continue`）。

結果:

- **全て 0 個で、在庫数＝実数（差分なし）で確定**  
  → 全グループで `hasCountedItems === false`  
  → **どのグループも groupItems に保存されない**  
  → `allDone = allIds.every(id => groupItems[id].length > 0)` は **false**  
  → **status は "in_progress" のまま**。
- 一方で **items** には、`lines` をそのままマージした `mergedEntry` が保存される（1398–1420 行）ため、**items にはデータが入る**。

### 不整合が起きる流れ（単一グループ・全て0・差分なし）

1. アプリで「在庫調整なし」で確定する。
2. 全行が「0 個／0 個／差分なし」のため、**groupItems には何も保存されない**。**items には全行が保存される**。
3. アプリ: `groupItems` が空 → `allDone === false` → **status = "in_progress"** のまま。
4. 管理画面 loader: 単一グループ & items あり & groupItems 空 → **isCompleted = true** → **status = "completed"** に上書き。

→ **管理画面では「完了」、アプリでは「処理中」** という状態になる。

---

## 要因3: 「一番最上部のグループ」で「まだ処理されていません」になりやすい理由

- **表示順と取得順**: モーダルでは `allGroupIds` の先頭から順にブロックを描画する。未完了グループの商品は `get_incomplete_group_products` を**1件ずつ順次**呼んで取得する。
- **キー型の不一致**: レスポンスの `groupId` は FormData 経由で常に**文字列**。一方 `allGroupIds`（＝`modalCount.productGroupIds`）はメタフィールドの JSON パース結果のため**数値**になっていることがある。`incompleteGroupProducts.get(groupId)` で `groupId` が数値だと、Map に文字列キーで保存したデータが**見つからず**、先頭の未完了グループほど「0件」のまま「まだ処理されていません」と表示されやすくなる。
- **初回レンダー時は未取得**: モーダルを開いた直後のレンダーでは、まだ1件目の fetch も返っていないため、先頭の未完了グループは必ず一時的に 0 件になる。キー不一致があると、fetch が返った後も照合できず表示が更新されない。

---

## 要因4: 「読み込み中...」のまま変わらない理由

- **成功時だけ loading を解除していた**: 未完了グループの商品取得は `get_incomplete_group_products` を順次呼んでいる。処理は「`fetcher.data` が `ok: true` かつ `groupId` ありのときだけ」データを保存し、その `groupId` を `loadingIncompleteGroupIds` から削除していた。
- **エラー時・異常応答時に解除していなかった**: API が `ok: false` を返した場合（例: グループ未検出、ロケーション未指定、GraphQL エラー）や、ネットワークエラーで応答が返らない場合、**どの groupId の loading も解除されない**。そのため、**一番上（先頭）の未完了グループ**でリクエストが失敗すると、そのグループだけ「読み込み中...」のまま固定される。
- **送信した groupId の記録がなかった**: 失敗応答には `groupId` が含まれないため、「いまどのグループの結果を待っていたか」が分からず、loading 解除できていなかった。

---

## 要因5: 在庫調整ありでも「アプリで処理中」になる理由

- **在庫調整ありパスで同じスキップをしていた**: 「在庫調整なし」で確定するときは、前回の修正で「全て0・差分なし」のグループも `groupItems` に保存するようにした。一方、**在庫調整が必要な場合**（差分がある商品が1件以上ある場合）は別のコードパスを通り、ここでは **「カウントした商品があるグループのみ」** を `groupItems` に保存し、`hasCountedItems === false` のグループは **スキップ（continue）** していた。
- そのため、**一部グループだけ差分があり、他は全て0・差分なし**で確定したケースでは、0・差分なしのグループが `groupItems` に保存されず、`allDone` が false のまま **status が "in_progress"** になり、管理画面では「完了」に見えてもアプリでは「処理中」のままになる。

---

## 要因6: 数量が（0/-）のまま読み込めない理由

- **表示の意味**: モーダルでは「実数/在庫数」を表示し、在庫数が 0 のときは在庫数を「-」と表示する仕様がある。そのため **（0/-）** は「実数 0、在庫数 0（表示上は -）」を意味する。
- **考えられる要因**
  1. **ロケーションIDの形式**: `get_incomplete_group_products` では GraphQL の `inventoryLevel(locationId: $loc)` で在庫数を取得している。Shopify の API によっては **ロケーションIDが GID 形式（例: `gid://shopify/Location/123`）でないと** 在庫が取れない場合がある。棚卸に保存されている `locationId` が数値や別形式だと、`inventoryLevel` が null になり、`currentQuantity` が 0 になる。
  2. **該当ロケーションに在庫が無い**: 商品がそのロケーションで在庫追跡されていない、または本当に 0 個の場合は 0 になる。
  3. **完了グループの groupItems**: 完了グループは `groupItems` の `currentQuantity` / `actualQuantity` を表示する。アプリ保存時に 0 で保存されていれば 0 のまま表示される。未完了グループは API 取得結果の `currentQuantity` を使うため、上記 1・2 の影響を受ける。

**一覧とモーダルでの違い**
- **履歴一覧**: 「○件・実数 X / Y」の **Y（母数＝在庫数の合計）** が 0 のとき「/-」と表示。データは `allGroupItems`（完了は groupItems、未完了は **incompleteGroupProductsForList**）の `currentQuantity` の合計。未完了分は `get_incomplete_group_products` の結果を使うため、**locationId の GID 正規化**で在庫が取れれば母数も数値になる。一覧側でも **incompleteGroupProductsForList のキーを文字列で統一**しないと、groupId が数値のときに照合漏れで未完了の商品が入らず、母数が 0 のまま「/-」になりやすい。
- **商品リストモーダル**: グループごとに「（実数/在庫数）」や各行の在庫/実数を表示。未完了は `incompleteGroupProducts`（同じ API）、完了は `groupItems`。同じく **locationId GID 正規化**と**キー正規化**で未完了の数量が揃う。
- いずれも **get_incomplete_group_products** を共有しており、API 内の locationId 正規化は一覧・モーダル両方に効く。一覧用の **incompleteGroupProductsForList** の保存・参照をキー正規化すると、一覧の母数「/-」も解消されやすい。

---

## まとめ

| 事象 | 主な要因 |
|------|-----------|
| **「この商品グループはまだ処理されていません」が不安定** | ① そのグループの表示データが `groupItems` にも `incompleteGroupProducts` にも無い／まだ無い（取得遅延・失敗・0件）。② 「全て0・差分なし」で確定したグループは `groupItems` に保存されないため未完了扱いになり、未完了用 API の結果に依存する。③ **先頭グループ**はキー型差（文字列 vs 数値）で照合漏れしやすい。 |
| **一番最上部のグループで発生しやすい** | 上記③。加えて、未完了グループの取得は順次実行のため、先頭が最初にリクエストされるが、初回レンダー時点ではまだデータが無く「まだ処理されていません」になる。キー正規化がないと取得後も表示が更新されない。 |
| **管理画面で完了・アプリで処理中** | 単一グループで「全て0・差分なし」で確定すると、アプリは **groupItems に保存しない** が **items には保存する**。管理画面は「単一 & items あり & groupItems 空」を**完了**とみなす一方、アプリは **groupItems が空のまま**なので **処理中** のまま。また **在庫調整ありパス**でも、0・差分なしのグループをスキップしていたため、一部だけ差分があるケースで同様の不整合が起きる。 |
| **「読み込み中...」のまま変わらない** | API が `ok: false` やエラーを返したとき、またはリクエストが失敗したときに、**そのグループの loading を解除していなかった**ため、特に先頭の未完了グループで「読み込み中...」のまま固定される。 |
| **数量が（0/-）のまま** | 未完了は `get_incomplete_group_products` の `inventoryLevel(locationId)` 結果に依存。**locationId の形式**（GID かどうか）や、そのロケーションに在庫が無い／追跡されていない場合に 0 になる。完了は `groupItems` の保存値のため、保存時 0 なら 0 で表示される。 |

---

## 実施した修正（2026-02-24）

- **管理画面（app.inventory-count.tsx）**
  - **キー正規化**: `incompleteGroupProducts` の取得を `getIncompleteProductsForGroup(groupId)` に統一。Map には常に `String(groupId)` で保存し、参照時も文字列／数値の両方で照合するようにした。これで「一番最上部のグループ」の照合漏れを解消。
  - **読み込み中表示**: 未完了グループの取得開始時に `loadingIncompleteGroupIds` をセットし、取得完了で解除。データ未到着の間は「読み込み中...」を表示し、先頭グループが一瞬「まだ処理されていません」になるのを防いだ。
  - **エラー時も loading 解除**: `get_incomplete_group_products` が `ok: false` や `groupId` なしで返った場合でも、**直前に submit した groupId**（`lastSubmittedGroupIdRef`）を `loadingIncompleteGroupIds` から削除するようにした。これで「読み込み中...」のまま固定される事象を解消。
  - **完了判定の統一**: loader の完了判定を「全グループで groupItems[groupId].length > 0」のみにし、単一グループの後方互換（items あり & groupItems 空で完了）を廃止。管理画面とアプリの表示を一致させた。
  - **locationId の GID 正規化**: `get_incomplete_group_products` 内で、`locationId` が `gid://` で始まらない場合は数値部分を抜き出して `gid://shopify/Location/{数値}` に変換して GraphQL に渡すようにした。**一覧・モーダルとも同じ API を使うため、両方で未完了グループの在庫数（母数）が読みやすくなる。**
  - **一覧の incompleteGroupProductsForList のキー正規化**: 一覧の「母数」も未完了グループは `incompleteGroupProductsForList` から取得。保存時に `String(groupId)` で統一し、参照時も `String(groupId)` で照合するようにした。targetCountId の特定時も `String(id) === groupIdStr` で比較。一覧で母数が「/-」のままになる照合漏れを防止。
- **POS（InventoryCountList.jsx）**
  - **全て0・差分なしでも groupItems に保存**: 「在庫調整なし」で確定するとき、`hasCountedItems` が false のグループも **groupItems に保存**するように変更。
  - **在庫調整ありパスも同様に保存**: 在庫調整が必要な場合のコードパスでも、`hasCountedItems === false` のグループをスキップせず **groupItems に保存**するように変更。一部グループだけ差分があるケースでも、0・差分なしのグループが「確定済み」になり、全グループ完了で status が "completed" になる。
- **要因の詳細**: 要因3（一番最上部のグループ）、要因4（読み込み中のまま）、要因5（在庫調整ありでも処理中）、要因6（数量 0/-）を追記。

以上が、棚卸の商品リスト読み込みの不安定さと、管理画面「完了」／アプリ「処理中」の不整合、および数量（0/-）表示の要因と修正内容です。
