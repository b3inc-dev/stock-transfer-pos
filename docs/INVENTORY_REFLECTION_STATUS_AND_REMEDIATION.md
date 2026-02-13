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
| **新** | チャンク送信失敗時のリトライ | ✅ 対応済み | `logInventoryChange.js` に MAX_CHUNK_RETRIES=2 で実装 |

---

## 1. inventory_levels/update Webhook

### ✅ 対応済み

| 要因 | 実装箇所 | 内容 |
|------|----------|------|
| #1 既知アクティビティの見逃し | `webhooks.inventory_levels.update.tsx` L369-411 | `inventoryItemIdCandidates`, `locationIdCandidates` で GID/数値両形式検索 |
| #3 OrderPendingLocation レース | 同ファイル L568-590 | 保存直前に OrderPendingLocation を再検索（18:29 型対策） |
| #3 完全反映（到着順対策） | 同ファイル L597-623 | まだ「管理」で保存する場合、2.5秒待機＋最大2回再検索（inventory_levels/update が先に届いても orders/updated の登録を待って売上で記録） |
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

### 運用で補うもの（ドキュメントに追記済み）

- [x] 初回は管理画面でアプリを開く … README.md に追記済み
- [x] 監視ログのスポット確認 … INVENTORY_ACTIVITY_REFLECTION_GUARANTEE.md のチェックリストに追記済み
- [x] 変動履歴一覧で想定どおり 1 行ずつ記録されているか確認 … 同上

---

**関連ドキュメント**:

- `INVENTORY_WEBHOOK_DELTA_OFFICIAL_AND_REFLECTION_HARDENING.md` … 要因の詳細と公式仕様
- `INVENTORY_ACTIVITY_REFLECTION_GUARANTEE.md` … 保証設計とチェックリスト
