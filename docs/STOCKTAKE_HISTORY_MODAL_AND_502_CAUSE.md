# 棚卸：履歴一覧の商品リストモーダルで明細・在庫が欠ける要因と 502／読み込み失敗

**日付**: 2026-02-25

## 1. 共有ログから分かること

### 1.1 明細・在庫数が全て取得できていない要因（ログで確認できる）

共有いただいたログに次の出力があります。

```
[inventory-count] get_incomplete_group_products item failed (pattern1): gid://shopify/InventoryItem/49089155170550 Throttled
[inventory-count] get_incomplete_group_products item failed (pattern1): gid://shopify/InventoryItem/50599589478646 Throttled
...（同様に複数）
```

- **Throttled** は **Shopify Admin API のレート制限** です。
- `get_incomplete_group_products` では、商品ごとに 1 本ずつ GraphQL（`inventoryItem` + `inventoryLevel`）を呼んでいます。
- 1 件で Throttled になると、現在のコードでは **例外を catch して `return null`** しており、**その商品は結果に含まれません**（明細数・在庫数から欠ける）。
- バッチ 10 件を `Promise.all` で同時に送っているため、まとめてレート制限に当たりやすく、複数件が連続で Throttled になっています。

**結論（ログから言えること）**  
→ **レート制限（Throttled）に当たった分だけ、明細と在庫数が返却結果に含まれず、モーダルや一覧の「母数」が少なく表示される。**

---

### 1.2 履歴一覧を開いていると 502・読み込み失敗が多くなる要因（ログから推測）

ログの特徴は次のとおりです。

| 内容 | ログ例 |
|------|--------|
| POST /app/inventory-count.data が非常に遅い | 15947ms, 14608ms, 26163ms, 22822ms など **4〜26 秒** |
| GET /app/inventory-count.data が完了していない | `GET /app/inventory-count.data - - - ms`（応答時間なし） |
| 一部の GET が極端に短い | `responseBytes=29`（エラーやリダイレクトの短い body の可能性） |

**想定される流れ**

1. **履歴タブを開いた状態**では、一覧の「○件・実数 X / **Y**」の **Y（母数）** を出すために、**未完了グループごとに** `get_incomplete_group_products` が **POST** で順次呼ばれます（`app.inventory-count.tsx` の 2477〜2522 行付近の `incompleteGroupProductsForListFetcher`）。
2. 1 回の POST が **4〜26 秒** かかることがあり、その間も **同じルート** で GET（loader：ページデータ・再検証）や keepalive が飛ぶことがあります。
3. Render では **WEB_CONCURRENCY=1** のため、**1 プロセスで 1 リクエストずつ**処理されます。長時間の POST が続いていると、GET（loader）がなかなか処理されず、**タイムアウト**したり、**502 Bad Gateway** になったりしやすくなります。
4. ログの **GET … - - - ms** は、クライアントがリクエストを打ち切った、またはプロキシ／Render 側でタイムアウトした可能性を示します。
5. **responseBytes=29** は、認証リダイレクトやエラーレスポンスの短い body である可能性があります（`docs/STOCKTAKE_MULTIPLE_GROUPS_PRODUCT_LIST_CAUSE.md` の「GET が 29 バイトで返る要因」参照）。

**結論（仮説として妥当なもの）**  
→ **履歴一覧で未完了グループの母数を出すために、長時間かかる POST が連続しており、同じプロセスを占有するため GET（loader／再読み込み）が待たされ、タイムアウトや 502 が起きやすい。**

---

## 2. 改善案（根本対策として実装済み）

### 2.1 明細・在庫が欠ける問題（Throttled 対策）✅ 実装済み

| 対策 | 内容 | 状態 |
|------|------|------|
| **Throttled 時にリトライ（例外）** | 1 件の GraphQL で **例外メッセージに Throttled が含まれる**場合、**1.5 秒待ってから 1 回だけ**同じリクエストをやり直す。 | ✅ パターン1・パターン1b |
| **Throttled 時にリトライ（errors）** | レスポンスの `errors` に Throttled が含まれていて `data` が無い場合も、1.5 秒待ってから 1 回だけ同じリクエストをやり直す。 | ✅ パターン1・パターン1b |
| **バッチ間待機の延長** | `DELAY_BETWEEN_BATCHES_MS` を **80ms → 180ms** に変更。 | ✅ |
| **同時並列数の削減** | `BATCH_SIZE` を **10 → 5** に変更（パターン1・パターン1b）。 | ✅ |

実装場所: `app/routes/app.inventory-count.tsx` の `actionType === "get_incomplete_group_products"` 内。

---

### 2.2 502・読み込み失敗（履歴一覧で負荷を下げる）✅ 実装済み

| 対策 | 内容 | 状態 |
|------|------|------|
| **一覧の母数は取得しない** | 履歴**一覧**では、未完了グループの母数用に **get_incomplete_group_products を一切呼ばない**。一覧では未完了がある行は「○件・実数 X **/-**」とし、**モーダルを開いたとき**にだけ未完了グループの商品を取得する。 | ✅ |
| **一覧用の POST／state を削除** | `incompleteGroupProductsForListFetcher` および一覧用の未完了取得 useEffect を削除。一覧行では `hasIncompleteGroup` のとき母数を「-」表示。 | ✅ |

実装場所: `app.inventory-count.tsx` の履歴一覧ブロック（useEffect 削除・行表示で `hasIncompleteGroup ? "/-"`）。

---

## 3. ログが不足していて「仮説しかできない」場合にやること

### 3.1 すでに出力されているログを最大限使う

- **Render の Logs** で `[inventory-count]` を検索する。
- **GraphQL errors** の直後の JSON に `message` / `code` / `extensions` が出ていないか確認する（Throttled や COST の情報がここに出ることがある）。
- **item failed** の **inventoryItemId** が、削除済み商品や他店舗のデータでないか確認する。

詳細な手順は **`docs/STOCKTAKE_DEBUG_PRODUCT_LIST_LOADING.md`** にあります。

---

### 3.2 仮説を裏付けるための「追加ログ」案

次のようなログを一時的に入れると、502／読み込み失敗の要因を切り分けしやすくなります。

| 入れたいログ | 目的 |
|--------------|------|
| **get_incomplete_group_products の開始・終了** | 例: `[inventory-count] get_incomplete_group_products start groupId=... locationId=...` と `... end groupId=... durationMs=... productCount=...`。POST が何秒かかっているか・何件返したかを確認。 |
| **Throttled の回数** | パターン1/1b のバッチ内で `return null` になった件数を集計し、`... end ... throttledCount=...` のように出す。明細が欠ける原因が Throttled 主体かどうか確認。 |
| **GET（loader）の開始・終了** | loader の先頭で `[inventory-count] loader start`、return 直前に `... loader end durationMs=...`。履歴タブを開いたときの GET が何秒かかっているか確認。 |
| **responseBytes=29 のときの status** | 可能であれば、短い body（例: 29 バイト）を返したときに **HTTP status** と **body の先頭** をログに出す。認証リダイレクトかエラーか切り分け。 |

追加後、**同じ操作（履歴一覧を開いたまま数分、モーダル開閉など）** を再現してログを取ると、「長時間 POST のあとに GET が遅れているか」「loader 自体が重いか」を判断しやすくなります。

---

### 3.3 ローカルで再現してログを増やす

- 同じショップ（ciarabeautiful 等）で **npm run dev** を立ち上げ、**同じ手順**（履歴タブを開く → モーダルを開く → 一覧のまましばらく待つ）を再現する。
- **ターミナル** に、GraphQL の `errors` や例外メッセージがそのまま出るため、本番では `[Array]` としか見えない中身を確認できる。
- **ブラウザの開発者ツール → Network** で `inventory-count.data` の **POST/GET の順序・所要時間・status** を確認すると、「POST が続いている間に GET が 502 になる」かどうかを直接見られる。

---

### 3.4 仮説の優先順位（ログ不足時）

1. **Throttled**  
   - ログにすでに `item failed ... Throttled` が出ているため、**明細・在庫が欠ける主因**として扱ってよい。  
   - → まず **Throttled 時のリトライ** と **バッチ間待機の延長／BATCH_SIZE 削減** を実施するのがおすすめ。

2. **履歴一覧での 502**  
   - ログでは「POST が 4〜26 秒」「GET が - - - ms」という事実しかないため、**「一覧の母数取得用 POST が長時間連続し、GET が待たされて 502」** は仮説のまま。  
   - → **一覧の母数を出さない／遅延表示** にして 502 が減るか確認するか、**上記の追加ログ** を入れてから同じ操作でログを取得し、仮説を検証する。

---

## 4. 関連ドキュメント

- **商品リスト読み込みのデバッグ手順**: `docs/STOCKTAKE_DEBUG_PRODUCT_LIST_LOADING.md`
- **GET が 29 バイトで返る要因・まとめて表示の 502**: `docs/STOCKTAKE_MULTIPLE_GROUPS_PRODUCT_LIST_CAUSE.md`
- **管理画面とアプリのステータス・母数表示**: `docs/STOCKTAKE_ADMIN_VS_APP_STATUS_CAUSE.md`
