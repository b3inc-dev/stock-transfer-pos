# DECISIONS — 設計判断・負債・優先度

在庫移管まわりの意思決定ログ（調査時点の事実整理）。新しい実装判断を足すときは日付と根拠を追記する。

---

## D1. 移管の正は Shopify Transfer/Shipment（アプリ job なし）

**決定（現行実装）**: 出庫ライフサイクルを Prisma job にせず、Shopify オブジェクトを正とする。

| 利点 | 代償 |
|------|------|
| Admin UI と状態が一致 | 途中進捗・resume・分散ロックがアプリに無い |
| スキーマ単純 | timeout 後の二重作成をアプリが検知しにくい |

**評価**: ドメインとしては妥当。**再実行安全性をアプリが担保しきれていない**点が最大の負債。

---

## D2. 250 超は「複数 Transfer」（同一 Transfer 複数 Shipment ではない）

**根拠（コードコメント）**: Transfer に無い SKU を同一 movement の別 Shipment に載せると数量エラー。

**結果**: ユーザーから見ると「1 回の出庫」が Shopify 上は **複数の在庫移動**になる。

**負債**:

- ループ非アトミック
- 履歴ログが先頭 Transfer 基準（推測: 後続が薄い）
- 失敗時の「どこまで成功したか」が UI に残らない

---

## D3. 作成冪等は UI ロックのみ / 履歴冪等は appEventId

| 層 | 方針 |
|----|------|
| Transfer create | idempotency key **なし** |
| 二重タップ | `submitLockRef` |
| 履歴 | `buildStableAppEventId` + DB unique |
| 数量調整 | `InventoryChangeEvent.appEventId` |

**意図**: 履歴・調整の再送安全性を先に固めた（Phase0/1）。\
**未完了**: 作成そのものの冪等。

---

## D4. POS GraphQL は短 timeout、サーバーは 429 リトライ

| クライアント | timeout | 429 retry |
|--------------|---------|-----------|
| POS `adminGraphql` | 20s | なし |
| サーバー `withGraphQLRetry` | （HTTP 層） | あり |

**負債**: 同じ Shopify API でも経路で耐障害性が違う。POS の timeout は「成功不明」を生みやすい。

---

## D5. 確定 UX を 3 ボタン + 編集/追加モードで分岐

業務上必要（下書き / READY / 即発送）。\
**負債**: `ModalOutbound.jsx` 肥大、条件分岐の重複、ギャップ文書の陳腐化。

---

## D6. 日次処理は snapshot のみ（移管バッチなし） / GAS なし

移管はユーザー駆動。Cron は在庫スナップショット。GAS は採用していない。

---

## 技術的負債チェックリスト

| 負債 | 症状 | 関連 |
|------|------|------|
| **retry 重複** | 失敗後の再確定で Transfer 増殖 | D3, STATE_MACHINE §7 |
| **timeout 継ぎ足し** | 20s / 30s / 90s（棚卸）が機能ごとに散在 | D4 |
| **状態フラグ増加** | UI モードフラグ・編集 ID が増え、正は Shopify と二重管理気味 | D5 |
| **trigger 増加** | Webhook 救済リトライ等は履歴側。移管作成トリガーはまだ単一だが混同注意 | PROJECT_CONTEXT |
| **同一条件判定の複数実装** | activate/wait が確定・READY・下書きで類似コピー | ModalOutbound |
| **手動運用依存** | 部分成功後の Admin キャンセル/再作成。setQuantities rollback 失敗時の手動回復メッセージ | D1, D2 |
| **巨大単一ファイル** | ModalOutbound 1 万行超。レビュー・回帰困難 | D5 |
| **docs の陳腐化** | add-shipment 未実装と書いた文書など | 実装と照合必須 |
| **レガシーパス** | ルート `stock-transfer-loss/` 等 | extensions が正 |

「0 に戻して再実行」型の公式 runbook は **出庫 Transfer 用には未確認（UNKNOWN）**。棚卸・調整 UI のリセットや rollback 失敗メッセージは存在。

---

## 根本的に整理した方がよい部分

1. **出庫作成の冪等・チェックポイント**（チャンク進捗の永続化、または作成前の client request id）
2. **timeout 後の成功確認フロー**（作成直後に Transfer を照会してから再実行可否を決める）
3. **POS とサーバーのリトライ政策統一**
4. **ModalOutbound の分割**と確定パイプラインの単一路線化
5. **多 Transfer 分割時の履歴・ユーザー通知**の一貫性
6. **状態遷移ドキュメントを正本化し、症状パッチを禁止するプロセス**（本 docs セット）

---

## 推奨優先順位（実装は本 PR 範囲外）

| 優先度 | 項目 | 理由 |
|--------|------|------|
| **P0** | 部分成功・timeout 後の二重発行防止設計 | 実在庫・実 Transfer が壊れる |
| **P0** | 運用手順の明文化（Admin で残った Transfer の扱い） | 手動依存が現状の安全弁 |
| **P1** | 250 分割の進捗永続 or オールオアナッシングに近い UX | 最大の部分成功源 |
| **P1** | POS GraphQL の 429/成功確認 | timeout グレーゾーン削減 |
| **P2** | 履歴の多 Transfer 対応 | 監査・サポート |
| **P2** | ModalOutbound 分割・分岐整理 | 将来の症状継ぎ足し防止 |
| **P3** | 陳腐化 docs の整理・アーカイブ | 調査コスト削減 |

---

## 変更しない方がよいこと（現状維持の判断）

- Transfer の正をいきなりアプリ DB に二重管理する（同期地獄）
- 入庫の delta 受領モデルを崩す（比較的安全）
- apply-change の appEventId モデルを捨てる
- Cron で移管を自動再実行する（冪等なしでは危険）

---

## D7. 陳腐 docs の扱い（2026-10-08）

gap / 原因分析ドキュメントで「未実装」「準備中」と書いてあっても、**コード再検証なしに正本としない**。  
棚卸 UX の正本は [`STOCKTAKE_UX_CANON.md`](./STOCKTAKE_UX_CANON.md) + 39GROUPS + COMPLETE_RETRY。  
陳腐候補リスト（`Modal.jsx` 前提、仕入「未着手」矛盾等）は Canon §4。Issue/PR では「参照しない」と明記する。

## D8. REQUIREMENTS_FINAL の役割（2026-10-08）

- **`REQUIREMENTS_FINAL.md`**: 進捗台帳・横断チェックリスト
- **詳細要件**: 各機能の正本（棚卸は Canon / 39GROUPS / COMPLETE_RETRY、履歴は `HISTORY_WEBHOOK_METAFIELD_REQUIREMENTS.md`）
- 台帳と詳細が矛盾する場合は **詳細正本 + 現行コード** を優先し、台帳側を更新する

## D9. API 2026-04 `changeFromQuantity`（記録のみ・2026-10-08）

Shopify Inventory API 2026-04 で concurrency 制御として `changeFromQuantity` が必須化される見込み。  
**本 workstream では実装しない**（Phase E2）。適用対象は apply-change / loss / order / stocktake setQuantities 経路。  
API バージョンバンプとセットで別 PR。

## D10. 棚卸確定順と webhook（2026-10-08）

- 差異あり確定: **apply-change → metafield**（履歴先行で webhook が early-returnしやすくする）
- 非売上 webhook: PENDING_ORDER 長時間 sleep しない（Phase C）
- メタ失敗時: `needMetafieldRetry`、二重 setQuantities 禁止（Phase D）

---

## 関連正本

- [`STATE_MACHINE.md`](./STATE_MACHINE.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`BUSINESS_RULES.md`](./BUSINESS_RULES.md)
- [`SHOPIFY.md`](./SHOPIFY.md)
- [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md)
- [`STOCKTAKE_UX_CANON.md`](./STOCKTAKE_UX_CANON.md)
- [`HISTORY_WEBHOOK_METAFIELD_REQUIREMENTS.md`](./HISTORY_WEBHOOK_METAFIELD_REQUIREMENTS.md)
- [`STOCKTAKE_PHASE_E_WORKSTREAMS.md`](./STOCKTAKE_PHASE_E_WORKSTREAMS.md)
- [`../AGENTS.md`](../AGENTS.md)
