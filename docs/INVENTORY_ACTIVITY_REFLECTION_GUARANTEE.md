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

- [ ] 管理画面のみで在庫を変更したとき、履歴には「管理」が 1 行だけ出る（同一操作で 2 本 Webhook が来ても 1 行にまとまる）
- [ ] POS で入庫確定後、履歴には「入庫」が 1 行だけ出る（「管理」が並ばない）
- [ ] POS で出庫・ロス・棚卸・仕入をしたとき、それぞれ正しいアクティビティで 1 行だけ出る
- [ ] 売上（POS/オンライン）後、履歴には「売上」が 1 行だけ出る
- [ ] 返品後、「返品」が 1 行だけ出る
- [ ] 注文キャンセル後、「キャンセル戻り」が 1 行だけ出る（「管理」が並ばない）
- [ ] 同一商品・同一ロケーションで短時間に 2 回変動した場合（例: 連続売上）、2 行とも正しいアクティビティで、片方が「管理」に化けない
- [ ] Render ログで「Updated recent admin_webhook (same event)」「Updated admin_webhook to order_cancel」等が想定どおり出ているか確認

---

## 7. 関連ファイル

| ファイル | 役割 |
|----------|------|
| app/routes/webhooks.inventory_levels.update.tsx | 在庫 Webhook：既知アクティビティ／直近 admin の更新、OrderPendingLocation、order_sales 救済 |
| app/routes/api.log-inventory-change.tsx | POS API：admin_webhook 上書き、同一 activity 更新で二重防止 |
| app/routes/webhooks.orders.updated.tsx | 注文 Webhook：order_sales 救済、OrderPendingLocation、order_cancel で既存 admin 更新 |
| app/routes/webhooks.refunds.create.tsx | 返品 Webhook：既存 admin_webhook を refund に更新 |

---

**作成日**: 2026-02-13  
**目的**: 公開アプリとして販売する際の「アクティビティ反映漏れなし・二重なし・管理は管理画面のみ」の確証のため
