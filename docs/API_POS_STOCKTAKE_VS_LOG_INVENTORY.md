# 棚卸完了API と 履歴API の差分一覧（通信で失敗する場合の確認用）

## 公式情報に基づく検証（履歴API が成功している前提）

以下は **仮説ではなく Shopify 公式ドキュメント** に基づく整理です。

### 1. POS 拡張からサーバーへ通信する際の公式要件

| 要件 | 公式ソース | 履歴API / 確定API の扱い |
|------|------------|---------------------------|
| **認証** | [Session API](https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/standard-apis/session-api): `getSessionToken()` でトークンを取得し、**`Authorization: Bearer <token>`** でバックエンドに渡す。 | 両方とも `session.getSessionToken()` → `Authorization: Bearer ${token}` を使用。**同一**。 |
| **CORS** | [Communicate with a server](https://shopify.dev/docs/api/pos-ui-extensions/latest/server-communication): 「Requests originating from an extension will be of origin **cdn.shopify.com** and **extensions.shopifycdn.com**. Your server needs to **allow requests from both origins**.」 | 両ルートとも `Access-Control-Allow-Origin: *` を返しており、上記オリジンを含む全オリジンを許可。**同一**。 |
| **HTTPS** | 同上: 「Shopify POS will **refuse to fetch any non-HTTPS requests**.」 | 両方とも同じ `getAppUrl()` のベース URL を使用。本番は HTTPS。**同一**。 |
| **トークン検証** | [Session tokens (getting started)](https://shopify.dev/docs/apps/auth/session-tokens/getting-started): 署名は **HS256**、アプリの **共有シークレット** で検証。 | 両ルートとも `jose` の `jwtVerify(token, key, { algorithms: ["HS256"] })` と `SHOPIFY_API_SECRET` を使用。**同一**。 |

公式の [Communicate with a server](https://shopify.dev/docs/api/pos-ui-extensions/latest/server-communication) の例では `mode: 'cors'` と `credentials: 'include'` を使っていますが、サーバーが `Access-Control-Allow-Origin: *` の場合、`credentials: 'include'` はブラウザ仕様上使えません。当プロジェクトでは **Bearer トークンだけで認証** しているため、`credentials` は付けず、履歴・確定の両方で同じ fetch オプション（method, headers, body のみ）にしており、公式の「Authorization: Bearer で渡す」「CORS でオリジンを許可する」は満たしています。

### 2. 結論（公式に照らした整理）

- **履歴API が成功している** ＝ 次の条件はすでに満たされている：
  - POS 側: `getSessionToken()` が取得できている
  - 同一の `getAppUrl()` でリクエストが届いている（ベースURL・HTTPS）
  - サーバー側: CORS が許可され、Bearer 検証とセッション取得ができている

- 履歴と確定で **仕様上違うのは「パス」だけ**：
  - 履歴: `${appUrl}/api/log-inventory-change` → ルートファイル `api.log-inventory-change.tsx`
  - 確定: `${appUrl}/api/pos-stocktake-complete` → ルートファイル `api.pos-stocktake-complete.tsx`

- [React Router のファイル命名](https://reactrouter.com/how-to/file-route-conventions): ドットは URL のスラッシュに対応。`api.log-inventory-change` → `/api/log-inventory-change`、`api.pos-stocktake-complete` → `/api/pos-stocktake-complete` となる。

したがって、**履歴API が成功している限り、認証・CORS・ベースURL・トークン検証に問題はない**。確定API だけ失敗する場合は、**本番で `/api/pos-stocktake-complete` が存在するか（ルートがデプロイされているか）** を確認するのが公式仕様に沿った切り分けになります。

---

## クライアント（POS 拡張）

| 項目 | 履歴 (logInventoryChangeToApi / sendChunkWithRetry) | 棚卸完了 (reportStocktakeCompleteToApi) | 備考 |
|------|-----------------------------------------------------|----------------------------------------|------|
| **取得** | `globalThis?.shopify?.session` | 同じ | 同一 |
| **トークン** | `session.getSessionToken()` | 同じ | 同一 |
| **appUrl** | `getAppUrl()` 動的 import | 同じ | 同一 |
| **URL** | `${appUrl}/api/log-inventory-change` | `${appUrl}/api/pos-stocktake-complete` | **パスのみ違う** |
| **method** | `POST` | `POST` | 同一 |
| **headers** | `{ Authorization: \`Bearer ${token}\`, "Content-Type": "application/json" }` | **同一に揃えた** | 順序・キーとも同じ |
| **mode** | 指定なし | 指定なし | 同一 |
| **credentials** | 指定なし | 指定なし | 同一 |
| **body** | `JSON.stringify(body)` | `JSON.stringify(body)` | 同一 |
| **タイムアウト** | なし（1リクエスト＝最大50件で短時間で返る想定） | **あり（90秒）** | **確定のみ長め** |
| **サーバー処理時間** | 1リクエストあたり短い（DB 書き込み＋必要時のみ GraphQL） | **長くなりうる**（メタ全チャンク read → 結合 → 全チャンク write） | **「APIが返ってこない」要因** |

※ ヘッダー順を履歴側（Authorization → Content-Type）に合わせてあり、それ以外の fetch オプションは履歴と同一。

### 「APIが返ってこない」可能性（履歴との重要な違い）

- **履歴API**: 1回の POST は「最大50件の記録」だけ。サーバーは DB 挿入と必要ならロケーション名の GraphQL 1本で、**短時間で応答**する。複数チャンクに分けて送るので、1本が長引いても他は別リクエストで成功する。
- **確定API**: 1回の POST でサーバーが **readInventoryCountsChunked（メタを全チャンク読む）→ 結合 → writeInventoryCountsChunked（全チャンク書く）** を行う。棚卸データが大きいと **数十秒かかることがある**。そのあいだクライアントは待つだけ。
  - ブラウザ・プロキシ・Render などの **タイムアウト** で接続が切れると、クライアントには **レスポンスが返ってこない**（「Load failed」「Failed to fetch」などで catch される）。
  - つまり **「返ってこない」＝サーバーが応答する前に接続が切れた** という違いが、履歴APIにはほぼなく、確定APIにはある。

対策として、確定API のクライアント側で **明示的に長めのタイムアウト（例: 90秒）** を付け、タイムアウト時は「サーバーが処理に時間を要しているか、接続が切れました」と分かるようにする。

### 商品リストが 50 件以上の場合（履歴との送り方の違い）

| 項目 | 履歴API | 確定API |
|------|---------|---------|
| **送信方法** | **50 件ずつチャンクに分け、複数回 POST**（`LOG_INVENTORY_CHANGE_CHUNK_SIZE = 50`）。200 件なら 4 リクエスト。 | **1 回の POST で全グループ・全商品を送る**。チャンク分割はしていない。 |
| **50 件超のとき** | 2 リクエスト目以降が続くだけ。1 リクエストあたりの負荷は一定。 | そのまま 1 リクエストに 50 件超の `items` が含まれる。body が大きくなり、サーバー側の merge とメタ write も重くなる。 |
| **制限** | 1 リクエストあたり最大 50 件（タイムアウト対策でチャンク送信）。 | 件数上限のコードはない。ただし **件数が多いほど 1 リクエストの処理時間が伸び、90 秒タイムアウトにかかりやすい**。 |

つまり、**商品リストが 50 件以上でも確定API は 1 リクエストで全件送っている**。履歴API のような「50 件ずつに分けて複数リクエスト」にはなっていない。多数グループ・多数商品を一度に確定するほど、サーバーが read/write に時間を使い、「APIが返ってこない」（クライアントが先に 90 秒でタイムアウト）が起きやすくなる。

---

## サーバー（Remix ルート）

| 項目 | api.log-inventory-change | api.pos-stocktake-complete | 備考 |
|------|--------------------------|-----------------------------|------|
| **ルートパス** | `/api/log-inventory-change` | `/api/pos-stocktake-complete` | flatRoutes の命名どおり |
| **OPTIONS** | loader で 204 + CORS_HEADERS | loader で 204 + CORS_HEADERS | 同一 |
| **CORS_HEADERS** | Allow-Origin: * 等 | 同じ定義 | 同一 |
| **認証** | Bearer 必須、decodePOSToken → authenticate.pos フォールバック | 同じ流れ | 同一 |
| **shop 取得** | shopFromDest(dest) | 同じ | 同一 |
| **セッション** | findSessionsByShop(shop)、オフライン優先、refreshOfflineSessionIfNeeded | 同じ | 同一 |
| **body 取得** | `await request.json()`（未 try/catch） | `await request.json()` を try/catch、失敗時 400 + CORS | 棚卸側の方が安全 |

---

## 通信が失敗する場合の切り分け

1. **履歴APIは成功し、棚卸完了APIだけ失敗するか**
   - 履歴は成功する → 同じ送信方法なので、**URL（パス）かルートの有無**を疑う。本番で `api.pos-stocktake-complete` がデプロイされているか、パスが `/api/pos-stocktake-complete` で届いているかを確認。
   - 履歴も失敗する → ネットワーク・CORS・appUrl など**共通要因**を疑う。

2. **一時的なデバッグ**
   - `reportStocktakeComplete.js` の `apiUrl` を一時的に  
     `${appUrl}/api/log-inventory-change` にし、body を `{ entries: [{ activity: "inventory_count", ... }] }` のような最小限の1件にして送信。
   - これで 200 や 401 など「レスポンスが返る」なら、**履歴のルートには届いている**ので、パスを元に戻したうえで「pos-stocktake-complete だけ届いていない」と判断できる。

3. **本番でルートが有効か（公式の「サーバーがリクエストを許可しているか」の確認）**
   - デプロイ後に `curl -X OPTIONS https://(あなたのドメイン)/api/pos-stocktake-complete` で 204 が返るか確認。
   - 204 が返れば OPTIONS は届いているので、続けて POST（Authorization 付き）で確認。
   - 履歴が成功している同じドメインで、`curl -X OPTIONS https://(同じドメイン)/api/log-inventory-change` と比較すると、同じ CORS 設定なら同様に 204 になるはず。

4. **POS が参照している appUrl とデプロイ先が一致しているか**
   - POS 拡張は `extensions/common/appUrl.js` の `getAppUrl()` でベース URL を取得している。
   - `APP_MODE = "public"` → 本番 URL は `https://pos-stock.onrender.com`
   - `APP_MODE = "inhouse"` → 本番 URL は `https://stock-transfer-pos.onrender.com`
   - **実際にアプリ（Remix）をデプロイしているドメイン** と上記が一致していないと、確定APIは別ホストに送られて届かない。履歴APIも同じ `getAppUrl()` を使うので、履歴が成功しているなら appUrl は合っている。履歴も送れない場合は APP_MODE とデプロイ先の対応を確認する。

---

## 確定API の失敗原因をログで特定する（仮説に頼らない）

コード側で **`STOCKTAKE_API_ORIGIN`** という固定文字列をログに出すようにしてある。デプロイ後に「棚卸確定」で失敗したタイミングで **Render のログ** と **POS 側のコンソール** を確認すると、原因を事実ベースで切り分けられる。

### サーバー側（Render ログで `STOCKTAKE_API_ORIGIN` を検索）

| ログに出す内容 | 意味 |
|----------------|------|
| `[server] request received: method=POST` | **POST がサーバーに届いている**。この後の 401/500 等の理由が原因。 |
| `[server] request received: method=OPTIONS` のみで POST が出ない | プリフライトは届いているが **POST が届いていない** → クライアント側で fetch が失敗している（CORS でブロック、または送信前のエラー）。 |
| `[server] response 401: Missing session token` | リクエストに Authorization ヘッダーがない。 |
| `[server] response 401: Invalid session token` | トークンの検証失敗（decode または authenticate.pos）。 |
| `[server] response 401: No shop in session token` | トークンの payload に dest がない。 |
| `[server] response 401: Shop session not found` | ショップのオフラインセッションが DB にない（管理画面を一度開いていない等）。 |
| `[server] response 200 ok:true` | 確定API は正常に完了している。 |

**POST が一度もログに出ない**（`request received: method=POST` がない）場合、**リクエストがサーバーに届いていない**。原因候補は「送信先 URL の違い」「ネットワーク」「クライアント側で fetch が throw している」のいずれか。そのときは POS 側の `STOCKTAKE_API_ORIGIN [client] fetch threw:` の内容（message / name / cause）を見れば、**実際に fetch が投げたエラー**が分かる（仮説ではなく事実）。

**POST は出ているがそのあと `response 200 ok:true` が出ない**場合、サーバーが **readInventoryCountsChunked / writeInventoryCountsChunked の途中で時間がかかっている** 可能性がある。クライアントは 90 秒でタイムアウトするので、**「APIが返ってこない」＝クライアントが先にタイムアウトした** という状態になりうる。そのときは `[client] fetch threw:` で `isAbort: true` や `AbortError` が出る。サーバー側はその後も処理を続け、完了すれば `ok:true` がログに出るが、クライアントにはもう届かない。

### クライアント側（POS 拡張のコンソール）

- `STOCKTAKE_API_ORIGIN [client] sending POST to` → 実際に送信しようとしている URL（origin + path）。
- `STOCKTAKE_API_ORIGIN [client] fetch threw:` → fetch が例外を投げた場合の `message` / `name` / `cause`。ここに「Load failed」「Failed to fetch」等が出ていれば、**レスポンスを受け取る前に失敗している**（ネットワーク・CORS・接続先の違いなど）。

---

## まとめ

- クライアントの fetch は **履歴と同一**（ヘッダー順も揃えた）。違うのは **URL のパス** と **body の中身** だけ。
- サーバー側の CORS・認証の流れも履歴APIと揃えてある。
- それでも通信で失敗する場合は、**履歴は成功するか** と **本番のルート・パス** を上記の手順で確認するとよい。
