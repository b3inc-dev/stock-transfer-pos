# 在庫変動履歴「管理」のまま反映されない要因（2026-02-17）

## 事象

- **発生日時**: 2026/02/16 23:12
- **内容**: オンラインストアの売上（注文による在庫減）が在庫変動履歴で「管理」のままとなり、変動数・参照IDが付かずに記録された。
- **ログ**: `orders/updated` で「No location found for order 6852483318006; OrderPendingLocation recorded」→ `inventory_levels/update` で「No logs found at all」「Saving log: activity=admin_webhook」と続いた。

## 要因（根本原因）

**OrderPendingLocation の検索で「ロケーション不明」用の `locationId=""` が条件に含まれておらず、マッチしなかった。**

1. **オンライン受注直後**  
   - `orders/updated` 受信時、`fulfillments.length=0` のため履行ロケーションがなく、GraphQL の `FulfillmentOrder.assignedLocation` も null。  
   - そのため「ロケーション不明」として **OrderPendingLocation に `locationId: ""`（空文字）** で登録している（`webhooks.orders.updated.tsx`）。

2. **inventory_levels/update 側の検索**  
   - OrderPendingLocation を検索するとき、候補を  
     `[locationIdRaw, \`gid://shopify/Location/${locationIdRaw}\`, ""].filter(Boolean)` で作成していた。  
   - **JavaScript の `.filter(Boolean)` は空文字 `""` を除去する**ため、実際の検索条件には `locationId` が `"67711566070"` と GID のみで、`""` が含まれない。

3. **結果**  
   - DB には `locationId=""` の OrderPendingLocation が登録されているのに、検索では `locationId in ("67711566070", "gid://...")` のみで照会するため、**該当行がヒットしない**。  
   - 待機・再検索（2.5秒×3回）でも同じ条件のため、一度もマッチせず、最終的に `admin_webhook`（管理）で保存された。

## 補足（Webhook の順序について）

- `inventory_levels/update` が先に届き、その時点ではまだ OrderPendingLocation が無い場合、待機・再検索で後から登録された行を拾う設計になっている。
- 今回の事象では、**仮に orders/updated が先に届いて OrderPendingLocation が登録されていても**、検索条件に `locationId=""` が含まれていなかったため、マッチしなかった。
- つまり「到着順」よりも「検索条件から空文字が抜けていたこと」が直接の原因。

## 対策（コード修正）

- **ファイル**: `app/routes/webhooks.inventory_levels.update.tsx`
- **変更内容**: OrderPendingLocation を検索する箇所（初回検索・保存直前再検索・待機後の再検索の 3 箇所）で、`locationId` の候補配列から **`.filter(Boolean)` をやめる**。
- **修正後**:  
  `[locationIdRaw, \`gid://shopify/Location/${locationIdRaw}\`, ""]` のまま検索に渡すことで、`locationId=""` で登録された「ロケーション不明」の OrderPendingLocation もヒットするようにする。

これにより、オンライン受注直後（ロケーション未確定）に `locationId=""` で登録された OrderPendingLocation と、後から届く `inventory_levels/update` が正しくマッチし、「売上」・変動数・参照ID付きで履歴に記録される。
