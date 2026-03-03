# 棚卸メタフィールド更新処理で処理ができない／不具合になる可能性の洗い出し

## 管理画面で履歴が出ない・「状態を確認」で syntax error になる原因

### 共通の要因

**Shopify の `admin.graphql()`（アプリ内の GraphQL クライアント）が、レスポンス body が空や不正なときに内部で `response.json()` 相当を実行し、`syntax error, unexpected end of file` を throw する**ため。

- 元々読み取れていた時との差分: 以前はメタデータが少なく GraphQL が正常な body を返していた。データ増加・Shopfiy 側のタイムアウト／切り詰めなどで **空や不正な body が返るケース** が増えると、クライアントがパースで落ちる。
- メタフィールド用のクエリ（list / main / version）は、**`admin.graphql()` を経由しない「直接 fetch + safeJson」** にすると throw しない。

### 履歴が出ない理由

1. **loader** で棚卸一覧用に list / main / version の 3 本を取得している。
2. **session.shop が null** になるリクエストがあると、`useDirectFetch` が false になり、list/main/version は **空で返す** フォールバックになる → 画面上は履歴 0 件。
3. あるいは direct fetch でも、Shopfiy が空 body を返すと `safeJsonFromResponseForLoader` は落ちないが、中身が空なので履歴は 0 件になる。

**対応**: loader で `session.shop` が空のとき、**URL の `?shop=` から shop を補完**して direct fetch を使うようにした。また、list/main/version は当初から **loader では direct fetch + safeJson** にしている。

**原因をログで確定する**: サーバーログに次の2行が出る。

- `[inventory-count] loader directFetch: ...`  
  - `ok shopSource=session` または `ok shopSource=url` → direct fetch 有効（shop と accessToken が取れている）。  
  - `no shop=empty accessToken=...` → **shop が無い**（session も URL も）。  
  - `no shop=set accessToken=empty` → **accessToken が無い**（session 不備）。
- `[inventory-count] loader result: useDirectFetch=... inventoryCounts=... source=...`  
  - `useDirectFetch=false` かつ `inventoryCounts=0` → 上記の「shop/accessToken 不足」でフォールバックしたと確定。  
  - `useDirectFetch=true` かつ `inventoryCounts=0` → direct fetch は動いているが **Shopfiy の list/main の応答が空**と確定。

### 「状態を確認」で syntax error になる理由

- **getMetafieldHealth** が従来どおり **`admin.graphql()`** のみ使っていたため、メインキー取得の段階で上記の throw が発生していた。
- **対応**: `getMetafieldHealth(admin, session)` で **session を渡すと、メインキー・チャンク取得をすべて「直接 fetch」（graphqlMetafieldValueDirect）で行う**ように変更。action からは常に session を渡すため、状態確認で syntax error は出ない。

---

## 「棚卸チャンク338が存在しません」について

### チャンク338がない理由（想定される原因）

- **メタの構造**: 棚卸データは **全棚卸IDを1本のチャンク列** で持つ（キー `inventory_counts_v1` に `{ _chunked: true, totalChunks: 339 }`、実体は `inventory_counts_v1_c0` ～ `inventory_counts_v1_c338`）。  
  `totalChunks: 339` なら **0～338 番のチャンクがすべて存在する前提**で読みに行く。
- **欠損の要因候補**:
  1. **書き込みの途中失敗**: `writeInventoryCountsChunked` は 25 件ずつ `metafieldsSet` で送る。最後のバッチ（例: チャンク 324～338）で Throttle／ネットエラー／タイムアウトなどで失敗すると、**ディスクリプタだけ 339 に更新済みで、チャンク 338 がまだ書かれていない（または書いた直後のバッチが失敗）** という状態になりうる。
  2. **append 系の失敗**: 新規 1 件を末尾に足す `appendNewCountToChunked` で、`totalChunks: N+1` と最後のチャンクを書くときに、チャンク書きだけ失敗すると「番号だけ増えたが最後のチャンクが無い」状態になりうる。
  3. **Shopfiy 側の制限・不具合**: メタフィールド数上限や一時的なエラーで、特定キーだけ保存されなかった可能性（原因として否定はできないが、コード上は 1 リクエスト内の複数キーをまとめて送っている）。

コード上は **totalChunks と実際に書くチャンク数は一致**（`totalChunks: chunks.length`、キーは `c0`～`c(chunks.length-1)`）しており、オフバイワンはない。したがって「338 だけない」のは、**どこかで「最後の 1 チャンク分の書き込みが失敗した」か「そのキーだけ欠けた」** 状態になったと考えられる。

### 今確定している棚卸IDが要因？ それとも全機能？

- **全機能（アプリ全体の棚卸メタ）の不整合** である。
- メタは **「このショップの全棚卸ID」を 1 セットで** 持っており、**特定の棚卸IDごとにチャンクが分かれているわけではない**。  
  どの棚卸を確定しようと、**確定API は必ず「全チャンクを読む」**（`readInventoryCountsChunked`）→ その中から該当 `countId` を探して merge → 再度「全件」を write する。
- したがって **「今確定しようとした棚卸ID」が悪いのではなく**、**そのショップの棚卸メタ全体で「チャンク 338 が欠けている」** 状態。  
  別の棚卸を確定しても、同じ読み取りで **同じくチャンク 338 が無い** ため同じエラーになる。
- 管理画面で棚卸一覧を開くときも、チャンク形式なら同じく全チャンクを読むため、**一覧表示でも同様のエラーになりうる**（loader 側で try/catch して落ちないようにしている場合は、一覧は空になる）。

**まとめ**: チャンク 338 欠損は **「今確定した棚卸ID」起因ではなく、そのストアの棚卸メタ全体（全機能で共有の 1 本のチャンク列）の不整合**。修復するには管理画面の「修復」や、メタを正しいチャンク数・内容で再書き込みする必要がある。

### 管理者用：メタフィールド復旧（管理画面）

- **表示の出し方**: 棚卸画面で、タブ（商品グループ設定・棚卸ID発行・履歴）の右端にある**入力欄に `metafield` と入力し「表示」ボタンを押す**と、その下に「管理者用：メタフィールド復旧」が表示される。通常利用では入力しないためユーザーには見えない。
- **状態を確認**: メインキー（単一/チャンク）、totalChunks、欠落しているチャンク番号を表示。`ok` / `warning`（最終チャンクのみ欠損） / `error` で判定。
- **修復を実行**: 全チャンクを読み直し、その内容で再書き込みする。**修復時だけ** `readInventoryCountsChunked` に `allowMissingChunksForRepair: true` を渡し、欠落チャンク（複数可）があってもスキップして読み進める（通常運用の「欠落時は読み取り中断」の防御からは外す）。「状態: エラー / チャンク 338, 339 が欠落」のように最終以外が欠けていても、修復ボタンで試行でき、読めたチャンク＋欠落分を空として再書き込みし整合を取る。

### メタを復旧するには

1. **「最後の1チャンクだけ欠けている」対応をデプロイしている場合**  
   確定API または 管理画面で棚卸を 1 件でも保存・確定すると、read が最後のチャンクを空として扱い、そのあと write で **totalChunks と実チャンク数が一致した状態** に書き直される。**1回の成功で復旧**する。
2. **上記をまだデプロイしていない場合**  
   「修復」ボタンも内部で `readInventoryCountsChunked` を使うため、チャンク欠損時は同じエラーになる。**まず「最後の1チャンクだけ欠けているときは空として読み続行」をデプロイし、そのあと 1 回でも確定 or 保存を成功させる**ことで復旧する。
3. **最後以外のチャンクが欠けている場合**  
   現状は「修復」や通常の保存では直せない。バックアップがあればリスト＋メタの再構成が必要。コード側では「最後の1チャンクだけ」を特別扱いしているため、**途中のチャンク欠損はエラーにしたまま**である。

### メタを壊さない堅牢さ

- **書き込み順の変更**: `writeInventoryCountsChunked` で、**ディスクリプタ（totalChunks）をチャンクのあと（最後）に書く**ようにした。  
  - 以前: 先頭バッチに「ディスクリプタ＋c0～c23」を入れていたため、最後のバッチが失敗すると「totalChunks: 339 なのに c338 が無い」状態になりえた。  
  - 現在: 先に c0～c338 を書き、最後のバッチで **c315～c338 とディスクリプタ** をまとめて書く。最後のバッチが失敗しても、**ディスクリプタは更新されず**、読み取りでは従来どおり全チャンクが存在する状態のまま。**「最後のチャンクが無い」不整合は起きない**。
- **制限**: メタフィールド API はバッチ単位のため、**全チャンクを 1 リクエストで書くような完全なトランザクション**はできない。ただし「ディスクリプタを最後に書く」ことで、**途中失敗時に「チャンク欠損」が発生するリスクは減らしている**。

---

### 過去の空データ上書きを履歴から削除した場合

- **その場合も同じ状態になりうる**: 空データで上書きしたあと、履歴からその件を削除して「実データ」だけに戻しても、**メタ側は「ディスクリプタだけ 339 に更新されたが、最後のチャンク（338）は空で書き込まれた／書き込みが失敗した」** ような状態が残ることがある。その結果、**実態は 0～337 が正しく、338 が存在しない** という形になりうる。
- **メタが正しい状態なら 338 を放置して更新できるか**: **できるようにした**。  
  **欠けているのが「最後の 1 チャンク」だけ** のときは、そのチャンクを **空配列として扱い読み取りを続行** するようにした（`readInventoryCountsChunked`）。  
  - これにより、確定API や管理画面の保存で「全件 read → マージ → 全件 write」が実行され、**次の write でチャンク数が実データに合わせて書き直される** ため、メタが正しい状態（例: totalChunks: 338、c0～c337）に戻る。
  - 最後以外のチャンクが欠けている場合は従来どおりエラーにし、中途半端な上書きを防いでいる。

---

## 確認日・現状サマリ

- **管理画面**（`app.inventory-count.tsx`）: 読取失敗時ガード（readMainKeyOnly）、`mergeExistingNonBlank` の groupItems マージ、楽観ロックは実装済み。
- **POS**（`stocktakeApi.js` / `InventoryCountList.jsx`）: 以下を修正すると更新処理の不具合を防げる。

---

## 1. 読み取り（readInventoryCountsRaw）まわり

### 1.1 メインキー取得にリトライがない（重大） → **要修正**
- **場所**: `stocktakeApi.js` 246–255行付近
- **内容**: メインキー（`INVENTORY_COUNTS_KEY`）取得の `graphql(gql)` に `runWithThrottleRetry` がかかっていない。
- **結果**: Throttle・一時的なネットエラー・タイムアウトで即失敗し、確定後の write が落ちる。
- **対応**: メインキー取得を `runWithThrottleRetry` で囲む。

### 1.2 メインキーの JSON パース失敗で空配列を返す（重大・データ消失リスク） → **要修正**
- **場所**: `stocktakeApi.js` 257–261行付近
- **内容**: `JSON.parse(raw)` が失敗したときに `return []` している（throw していない）。
- **結果**: 不正 JSON のときに `[]` が返り、UI が 1 件だけを渡して write すると他棚卸が消える。
- **対応**: パース失敗時は throw する。

### 1.3 レスポンス body 取得失敗で実質的に空リストになる（低）
- **場所**: `stocktakeApi.js` graphql 内
- **内容**: body 取得失敗で `raw ?? "[]"` となり空とみなされる。
- **対応**: 1.2 の throw 化でパース失敗は検知可能。graphql 側の data チェックは別途検討。

---

## 2. マージまわり

### 2.1 mergeExistingNonBlank で groupItems をマージしていない（他グループが未完了に見える） → **要修正**
- **場所**: `stocktakeApi.js` の `mergeExistingNonBlank`
- **内容**: 両方に groupItems がある場合のマージがなく、`out.groupItems` のみで上書きしている。
- **結果**: 確定時に「今回のグループの groupItems だけ」で保存され、他グループの groupItems が消える。
- **対応**: 管理画面と同様に `out.groupItems = { ...exGroupItems, ...out.groupItems }` でマージする。

### 2.2 fromStorage が一覧用ミニマル（groupItems なし）のとき
- **対応**: 1.2 で read が throw するようにし、2.3 で「list に無いときは書かない」にすると、不正な fromStorage で書く経路を減らせる。

### 2.3 該当 count が list に無いときに親の count（ミニマル）を base にしている → **要修正**
- **場所**: `InventoryCountList.jsx` の `doMergeAndWrite(list2, fromStorage2 ?? count)`
- **内容**: 2回読んでも該当 id が無いときに `count`（一覧用・groupItems なしの可能性）を base にしている。
- **結果**: 他グループの groupItems が欠けた状態で保存される。
- **対応**: 該当 id が list に無い場合は書き込みせず、Promise.reject で「該当棚卸が取得できません。再読み込みしてから再度確定してください。」を返す。

---

## 3. 書き込み（writeInventoryCounts）まわり

### 3.1 内部で read が失敗すると existing = [] のまま上書き → **要修正**
- **場所**: `stocktakeApi.js` の `writeInventoryCounts`
- **内容**: read が throw すると `existing = []` のままマージし、渡された counts をそのまま書く。
- **結果**: 1.2 の経路で「1件だけ」が渡ると全件が 1 件に置き換わる。
- **対応**: existing が空で counts があるとき、1回だけ再読してまだ空なら新規ショップとして書く。再読で取得できた場合はその existing でマージする。

### 3.2 バッチ書き込みの途中失敗（低）
- リトライで全体再実行。トランザクションは別検討。

### 3.3 楽観ロック（仕様どおり）
- 競合時は「他の操作で更新されています」で保存しない。メッセージで案内済み。

---

## 4. 実行タイミング・ライフサイクル

### 4.1 メタ更新がバックグラウンドのため完了前にタイルが閉じられる
- 別案として「メタ更新を別場所で実行する」検討中。本ドキュメントでは更新処理自体の不具合修正を優先。

### 4.2 リトライ・待機時間
- 現状のままでよい。

---

## 5. 修正実施一覧（更新処理の完全性のため）

| 項目 | 対象 | 内容 |
|------|------|------|
| 1.1 | POS stocktakeApi.js | メインキー取得を `runWithThrottleRetry` で囲む |
| 1.2 | POS stocktakeApi.js | パース失敗時は `return []` ではなく throw |
| 2.1 | POS stocktakeApi.js | `mergeExistingNonBlank` で groupItems を `{ ...ex, ...out }` でマージ |
| 2.3 | POS InventoryCountList.jsx | 該当 id が list に無いときは doMergeAndWrite せず reject |
| 3.1 | POS stocktakeApi.js | 読取失敗時に 1 回再読。existing が空のまま counts が 1 件だけのときは上書きをブロック（他棚卸消失防止） |
