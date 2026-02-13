# POS の変動数「-」と「アクティビティ Webhook」の要因分析（2026-02-13）

Render ログ・CSV（共有済みドキュメント）とコードを突き合わせた要因追求の結果です。

---

## 1. 前提：今回の件は「全て POS アプリでの処理」

- 入庫・出庫・ロス・棚卸・仕入など、**POS アプリで確定した在庫変動**が対象。
- 管理画面での在庫調整ではなく、**POS → api/log-inventory-change → その後 inventory_levels/update Webhook** という流れ。

---

## 2. なぜ「直前ログを遡って delta 算出」の修正では解消されないか

### 2.1 POS での実際の流れ（ドキュメント 20260213 と一致）

| 順番 | 起きること |
|------|------------|
| 1 | **POS が api/log-inventory-change を呼ぶ**（例: activity=inbound_transfer, deltas=[{ inventoryItemId, delta }], quantityAfter は送らないことが多い） |
| 2 | **API は「直近の admin_webhook を上書き」を試みる**が、この時点では **まだ Webhook が届いていない** → ヒットしない（No admin_webhook log found） |
| 3 | **API は新規 create**：activity=inbound_transfer, **delta=リクエストの値**, **quantityAfter=null** |
| 4 | **その後** Shopify から **inventory_levels/update** が届く |
| 5 | Webhook は「既知アクティビティの直近ログ」を検索 → **API が作った inbound_transfer（quantityAfter=null）** が見つかる |
| 6 | 既存対応：「quantityAfter が null なら同一イベント」→ **その行の quantityAfter を available で更新するだけ**（新規 admin_webhook は作らない） |

### 2.2 変動数「-」が出る理由

- **変動数**は DB の `delta` がそのまま表示される。`delta` が null だと画面で「-」になる。
- 想定される原因は次のどちらか（または両方）:
  1. **Webhook が先に届いた場合**  
     - 直近ログがまだ無い → Webhook は **admin_webhook（delta=null）** で 1 行保存。  
     - その後 API が届き「admin_webhook を探して上書き」すれば、**API が delta を渡していれば** update で delta が入る。  
     - しかし **API が届かない・失敗する・時間窓外**だと、その 1 行は delta=null のまま残り「変動数 -」になる。
  2. **API が先で create したが delta が入っていない場合**  
     - 通常は POS が `delta` を送り、API は create 時に `delta` を保存する（extensions/common/logInventoryChange.js で `delta: Number(d.delta)` を送っている）。  
     - 何らかの理由で **delta が送られていない／API が null で保存している**と「変動数 -」になる。

### 2.3 今回の「遡り」修正が効く／効かないケース

- **遡り修正**：「直近 1 件の quantityAfter が null のとき、同一 item/location で quantityAfter が null でない直近 1 件を遡って prevAvailable とし、delta = available - prevAvailable を計算する」。
- これは **Webhook が「新規で admin_webhook 行を保存する」とき**の delta 算出に効く（直前が未確定でも、その前の確定値から変動数を出す）。
- **POS の典型的な流れ**では、Webhook は「新規 admin_webhook を作る」のではなく、**既存の inbound_transfer 行の quantityAfter を更新するだけ**で return している。  
  → その経路では **delta の再計算をしていなかった**ため、その行が元々 delta=null（Webhook 先着で admin_webhook だったが API がまだ来ていない、など）だと「変動数 -」のままだった。

### 2.4 今回追加した対応（POS で確実に変動数を埋める）

- **既知アクティビティの既存ログ**（inbound_transfer 等）の **quantityAfter が null** のとき、  
  「同一イベント」として **quantityAfter を available で更新する**処理のところで、  
  **その行の delta が null なら**、同一商品・同一ロケーションで **この行より前の時刻の「quantityAfter が null でない直近 1 件」** から prevAvailable を取得し、  
  **delta = available - prevAvailable** を計算して **同じ update で delta も更新**する。
- これで「API が後から来ない」「API が delta を送っていない」場合でも、**Webhook 側だけで変動数を補完**できる（入庫・出庫・ロス・棚卸・仕入など全アクティビティで同じ考え方）。

---

## 3. 「アクティビティの Webhook」はなぜ適用されていないか

### 3.1 Shopify の在庫 Webhook の仕様

- **inventory_levels/update** は「在庫レベル（available）が変わった」という**結果**だけを通知する Webhook。
- ペイロードに含まれるのはおおむね次のようなもの:
  - `inventory_item_id`, `location_id`, `available`, `updated_at`
  - 管理画面での在庫調整時は **inventory_adjustment_group_id** が付くことがある
- **「何で変動したか」（入庫・出庫・売上・返品・ロス等）はペイロードに含まれていない**。

### 3.2 いわゆる「アクティビティ用」の Webhook について

- Shopify には **「在庫変動の種別だけを通知する」専用 Webhook** はない。
- **InventoryAdjustmentGroup**（GraphQL）は、**管理画面での在庫調整**をまとめたもので、  
  `inventory_levels/update` のペイロードに `inventory_adjustment_group_id` が付く場合は、この GraphQL から `reason` や `changes` を取得できる。
- **POS アプリ経由の在庫変更**では、Shopify 側は「在庫レベルが変わった」とだけ記録し、  
  **inventory_adjustment_group_id が付かない／種別が紐づかない**ことが多い。  
  → **Webhook だけでは「入庫」「出庫」などのアクティビティを判定できない**。

### 3.3 結論

- 「アクティビティの Webhook があるはずなのに適用されていない」のではなく、  
  **在庫の「種別」を伝える Webhook は Shopify には存在しない**。
- 種別を付けるには、**POS から api/log-inventory-change で activity を明示する**現行設計が正しい。
- そのうえで、**Webhook が先に届いたり API が delta を入れられなかったりする場合**に備え、  
  上記「既知アクティビティ行の quantityAfter 更新時に delta を補完する」処理で変動数「-」を減らす。

---

## 4. 共有されていた Render ログ・CSV との対応（参照ドキュメント）

- **INVENTORY_ACTIVITY_MANAGEMENT_CAUSE_20260212.md**  
  - 18:29 / 19:30 / 20:11・20:14 が「管理」になる要因（レース・連続売上・既存が admin_webhook のまま等）。  
  - 変動数「-」の行（例: 20:11 の delta=null, quantityAfter=2, admin_webhook）も、ログの流れで説明されている。
- **INVENTORY_ACTIVITY_MANAGEMENT_CAUSE_20260213.md**  
  - POS 入庫時の「API が先に create（quantityAfter=null）→ Webhook が既存行の quantityAfter だけ更新」という流れ。  
  - 二重記録防止のため「quantityAfter が null の既存行は更新のみで新規 admin_webhook を作らない」対応が記載されている。
- **SALES_REFUND_VERIFICATION_CHECKLIST.md**  
  - 共有されていた変動履歴・Render ログの要約（POS ロケーションがすべて「管理」・変動数「-」等）。

今回の修正は、**同じ Render ログ・CSV で起きている「POS 由来で変動数が - のまま」** を、  
Webhook 側で「既知アクティビティ行の quantityAfter 更新時に delta を補完する」ことで解消するためのものです。

---

## 5. 今後の確認ポイント（Render ログ・CSV）

- 変動数「-」の行について:
  - その直前に **`[api.log-inventory-change] No admin_webhook log found to update`** が出ているか（API が先で、Webhook が後から届いて既存行を更新しているか）。
  - その直前に **`[inventory_levels/update] Existing log quantityAfter is null; updating to available (same event)`** と **`Complementing delta for same-event update`** が出ているか（今回の delta 補完が効いているか）。
- POS から API を呼ぶタイミングで、**delta がリクエストに含まれているか**（`[api.log-inventory-change] Processing entry: activity=..., delta=...` のログで確認）。

---

**作成日**: 2026-02-13  
**関連**: INVENTORY_ACTIVITY_MANAGEMENT_CAUSE_20260212.md, INVENTORY_ACTIVITY_MANAGEMENT_CAUSE_20260213.md, SALES_REFUND_VERIFICATION_CHECKLIST.md
