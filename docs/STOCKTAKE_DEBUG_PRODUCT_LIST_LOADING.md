# 棚卸：商品リスト読み込みが完了しないときのデバッグ

## ログから分かること（共有ログの要因）

共有いただいたログから読み取れる点は次のとおりです。

1. **GraphQL エラー（HTTP 200 なのにエラー）**
   - `errors: { message: "GraphQL Client: An error occurred while fetching from the API. Review 'graphQLErrors' for details.", graphQLErrors: [Array] }`
   - HTTP は 200 だが、レスポンス body 内に **GraphQL の errors** が含まれている。
   - ログでは `graphQLErrors: [Array]` としか出ておらず、**中身（メッセージ・コード）が分からない**ため、要因の特定には `graphQLErrors` の内容を出す必要がある。

2. **POST /app/inventory-count.data が重い・ばらつく**
   - 1.2秒〜約20秒と応答時間にばらつきがある（例: 11724ms, 9530ms, 19905ms）。
   - グループ数・商品数が多いほど、`get_incomplete_group_products` 内の GraphQL 呼び出しが増え、レート制限やコスト制限に当たりやすくなる。

3. **GET /app/inventory-count.data が「- - - - ms」**
   - 応答時間がログに出ていない = クライアントがリクエストを中断した、または別要因で完了していない可能性。
   - 認証ログの `{ shop: null }` と組み合わさると、**認証失敗で短い body（例: 29 バイト）が返っている**ケースもあり得る（`docs/STOCKTAKE_MULTIPLE_GROUPS_PRODUCT_LIST_CAUSE.md` の「GET が 29 バイトで返る要因」参照）。

4. **想定される GraphQL 側の要因**
   - **Throttled**（レート制限）
   - **Cost limit**（クエリコスト超過）
   - **Invalid ID**（存在しない inventoryItem / location の GID）
   - **権限・スコープ**（inventory 読み取り権限など）

---

## コード側で追加したログ（要因追求用）

次のログが出力されるようにしてあります。本番・ステージングのログやローカル実行時のターミナルで確認してください。

| ログプレフィックス | 意味 |
|--------------------|------|
| `[inventory-count] get_incomplete_group_products GraphQL errors (pattern1):` | パターン1（inventoryItemIds で取得）の GraphQL レスポンスに `errors` が含まれたとき。**中身を JSON で出している**ので、ここに Throttled / メッセージが出る。 |
| `[inventory-count] get_incomplete_group_products GraphQL errors (pattern1b):` | パターン1b（skus から ID 解決して取得）で同様に `errors` があったとき。 |
| `[inventory-count] get_incomplete_group_products item failed (pattern1/1b):` | 1件ごとの取得で例外になったとき。**inventoryItemId と例外メッセージ**を出している。 |
| `[inventory-count] action error graphQLErrors:` | action 全体の catch で、クライアントが持っている `errors.graphQLErrors` を JSON で出力。 |
| `[inventory-count] action error:` | action の例外メッセージ。 |

**次のデプロイ以降**、同じ操作を再現すると上記ログに **graphQLErrors の内容**や **失敗した ID** が出るので、そこから要因を絞り込めます。

---

## デバッグの進め方（情報が足りない場合）

### 1. 本番／ステージングのログで「中身」を確認する

- Render の **Logs** で、`[inventory-count]` を検索する。
- **GraphQL errors** または **action error graphQLErrors** の直後にある JSON を開く。
  - `"message"` に Throttled / 権限エラー / 無効な ID などの文言が出ていれば、それを手がかりに対応する。
- **item failed** が出ている場合は、その **inventoryItemId** が無効・削除済み・他店舗のデータでないか確認する。

### 2. ローカルで再現してログを見る

1. 同じショップ（ciarabeautiful 等）で **開発環境** を立ち上げる。
2. 棚卸画面で、**読み込みが完了しないのと同じ手順**（同じ棚卸ID・グループ・「まとめて表示」かグループ別か）を再現する。
3. **ターミナル（npm run dev の出力）** で、上記の `[inventory-count]` ログを確認する。
4. GraphQL の `errors` や例外メッセージがそのまま出るので、本番で `[Array]` としか見えなかった中身をここで確認できる。

### 3. ネットワーク／GraphQL を直接見る（ブラウザ）

- ブラウザの **開発者ツール → Network** で `inventory-count.data` を選ぶ。
- **POST** の Request Payload（action, groupId, locationId など）と、**Response** の JSON を確認する。
  - `ok: false` かつ `error: "商品取得エラー: ..."` になっていれば、その文言がサーバー側の catch で返したメッセージ。
  - レスポンスが 200 なのに body に `errors` が含まれる場合は、クライアント（Remix/Shopify クライアント）がそれをどう扱っているかも合わせて確認する。

### 4. アプリタイル（POS）側の読み込み

- 管理画面の商品リスト取得は **POST /app/inventory-count.data**（action: `get_incomplete_group_products`）で、**管理画面用の GraphQL（admin API）** を使っている。
- **POS タイル**は、**別経路**（`readInventoryCounts` / `fetchProductsByGroups` 等）で、管理画面のこの action を **そのまま** 叩く場合と、**POS 用 API** だけを使う場合がある。
- 同じ「商品リストが揃わない」現象なら、
  - 管理画面で **上記ログ（graphQLErrors / item failed）** を先に確認する。
  - 管理画面で再現しない場合は、POS 側の **ネットワーク**（POS の開発者ツールやプロキシ）で、どの API が失敗しているかを見る。
- 本番ログに **shop: null** が出ている場合、**認証・セッション**（iframe の Cookie、同一ショップか）も疑う。

---

## 次のアクション（チェックリスト）

- [ ] デプロイ後、**同じ操作**で再度ログを取得する。
- [ ] ログで **`[inventory-count] get_incomplete_group_products GraphQL errors`** または **`action error graphQLErrors`** の **直後の JSON** を確認し、`message` / `code` をメモする。
- [ ] 可能なら **ローカルで同じ手順**を再現し、ターミナルに出力される **graphQLErrors の全文**を取得する。
- [ ] **商品リストが一部だけ欠ける**場合は、**item failed** の **inventoryItemId** が、削除済み商品や他ロケーションの商品になっていないか確認する。
- [ ] レート制限（Throttled）なら、**DELAY_BETWEEN_BATCHES_MS** の増加や、**同時並列数の削減**を検討する（`app.inventory-count.tsx` の get_incomplete_group_products 内）。

以上で、ログから要因を追いやすくなり、情報が足りない場合のデバッグ手順も揃っています。
