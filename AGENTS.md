# AGENTS.md — POS Stock（stock-transfer-pos）

Shopify POS / 在庫移管アプリの長期開発・保守向けエージェント向け指針。\
**事実に基づく要約**。詳細は `docs/` を参照。

調査→設計→実装→品質確認→独立レビューの順で進めます。既存仕様・共通処理を優先し、本番コード・deploy挙動を初期設定で変更しません。

- [README.md](README.md): 構成と既存開発手順
- [docs/DEPLOY.md](docs/DEPLOY.md): 開発・deploy・共通運用


## 3ツール共通の入口

共通ルールの正本は本書と既存docsです。Cursor・Codex・Claude Codeは開始前に [docs/DEPLOY.md](docs/DEPLOY.md) の共通開発運用・引き継ぎ・リリース境界を確認してください。1 workstreamにつきowner toolは1つ。main直push・force push、本番操作の無承認実行、Backlogへの勝手な着手は禁止です。

作業分離は毎回の指示を待たず自動で行う。編集前にGitHubのowner・進行中PRとローカル変更を確認し、同じworkstreamの自分の専用branch/worktreeがあれば再利用、なければGitHubの適切なbaseから作成する。main/stagingの共有checkoutや他toolのworktreeへ直接編集しない。詳細手順は上記の共通運用docsを参照する。

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

## 全アプリ共通の UI ルール（11/20 T・正式）

管理画面とお客様アカウントの画面は、全アプリ共通の UI ルールに従う。正本は Shop Point の [docs/UI_RULES.md「全アプリ共通の UI ルール（11/20 T）」](https://github.com/b3inc-dev/shop-point/blob/claude/admin-block-ui-rule/docs/UI_RULES.md)（今は [shop-point#58](https://github.com/b3inc-dev/shop-point/pull/58) のブランチにある。取り込んだあとは main の同じファイル）。T の原文がいちばん元で、下にある前の決まりと食いちがうときは原文に合わせる。全アプリへの広げ方と進み具合は [shop-point#38](https://github.com/b3inc-dev/shop-point/issues/38)。

- このアプリに当てはまる部分: A（管理画面）のすべて。アプリ自身の上部メニュー（A2）は `app/components/AppNavBar.tsx`。B（お客様アカウント）は、今はお客様アカウントの拡張がないので当てはまらない（作るときに使う）。C（残高や履歴を持つアプリだけ）は、お客様ごとの残高と履歴を出す機能がコードに見当たらないので今は当てはまらない（推測。作るときに使う）。
- 写して使う見本: [docs/templates/AdminBlock.tsx](https://github.com/b3inc-dev/shop-point/blob/claude/admin-block-ui-rule/docs/templates/AdminBlock.tsx)（アプリの中に同じ役目の部品があるときは、そちらを直して使う）
- 画面を直す PR には、PC 幅（1280px）と iPhone 幅（390px）の写真を付ける。日付欄があるときは iPhone の Safari（実機）も確かめる。
