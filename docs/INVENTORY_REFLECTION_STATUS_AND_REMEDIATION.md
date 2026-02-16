# 在庫変動反映漏れ：対応状況一覧と修正方法

**作成日**: 2026-02-13  
**参照元**: `INVENTORY_WEBHOOK_DELTA_OFFICIAL_AND_REFLECTION_HARDENING.md`  
**目的**: 反映漏れが発生する要因ごとに「対応済み／対応が必要」を整理し、必要な修正方法を明示する。

---

## 全体マトリクス（要因別）

| # | 要因 | 対応状況 | 修正方法 |
|---|------|----------|----------|
| 1 | 既知アクティビティの見逃し | ✅ 対応済み | 特になし |
| 2 | 時間窓外で API が遅延 | ⚠️ 運用補完 | 窓拡大は二重リスク。運用で初回管理画面案内。 |
| 3 | OrderPendingLocation のレース | ✅ 対応済み | 特になし |
| 4 | 連続売上で 2 件目が「別イベント」 | ✅ 対応済み | 特になし |
| 5 | 直近が admin_webhook のみの 2 本目 | ✅ 対応済み | 特になし |
| 6 | idempotencyKey の重複 | ✅ 対応済み | 特になし |
| 7 | delta が null のまま残る | ✅ 対応済み | 初回履歴なしは delta=null 不可避（注釈で許容） |
| 8 | セッションなしで 401 | ⚠️ 一部対応 | JWT 自前 decode あり。トークン不正時は 401。 |
| 9 | admin_webhook の時間窓（API が後から） | ⚠️ 軽減済み | 窓拡大済み。極端遅延は残りうる。 |
| 10 | 同一 activity の二重（POS 重複送信） | ✅ 対応済み | 特になし |
| 11 | order_sales/refund の二重 | ✅ 対応済み | 特になし |
| 12 | ID 形式の不一致 | ✅ 対応済み | 特になし |
| 13 | 救済の時間窓（注文編集） | ✅ 対応済み | 特になし |
| 14 | ロケーション不明時の救済 | ✅ 対応済み | 特になし |
| 15 | 複数明細の並列処理 | ✅ 対応済み | 特になし |
| 16 | order_cancel | ✅ 対応済み | 特になし |
| 17 | refunds/create 時間窓 | ✅ 対応済み | 特になし |
| 18 | refunds item/location 候補 | ✅ 対応済み | 特になし |
| **19** | **返品の売上同様処理（RefundPendingLocation）** | ✅ 対応済み | `webhooks.refunds.create.tsx`, `webhooks.inventory_levels.update.tsx`。Line item 検索失敗時の GraphQL Refund フォールバック、RefundPendingLocation 登録、inventory_levels/update での返品マッチ |
| **新** | チャンク送信失敗時のリトライ | ✅ 対応済み | `logInventoryChange.js` に MAX_CHUNK_RETRIES=2 で実装 |
| **20** | **Webhook の create が API の検索より遅いレース（ロス・入庫・売上・返品等）** | ✅ 対応済み | 共通モジュール `admin-webhook-retry.ts` で 2.5 秒×最大 12 回＝合計 30 秒待機＋再検索。api/log-inventory-change・orders/updated・refunds/create の全経路で適用。見つかった時点で抜けるため早く届けば短い応答で返る。要因は `docs/WEBHOOK_LINKING_ISSUES_CAUSE.md` の要因 A。 |
| **21** | **救済時の idempotencyKey 更新による P2002** | ✅ 対応済み（2026-02-16） | 救済（admin_webhook → order_sales/refund/order_cancel）の **update で idempotencyKey を変更しない**。他経路で同じキーが既に使われていると Unique constraint で更新失敗するため。orders/updated・refunds/create・inventory_levels/update の救済処理で idempotencyKey を update に含めない。 |
| **22** | **並列 Webhook による create の P2002** | ✅ 対応済み（2026-02-16） | inventory_levels/update の create で P2002（idempotencyKey 重複）をキャッチし、ログ出力の上で 200 を返す。もう1リクエストが先に保存済みのため二重送信防止として成功扱い。 |
| **23** | **同一商品で「管理」と「売上」が2行になる** | ✅ 対応済み（2026-02-16） | OrderPendingLocation マッチ時に、`quantityAfter = expectedPrevQty` に加え **quantityAfter === available** の admin_webhook も検索し、あればその行を order_sales/refund に更新。先に届いた Webhook が「売上後」の値で管理保存している場合の二重行を防止。 |
| **24** | **OrderPendingLocation 登録が遅くマッチしない** | ✅ 軽減済み（2026-02-16） | 待機・再検索を 2 回→**3 回**に増加（最大約 7.5 秒）。orders/updated が遅れてもマッチしやすくする。 |
| **25** | **ロケーション不明時 OrderPendingLocation（locationId=""）が検索にヒットしない** | ✅ 対応済み（2026-02-17） | OrderPendingLocation 検索で `locationId` 候補に `""` を含めていたが `.filter(Boolean)` で空文字が除かれていた。`.filter(Boolean)` をやめ、`locationId=""` で登録された行もマッチするように修正。要因: `docs/INVENTORY_ACTIVITY_MANAGEMENT_CAUSE_20260217.md`。 |
| **26** | **RefundPendingLocation の locationId="" と deleteMany の整合** | ✅ 防御的対応（2026-02-17） | 返品は現状 `location_id` なしで RefundPendingLocation を登録しないが、検索の `locCands` に `""` を追加。マッチ時に `locationId` を保持し、deleteMany でマッチした行の locationId を使うよう統一。残存リスク一覧: `docs/INVENTORY_REFLECTION_REMAINING_RISKS.md`。 |

---

## 1. inventory_levels/update Webhook

### ✅ 対応済み

| 要因 | 実装箇所 | 内容 |
|------|----------|------|
| #1 既知アクティビティの見逃し | `webhooks.inventory_levels.update.tsx` L369-411 | `inventoryItemIdCandidates`, `locationIdCandidates` で GID/数値両形式検索 |
| #3 OrderPendingLocation レース | 同ファイル L568-590 | 保存直前に OrderPendingLocation を再検索（18:29 型対策） |
| #3 完全反映（到着順対策） | 同ファイル L597-623 | まだ「管理」で保存する場合、2.5秒待機＋最大**3回**再検索（計最大約7.5秒）。inventory_levels/update が先に届いても orders/updated の登録を待って売上で記録 |
| #4 連続売上で 2 件目が「管理」 | 同ファイル L592-631 | 既存 admin_webhook を order_sales に更新して二重防止（20:11/20:14 型） |
| #5 直近 admin_webhook の 2 本目 | 同ファイル L496-533 | 2分前〜1分後の admin_webhook で quantityAfter 一致 or null なら更新して新規を作らない |
| #6 idempotencyKey 重複 | 同ファイル L309-326 | 同一 timestamp で既存 admin_webhook があればスキップ |
| #7 delta が null | 同ファイル L455-472, L516-529 | 直前ログから delta 補完。初回履歴なしは delta=null を許容 |

### ⚠️ 運用で補うもの

| 要因 | 内容 | 補完方法 |
|------|------|----------|
| #2 時間窓外で API が遅延 | 窓は 30分前〜5分後。極端遅延で「管理」のまま残る | 窓を広げると二重リスク増。**初回は管理画面でアプリを開く**案内を利用手順に明記 |

---

## 2. api/log-inventory-change（POS）

### ✅ 対応済み

| 要因 | 実装箇所 | 内容 |
|------|----------|------|
| #9 admin_webhook 時間窓 | `api.log-inventory-change.tsx` L250 | `recentTo = max(ts+5分, now+2分)` で広めに検索 |
| #10 同一 activity 二重 | 同ファイル L295-350 付近 | 時間窓内で同一 item/location/activity 検索→あれば update |
| #11 order_sales/refund 二重 | 同ファイル L294-350 | 時間窓内で order_sales/refund 検索→あれば update |
| #12 ID 形式不一致 | 同ファイル L254-266, L374-386 | inventoryItemIdCandidates / locationIdCandidates で両形式検索 |

### ⚠️ 一部対応

| 要因 | 現状 | 補完方法 |
|------|------|----------|
| #8 セッションなしで 401 | JWT を自前 decode（`decodePOSToken`）し、成功すれば shop 取得して処理続行 | トークン不正・秘密鍵不一致時は 401。**利用手順で「初回は管理画面を開く」**案内が前提 |

### ✅ 対応済み（チャンク送信リトライ）

| 要因 | 実装箇所 | 内容 |
|------|----------|------|
| チャンク送信失敗時のリトライ | `extensions/common/logInventoryChange.js` | 失敗時に最大 2 回リトライ（1秒待機）。一時的なネットワーク障害で「管理」のまま残る漏れを軽減 |

### ⚠️ 要因 #20：Webhook の create が API より遅いレース（ロス・入庫等で「管理」が残る）

**現象**: 同一のロス（または入庫等）操作で、履歴に「ロス」行と「管理」行の **2 行** が残る。ログでは API が「admin_webhook not found」→ 2.5 秒待機→再検索でも見つからず、その **後** に Webhook が「Saving log: activity=admin_webhook」している。

**原因**:  
- **Webhook**（inventory_levels/update）は「管理」で 1 行保存する **直前** に、OrderPendingLocation／RefundPendingLocation を待つため **2.5 秒×3 回＝約 7.5 秒** 待機する（`PENDING_ORDER_WAIT_MS` / `PENDING_ORDER_MAX_RETRIES`）。ロス・入庫など売上／返品でない場合でもこの待機が走る。  
- **API**（api/log-inventory-change）や **orders/updated / refunds/create** は、既存 admin_webhook を探すときに **共通モジュール `admin-webhook-retry.ts`** で **2.5 秒×12 回＝最大 30 秒** まで待機して再検索する（下記「待機・リトライ一覧」参照）。  
→ 以前は API 側の待機が短く、Webhook の create が遅いと二重になった。**30 秒リトライ**を全経路に適用済み。

**対策（実装済み）**: 共通モジュール `app/utils/admin-webhook-retry.ts` で **2.5 秒×最大 12 回＝合計 30 秒** まで待機してから再検索。以下に適用：
- **api/log-inventory-change**（入庫・出庫・ロス・棚卸・仕入）
- **webhooks.orders.updated**（売上・order_cancel、3箇所）
- **webhooks.refunds.create**（返品）
**見つかった時点で抜ける**ため、admin_webhook が早く commit されていれば短い応答で返り、最大 30 秒待つのは「最後まで見つからなかった場合」のみ。

**30秒（12回）の根拠**  
- 同種の Webhook 抱き合わせでは 15〜30 秒待機が一般的。漏れを残さないよう **最大 30 秒**（2.5秒×12回）まで待機する。  
- **早く届けば短い応答**：ループは「待機→再検索→見つかったら break」なので、早く commit されていれば 2.5 秒・5 秒などで返る。30 秒かかるのは **最後まで見つからなかった場合のみ**。

**理想の待機時間の考え方**  
- **下限**: Webhook の待機合計 5 秒以上。  
- **現状**: 最大 30 秒（12 回）。見つかり次第抜けるため、多くのリクエストは 2.5〜5 秒程度で返る想定。  
- **上限の目安**: 30 秒を超えると POS の体感待ち・タイムアウトのリスクが増える。

**参照**: `docs/WEBHOOK_LINKING_ISSUES_CAUSE.md` 要因 A（レース）。

---

### 待機・リトライの一覧（30秒と OrderPendingLocation の違い）

| 用途 | どこで使うか | 定数・値 | 最大待機 | 履歴・根拠 |
|------|--------------|----------|----------|------------|
| **admin_webhook を探して更新する**（救済・二重防止） | api/log-inventory-change、orders/updated（売上・order_cancel）、refunds/create | `admin-webhook-retry.ts`: 2.5秒×**12回** | **約30秒** | 2026-02-15 に「admin_webhook 未検出時リトライ 30 秒を全経路に適用」。REQUIREMENTS_FINAL・本ドキュメント #20 に記載。見つかり次第抜けるため、多くの場合は 2.5〜5 秒で返る。 |
| **OrderPendingLocation / RefundPendingLocation の登録を待つ** | inventory_levels/update（売上・返品として記録する直前） | `PENDING_ORDER_WAIT_MS` 2500、`PENDING_ORDER_MAX_RETRIES` **3** | **約7.5秒** | 2026-02-14 に 2.5秒×2回で導入、2026-02-16 に 3 回に増加。Webhook の応答を長くしすぎないよう 30 秒にはしていない（Shopify の再送・タイムアウトの観点）。 |

→ **30秒に変更した記憶**は、**admin_webhook を探す側**（admin-webhook-retry.ts）の話で、REQUIREMENTS_FINAL の 2026-02-15 および本ドキュメント #20 に履歴が残っている。**OrderPendingLocation を待つ側**（inventory_levels/update）は別処理で、最大 7.5 秒のまま。

---

## 3. orders/updated（売上・キャンセル）

### ✅ 対応済み

| 要因 | 実装箇所 | 内容 |
|------|----------|------|
| #13 救済の時間窓 | `webhooks.orders.updated.tsx` | fulfillments なし時は **updated_at** 基準で 30分前〜5分後 |
| #14 ロケーション不明時の救済 | 同ファイル L487-491 | orderLocationId が null のときは admin_webhook 救済を**行わない**。OrderPendingLocation のみ登録 |
| #15 複数明細の並列処理 | `webhooks.inventory_levels.update.tsx` L568-590 | 保存直前の OrderPendingLocation 再検索で軽減 |
| #16 order_cancel | `webhooks.orders.updated.tsx` L196-230 | 時間窓内の admin_webhook を order_cancel に更新して二重防止 |

---

## 4. refunds/create

### ✅ 対応済み

| 要因 | 実装箇所 | 内容 |
|------|----------|------|
| #17 時間窓 | `webhooks.refunds.create.tsx` L307-309 | `searchTo = max(refundCreatedAt+5分, now+2分)` |
| #18 item/location 候補 | 同ファイル L295-305 | inventoryItemIdCandidates / locationIdCandidates で両形式検索 |
| #19 売上同様の RefundPendingLocation | 同ファイル、`webhooks.inventory_levels.update.tsx` | ①line_item_id 検索失敗時に GraphQL Refund API で inventory_item_id 取得。②RefundPendingLocation を先に登録（inventory_levels/update が先に届いた場合のマッチ用）。③inventory_levels/update で delta>0 時に RefundPendingLocation マッチ→返品で記録。待機・再検索・既存 admin_webhook→refund 更新も実施。 |

---

## 5. 大量在庫処理（200SKU 等）

### ✅ 対応済み

| 要因 | 実装箇所 | 内容 |
|------|----------|------|
| API タイムアウト | `extensions/common/logInventoryChange.js` L18, L80-106 | `LOG_INVENTORY_CHANGE_CHUNK_SIZE = 50` でチャンク分割送信 |

### ❌ 未対応（追加推奨）

| 要因 | 内容 | 修正方法 |
|------|------|----------|
| チャンク失敗時のリトライ | チャンク送信で 1 件でも 4xx/5xx やネットワークエラーだと、そのチャンク分は記録されず「管理」のまま残る | 失敗時 1〜2 回リトライするロジックを追加 |

---

## 修正方法詳細

### 1. チャンク送信のリトライ ✅ 実装済み

**対象ファイル**: `extensions/common/logInventoryChange.js`

**実装内容**: 失敗時に最大 2 回リトライ（1秒待機）する `sendChunkWithRetry` 関数を追加し、チャンク送信ループで使用。

---

### 2. 時間窓の拡大（任意・リスクあり・非推奨）

**対象**: `webhooks.inventory_levels.update.tsx` の既知アクティビティ検索窓

**現状**: 30分前〜5分後

**拡大案**: 例として 60分前〜10分後に変更する。

**リスク**: 窓が広いと、本当に別イベントの行を誤って「同一イベント」と判定する二重防止ミスが増える可能性がある。**推奨はしない**。運用で「初回は管理画面を開く」案内に頼る。

---

### 3. 運用で補う項目（コード変更なし）

| 項目 | 内容 |
|------|------|
| 初回は必ず管理画面でアプリを開く | POS の api/log-inventory-change が 401 にならないようにする。利用手順・README に明記。 |
| Cron の日次スナップショット | トークンリフレッシュでセッション維持、Webhook/API 成功率向上。 |
| 監視ログの確認 | `Updated recent admin_webhook (same event)`, `Remediated admin_webhook to order_sales`, `Updated admin_webhook to order_cancel`, `Before create: matched OrderPendingLocation`, `Updated existing admin_webhook to order_sales (avoid duplicate row)` が想定どおり出ているか定期的に確認。 |

---

## まとめ：漏れを完全に潰すためのチェックリスト

### コードで実施済み

- [x] 既知アクティビティ・admin_webhook の GID/数値両形式検索
- [x] OrderPendingLocation の保存直前再検索
- [x] 連続売上での既存 admin_webhook → order_sales 更新
- [x] ロケーション不明時の救済スキップ
- [x] チャンク送信（50件ずつ）によるタイムアウト対策
- [x] delta 補完（直前ログから算出）
- [x] JWT 自前 decode（セッションなし時の 401 回避試行）

### 追加実装（完了）

- [x] **チャンク送信のリトライ**（`logInventoryChange.js`）  
  → 失敗時に最大 2 回リトライを実装済み
- [x] **救済時に idempotencyKey を更新しない**（2026-02-16）  
  → `webhooks.orders.updated.tsx`（order_sales / order_cancel）、`webhooks.refunds.create.tsx`、`webhooks.inventory_levels.update.tsx`（既存行を order_sales/refund に更新する箇所）で update の data から idempotencyKey を除外。P2002 による救済失敗を防止。
- [x] **create 時の P2002 を成功扱い**（2026-02-16）  
  → `webhooks.inventory_levels.update.tsx` の create で、idempotencyKey 重複（P2002）をキャッチして 200 を返す。並列 Webhook で二重送信防止。
- [x] **quantityAfter === available の既存行も order_sales/refund に更新**（2026-02-16）  
  → OrderPendingLocation / RefundPendingLocation マッチ時、expectedPrevQty で見つからなければ **quantityAfter === available** の admin_webhook を検索し、あればその行を更新。同一商品で「管理」と「売上」が2行になる残りケースを防止。
- [x] **待機・再検索回数の増加**（2026-02-16）  
  → `PENDING_ORDER_MAX_RETRIES` を 2 → 3 に変更（最大約 7.5 秒待機）。orders/updated が遅い場合のマッチ率向上。

### 運用で補うもの（ドキュメントに追記済み）

- [x] 初回は管理画面でアプリを開く … README.md に追記済み
- [x] 監視ログのスポット確認 … INVENTORY_ACTIVITY_REFLECTION_GUARANTEE.md のチェックリストに追記済み
- [x] 変動履歴一覧で想定どおり 1 行ずつ記録されているか確認 … 同上

---

## 完全に履歴が意図通り処理される方法（設計・運用）

在庫変動履歴を「意図どおり」にするには、**コード側の対策**と**運用前提**の両方が必要です。

### 1. コードで担保していること（2026-02-16 時点）

| 項目 | 内容 |
|------|------|
| 売上・返品の種別 | orders/updated で OrderPendingLocation を**先に**登録 → inventory_levels/update が先に届いても保存直前に再検索＋待機（2.5秒×最大3回＝約7.5秒）でマッチ → order_sales/refund で記録。救済時は idempotencyKey を変更しないため P2002 で失敗しない。 |
| 二重行の防止 | 既存 admin_webhook を order_sales/refund に**更新**して新規行を作らない（同一商品で「管理」と「売上」が2行並ばない）。 |
| 救済の成功 | 救済時の update に idempotencyKey を含めない（本修正）。他経路で同じキーが既に使われていても update が成功する。 |
| 並列 create | 同じ Webhook が並列で届いた場合の create の P2002 をキャッチし、200 を返して成功扱い（1本は既に保存済み）。 |
| 変動数（delta） | 直前ログから算出。初回のみ履歴がない場合は delta=null（UI では「-」）を注釈で許容。 |

### 2. 運用で守ること

| 項目 | 内容 |
|------|------|
| 初回オープン | インストール後（または初回利用前）に**1回は管理画面でアプリを開く**。オフラインセッションが保存され、POS・Webhook から API が通る。 |
| 永続 DB | 本番では PostgreSQL 等の永続 DB を用意し、デプロイで履歴が消えないようにする。 |
| 監視 | たまに変動履歴一覧で「売上であるべき行が管理のまま」「同一商品で管理と売上が2行」がないか確認する。 |

### 3. 意図とずれうる残り要因（許容範囲・追加修正不要）

| 要因 | 現象 | 対応 |
|------|------|------|
| 管理画面からの初回変更 | 変動数が「-」 | Webhook に変動量が含まれない仕様のため、当該 SKU/ロケーションの初回は delta を計算できない。注釈で案内済み。**コードでは遡り delta 算出済み。初回のみ「-」は許容。** |
| 極端な API 遅延 | まれに「管理」のまま | 時間窓（30分前〜5分後）を広げると二重リスクが増えるため、窓は現状のまま。待機は 3 回（約 7.5 秒）に増加済み。 |
| ロケーション不明時の救済スキップ | オンライン受注直後のみ「管理」のまま残りうる | 他ロケーションの行を誤更新しないため意図的にスキップ。OrderPendingLocation ＋ inventory_levels/update のマッチで多くの場合は order_sales になる。 |

### 4. 完全化のために対応済みの修正一覧（2026-02-16）

「履歴を意図通りに扱う方法」を完全にするために実施したコード修正は以下で揃っている。

| # | 修正内容 | ファイル |
|---|----------|----------|
| 1 | 救済時の update で idempotencyKey を変更しない | webhooks.orders.updated.tsx, webhooks.refunds.create.tsx, webhooks.inventory_levels.update.tsx |
| 2 | create 時の P2002 をキャッチして 200 を返す | webhooks.inventory_levels.update.tsx |
| 3 | OrderPendingLocation マッチ時、quantityAfter === available の既存 admin_webhook も order_sales に更新 | webhooks.inventory_levels.update.tsx |
| 4 | RefundPendingLocation マッチ時、quantityAfter === available の既存 admin_webhook も refund に更新 | webhooks.inventory_levels.update.tsx |
| 5 | 待機・再検索を 2 回→3 回に増加 | webhooks.inventory_levels.update.tsx（PENDING_ORDER_MAX_RETRIES） |

上記に加え、**運用**（初回管理画面オープン・永続 DB・たまの履歴確認）を守れば、履歴は意図通りに扱える状態になっている。

---

**関連ドキュメント**:

- `INVENTORY_WEBHOOK_DELTA_OFFICIAL_AND_REFLECTION_HARDENING.md` … 要因の詳細と公式仕様
- `INVENTORY_ACTIVITY_REFLECTION_GUARANTEE.md` … 保証設計とチェックリスト
