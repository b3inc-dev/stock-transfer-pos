# AGENTS.md — POS Stock（stock-transfer-pos）

Shopify POS / 在庫移管アプリの長期開発・保守向けエージェント向け指針。  
**事実に基づく要約**。詳細は `docs/` を参照。

## プロジェクト概要

- **リポジトリ**: `b3inc-dev/stock-transfer-pos`
- **デフォルトブランチ**: `main`
- **製品名**: POS Stock（社内アプリ名例: POS Stock - Ciara）
- **役割**: Shopify POS UI Extensions + 埋め込み Admin アプリで、**出庫（InventoryTransfer / Shipment）・入庫受領・ロス・調整・棚卸・発注・仕入・在庫変動履歴**を扱う
- **正の所在**:
  - Transfer / Shipment のライフサイクル → **Shopify Admin GraphQL**
  - アプリ履歴・冪等イベント → **PostgreSQL（Prisma）**
  - POS 下書き・UI 状態 → **`SHOPIFY.storage` / localStorage**

## 絶対制約（このリポジトリで作業するとき）

1. **症状ごとに条件分岐を継ぎ足す前に、状態遷移を読む**（`docs/STATE_MACHINE.md`）
2. **再実行安全性を最優先**（二重 Transfer、API 成功後のログ失敗、250 分割の途中失敗）
3. **コード変更は依頼範囲のみ**。docs-only 依頼ではアプリコードを触らない
4. **推測は推測と明記**。コード・設定に無い「ロケーション単位ジョブキュー」等を前提にしない

## 必読ドキュメント

| 文書 | 内容 |
|------|------|
| [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) | 目的・構成・スコープ |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | コンポーネント・データ配置・デプロイ |
| [`docs/BUSINESS_RULES.md`](docs/BUSINESS_RULES.md) | 業務ルール・250 分割・確定フロー |
| [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) | 状態遷移・retry/timeout・冪等 |
| [`docs/SHOPIFY.md`](docs/SHOPIFY.md) | Location/Inventory/Transfer API |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 設計判断・負債・優先度 |

既存の詳細調査（差分・原因分析）は `docs/` 配下に多数ある。**正本の状態遷移は本セットを優先**し、古いギャップ文書（例: add-shipment 未実装と書かれたもの）は `ModalOutbound.jsx` の現行実装で再確認すること。

## コア実装の所在

| 領域 | 主なパス |
|------|----------|
| 出庫（移管作成） | `extensions/stock-transfer-tile/src/ModalOutbound.jsx` |
| 入庫受領 | `extensions/stock-transfer-inbound/` |
| 共通（履歴・apply-change・appEventId） | `extensions/common/` |
| apply-change API | `app/routes/api.inventory.apply-change.tsx` |
| 履歴ログ API | `app/routes/api.log-inventory-change.tsx` |
| GraphQL 429/503 リトライ | `app/utils/graphql-with-retry.ts` |
| スキーマ | `prisma/schema.prisma` |
| アプリ設定 | `shopify.app.toml` / `shopify.app.public.toml` |

## 状態管理の単位（現行）

| 単位 | 用途 | 評価の要点 |
|------|------|------------|
| **UI ロック** (`submitLockRef`) | 二重タップ防止 | セッション内のみ。永続チェックポイントではない |
| **Shopify Transfer / Shipment** | 出庫の正 | 作成 API にアプリ側 idempotency key **なし** |
| **InventoryChangeEvent (`appEventId`)** | 調整系 apply-change | 冪等あり。**Transfer 作成には使っていない** |
| **InventoryChangeLog (`idempotencyKey`)** | 履歴行 | ログ再送には効く。Transfer 二重作成は防げない |
| **ロケーション** | activate / 在庫レベル待ち | 出庫は origin→destination の 2 点。多ロケ一括ジョブではない |

## 再実行で必ず確認すること

- 250 超の **複数 Transfer ループ途中失敗** → 再確定で先頭チャンクが二重になり得る
- Shopify 成功後の **`logInventoryChangeToApi` 失敗** → Transfer は残る（ロールバックしない）
- POS `adminGraphql` **20s timeout** → サーバー側 `withGraphQLRetry` と挙動が異なる
- 入庫は **alreadyAccepted 差分** + 安定 `appEventId` で比較的安全。出庫作成は UI ロック中心

## トリガー / GAS / CI

- **GAS（Google Apps Script）: リポジトリ内に存在しない**
- **GitHub Actions: なし**（`.github/workflows` なし）
- **定期実行**: Render Cron → 日次在庫スナップショットのみ（移管処理ジョブではない）
- **デプロイ**: `main` → Render；拡張は `shopify app deploy`（inhouse / public）

## 変更時のチェックリスト

- [ ] 状態遷移図（`STATE_MACHINE.md`）と矛盾しないか
- [ ] 二重発行・部分成功・timeout 直後の再実行を説明できるか
- [ ] Transfer 作成と apply-change / 履歴ログを混同していないか
- [ ] 既存の「条件継ぎ足し」負債を増やしていないか（`DECISIONS.md`）
