# 棚卸メタ更新を「タイルは送るだけ」でシンプルにする要件

## 1. 目的・ゴール

- **現状**: POS タイル側で read → find → merge → write（チャンク・バージョン・リトライ）まで行っており、複雑でタイル閉じで失敗しやすい。
- **狙い**: タイルは「商品リストを読み取る」のと同じように **「完了報告を 1 回送るだけ」** にし、メタの read / merge / write は **すべてサーバー（管理画面の Remix）** で行う。

---

## 2. タイル側の責務（シンプルに保つ）

| 項目 | 内容 |
|------|------|
| やること | 在庫調整 API の実行 → 履歴送信 → **完了報告を 1 リクエストで送信** |
| やらないこと | メタの read、一覧からの find、merge、write、チャンク・バージョン・バックグラウンド retry |
| 送る内容 | 下記「ペイロード仕様」の最小限のみ |

確定ボタン押下後の流れ:

1. `adjustInventoryToActual` で在庫調整（現状どおり）
2. `logInventoryCountToApi` で履歴送信（現状どおり）
3. トースト・UI 完了（現状どおり）
4. **NEW**: アプリサーバーへ `pos_stocktake_complete` を **1 回だけ** POST（countId + 確定したグループの groupId と items）
5. タイル側の read/merge/write キュー・`runThisWrite`・`pendingBackgroundWriteByCountId` は **削除**

---

## 3. サーバー側の責務

| 項目 | 内容 |
|------|------|
| 受け口 | `app.inventory-count.tsx` の action に `pos_stocktake_complete` を追加 |
| 処理 | ① ペイロードで countId を受け取る → ② メタを **1 回 read**（既存の readInventoryCountsChunked）→ ③ 該当 count を id で find → ④ 渡された groupId/items で groupItems を更新、全グループ完了なら status/completedAt を更新 → ⑤ **1 回 write**（既存の writeInventoryCountsChunked） |
| 既存との共通化 | 中身のロジックは管理画面の `confirm_stocktake_group` と揃える（groupItems のマージ、allDone 判定、楽観ロックは既存どおり）。違いは「inventoryCounts を loader ではなくメタから 1 回 read して使う」だけ |

---

## 4. ペイロード仕様

### 4.1 単一グループ確定（1 回の確定で 1 グループだけ完了する場合）

管理画面の `confirm_stocktake_group` と揃える。

| キー | 型 | 必須 | 説明 |
|------|-----|------|------|
| action | string | ○ | `"pos_stocktake_complete"` |
| countId | string | ○ | 棚卸 ID（GID または一意になる id） |
| groupId | string | ○ | 確定した商品グループの ID |
| items | string | ○ | JSON 文字列。配列。要素は `{ inventoryItemId, currentQuantity, actualQuantity, variantId?, sku?, title? }` |

### 4.2 複数グループ一括確定（1 回の確定で複数グループをまとめて完了する場合）

| キー | 型 | 必須 | 説明 |
|------|-----|------|------|
| action | string | ○ | `"pos_stocktake_complete"` |
| countId | string | ○ | 棚卸 ID |
| completedGroups | string | ○ | JSON 文字列。`Array<{ groupId: string, items: Array<{ inventoryItemId, currentQuantity, actualQuantity, variantId?, sku?, title? }> }>` |

- サーバーは `completedGroups` があればそちらを採用し、各 groupId ごとに groupItems をマージする。`groupId` + `items` のみの場合は単一グループとして扱う。

### 4.3 バージョン（楽観ロック）

- 管理画面と同様に、可能であれば `inventoryCountsVersion` をフォームで送り、サーバー側で `writeInventoryCountsChunked(..., expectedVersion)` に渡す。
- POS からは「タイルで version を読まない」設計でもよい。その場合はサーバー側で「read した直後の version を使って write」するだけにし、競合時は write が userErrors で返す。

---

## 5. 認証・エンドポイント（公式に基づく確定方針）

### 5.1 公式のやり方

- **POS UI 拡張 → アプリサーバー** の認証は、**Session API のセッショントークン（JWT）** で行う。
- 公式ドキュメント:
  - [Communicate with a server (POS)](https://shopify.dev/docs/apps/build/pos/communicate-with-server)  
    - 拡張側: `shopify.session.getSessionToken()` でトークン取得 → `Authorization: Bearer ${token}` で fetch。
  - [Session API (POS UI Extensions)](https://shopify.dev/docs/api/pos-ui-extensions/apis/session-api)  
    - トークンでショップ情報・ユーザー情報を取得し、バックエンド通信に利用。
- サーバー側:
  - トークンは **JWT（HS256）**。アプリの **共有シークレット（SHOPIFY_API_SECRET）** で署名検証する。
  - [Session tokens (Getting started)](https://shopify.dev/docs/apps/auth/session-tokens/getting-started) では、Node の場合は **Shopify Node API ライブラリ** で decode/verify することを推奨。
- その他:
  - **HTTPS 必須**。POS は非 HTTPS を拒否する。
  - **CORS**: オリジン `cdn.shopify.com` と `extensions.shopifycdn.com` を許可する必要あり。

### 5.2 本プロジェクトでの採用方針（既存パターン流用）

既に **同じ方式** が `api.log-inventory-change` で実装されている。

| 項目 | 内容 |
|------|------|
| 拡張側 | `shopify.session.getSessionToken()` でトークン取得 → `POST ${appUrl}/api/xxx` に `Authorization: Bearer ${token}` と body を送る（`extensions/common/logInventoryChange.js` 等を参照）。 |
| エンドポイント | 管理画面の `app.inventory-count` の action ではなく、**専用 API ルート** を用意する（例: `api.pos-stocktake-complete` または `api/stocktake-complete`）。管理画面は Cookie の `authenticate.admin`、POS は Cookie を持たないため別ルートが確実。 |
| サーバー側認証 | 既存の `api.log-inventory-change` と同様にする。 1. `Authorization: Bearer <token>` を取得 2. **JWT 検証**: `jose` の `jwtVerify(token, key, { algorithms: ["HS256"] })` でアプリの共有シークレットを鍵に検証 3. payload の `dest` からショップドメイン（例: `xxx.myshopify.com`）を取得 4. `sessionStorage.findSessionsByShop(shop)` でセッション取得 → `admin` で GraphQL/メタ操作 |
| CORS | `api.log-inventory-change` と同様に、OPTIONS と POST で `Access-Control-Allow-Origin` 等を返す。 |

### 5.3 結論

- **認証**: POS は **Session API の getSessionToken() → Bearer JWT**。サーバーは **JWT を共有シークレットで検証し、`dest` から shop を特定してセッション取得**。管理画面の Cookie 認証は使わない。
- **エンドポイント**: **専用 API ルート**（例: `POST /api/pos-stocktake-complete`）。既存の `api.log-inventory-change` の実装（`decodePOSToken`・CORS・session 取得）を流用する。
- 実装時は `app/routes/api.log-inventory-change.tsx` のトークン検証・CORS・session 取得部分を参照し、同じパターンで `pos_stocktake_complete` 用の API ルートを追加する。

### 5.4 参考（公式）

- [Communicate with a server - POS](https://shopify.dev/docs/apps/build/pos/communicate-with-server) … 拡張からサーバーへ fetch する例・Session API・CORS/HTTPS
- [Session API - POS UI Extensions](https://shopify.dev/docs/api/pos-ui-extensions/apis/session-api) … getSessionToken の説明
- [Session tokens - Getting started](https://shopify.dev/docs/apps/auth/session-tokens/getting-started) … トークン取得・Bearer 送信・バックエンドでの decode/verify（Node では Shopify Node API または手動で JWT 検証）

---

## 10. api.log-inventory-change との違い（「順番が不安定」の有無）

`api.log-inventory-change` では **Webhook と API の到着順序** に依存するため、実装が複雑で「完全ではない」部分がある。

### 10.1 log-inventory-change で順番が不安定な理由

| 要素 | 説明 |
|------|------|
| 2 系統のイベント | 在庫変動時に **(1) Shopify の inventory_levels/update Webhook** が先に届き `admin_webhook` として 1 件保存され、**(2) POS から API** が「棚卸」「ロス」等の種別で送られる。 |
| 到着順が不定 | Webhook が先か API が先かは保証されない。API が先に届くと「更新対象の admin_webhook 行」がまだ無く、検索で見つからない。 |
| 現状の対処 | 一定時間ウィンドウで `admin_webhook` を検索し、見つからなければ `findWithAdminWebhookRetry` で最大 30 秒まで待機・再検索。それでも無ければ新規作成したり「管理」のまま残る可能性があり、**順番に依存した不安定さ**が残る。 |

### 10.2 棚卸完了 API（pos_stocktake_complete）に同様の要素はあるか

**ない。**

| 比較項目 | log-inventory-change | pos_stocktake_complete（棚卸完了） |
|----------|------------------------|------------------------------------|
| Webhook への依存 | あり。admin_webhook の有無・到着タイミングに依存。 | **なし**。Webhook は関与しない。 |
| 処理の流れ | 「DB 検索 → 既存行を更新 or 新規作成」で、他システム（Webhook）の 1 件と突き合わせる。 | **1 リクエストで「メタ read → 該当 count 更新 → メタ write」** するだけ。 |
| 順序の影響 | API と Webhook の到着順で結果が変わりうる。 | 到着順に依存する他イベントはない。 |

棚卸完了は **POS からの 1 本のリクエストだけで完結** するため、**「Webhook を受け取る順番が不安定」という種類の課題は発生しない**。  
気にするなら **同一 count への同時リクエスト**（二重送信・別端末の同時確定）程度で、既存の楽観ロック（バージョン）で競合時は userErrors を返す形にすれば足りる。

---

## 6. エラー・例外

| ケース | サーバー側の返し | タイル側の扱い |
|--------|------------------|----------------|
| countId がメタに無い | 400 または 200 + `{ ok: false, error: "棚卸が見つかりません" }` | トーストでメッセージ表示。メタは更新しない。 |
| 楽観ロック競合 | 200 + `{ ok: false, error: "他の操作でデータが更新されています…" }` | トーストで「再読み込みして再度確定してください」を表示。 |
| メタ read/write の一時失敗 | 500 または 200 + `{ ok: false, error: "…" }` | トーストでエラー表示。必要なら「再試行」ボタン。 |
| ネットエラー・タイムアウト | レスポンスなし / 5xx | タイル側で「送信に失敗しました。通信を確認して再試行してください。」等を表示。 |

---

## 7. 反映タイミング

| 対象 | いつ反映されるか |
|------|------------------|
| 管理画面 | サーバーが write 成功した時点でメタが更新される。次回のページ読み込み（loader）で完了が反映される。 |
| POS タイルの商品リスト | タイルがメタを読んでいる場合、次に一覧や商品リストを開き直したときに最新メタが読まれ、完了が反映される。タイル側でメタを read しない設計なら、見た目は「確定済み」で固定でも可。 |

---

## 8. 実装ステップ案

1. **サーバー**: `pos_stocktake_complete` を追加。  
   - 受け取り: `countId`, `groupId`, `items`（単一）または `completedGroups`（複数）。  
   - 処理: メタを 1 回 read → 該当 count を find → groupItems/status/completedAt を更新 → 1 回 write。  
   - 返却: `{ ok: true }` または `{ ok: false, error: string }`。
2. **認証**: 上記「要検討」を解消（POS から POST できる URL と認証方法を決定）。
3. **タイル**: 確定後に在庫調整・履歴送信まで実施したら、`pos_stocktake_complete` に 1 回だけ POST。既存の read/merge/write キューは削除。
4. **テスト**: 単一グループ確定・複数グループ一括確定・競合時・count が無い場合のエラーを確認。

---

## 9. まとめ（要件の要点）

- **タイル**: 「完了報告を 1 回送る」だけ。送る内容は countId + 確定した groupId(s) + items。
- **サーバー**: その 1 リクエストを受け、メタを 1 回 read → 1 件更新 → 1 回 write。中身は既存の confirm_stocktake_group ロジックを流用。
- **認証**: POS からアプリへ POST する方法を 1 つ決める（要検討）。
- **エラー**: ok: false + error で返し、タイルはトーストで表示。管理画面・タイルの「完了」の見え方は、メタが更新された後の次回読込で反映。

この内容で要件を固定し、認証が決まり次第実装に落とす想定。
