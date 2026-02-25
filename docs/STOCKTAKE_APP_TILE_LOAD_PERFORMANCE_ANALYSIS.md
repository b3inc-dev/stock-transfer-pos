# 棚卸アプリタイル読み込み速度の分析と要件検討

**日付**: 2026-02-25  
**前提**: 39グループ・合計約5600SKU、メタフィールド仕様のまま

---

## 1. アプリタイル初回表示で何が起きているか

棚卸タイルを開いたとき、**InventoryCountConditions** が表示する「棚卸一覧」を出すために、次の処理が走ります。

### 1.1 初回読み込みの流れ（`readInventoryCountsFirstPage`）

| 順番 | 処理 | GraphQL/API | 内容 |
|------|------|-------------|------|
| 1 | ディスクリプタ取得 | 1回 | `inventory_counts_v1` メタフィールド（`{ _chunked, totalChunks }` または配列） |
| 2 | 商品グループ取得 | 1回 | `product_groups_v1` メタフィールド（**39グループ一式**） |
| 3 | 表示件数取得 | 1回 | 設定メタフィールド（`fetchSettings` → `getStocktakeListLimit`） |
| 4 | 1チャンク取得 | 1回 | `inventory_counts_v1_c{N}` のいずれか1つ（新しい順で「最後のチャンク」） |

→ **最低 4 回の GraphQL が直列**で実行されます。

### 1.2 ロケーション絞り込み時のかかり方

`locationGid` が設定されている場合、**「最後のチャンク」だけでは該当ロケーションの棚卸が 0 件**だと、  
「該当する棚卸が1件以上出るまで」**追加チャンクを読むループ**に入ります。

```javascript
// InventoryCountConditions.jsx の refresh 内
while (filtered.length === 0 && allFetched.length > 0 && loadedChunks < totalChunks) {
  const chunkIndex = totalChunks - 1 - loadedChunks;
  const next = await readInventoryCountsPage(chunkIndex);  // ← ここが重い
  ...
}
```

**`readInventoryCountsPage(chunkIndex)` のたびに**、毎回以下が実行されます。

- ディスクリプタ取得（同上）
- **readProductGroups()**（39グループ再取得）
- 指定インデックスのチャンク取得

つまり「チャンクを1つ読むごとに **3 回の GraphQL**」です。  
該当ロケーションの棚卸が後ろのチャンクに多いと、**チャンク数 × 3 回**まで増えます。

### 1.3 一覧表示後の「名前」取得

一覧を描画したあと、**useEffect** で次の処理が走ります。

- 各棚卸の `locationId` ごとに `getLocationName(locationId)`（最大で「一覧に登場するロケーション数」回）
- 各棚卸の `productGroupIds` ごとに `getProductGroupName(groupId)`  
  → 内部で **productGroupsCache** を使うが、キャッシュが空なら **readProductGroups() が再度 1 回**

初回は `readInventoryCountsFirstPage` で既に `readProductGroups()` を読んでいるため、  
`getProductGroupName` はキャッシュヒットになる想定ですが、タイミング次第では **追加 1 回**の可能性があります。  
`getLocationName` は **ロケーションごとに 1 回** GraphQL です。

---

## 2. 現在のメタフィールド仕様で「最速に近いか」

### 2.1 仕様の制約（変えない前提）

- 棚卸一覧・棚卸詳細は **Shopify のメタフィールド**（`inventory_counts_v1` / チャンクキー）に保存。
- 商品グループは **1 つのメタフィールド**（`product_groups_v1`）に 39 グループ一式。
- 一覧用でも **ステータス補正**（完了/処理中）のために **商品グループ一覧**が必要（`fixCountsStatusOnly`）。
- チャンクは **バイト数ベース**（32KB 等）で、**中身は「明細（groupItems/items）込みのフルデータ**」。

この前提のままでは、

- 「一覧用に軽いデータだけ別メタフィールドで持つ」ことはしていない
- チャンク 1 つには「フルな棚卸データ」が入っているので、**一覧表示だけでもその分のデータを読んでいる**

という意味で、**「メタフィールド＋現仕様」の範囲では、すでに「チャンク分割」「1 ページ分だけ読む」という最適化は入っており、実装レベルでできることはかなりやっている**と言えます。

ただし「**同じ情報を何度も取らない**」という点ではまだ余地があります（次の「遅くなりそうな仕様」で整理します）。

### 2.2 現状で遅くなりやすいポイント（仕様・実装の両方）

| 要因 | 内容 | 影響 |
|------|------|------|
| **直列 4 本立て** | ディスクリプタ → product_groups → settings → チャンク が全部直列 | ラウンドトリップ時間がそのまま積み上がる |
| **readInventoryCountsPage の重複取得** | チャンクを読むたびに「ディスクリプタ」「product_groups」を再取得 | ロケーション絞りで複数チャンク読むと 3×N 回の GraphQL |
| **product_groups のサイズ** | 39 グループを 1 メタフィールドに格納。コレクションID・設定などで肥大化しうる | 1 回あたりの転送量・パースコストが増える |
| **一覧用と詳細用のデータが同一** | 一覧では id/status/locationId/countName/createdAt/productGroupIds 程度あればよいが、チャンクには groupItems/items も含む | 32KB チャンクあたりの「実質使う情報」の割合が小さい |
| **5600SKU と 39 グループ** | 棚卸 1 件あたりの groupItems が大きく、1 件で複数パートに分割され、チャンク数が多くなりやすい | ロケーション絞り時に「当たるまで」読むチャンク数が増える |

---

## 3. 他に読み込みが遅くなりそうな仕様

- **商品リスト（タイル内の「グループ選択 → 商品リスト」）**  
  - 39 グループ・約 5600SKU を「まとめて表示」や「在庫数読込」で扱う場合、  
    `fetchProductsByGroups` ＋ 在庫取得（`getCurrentQuantity` を 15 件バッチ）が重く、**既にレート制限対策でグループ順次・15件バッチ**になっている。  
  - ここは「タイルを開いた瞬間」ではなく「グループを選んだあと」の遅さなので、タイル一覧の遅さとは別軸だが、体感の「棚卸が遅い」の一因にはなりうる。

- **履歴の「さらに読み込む」**  
  - `readInventoryCountsPage` をそのまま使っているため、**毎回ディスクリプタ＋product_groups＋当該チャンク**の 3 本立て。  
  - ページを進めるたびに product_groups を再取得する仕様になっている。

- **readInventoryCountById（棚卸 1 件取得）**  
  - `readInventoryCountsRaw()` で**全チャンクを結合してから**1件を検索。  
  - 棚卸件数・チャンク数が増えると、タップ後の表示が遅くなりうる。

---

## 4. 現仕様のまま実装でできる短縮（要件変更なし）

- **並列化**  
  - 初回: 「ディスクリプタ」「product_groups」「settings」は**互いに独立**なので、  
    `Promise.all([ descriptor, readProductGroups(), getStocktakeListLimit() ])` でまとめて取り、  
    その後「必要な 1 チャンク」だけ読む。  
  - これで初回は **4 回直列 → 1 回並列 + 1 回チャンク** にでき、ラウンドトリップを減らせる。

- **readInventoryCountsPage の軽量化**  
  - 呼び出し元（`InventoryCountConditions` の refresh / loadMore）は、  
    すでに「ディスクリプタ」「product_groups」「listLimit」を持っている。  
  - `readInventoryCountsPage(pageIndex, { productGroups, listLimit })` のように**オプションで渡し**、  
    渡されているときは **ディスクリプタ・readProductGroups・getStocktakeListLimit をスキップ**して、  
    **チャンク 1 本だけ** GraphQL する。  
  - ロケーション絞りで複数チャンク読む場合や、「さらに読み込む」で **3×N → N 回** に減らせる。

- **getStocktakeListLimit のキャッシュ**  
  - 初回に 1 回取っておき、同じセッション内では `readInventoryCountsPage` に渡して再利用する。  
  - 設定変更が少ない前提なら、不要な settings 取得を減らせる。

これらは**メタフィールドのキー構成や保存形式を変えずに**実装できる範囲です。

---

## 5. これ以上速くするために必要な「要件・仕様」の検討

「メタフィールドのまま」「現行のデータ構造のまま」では、  
**一覧用の軽いデータ**と**詳細用の重いデータ**を分離していないため、  
「一覧だけ見せる」という目的に対してはデータ量が過多になります。  
さらに速くするには、次のような**要件・仕様の見直し**が必要です。

### 5.1 一覧用メタフィールドの分離（推奨）

- **現状**: チャンクには「groupItems / items 込みのフル棚卸」が入っており、一覧表示でも同じチャンクを読んでいる。
- **検討案**:  
  - **一覧用**に「id, locationId, status, countName, createdAt, productGroupIds」程度の**軽い一覧専用メタフィールド**（例: `inventory_counts_list_v1` とそのチャンク）を用意する。  
  - タイルの初回表示・「さらに読み込む」は**一覧用だけ**を読む。  
  - 某棚卸をタップして詳細（商品リスト）を開くときにだけ、既存の `inventory_counts_v1` / チャンクから**その 1 件**を取る（または 1 件用 API を別途用意）。
- **効果**: タイル表示時の転送量・パース対象が一気に減り、チャンク数も減りやすい。  
- **トレードオフ**: 保存時に「フル用」と「一覧用」の二重書きが発生する。管理画面・POS 両方の保存処理の対応が必要。

### 5.2 商品グループの分割またはキャッシュ戦略

- **現状**: 39 グループを 1 つの `product_groups_v1` で毎回取得。  
  初回・チャンク読むたび・getProductGroupName のキャッシュミスで繰り返し読む。
- **検討案**:  
  - **分割**: グループ数が多い場合は「グループ用メタフィールドを複数キーに分割」し、  
    一覧表示では「一覧に登場する groupId のグループ情報だけ」取る（グループ数が多くなってから検討）。  
  - **キャッシュ**: POS 側で「product_groups は一度取ったらセッション中は再利用」を徹底し、  
    `readInventoryCountsPage` などに productGroups を渡して再取得をやめる（上記「実装でできる短縮」の一環）。

### 5.3 バックエンド（API）の導入

- **現状**: すべて POS から Shopify GraphQL のメタフィールド直接読み書き。
- **検討案**:  
  - 自社サーバー（例: Render）に「棚卸一覧」「棚卸 1 件」用の API を用意し、  
    一覧は「軽い一覧 API」、詳細は「1 件取得 API」にする。  
  - データはメタフィールドと同期しておく、またはメタフィールドを「キャッシュ/同期先」と位置づける。
- **効果**: 一覧用・詳細用のデータ構造を自由に設計でき、インデックスやページネーションも最適化しやすい。  
- **トレードオフ**: インフラ・認証・同期の設計・運用が必要。

### 5.4 readInventoryCountById の見直し

- **現状**: 1 件取りたいだけでも `readInventoryCountsRaw()` で全チャンク結合。
- **検討案**:  
  - 管理画面側で「棚卸 ID → どのチャンク（またはパート）に含まれるか」のインデックスを別メタフィールドに持つ。  
  - または「1 棚卸 = 1 メタフィールド」のように ID ベースのキーで持つ。  
  - POS の `readInventoryCountById` では、そのインデックス／ID キーだけ読んで必要なチャンクだけ取得。  
- **効果**: 棚卸タップ後の詳細表示が速くなる。  
- **トレードオフ**: 保存・削除時にインデックス／ID キーの更新が必要。

---

## 6. まとめ

| 質問 | 回答 |
|------|------|
| **今のメタフィールド要件・仕様のままで、処理方法は最速に近いか？** | チャンク分割・「1 ページ分だけ読む」という点では最適化されている。一方で「**同じデータの再取得**」（ディスクリプタ・product_groups の重複）があり、**実装変更だけでまだ短縮できる**。 |
| **他に読み込みが遅くなりそうな仕様は？** | ① ロケーション絞り時の**複数チャンク読み**（readInventoryCountsPage の 3×N 回）、② **さらに読み込む**のたびの product_groups 再取得、③ **readInventoryCountById** の全チャンク読込、④ 商品リスト（5600SKU・在庫数読込）の重さ。 |
| **これ以上速くするには要件をどう変えるか？** | ① **一覧用の軽いメタフィールドを分離**する、② **product_groups の分割またはキャッシュ**を明確にする、③ **自社 API で一覧/1件取得**を用意する、④ **棚卸 ID → チャンクのインデックス**や「1 件 1 キー」で readInventoryCountById を軽くする、といった検討が必要。 |

まずは**要件を変えずに「並列化」と「readInventoryCountsPage の重複取得削減」**から入るのが現実的です。  
そのうえで、一覧の体感速度をさらに上げたい場合は **「一覧用メタフィールドの分離」** を要件として検討するのがよいと思います。

---

## 7. 実装済みの最適化（2026-02-25）

以下を実装済みです。

| 項目 | 内容 |
|------|------|
| **初回並列化** | `readInventoryCountsFirstPage` でディスクリプタ（main+list）・`readProductGroups()`・`getStocktakeListLimit()` を `Promise.all` で同時取得。 |
| **readInventoryCountsPage の軽量化** | 第2引数 `opts: { productGroups, totalChunks, useListMetafield }` を渡したときはディスクリプタ・readProductGroups をスキップし、チャンク1本だけ GraphQL。 |
| **呼び出し元** | `InventoryCountConditions` の refresh / loadMoreHistory で初回結果の productGroups・listLimit・useListMetafield を ref に保持し、`readInventoryCountsPage` に渡す。 |
| **一覧用メタフィールド** | `inventory_counts_list_v1`（およびチャンク `inventory_counts_list_v1_c{N}`）に id, locationId, status, countName, createdAt, productGroupIds のみ保存。タイル一覧は list があれば list のみ読む。POS の `writeInventoryCounts` と管理画面の `writeInventoryCountsChunked` の両方で list を書込。 |
| **棚卸ID→チャンクのインデックス** | `inventory_count_index_v1` に countId → チャンク番号の配列を保存。`readInventoryCountById` はインデックスがあれば該当チャンクのみ取得して結合。 |
| **商品グループ軽量化** | `product_group_ids_v1`・`product_group_names_v1` を管理画面の商品グループ保存時に同時書込。POS の `readProductGroupIds()` / `readProductGroupNames()` で取得。`getProductGroupName` は names を優先し、`fixCountsStatusOnly` は productGroups のほか groupIds（Set）にも対応。 |

---

## 8. 管理画面の読み込み最適化・502/499 対策（2026-02-25）

### 事象

- 管理画面の棚卸画面（`/app/inventory-count`）の読み込みが遅い。
- 読み込みしきれず商品リストが不足したり、画面を開いたまま 502 になったり、ログで 499（Client Closed Request）が発生する。

### 要因

1. **チャンクの直列取得**: `readInventoryCountsChunked` がディスクリプタのあと、チャンクを **1 本ずつ順番に** 取得していた。チャンク数が増えると「1 + N 回の直列」で時間が伸び、Render のリクエストタイムアウト（約 30 秒等）や Shopify のレート制限に当たりやすい。
2. **初回からフルデータ**: 一覧表示に必要なのは id / status / locationId / countName / createdAt / productGroupIds 程度だが、loader で **groupItems 込みのフルチャンク** を全部読んでいた。
3. **一時的な 502/499**: 1 チャンクの取得に失敗するとその時点で欠損したり、ユーザーが待ちきれず離脱して 499 になったりする。

### 対応（実装済み）

1. **一覧用 list メタフィールドの優先利用**  
   - loader でまず `readInventoryCountsListChunked(admin)` を実行（一覧用メタフィールドのチャンクを並列取得）。  
   - **list が 1 件以上返れば** それを `inventoryCounts` として使い、**フルチャンク（readInventoryCountsChunked）は呼ばない**。  
   - list が無い（従来データのみ）場合だけ `readInventoryCountsChunked(admin)` にフォールバック。  
   - list 利用時は groupItems がないため、**完了判定のステータス補正は行わず**、list に保存されている status をそのまま使う。

2. **チャンクの並列取得**  
   - `readInventoryCountsChunked` と `readInventoryCountsListChunked` の両方で、チャンク取得を **最大 8 本ずつ並列**（`CHUNK_FETCH_CONCURRENCY = 8`）に変更。  
   - 「1 +  ceiling(N/8) ラウンド」で済むようにし、総時間を短縮。

3. **チャンク取得のリトライ**  
   - 各チャンク取得に **1 回リトライ**（`CHUNK_FETCH_RETRY = 1`）を追加。  
   - 一時的な 502 やネットワークエラーで失敗したチャンクだけ再取得し、読み込み漏れを減らす。

### 注意点

- **list メタフィールド** は、管理画面または POS で棚卸を保存したときに一緒に書かれる。**過去のデータだけ** の場合は list が無く、従来どおりフルチャンク取得になる。
- 502/499 が続く場合は、下記「Render のタイムアウト」を参照。

### Render のタイムアウト（2026-02-25 追記）

- Render の Web サービスでは **リクエストごとのタイムアウト（15〜30 秒程度）** があり、ダッシュボードからユーザーが直接変更することはできません。
- 本ドキュメントで実施した「list 優先」「チャンク並列取得」「action では create_inventory_count のときだけ棚卸フル取得」により、loader と action の応答時間が短くなり、タイムアウトに当たりにくくなっています。
- それでも 502 や first-byte timeout が続く場合は、[Render サポート](https://community.render.com) に問い合わせ、個別にタイムアウト延長の可否を相談してください。

**変更ファイル**: `app/routes/app.inventory-count.tsx`  
（`readInventoryCountsListChunked` 追加、`fetchOneChunk` による並列・リトライ、loader で list 優先とフォールバック）

---

## 9. 他に遅くなりうる箇所・今後の要件検討の実装（自社API除く）（2026-02-25）

「3. 他に読み込みが遅くなりそうな仕様」と「4. 今後の要件検討（さらに速くする場合）」のうち、**自社APIの導入以外**を実装しました。

| 項目 | 内容 |
|------|------|
| **Action での棚卸フル取得の限定** | 管理画面の action で「現在のデータ取得」時に、**create_inventory_count のときだけ** `readInventoryCountsChunked(admin)` を実行するように変更。save_product_group・delete_product_group・get_incomplete_group_products などは productGroups のみ取得し、棚卸チャンクは読まないため、応答が速くなる。 |
| **モーダルで list-only 対応** | 一覧用 list メタフィールド由来の棚卸（groupItems/items なし）をモーダルで開いた場合、商品リストは **get_incomplete_group_products の結果のみ**で表示。読込中は「商品明細がありません」ではなく **「商品リストを読込中...」** を表示するように変更。 |
| **Render のタイムアウト** | 上記「Render のタイムアウト」のとおり、ダッシュボードでは変更不可。本節の最適化により loader/action の負荷を下げ、タイムアウトに当たりにくくした。延長が必要な場合は Render サポートに相談。 |

**変更ファイル**: `app/routes/app.inventory-count.tsx`  
（action の needInventoryCounts 分岐、モーダル内の isListOnlyCount / isLoadingModalProducts による読込中表示）
