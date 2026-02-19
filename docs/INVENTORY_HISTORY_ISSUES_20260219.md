# 在庫変動履歴 不具合要因と対策（2026-02-19）

CSV・Renderログから確認した不具合と、想定要因・対策をまとめます。

---

## ① 入庫でアクティビティは「入庫」なのに備考が「変動数は直前ログが存在しなかったため記録されていません」になる

### 現象
- アクティビティは正しく「入庫」で反映されている
- 変動数（+1, +3 など）も表示されている場合があるが、備考に「変動数は直前ログが存在しなかったため記録されていません」が残る

### 要因（処理順の組み合わせ）

1. **Webhook が先に届く**
   - `inventory_levels/update` が先に処理され、その時点では「直前ログ」がまだ無い（同一入庫バッチの他SKUのWebhookが未コミット、またはその商品・ロケーションで初めての変動）
   - そのため **delta=null** のまま `admin_webhook` で1行保存され、備考に「変動数は直前ログが存在しなかったため記録されていません」が入る

2. **その後 api/log-inventory-change が届く**
   - POS 入庫確定で呼ばれる API が、その行を検索して **activity を `inbound_transfer`（入庫）に上書き**し、**delta をリクエスト通りに更新**する
   - しかし **備考（note）は更新していなかった**ため、「変動数は直前ログが存在しなかったため記録されていません」がそのまま残る

### 対策（実装）
- **api/log-inventory-change** で、既存の `admin_webhook` 行を入庫・出庫・ロス・棚卸・仕入などに上書きする際、**delta または quantityAfter を更新するときは `note` を null にクリアする**
- これにより「変動数は…記録されていません」という文言が、正しく入庫として確定した行に残らなくなる

### 補足
- 変動数が「-」で備考に同じ文言が出るケースは、同一設計（Webhook が delta=null で保存 → API が種別のみ上書きして note を更新していなかった）に由来する
- 初回のみ履歴が無く delta がどうしても取れない場合は、従来どおり備考で説明する運用のままとする

---

## ② 名古屋パルコ店の入庫が全て「管理」になっている

### 現象
- 名古屋パルコ店（location_id: 84233715958）の 2026/02/19 10:40 頃の変動が、CSV上はすべてアクティビティ「管理」で、参照IDなし・備考「変動数は直前ログが存在しなかったため記録されていません」になっている
- **実際にはアプリの POS 画面（入庫タイル）から確定した**という場合、API が届いていないか、共有いただいた Render ログに API の記録が含まれていない可能性がある

### 要因の二通り

- **A. 管理画面から変更した場合**
  - `inventory_levels/update` Webhook は種別を判定せず常に `admin_webhook`（管理）で保存する
  - 管理画面からの在庫変更では **api/log-inventory-change は呼ばれない**ため、「管理」のまま残る

- **B. 本当にアプリ POS から入庫確定した場合**
  - 設計上は、POS 確定時に **api/log-inventory-change** が呼ばれ、既に保存されている `admin_webhook` 行を「入庫」に上書きする想定
  - それでも「管理」のままになるのは、次のいずれかが考えられる：
    1. **API がサーバーに届いていない／失敗している**  
       - ネットワークエラー、POS 側の例外で `logInventoryChangeToApi` が実行されていない、など
    2. **API が 401 で失敗している**  
       - オフラインセッションが無い（インストール後や長期間、管理画面を開いていない）
    3. **共有いただいた Render ログに API のログが含まれていない**  
       - 貼り付けが `inventory_levels/update` 中心のため、`[api.log-inventory-change]` や `POST /api/log-inventory-change` の行が含まれていない可能性がある

### 確認方法（B の場合）

- Render のログで、該当時刻前後に次を検索する：
  - `log-inventory-change` または `api/log-inventory-change`
  - `[logInventoryChangeToApi]`（POS 側は Render に出ないが、API 側の `Found admin_webhook log to update` などがあれば API は実行されている）
- ヒットしなければ、**API が届いていない／失敗している**か、**ログの抜粋に含まれていない**かのどちらか

### 対策（運用）

- **今後の運用**: 入庫・出庫等はアプリの POS 画面から確定することを案内する。管理画面のみで変更した分は仕様どおり「管理」のまま
- **既に「管理」で残っているが実態は入庫だった分**: 下記「既存データを CSV と一致させる方法」の救済 API で一括で「入庫」に振り直せる

---

## ③ その他 CSV・ログから気になる点

### 変動数が「-」で備考に「変動数は…記録されていません」が残る行（入庫以外）
- 上記 ① と同様に、Webhook が先に delta=null で保存し、後から API で種別だけ上書きして **note を更新していなかった**ことで残っている
- ① の対策（API で上書き時に note をクリア）で、今後の新規行は解消される

### 一括入庫で「変動数は…」が出る行と出ない行が混在する
- **変動数が記録されている行**:  
  - API が先に届いて delta 付きで作成した、または  
  - Webhook が先でも「直前ログ」が既にあり delta を算出できた、のちに API が種別を上書きした
- **変動数が無く備考だけ残る行**:  
  - Webhook が先に delta=null で保存 → API が種別と delta を上書きしたが、**note をクリアしていなかった**（① の対策で解消）

### 金沢フォーラス店の入庫で同様の備考が多数
- 福岡パルコ店・名古屋パルコ店と同様、**Webhook 先着で delta=null + 備考付きで保存 → API で種別・delta は上書きしたが note を更新していなかった**パターン
- ① の対策で新規分は改善する

### フレームラインアップルウォッチカバー（金沢フォーラス店）11:50 の「管理」-1
- 参照IDなしの「管理」で -1 は、**管理画面からの在庫減**（手動調整）か、**売上として OrderPendingLocation にマッチしなかった**いずれかの可能性がある
- 既存の「保存直前 OrderPendingLocation 再検索」「待機＋再検索」で救済される範囲外だと「管理」のまま残る（docs/INVENTORY_ACTIVITY_MANAGEMENT_CAUSE_20260212.md 等参照）

### Duplicate idempotencyKey（concurrent create）
- ログの「Duplicate idempotencyKey (concurrent create), treating as success」は、**同一 item/location/時刻で複数 Webhook が並列に届いたときの二重防止**で、意図した挙動
- 1件だけ create し、他は 200 で成功扱いにして重複行を防いでいる

---

## 今後常に正しい情報を表示するための恒久対策（実装済み）

一時的な救済ではなく、**今後も**アプリ POS から入庫・出庫等した分が必ず「入庫」「出庫」で表示されるようにするための変更です。

### 1. API の検索時間窓の拡張（api/log-inventory-change）

- **原因**: これまで「admin_webhook を探すとき」の `recentFrom` が **「現在の 60 秒前」より昔を見ない**実装だった。Webhook が先に保存され、API が数分遅れて届くと、該当行が 60 秒より前になるため **ヒットせず「管理」のまま残っていた**。
- **対策**: `recentFrom` を **「イベント 30 分前」と「現在から最大 15 分前」の遅い方**に変更した。
  - これにより、API が 2〜3 分遅れて届いても、既に保存されている admin_webhook 行を確実に検索し、「入庫」等に上書きできる。
- **変更ファイル**: `app/routes/api.log-inventory-change.tsx`（定数 `RECENT_FROM_NOW_MAX_SEC = 15分`、`recentFrom` の算出を `Math.min` → `Math.max` に変更）

### 2. 備考のクリア（同上・既に対応済み）

- Webhook が先に delta=null で保存した行を API が上書きする際、**note を null にクリア**するようにしてあり、「変動数は直前ログが…」が入庫行に残らない。

### 3. 運用上の前提（変わらず）

- **初回オープン**: インストール後（または長期間管理画面を開いていない後）は、**1 回は管理画面でアプリを開く**ことでオフラインセッションを保存する。これがないと POS から API が 401 になり、種別が「管理」のまま残る。
- **入庫・出庫はアプリの POS から確定する**: 管理画面のみで在庫を変更した分は仕様どおり「管理」のまま。

---

## 既存データを CSV と一致させる方法（完全に揃えたいとき）

実態が「入庫」なのに「管理」のままになっている行や、備考「変動数は直前ログが…」が残っている行を、一括で正す方法です。

### 1. 救済 API の用意

- **ルート**: `POST /api/reclassify-change-history`
- **認証**: 環境変数 `RECLASSIFY_CHANGE_HISTORY_API_KEY` を設定し、リクエストヘッダーで `Authorization: Bearer <その値>` を送る。未設定の場合は `INVENTORY_SNAPSHOT_API_KEY` を代わりに参照する。

### 2. 「管理」→「入庫」に振り直す（名古屋パルコ 10:40 の例）

該当時刻・ロケーションの `admin_webhook` 行を一括で `inbound_transfer`（入庫）に更新する例です。

```bash
curl -X POST "https://<あなたのアプリURL>/api/reclassify-change-history" \
  -H "Authorization: Bearer $RECLASSIFY_CHANGE_HISTORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "shop": "ciarabeautiful.myshopify.com",
    "locationId": "84233715958",
    "fromTime": "2026-02-19T01:35:00.000Z",
    "toTime": "2026-02-19T01:45:00.000Z",
    "activity": "inbound_transfer",
    "sourceId": null
  }'
```

- `fromTime` / `toTime`: 対象とする発生日時の範囲（ISO 8601）。上記は JST 10:35〜10:45 を UTC で指定した例。
- `sourceId`: 入庫の参照ID（Transfer ID など）が分かっていれば指定。不明なら `null` のままでよい。
- レスポンスの `updated` が更新件数。CSV 再出力で「入庫」として出るようになる。

### 3. 備考「変動数は直前ログが…」だけをクリアする

既にアクティビティは「入庫」等になっているが、備考だけ残っている行を一括でクリアする例です。

```bash
curl -X POST "https://<あなたのアプリURL>/api/reclassify-change-history" \
  -H "Authorization: Bearer $RECLASSIFY_CHANGE_HISTORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "shop": "ciarabeautiful.myshopify.com",
    "clearStaleNoteOnly": true
  }'
```

- `activity !== admin_webhook` かつ備考に「変動数は直前ログが存在しなかったため記録されていません」を含む行の `note` を null に更新する。本当の「管理」行の備考は触れない。

### 4. 手順の目安（CSV を実態と完全に揃えたい場合）

1. **名古屋パルコ 10:40 を入庫に揃える**: 上記 2 の curl を実行（`shop` / `fromTime` / `toTime` / `locationId` は実データに合わせて変更）。
2. **不要な備考を消す**: 上記 3 の curl を実行（`clearStaleNoteOnly: true`）。
3. 管理画面の在庫変動履歴で対象期間・ロケーションを指定し、CSV を再出力して内容を確認。

---

## 修正内容サマリ

| 項目 | 内容 |
|------|------|
| **① 備考が残る** | api/log-inventory-change で admin_webhook を既知アクティビティに上書きする際、**note を null にクリア**するよう修正済み。既存分は救済 API の「備考クリア」で一括対応可。 |
| **② 名古屋パルコが全て管理** | 管理画面経路なら仕様どおり。**本当に POS から入庫している**場合は API 未到達／失敗か、ログ抜粋に API が含まれていない可能性。既存分は救済 API で「管理→入庫」に振り直せる。 |
| **③ その他** | ① の修正で新規行の備考は解消。既存データは上記救済 API で CSV と実態を一致させられる。 |
