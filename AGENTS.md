# AGENTS.md — POS Stock（stock-transfer-pos）

Shopify POS / 在庫移管アプリの長期開発・保守向けエージェント向け指針。\
**事実に基づく要約**。詳細は `docs/` を参照。

調査→設計→実装→品質確認→独立レビューの順で進めます。既存仕様・共通処理を優先し、本番コード・deploy挙動を初期設定で変更しません。

- [README.md](README.md): 構成と既存開発手順
- [docs/DEPLOY.md](docs/DEPLOY.md): 開発・deploy・共通運用


## 3ツール共通の入口

共通ルールの正本は本書と既存docsです。Cursor・Codex・Claude Codeは開始前に [docs/DEPLOY.md](docs/DEPLOY.md) の共通開発運用・引き継ぎ・リリース境界を確認してください。1 workstreamにつきowner toolは1つ。main直push・force push、本番操作の無承認実行、Backlogへの勝手な着手は禁止です。

作業分離は毎回の指示を待たず自動で行う。編集前にGitHubのowner・進行中PRとローカル変更を確認し、同じworkstreamの自分の専用branch/worktreeがあれば再利用、なければGitHubの適切なbaseから作成する。main/stagingの共有checkoutや他toolのworktreeへ直接編集しない。詳細手順は上記の共通運用docsを参照する。

## Codex単独継続開発（2026-10-04以降）

通常の開発ownerはCodex。GitHubを唯一の正本とし、確認先は依頼元のチャットとする。他チャット・他ツールへの確認を通常の開始条件にしない。既存の他tool所有PR/branchは、停止・明示handoffなしに編集しない。以下は既存の共通運用に追加する現行指示であり、過去の監査記録より優先する。

- 依頼ごとにfetch/status/main/docs/進行中PR/履歴を調査し、専用feature branch/worktreeで進める。合理的に判断できる調査・実装・mockテスト・commit・push・PR作成は確認なしで進める。Backlogへの無断着手はしない。
- inventory mutationを変更する前に入口からShopify mutation・履歴保存まで追跡し、location/SKU/variant/inventoryItem/quantityの対応、冪等キー、再開位置、成功不明状態、部分成功を説明する。
- fixture/mock/test environmentを優先し、実在庫を書き換えない。lint/typecheck/test/build、retry/duplicate/partial failure/location別の検証、自己レビュー・独立レビューを行う。未検証の安全性をテスト済みと記載しない。
- 本番在庫mutation、production app deploy、Shopify本番設定変更、main merge、secret変更、不可逆な本番操作は明示承認まで停止する。PR作成の許可はこれらの許可を含まない。
- PR本文にowner/base/scopeと、在庫変更ロジックへの影響・二重実行防止・retry・timeout・partial failure・テスト結果・本番反映時の注意点を必ず記録する。

調査結果と安全な検証の範囲は [docs/CODEX_INVENTORY_AUDIT.md](docs/CODEX_INVENTORY_AUDIT.md) を参照する。

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
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 安全な開発・mock検証・障害調査・PR手順 |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | 未実装候補・課題ID・完了条件（着手許可ではない） |

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

## 継続開発の手順と課題管理

[開発・mock検証・障害調査手順](docs/DEVELOPMENT.md) と [BACKLOG](docs/BACKLOG.md) を参照する。通常ownerはCodex、GitHubが唯一の正本。Backlogは未実装候補で、依頼範囲外には着手しない。本番反映の承認条件は [DEPLOY.md](docs/DEPLOY.md) に従う。
