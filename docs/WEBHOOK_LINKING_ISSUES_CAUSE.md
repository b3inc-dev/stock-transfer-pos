# Webhook 紐付け不具合の要因

在庫変動履歴のCSVで見られる「管理」のままになる件・「入庫」で商品名/SKUが空になる件の原因を整理する。

---

## 0. 「管理」と「入庫」が二重に登録される要因（api/log-inventory-change は呼ばれている前提）

**現象**: 実際は入庫操作1回なのに、**同じ変動について「管理」の行と「入庫」の行が両方残る**（二重登録）。api/log-inventory-change は呼ばれているが、**Webhook で作った「管理」行を API が上書きできておらず、API が別の「入庫」行を新規作成している**状態。

**二重になる流れ**:  
1. Webhook (inventory_levels/update) が「管理」行を **create** する。  
2. API が「直近の admin_webhook」を **検索**するが、**見つからない**。  
3. API は「該当なし」と判断し、**新規で「入庫」行を create** する。  
4. 結果、同一変動で **「管理」1行 ＋「入庫」1行** の二重登録になる。

したがって要因は「**なぜ API が既存の「管理」行を見つけられないか**」に絞られる。

---

### 要因 A: レース（Webhook の commit が API の検索より後）

| 項目 | 内容 |
|------|------|
| **何が起きているか** | Webhook リクエストは **先に届いて処理を開始**しているが、**DB に「管理」行を commit するのが API の検索より後**になっている。 |
| **理由** | Webhook 側の処理が重い。認証・GraphQL（タイムゾーン・ロケーション名・SKU取得）・直前ログ取得・OrderPendingLocation の **2.5秒待機×最大2回** などを行った **後** に create している。この間に API が実行されると、API の「直近 admin_webhook」検索時点ではまだ行が存在しない。 |
| **コード** | `webhooks.inventory_levels.update.tsx`: create は GraphQL・待機・既存ログ検索の **最後**（670行付近）。`api.log-inventory-change.tsx`: admin_webhook 検索（261–269行 / 381–389行）で見つからなければ新規 create。 |
| **結果** | API が「該当なし」→ 入庫で新規 create → その後 Webhook が「管理」で create → 二重。 |

---

### 要因 B: API の時間窓に Webhook 行の timestamp が入っていない

| 項目 | 内容 |
|------|------|
| **何が起きているか** | API は「直近の admin_webhook」を **`timestamp` が [recentFrom, recentTo] に入る行** で検索している。既に commit 済みの「管理」行の **timestamp がこの範囲外**だと、API は見つけられない。 |
| **時間窓の定義** | `recentFrom = ts - 30分`、`recentTo = max(ts + 5分, Date.now() + 2分)`。`ts` は **API リクエストの body の `timestamp`**（未指定なら `new Date()`）。 |
| **ずれが起きる例** | ・**クライアントの `timestamp` が、Webhook の `updated_at`（＝DB の timestamp）より 30分以上「未来」**だと、`recentFrom = ts - 30分` が Webhook の発生時刻より後になり、Webhook 行の timestamp が窓の左端より前にはみ出して窓の外になる。API は「直近 admin_webhook」にヒットしない。<br>・クライアント時計が進みすぎで `ts` がサーバーよりかなり未来の場合も同様。`ts` を送らないと API は `new Date()` を使うため、通常は窓に収まりやすい。 |
| **コード** | `api.log-inventory-change.tsx` 250–251行 / 370–371行。Webhook は `updatedAt`（ペイロードの `updated_at`）をそのまま log の `timestamp` に保存（677行）。 |

---

### 要因 C: inventoryItemId / locationId の形式・値の不一致

| 項目 | 内容 |
|------|------|
| **何が起きているか** | API の検索は **inventoryItemId ∈ { raw, GID }** と **locationId ∈ { raw, GID }** の両方で行う。Webhook は **数値文字列（raw）** で保存している。通常は toRawId で正規化しているため一致するが、**リクエストの値が欠けている・別 ID になっている**とヒットしない。 |
| **想定しうる不一致** | ・管理画面から API を呼ぶ際、**inventoryItemId / locationId を送っていない**、または **別のキー名で送っている**。<br>・**転送元・転送先など、別の locationId を送っている**（入庫先と Webhook の location_id が一致していない）。<br>・**GID と数値の表記ゆれ**はコード上は両方候補に入っているため、通常はどちらでもヒットする。 |

---

### 要因 D: 同一品目に Webhook が複数回届き、API は「直近1件」だけ更新する

| 項目 | 内容 |
|------|------|
| **何が起きているか** | 同じ (item, location) に **inventory_levels/update が複数回** 届き、「管理」行が **複数行** できる。API は **`orderBy: { timestamp: 'desc' }` の直近1件** だけ「入庫」に更新する。 |
| **結果** | 直近の1行だけ「入庫」になり、**それより前の「管理」行はそのまま残る**。同一入庫でも「入庫」1行と「管理」が N 行残り、二重・多重に見える。 |
| **コード** | `api.log-inventory-change.tsx` 269行 / 389行 `orderBy: { timestamp: 'desc' }`。Webhook の重複チェックは **±5秒** のみ（315–326行）。5秒以上離れた同じ品目の Webhook は別行になる。 |

---

### まとめ（二重登録の因果）

- **api/log-inventory-change が呼ばれているのに二重になる**のは、**「管理」行を API が 1 件も見つけられず、新規で「入庫」行を作っている**ため。
- 見つからない理由として、上記の **A（レース）・B（時間窓）・C（ID 不一致）・D（複数「管理」のうち1件だけ更新）** をコードと仕様に基づいて整理した。
- 特に **A（Webhook の create が遅く、API の検索が先に走る）** は、Webhook 内の GraphQL と OrderPendingLocation 待機の分だけ「管理」行の commit が遅れるため、二重登録の主要原因として疑う価値が高い。

### 二重登録を減らす対策（実装済み）

| 対策 | 内容 | 実装 |
|------|------|------|
| **API 側で「見つからないときは短時間待って再検索」** | admin_webhook が検索で 0 件のとき、2.5 秒 sleep してから同じ条件で再検索を最大 12 回繰り返し（最大 30 秒）。ヒットした時点でループを抜けるため、早く届けば短い応答で返る。 | ✅ `api.log-inventory-change.tsx`: `ADMIN_WEBHOOK_RETRY_WAIT_MS`（2.5秒）、`ADMIN_WEBHOOK_RETRY_TIMES`（12回）。セッションなし・ありの両パスで実施。 |
| **時間窓の緩和** | クライアントの `timestamp` が未来寄りだと「管理」行が窓の外になるため、`recentFrom` を「いま − 1分」より過去にしないようにする。 | ✅ `recentFrom = min(ts - 30分, Date.now() - 60秒)` で直近 1 分は必ず検索対象に含める。 |
| **上書き時に variantId/sku を反映** | 「管理」→「入庫」等に更新するとき、リクエストに variantId・sku があれば updateData に含め、CSV で商品名が空にならないようにする。 | ✅ admin_webhook を更新する 2 箇所で `updateData.variantId` / `updateData.sku` を設定。 |
| **timestamp を送らないとサーバー基準** | リクエストで `timestamp` を省略すると API は `new Date()` を使うため、窓が「いま」中心になりヒットしやすい。 | 元からその仕様（変更なし）。 |

---

## 0-2. 「全て入庫なのに紐付けできず別れた」ときの要因（API が呼ばれていない／一部だけのケース）

**現象**: 実際はすべて入庫操作なのに、履歴では「入庫」と「管理」が混在したり、同じ一括入庫なのに行がバラけて見える（**二重登録とは別**：API 未呼び出しや一部品目だけ API で送っている場合）。

| 要因 | 何が起きているか |
|------|------------------|
| **1. api/log-inventory-change が呼ばれていない** | 入庫操作時に API が一度も呼ばれていない。Webhook では種別が分からないためすべて「管理」で保存され、全部「管理」のままになる。 |
| **2. API は「直近1件」だけ上書きする** | 同一商品に「管理」が複数行ある場合、API は直近1件だけ「入庫」に更新する。残りは「管理」のまま。 |
| **3. API が全品目を送っていない** | 1回の入庫で動いた全品目を API の entries で送っていないと、送った品目だけ「入庫」、それ以外は「管理」のままになる。 |

---

## 1. 「管理」のままになる要因

### 設計の前提

- **inventory_levels/update** の Webhook ペイロードには、多くの場合 **`inventory_adjustment_group_id` が含まれない**（Shopify の仕様）。
- アプリ側は意図的に「**常に admin_webhook（管理）で保存し、POS/アプリの api/log-inventory-change が正しい activity で上書きする**」設計になっている。
- ログの `[inventory_levels/update] No adjustment_group_id. Recording as admin_webhook; api/log-inventory-change will overwrite to correct activity.` はこの仕様どおりの動き。

### 不具合として現れる理由

「管理」のままになる主な要因は次のどちらか（または両方）です。

| 要因 | 説明 |
|------|------|
| **api/log-inventory-change が呼ばれていない** | 管理画面での入庫・出庫・ロス・棚卸・仕入を行ったときに、その操作を通知するために **api/log-inventory-change** が呼ばれる想定。呼び元（管理画面のスクリプトや別アプリ）が未実装・無効・エラーで呼んでいないと、Webhook で保存された「管理」が上書きされず残る。 |
| **呼ばれるタイミング・条件のずれ** | API は「**直近の admin_webhook ログ**」（同一 shop・inventoryItemId・locationId・約30分の時間窓）を探して上書きする。Webhook が複数件まとめて届いたり、API が届くより先に別の admin_webhook が挿入されたりすると、意図した行と別の行が更新されたり、該当なしで「上書きされない」ことがある。 |

**まとめ**: 「管理」固定は、**Shopify が種別を送ってくれないこと**と、**種別を付ける役割の api/log-inventory-change が届いていない／マッチしていないこと**の両方の結果です。

---

## 2. 「入庫」なのに商品名・SKU・JAN が空になる要因

### 2-1. Webhook で session が無いとき

- **inventory_levels/update** では、**セッションがあるときだけ** GraphQL で「InventoryItem → variant（id, sku）」を取得し、`variantId` と `sku` を保存している。
- **セッションが無い**（例: インストール直後・再デプロイ直後・認証切れなど）ときはログに  
  `[inventory_levels/update] No session; saving minimal log (no GraphQL).`  
  と出て、**ロケーション名・SKU・variantId は一切取らず**「最小限のログ」だけ保存する。
- そのあと api/log-inventory-change がこの行を「入庫」に上書きしても、**上書き処理では variantId/sku を更新していない**ため、商品名・SKU・JAN は空のまま残る。

### 2-2. api/log-inventory-change で admin_webhook を上書きするとき

- api/log-inventory-change が「直近の admin_webhook」を探して **activity だけ「入庫」などに更新**するとき、  
  更新内容は **activity, sourceType, sourceId, delta, quantityAfter, locationName** などに限られている。
- **variantId と sku は update の対象に含めていない**（`app/routes/api.log-inventory-change.tsx` の updateData に未記載）。
- そのため、
  - もともと Webhook で **sku/variantId が空**で保存されていた行は、「入庫」に書き換わっても **商品情報は空のまま**。
  - もともと Webhook で **sku/variantId が入っていた**行は、上書き後もそのまま残る（意図どおり）。

### 2-3. API が「新規作成」するとき（admin_webhook が無い）

- 「入庫」で **該当する admin_webhook が無い**場合、api/log-inventory-change は **新規ログを 1 件 create** する。
- このとき **リクエスト body の variantId / sku** をそのまま DB に保存する。
- POS や呼び元が **variantId・sku を送っていない**（一括入庫で「種別＋在庫数」だけ送っているなど）場合、**新規作成時点で variantId/sku が空**になり、CSV で商品名・SKU・JAN が「-」になる。

**まとめ**: 「入庫」なのに商品が空なのは、(1) Webhook が session なしで保存したため最初から sku/variantId が空、かつ (2) その後の API 上書きで variantId/sku を付与していない、または (3) API が新規作成するときに呼び元が variantId/sku を送っていない、のいずれか（または組み合わせ）です。

---

## 3. 参照IDが同じ「7840170230」の「入庫」が複数行ある件

- 参照ID 7840170230 は **sourceId**（入庫元の伝票・オーダー・調整グループ ID などの想定）。
- **同一 sourceId で複数アイテムが一括入庫**されると、在庫変動は **品目ごとに 1 件ずつ** inventory_levels/update が飛ぶ。
- 各 Webhook で 1 行ずつログが立つが、**session なし**だったり **API が variantId/sku を付与していない**ため、どれも「入庫・商品名なし・同一参照ID」の行が並ぶ。
- 設計上「1 sourceId = 1 行」にはなっていないため、**同一参照IDで複数行になるのは仕様どおり**の動きです（紐付け不具合というより「商品情報が埋まっていない」問題）。

---

## 4. 改善の方向性（参考）

1. **「管理」を減らす**
   - 管理画面での入庫・出庫・ロス・棚卸・仕入時に **必ず api/log-inventory-change が呼ばれる**ようにする（実装・ネットワーク・認証の確認）。
   - 必要なら、**時間窓や検索条件**（同一 item/location の直近 1 件に絞るなど）を見直し、意図した admin_webhook に確実にマッチするようにする。

2. **「入庫」で商品名・SKU を埋める**
   - **api/log-inventory-change で admin_webhook を上書きするとき**、リクエストに variantId/sku が含まれていれば **updateData に variantId と sku を追加**して保存する。
   - **Webhook で session が無い場合**の代替として、「後からバッチで inventoryItemId から GraphQL 取得して variantId/sku を埋める」処理を用意する。
   - **POS 側**で、入庫・出庫などを送るときに **variantId と sku を必ず body に含める**ようにする。

3. **重複・取りこぼしの見直し**
   - 同一変動で Webhook が複数回来た場合の「スキップ」条件（重複キー・時間）と、API の「直近 1 件」検索の時間窓を揃え、取りこぼしや二重記録が起きないようにする。

---

## 5. 関連コード箇所

| 内容 | ファイルとおおよその位置 |
|------|---------------------------|
| Webhook で admin_webhook 固定・adjustment_group 未使用 | `webhooks.inventory_levels.update.tsx` 166–177 行付近 |
| Webhook で session が無いときの最小ログ | 同 178–179 行付近 |
| Webhook で SKU/variantId 取得（GraphQL） | 同 147–165 行付近 |
| API で admin_webhook を上書き（variantId/sku 未更新） | `api.log-inventory-change.tsx` 275–284 行、395–404 行付近 |
| API で新規 create するときの variantId/sku | 同 337–354 行、462–476 行付近（リクエストの variantId/sku をそのまま保存） |
