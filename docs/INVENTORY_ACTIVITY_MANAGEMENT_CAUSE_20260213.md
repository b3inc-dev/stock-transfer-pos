# POS在庫処理の二重記録・「管理」になる要因（2026-02-13）

大量入庫時に「入庫」と「管理」が両方出る・商品情報が無い行が出る事象の原因と対応をまとめます。

---

## 1. 事象の整理

### 1.1 ユーザーが報告しているパターン

| パターン | 内容 |
|----------|------|
| **二重記録** | 同じ発生日時・ロケーションで「入庫」と「管理」が両方表示される |
| **商品情報なしの入庫** | アクティビティは「入庫」だが、商品名・SKU・JAN・オプションがすべて「-」の行が並ぶ |
| **管理に商品あり** | 同じタイミングで「管理」の行には商品名・SKU等が入っている |

### 1.2 ログから分かる処理の流れ

- **api/log-inventory-change** が POS から呼ばれる（例: entries.length=15, activity=inbound_transfer）。
- 各エントリで「admin_webhook を探して上書き」するが、**No admin_webhook log found to update** と出ることが多い。
- その直後〜並行して **inventory_levels/update** Webhook が大量に届く。
- Webhook 側で **Found existing log: activity=inbound_transfer, quantityAfter (null) !== available (1); treating as new event, will create admin_webhook row** となり、**新規で admin_webhook 行を保存**している。

---

## 2. 要因（なぜ二重・「管理」になるか）

### 2.1 処理順序のレース

1. **POS が api/log-inventory-change を送る**  
   - 入庫確定時に、入庫先ロケーション・各商品の delta をまとめて送る。
2. **API は「すでにある admin_webhook を上書き」する設計**  
   - 検索窓: リクエスト時刻の 30分前 〜 max(リクエスト時刻+5分, 現在+2分)。  
   - この時点では **まだ Webhook が届いていない** ため、admin_webhook が **一件もない**。
3. **API は「admin_webhook が無いので新規作成」**  
   - activity=inbound_transfer、delta は設定するが、**quantityAfter は POS から送られてこないことが多く null** のまま保存される。
4. **その後、Shopify から inventory_levels/update が大量に届く**  
   - 既知アクティビティ（inbound_transfer 等）の「直近ログ」を検索すると、**上記の API が作った行** が見つかる。
5. **既存ログの quantityAfter が null**  
   - 現在の実装では「既存の quantityAfter と今回の available が**同じ**なら更新、**違う**なら別イベントとして新規 admin_webhook 作成」。
   - **null と available（数値）は「違う」** と判定されるため、**別イベント → 新規 admin_webhook 行を作成** してしまう。
6. **結果**  
   - 1件目: API が作った **inbound_transfer**（quantityAfter=null、商品情報は API 側で取れていれば入るが、セッションなしだと SKU 等が空になりうる）→ 一覧では「入庫」だが商品が「-」になることがある。  
   - 2件目: Webhook が作った **admin_webhook**（quantityAfter=available、商品は GraphQL で取得）→ 一覧では「管理」で商品あり。  
   - 同じ変動が「入庫」と「管理」の **2行** になる。

### 2.2 商品情報が「-」になる理由

- api/log-inventory-change は **セッションなし**（POS からの CORS 呼び出し）で動くことが多い。
- その場合、variant/sku を GraphQL で取りにいけない、または idempotencyKey のみで既存行チェックして create するため、**商品名・SKU・JAN が未設定のまま** 保存されることがある。
- 一方、Webhook はサーバー内で GraphQL を叩けるため、**admin_webhook 行には商品情報が入る**。
- そのため「入庫（商品なし）」と「管理（商品あり）」がペアで出る。

### 2.3 参照IDが同じ「入庫」が複数行並ぶ理由

- 同一 transfer（参照ID 7840071926 等）で **api/log-inventory-change が複数エントリを一括送信** している。
- 各エントリで「admin_webhook なし → 新規 create（inbound_transfer）」となるため、**同じ参照IDで複数行の「入庫」** ができる。
- さらに各在庫変動ごとに Webhook が来て「既存 inbound_transfer は quantityAfter=null だから別イベント」と判断し、**同じ本数だけ「管理」行** もできる。
- 結果、同じ時刻・同じ参照IDで「入庫」複数行＋「管理」複数行が並ぶ。

---

## 3. 他に起きうる事象の洗い出し

| 事象 | 要因 | 備考 |
|------|------|------|
| 入庫と管理の二重 | 上記の「quantityAfter=null → 別イベント扱いで admin_webhook 新規作成」 | 本対応で軽減 |
| 商品なしの入庫行 | API がセッションなしで create する際に variant/sku を埋められない | 表示側で「参照IDが同じなら管理の行から商品を補完」等の検討余地あり |
| 変動後数量が「-」 | 既存ログが quantityAfter=null のまま表示されている | 本対応で Webhook が既存行を更新するため解消されやすくなる |
| 大量同時のときだけ起きる | Webhook が API より遅れて届き、API 作成行が quantityAfter=null のまま Webhook に渡る | 本対応で「null の既存行は更新のみ」にすれば発生しにくくなる |
| 売上・返品が「管理」になる | 既存の 18:29 / 19:30 / 20:11 型（OrderPendingLocation や連続売上の別イベント判定） | 既存ドキュメント・保存直前の OrderPendingLocation 再チェックで対応済み |

---

## 4. 対応方針（実装で行うこと）

### 4.1 Webhook 側の修正（本対応）

**ファイル**: `app/routes/webhooks.inventory_levels.update.tsx`

- **現状**: 既知アクティビティの既存ログがあり、`quantityAfter !== available` のとき「別イベント」として新規 admin_webhook を作成している。  
  `quantityAfter` が **null** のときも「null !== available」で別イベント扱いになっている。
- **変更**: 既存ログの **quantityAfter が null（未設定）** のときは、**同一イベントの追報** とみなし、  
  **その行の quantityAfter を available で更新するだけ** にして、**新規 admin_webhook 行は作らない**。
- **理由**: API が先に inbound_transfer 等で「quantityAfter=null」の行を作り、その後に Webhook で正しい available が届く、というパターンが大量入庫時に多いため。  
  この場合に限り「別イベント」にせず「既存行の数量だけ確定させる」ようにする。

### 4.2 今後の検討（任意）

- **api/log-inventory-change**: POS から quantityAfter を送る、または API 側で GraphQL により available を取得して保存する。  
  あれば Webhook 到着前から quantityAfter が埋まり、二重化しにくくなる。
- **一覧表示**: 同じ参照ID・同じ時刻の「入庫（商品なし）」行について、「管理」行の商品情報で補完表示する。

---

## 5. 修正後の期待される挙動

- 大量入庫時でも、API が先に inbound_transfer（quantityAfter=null）を作成した場合、  
  Webhook はその行の **quantityAfter を更新するだけ** で終わり、**新規 admin_webhook は作らない**。
- その結果、「入庫」1行＋「管理」1行の二重にならず、「入庫」1行に変動後数量が入って表示される。
- 既存の「既存ログの quantityAfter と available が同じなら更新」や「OrderPendingLocation の保存直前再チェック」はそのまま活きる。

---

**作成日**: 2026-02-13  
**関連**: INVENTORY_ACTIVITY_MANAGEMENT_CAUSE_20260212.md, INVENTORY_HISTORY_ADMIN_AND_DELTA_CAUSE.md
