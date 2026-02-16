# 在庫変動アクティビティ反映の保証設計（公開アプリ向け）

「管理画面からの在庫変動のみ管理、その他は全てアクティビティが反映され二重にならない」ことを確証するための設計と実装ポイントです。

---

## 1. 保証したいこと

| 要件 | 内容 |
|------|------|
| **管理のみ** | 管理画面（Shopify 管理・在庫調整）由来の変動だけが「管理」になる |
| **アクティビティ反映** | POS（入庫・出庫・ロス・棚卸・仕入）、売上、返品、キャンセル戻りは、すべて正しいアクティビティで 1 行だけ記録される |
| **二重にならない** | 同一の在庫変動が「管理」と「入庫」など 2 行に分かれて記録されない |

---

## 2. 変動の発生源と記録経路

| 発生源 | 記録経路 | 期待アクティビティ |
|--------|----------|---------------------|
| 管理画面での在庫調整 | inventory_levels/update のみ | admin_webhook（管理） |
| POS 入庫・出庫・ロス・棚卸・仕入 | api/log-inventory-change → 後から inventory_levels/update | inbound_transfer / outbound_transfer / loss_entry / inventory_count / purchase_entry / purchase_cancel |
| 売上（受注・履行） | orders/updated または OrderPendingLocation + inventory_levels/update | order_sales |
| 返品 | refunds/create または inventory_levels/update 後で refund に更新 | refund |
| 注文キャンセル | orders/updated（cancelled_at）または inventory_levels/update 後で order_cancel に更新 | order_cancel |

---

## 3. 反映漏れ・二重を防ぐ実装（全経路）

### 3.1 inventory_levels/update Webhook

- **既知アクティビティの直近ログ**（同一 item/location、30分前〜5分後）がある場合  
  - quantityAfter が今回の available と**同じ** → その行の quantityAfter のみ更新して return（新規「管理」を作らない）  
  - quantityAfter が **null**（API が先に create した行）→ 同一イベントとみなし、quantityAfter を available で更新し、delta が null なら補完して return  
  - quantityAfter が**数値で不一致** → 別イベントとして新規 admin_webhook を作成（連続売上など）
- **直近が admin_webhook のみ**の場合（既知アクティビティが時間窓に無い）  
  - 同一 item/location で **2分前〜1分後** に admin_webhook が 1 件あり、その quantityAfter が今回の available と**一致または null** → その行を更新して return（同一変動の 2 本目で二重にならない）
- **OrderPendingLocation** にマッチ → order_sales で保存（新規または既存 admin_webhook を order_sales に更新）
- **保存直前** に OrderPendingLocation を再検索（レース対策）
- **knownActivities** に order_sales, refund, order_cancel, inbound_transfer, outbound_transfer, loss_entry, inventory_count, purchase_entry, **purchase_cancel** を含める

### 3.2 api/log-inventory-change（POS）

- **admin_webhook** を時間窓内で検索 → あればその行を指定 activity に更新（delta, quantityAfter も設定）
- **order_sales / refund** を時間窓内で検索 → あればその行を更新（二重 create 防止）
- **同一 activity**（inbound_transfer, outbound_transfer, loss_entry, inventory_count, purchase_entry, purchase_cancel）を時間窓内で検索 → あればその行を更新（POS の重複送信で二重にならない）
- いずれも無い場合のみ **新規 create**

### 3.3 orders/updated（売上）

- キャンセル時（cancelled_at）: **order_cancel** を記録する前に、時間窓内の **admin_webhook** を検索 → あればその行を order_cancel に更新して新規 create しない（二重防止）
- 非キャンセル時: OrderPendingLocation 登録、または時間窓内の admin_webhook を order_sales に救済

### 3.4 refunds/create

- 時間窓内の **admin_webhook** を検索 → あればその行を refund に更新して新規 create しない

---

## 4. ID 形式の統一（二重の原因になりやすいポイント）

- **inventory_levels/update** はペイロードを**数値 ID**のまま保存している
- **orders/updated / refunds/create** は **GID 形式**で保存していることがある
- そのため「既知アクティビティ」「admin_webhook」の検索では、**inventoryItemId / locationId の両方の形式**を候補にして検索する（inventoryItemIdCandidates, locationIdCandidates）
- **delta 算出用の「直前ログ」**（prevLog / prevLogWithQty）も、数値のみだと order_sales/refund（GID 保存）を拾えず誤った直前値から delta が計算されるため、**両形式を候補**にして検索する（prevItemCandidates, prevLocCandidates）

---

## 5. 時間窓の目安

| 処理 | 窓 |
|------|-----|
| 既知アクティビティ検索（Webhook） | updatedAt - 30分 〜 updatedAt + 5分 |
| 直近 admin_webhook（同一イベント、Webhook） | updatedAt - 2分 〜 updatedAt + 1分 |
| api/log-inventory-change | ts - 30分 〜 max(ts+5分, now+2分) |
| OrderPendingLocation マッチ | updatedAt - 5分 〜 updatedAt + 2分 |
| order_cancel 既存 admin 検索 | cancelledAt - 30分 〜 cancelledAt + 5分 |

---

## 6. チェックリスト（公開アプリリリース前の確認）

### 動作確認

- [ ] 管理画面のみで在庫を変更したとき、履歴には「管理」が 1 行だけ出る（同一操作で 2 本 Webhook が来ても 1 行にまとまる）
- [ ] POS で入庫確定後、履歴には「入庫」が 1 行だけ出る（「管理」が並ばない）
- [ ] POS で出庫・ロス・棚卸・仕入をしたとき、それぞれ正しいアクティビティで 1 行だけ出る
- [ ] 売上（POS/オンライン）後、履歴には「売上」が 1 行だけ出る
- [ ] 返品後、「返品」が 1 行だけ出る
- [ ] 注文キャンセル後、「キャンセル戻り」が 1 行だけ出る（「管理」が並ばない）
- [ ] 同一商品・同一ロケーションで短時間に 2 回変動した場合（例: 連続売上）、2 行とも正しいアクティビティで、片方が「管理」に化けない

### 運用・案内

- [ ] **初回は必ず管理画面でアプリを開く**ことを、利用手順・オンボーディング・README に明記している（POS・Webhook の API が動くために必須）
- [ ] 日次 Cron（在庫スナップショット）を設定している（推奨：トークンリフレッシュでセッション維持）

### 監視・確認（定期実施）

- [ ] Render ログで次のメッセージが想定どおり出ているか確認する：
  - `Updated recent admin_webhook (same event)` … 同一変動の 2 本目で二重防止
  - `Remediated admin_webhook to order_sales` … 売上の救済
  - `Updated admin_webhook to order_cancel` … キャンセル戻りの二重防止
  - `Before create: matched OrderPendingLocation` … レース対策での order_sales マッチ
  - `Updated existing admin_webhook to order_sales (avoid duplicate row)` … 連続売上の二重防止
- [ ] 変動履歴一覧で「想定どおり管理のみ・売上・返品・キャンセル戻りが 1 行ずつか」をスポット確認する

---

## 7. 反映漏れ洗い出し・Webhook 変動数（公式）・強固化

- **管理画面 Webhook に変動数は含まれない**ことの公式根拠、および**反映漏れ・二重になりうる箇所の一覧と強固化**は、  
  **`docs/INVENTORY_WEBHOOK_DELTA_OFFICIAL_AND_REFLECTION_HARDENING.md`** にまとめている。  
  公開アプリ化前に一読し、チェックリストと合わせて確認するとよい。

---

## 8. アクティビティ・変動数・変動後在庫が意図とずれうる残りのリスク

以下は、既存の救済・二重防止を入れたうえで、**まだ意図した処理にならない可能性がある箇所**の整理です。

| リスク | どの値がずれるか | 条件・経路 | 対策・備考 |
|--------|------------------|------------|------------|
| **短時間の複数注文で 2 件目が「管理」** | アクティビティ | 同一商品で別注文が続き、1 件目の Webhook で OrderPendingLocation がマッチして削除される。2 件目の Webhook では別 orderId のため Pending が無く「管理」で記録される。 | **対応済み**: inventory_levels/update で「変動前在庫（prevAvailable）=== available + 売上数」となる Pending だけを採用する数量一致マッチに変更。複数 Pending があっても正しい注文に紐づく。 |
| **api/log-inventory-change が別注文の行を更新** | 変動数・変動後在庫 | 同一商品・ロケーションで短時間に複数注文があり、API が「直近の order_sales」を 1 件だけ更新する。直近が 2 件目の注文の行だと、1 件目のロス等を送ったときに 2 件目の行の delta/quantityAfter が上書きされる。 | **対応済み**: order_sales/refund の既存行を更新するのは、API が activity として **order_sales または refund を送ったときだけ**に限定。ロス・入庫等では order_sales 行を更新しない。 |
| **refunds.create で quantityAfter が取れない** | 変動後在庫 | GraphQL で在庫レベルを取得できない場合、既存 admin_webhook 更新時に quantityAfter が null のまま。 | **対応済み**: ロケーション ID の GID/数値両形式で一致を試すフォールバックを追加。取得できない場合は従来どおり既存値を維持。 |
| **orders.updated の救済で quantityAfter を更新していない** | 変動後在庫 | 救済時は activity, delta, sourceType, sourceId, note のみ更新。quantityAfter は既存のまま。 | **対応済み**: 救済時に GraphQL で現在の在庫レベル（available）を取得し、quantityAfter をセットしてから更新。取得失敗時は既存のまま。 |
| **delta が null のまま残る** | 変動数 | 直前ログが無い・InventoryAdjustmentGroup からも取れない、かつ API で補完されない場合。 | **対応済み**: 保存時に note に「変動数は直前ログが存在しなかったため記録されていません」を付与。一覧に「備考」列を追加し、理由を表示。prevLog を GID 候補で検索する修正で、order_sales/refund 直後の誤計算は防止済み。 |
| **重複チェック（5秒窓）で別イベントの行を上書き** | 変動後在庫・二重防止 | 5秒窓内の既存 admin_webhook を「重複」とみなして quantityAfter を更新し return していたため、別イベント（例: 売上→返品）の行を誤って上書きする可能性があった。 | **対応済み**: 「同一イベント」のみ重複扱いするよう変更。既存行の quantityAfter が今回の available と**一致する**か **null** のときだけ更新して return。一致しない場合は別イベントとして新規行を作成。 |

上記のうちリスク 1〜4 および delta null・重複チェックはコードで対策済み。delta が null になるケースは初回変動などで残るが、note と備考列で理由が分かる。

**再確認で追加対応した残りリスク（同上・対策済み）**

| リスク | 対策 |
|--------|------|
| **短時間に複数返品で 2 件目が誤った返品にマッチ** | RefundPendingLocation を「変動前在庫 === available - 返品数」で数量一致マッチに変更（OrderPendingLocation と同様）。初回・保存直前・待機後の 3 箇所で適用。 |
| **refunds.create の prevLog が Webhook 保存行を拾えない** | prevLog 検索で inventoryItemId / locationId を GID と数値の両形式で候補にし、delta 計算の直前値が取れるようにした。 |

**残りの軽微なエッジケース（発生頻度低・仕様上許容）**

- **同一注文で同一商品が2ロケーションから出荷**: **対応済み**。OrderPendingLocation に locationId を追加し、upsert・findMany・deleteMany で locationId を扱うように変更。同一注文で2ロケーション出荷時も各 Webhook が正しいロケーションの Pending にマッチする。
- **異なる変動が同じ変動後在庫で 2 分以内に発生**: 例）10→8 と 12→8。2本目の Webhook で「直近 admin_webhook（quantityAfter=8）」を同一イベントとみなし更新して return するため、2つの変動が1行にまとまる。レアなケース。

新たな Webhook 順序や Shopify 側の挙動変更が出た場合は、上記と同様に「経路・条件・どの値がずれるか」を追記して対策するとよいです。

---

## 9. 関連ファイル

| ファイル | 役割 |
|----------|------|
| app/routes/webhooks.inventory_levels.update.tsx | 在庫 Webhook：既知アクティビティ／直近 admin の更新、OrderPendingLocation、order_sales 救済 |
| app/routes/api.log-inventory-change.tsx | POS API：admin_webhook 上書き、同一 activity 更新で二重防止 |
| app/routes/webhooks.orders.updated.tsx | 注文 Webhook：order_sales 救済、OrderPendingLocation、order_cancel で既存 admin 更新 |
| app/routes/webhooks.refunds.create.tsx | 返品 Webhook：既存 admin_webhook を refund に更新 |
| docs/INVENTORY_WEBHOOK_DELTA_OFFICIAL_AND_REFLECTION_HARDENING.md | Webhook 変動数（公式）・反映漏れ洗い出し・強固化 |

---

**作成日**: 2026-02-13  
**目的**: 公開アプリとして販売する際の「アクティビティ反映漏れなし・二重なし・管理は管理画面のみ」の確証のため
