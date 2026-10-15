# PROJECT_CONTEXT — POS Stock / 在庫移管

調査日: 2026-10-02（コード・設定ベース）。推測は明記。

## 1. 何のためのプロジェクトか

Shopify 店舗向けの **POS 在庫オペレーションアプリ**。\
POS 上で出庫（ロケーション間移管）、入庫受領、ロス、在庫調整、棚卸、発注、仕入を行い、管理画面で履歴・設定・課金等を扱う。

| 項目 | 事実 |
|------|------|
| Repo | `b3inc-dev/stock-transfer-pos` |
| Default branch | `main` |
| ランタイム | React Router 埋め込み Admin + POS UI Extensions |
| DB | PostgreSQL + Prisma |
| Shopify API | Admin GraphQL **2026-01**（`shopify.app.toml`） |
| ホスティング | Render（社内 / 公開の dual app） |

## 2. 「在庫移管」が指すもの

本プロジェクトで最も重要な移管フローは **出庫 → Shopify InventoryTransfer / InventoryShipment → 入庫受領**。

```text
POS 出庫タイル
  → InventoryTransfer（DRAFT / READY_TO_SHIP / IN_PROGRESS / TRANSFERRED …）
  → InventoryShipment（DRAFT / IN_TRANSIT / PARTIALLY_RECEIVED / RECEIVED …）
  → POS 入庫タイルで受領
```

**アプリ独自の「移管ジョブ」テーブルは存在しない。**\
Prisma の `InventoryChangeEvent` は **在庫数量の set/adjust（apply-change）** 用であり、Transfer 作成そのものの状態機械ではない。

## 3. コンポーネント地図

| 領域 | パス | 役割 |
|------|------|------|
| 出庫 | `extensions/stock-transfer-tile/` | Transfer/Shipment 作成・編集・履歴 |
| 入庫 | `extensions/stock-transfer-inbound/` | 宛先ロケの Transfer 一覧・受領 |
| ロス | `extensions/stock-transfer-loss/` | ロス計上（adjust/set + 履歴） |
| 調整 | `extensions/stock-transfer-adjustment/` | 簡易棚卸/調整 |
| 棚卸 | `extensions/stock-transfer-stocktake/` | 棚卸 metafield + set quantities |
| 発注/仕入 | `extensions/stock-transfer-order/` / `purchase/` | 発注・仕入 |
| 共通 | `extensions/common/` | appEventId・log・apply-change・activate retry |
| Admin | `app/routes/*` | 設定・履歴・API・Webhook |
| スナップショット | `scripts/call-inventory-snapshot-daily.js` + cron API | 日次在庫スナップ（移管処理ではない） |

## 4. Shopify エンティティとの関係

| Shopify | アプリでの使い方 |
|---------|------------------|
| **Location** | 出庫元＝基本はPOSセッション（manualOrigin経路の優先順位は要確認）、宛先＝ユーザー選択。activate / レベル待ちはロケ単位 |
| **InventoryItem** | 明細のキー。追跡未設定時は `inventoryActivate` |
| **InventoryLevel** | 出庫前に origin/dest でレベル存在をポーリング（最大約 30s） |
| **InventoryTransfer** | 出庫の正。250 明細上限のため分割時は **Transfer 複数** |
| **InventoryShipment** | 発送単位。確定時は DRAFT → `MarkInTransit` |
| **Adjustment（set/adjust）** | ロス・調整・棚卸・入庫過不足補正。Transfer とは別経路 |

POS は Shopify のネイティブ在庫移動 UI と並行して動く。アプリは GraphQL で同じ Transfer/Shipment モデルを操作する。

## 5. 処理のトリガー

| トリガー | 対象 | 備考 |
|----------|------|------|
| POS ユーザー操作 | 出庫確定・入庫受領・ロス等 | 主経路 |
| Admin UI | 設定・履歴・棚卸管理等 | |
| Webhook | `inventory_levels/update`, `orders/updated`, `refunds/create` 等 | **履歴・売上/返品突合**。移管作成ジョブではない |
| Render Cron | 日次 inventory snapshot | 移管処理ではない |
| GAS | **なし** | リポジトリ内に Apps Script なし |
| GitHub Actions | **なし** | CI workflow なし |

## 6. 過去修正の傾向（コード・既存 docs から）

症状ごとに継ぎ足された痕跡が強い領域:

- **出庫 250 超分割**（同一 Transfer に載らないため複数 Transfer 化）
- **activate + 在庫レベル待ち timeout**
- **確定ボタン 3 系統**（確定 / 配送準備完了 / 下書き）と編集・Shipment 追加モード
- **履歴・Webhook の idempotencyKey / appEventId**
- **棚卸完了の retry / metafield バックアップ**（出庫 Transfer 作成とは別系統）

→ 状態遷移の正本は [`STATE_MACHINE.md`](./STATE_MACHINE.md)。条件追加前に必ず参照する。

## 7. スコープ外・注意

- 本セットは **調査・設計理解用ドキュメント**。実装変更の代替ではない
- `docs/` 内の古いギャップ文書は現行 `ModalOutbound.jsx` と食い違うことがある
- ルートの `stock-transfer-loss/` など拡張外の残骸パスがあり、正は `extensions/` 配下

## 関連

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`BUSINESS_RULES.md`](./BUSINESS_RULES.md)
- [`STATE_MACHINE.md`](./STATE_MACHINE.md)
- [`SHOPIFY.md`](./SHOPIFY.md)
- [`DECISIONS.md`](./DECISIONS.md)
- ルート [`AGENTS.md`](../AGENTS.md)

## 継続開発の手順と課題管理

[開発・mock検証・障害調査手順](DEVELOPMENT.md) と [BACKLOG](BACKLOG.md) を参照する。通常ownerはCodex、GitHubが唯一の正本。Backlogは未実装候補で、依頼範囲外には着手しない。本番反映の承認条件は [DEPLOY.md](DEPLOY.md) に従う。
