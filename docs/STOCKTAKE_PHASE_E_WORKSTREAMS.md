# Phase E — 棚卸 workstream 外ロードマップ分割

**日付**: 2026-10-08  
**目的**: 棚卸改善プラン Phase E を **別 workstream / 別 owner / 別 PR** に分割する。本ファイルはスコープ境界の正本。**本 PR では実装しない**（doc-only）。

親プランの Phase A–D / F は棚卸 workstream（Cursor）。Phase E 各トラックは着手前に owner を確定すること（`AGENTS.md` / `DEPLOY.md`）。

---

## トラック一覧

| ID | 優先 | トラック | Owner（未定は空） | スコープ（含む） | スコープ外 | 根拠 docs |
|----|------|----------|-------------------|------------------|------------|-----------|
| **E1** | 次 | 公開審査: Billing / Managed Pricing・設定 500 | | App Store 向け Billing UI、Managed Pricing、設定画面 500 調査・修正 | 棚卸 UX / webhook | `RELEASE_REQUIREMENTS_PUBLIC_APP`, `ADMIN_HOME_AND_PLAN_UI_REQUIREMENTS`, `PUBLIC_APP_PLAN_FEATURES_DESIGN` |
| **E2** | 次 | API 2026-04 concurrency（`changeFromQuantity`） | | apply-change / loss / order 等の mutation 対応、DECISIONS 記録済み方針の実装 | API バージョンだけ上げて検証なし | Shopify changelog, `DECISIONS` D9, apply-change |
| **E3** | 次 | 出庫: 作成冪等・250 分割途中失敗・multi-shipment 再検証 | | Transfer 作成チェックポイント、timeout 後成功確認、`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR` 再監査 | 古い `Modal.jsx` gap を盲信 | `DECISIONS` P0, `STATE_MACHINE`, `OUTBOUND_MULTI_SHIPMENT_BEHAVIOR` |
| **E4** | 後 | 入庫: multi-shipment 一括表示・settings 未適用 | | 一括表示 UX、settings 適用のコード突合 | Modal.jsx 前提の陳腐 gap | `MULTI_SHIPMENT_REQUIREMENTS`, `INBOUND_MODAL_MIGRATION_GAP`（要コード確認） |
| **E5** | 後 | 仕入/発注: docs「未着手」と実コード突合後の残件のみ | | 再監査 → 残ギャップのみ PR | docs の「未着手」をそのまま実装前提にしない | `REQUIREMENTS_PURCHASE_AND_ORDER`, `PURCHASE_*` |
| **E6** | 後 | ロス/調整: changeFromQuantity・履歴ラベル・残 UX | | ラベル整合、残 UX | 棚卸 COMPLETE_RETRY の再発明 | `LOSS_*`, `SIMPLE_STOCKTAKE_ADJUSTMENT_*` |
| **E7** | 後 | 横断 perf: 全タイル表示件数・ページネーション | | 明細 DOM ページネーション等 | 棚卸グループ選択 P0（A–B2 済み想定） | `PERFORMANCE_UX_REQUIREMENTS_ALL_FEATURES`, `STOCKTAKE_POS_LIST_PERFORMANCE_REQUIREMENTS` |
| **E8** | 後 | 全機能販売監査 | | App Store skill + `REQUIREMENTS_FINAL` 突合 | 本番 deploy | App Store skill, `REQUIREMENTS_FINAL` |

---

## 運用ルール

1. 1 トラック = 1 owner tool = 1 branch/worktree/PR。
2. 棚卸 Phase A–D / F とファイル衝突する場合は棚卸 PR を優先し、E 側は rebase/待機。
3. `main` 直 push・本番 deploy・Shopify publish は明示承認まで禁止。
4. 陳腐 docs（`Modal.jsx` 前提等）は着手時にコード再検証。`DECISIONS` D7 参照。

---

## 棚卸 workstream との境界

| 含む（棚卸 PR） | 含めない（本ファイルの E*） |
|-----------------|---------------------------|
| グループ選択・まとめて表示 lazy | Billing / Managed Pricing |
| webhook 5s 緩和（注文救済は維持） | 出庫 Transfer 冪等の大規模改修 |
| COMPLETE_RETRY / needMetafieldRetry | API 2026-04 実装（DECISIONS 記録のみ棚卸側） |
| 履歴 event-first・棚卸ドキュメント DB 基盤 | 仕入/発注機能追加 |
