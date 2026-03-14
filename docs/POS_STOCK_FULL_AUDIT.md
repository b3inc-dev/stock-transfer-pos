# POS Stock（stock-transfer-pos）全体監査レポート

実施日: 2025-03-14

---

## 1. ディレクトリ構成と各ファイルの役割一覧

### ルート直下

| パス | 役割 |
|------|------|
| **app/** | Remix / React Router アプリ本体（管理画面・API・Webhook） |
| **extensions/** | POS UI 拡張（タイル・入庫・出庫・棚卸・ロス・発注・仕入・調整など） |
| **prisma/** | DB スキーマ・マイグレーション（PostgreSQL） |
| **scripts/** | 日次スナップショット呼び出し用スクリプト等 |
| **docs/** | 設計・障害分析・手順などのドキュメント |
| **public/** | 静的アセット |
| **.react-router/** | React Router の型・ビルド成果物 |
| **.shopify/** | Shopify CLI のデプロイバンドル等 |

### ルート主要ファイル

| ファイル | 役割 |
|----------|------|
| `package.json` | 依存関係・スクリプト・workspaces（extensions/*） |
| `shopify.app.toml` | アプリ設定（client_id, webhooks, access_scopes） |
| `shopify.app.public.toml` | 公開版アプリ用設定 |
| `vite.config.ts` | Vite ビルド・開発サーバー（HOST, SHOPIFY_APP_URL, FRONTEND_PORT, PORT） |
| `tsconfig.json` | TypeScript 設定 |
| `env.d.ts` | 型参照（vite, react-router, globals.d.ts） |

### app/ 配下

| パス | 役割 |
|------|------|
| **app/routes/** | Remix ルート（画面・API・Webhook） |
| **app/components/** | 共通 UI（AppNavBar 等） |
| **app/utils/** | サーバー用ユーティリティ（在庫変更・スナップショット・タイムゾーン・スキーマ等） |
| `app/root.tsx` | ルートレイアウト |
| `app/entry.server.tsx` | サーバーエントリ |
| `app/routes.ts` | ルート設定（flatRoutes） |
| `app/shopify.server.ts` | Shopify アプリ認証・セッションストレージ（Prisma） |
| `app/db.server.ts` | Prisma クライアント（シングルトン） |
| `app/types.ts` | 共通型定義 |
| `app/export-change-history-csv.server.ts` | 在庫変動履歴 CSV エクスポート処理 |
| `app/globals.d.ts` | グローバル型（s-app-nav, s-link 等） |

### app/utils/ 一覧

| ファイル | 役割 |
|----------|------|
| `ensure-inventory-activated-server.ts` | 在庫管理有効化チェック |
| `inventory-set-quantities-server.ts` | 在庫数量一括設定（GraphQL） |
| `inventory-change-log.ts` | 在庫変動履歴の DB 記録・取得 |
| `timezone.ts` | ショップタイムゾーン取得 |
| `schemas.ts` | Zod スキーマ（API リクエスト検証等） |
| `admin-webhook-retry.ts` | Webhook 処理リトライ |
| `billing.ts` | 課金（プラン取得・使用量レポート） |
| `refresh-offline-session.ts` | オフラインセッション更新 |
| `inventory-snapshot.ts` | 日次在庫スナップショット処理 |

### app/routes/ 一覧（役割のみ・詳細はセクション2）

| ファイル | 役割 |
|----------|------|
| `app.tsx` | 管理画面レイアウト・認証・プラン取得 |
| `app._index.tsx` | ホーム（導入ステップ案内） |
| `app.settings.tsx` | 設定画面 |
| `app.plan.tsx` | 料金プラン・課金 |
| `app.history.tsx` | 入出庫履歴一覧 |
| `app.history.$id.tsx` | 履歴詳細 |
| `app.inventory-count.tsx` | 棚卸画面 |
| `app.inventory-info.tsx` | 在庫情報・変動履歴 |
| `app.loss.tsx` | ロス管理 |
| `app.purchase.tsx` | 仕入管理 |
| `app.order.tsx` | 発注管理 |
| `app.adjustment.tsx` | 調整（簡易棚卸） |
| `app.export-change-history-csv.tsx` | CSV エクスポート |
| `app.keepalive.tsx` | セッション維持 |
| `app.additional.tsx` | 追加ページ（テンプレート） |
| `api.inventory.apply-change.tsx` | POS 在庫変更適用 API |
| `api.log-inventory-change.tsx` | 在庫変動ログ記録 API |
| `api.pos-stocktake-complete.tsx` | 棚卸確定 API |
| `api.inventory-snapshot-daily.tsx` | 日次スナップショット（Cron） |
| `api.staff-members.tsx` | スタッフ一覧 API |
| `api.reclassify-change-history.tsx` | 履歴振替 API |
| `webhooks.inventory_levels.update.tsx` | 在庫レベル更新 Webhook |
| `webhooks.orders.updated.tsx` | 注文更新 Webhook |
| `webhooks.refunds.create.tsx` | 返品 Webhook |
| `webhooks.app.uninstalled.tsx` | アンインストール Webhook |
| `webhooks.app.scopes_update.tsx` | スコープ更新 Webhook |
| `webhooks.compliance.tsx` | コンプライアンス（data_request, redact） |
| `auth.$.tsx` | 認証後リダイレクト |
| `auth.login/route.tsx` | ログインルート |
| `auth.login/error.server.tsx` | ログインエラー |
| `$.tsx` | スプラット（shop/host で /app へ redirect） |
| `_index/route.tsx` | トップルート |

### extensions/ 一覧

| 拡張 | 役割 |
|------|------|
| **common/** | 共通モジュール（appUrl, logInventoryChange, applyInventoryChange, reportStocktakeComplete） |
| **stock-transfer-tile** | 出庫タイル（ModalOutbound 等） |
| **stock-transfer-inbound** | 入庫拡張（InboundListScreen, 入庫 API） |
| **stock-transfer-order** | 発注拡張 |
| **stock-transfer-purchase** | 仕入拡張 |
| **stock-transfer-loss** | ロス拡張 |
| **stock-transfer-adjustment** | 調整（簡易棚卸）拡張 |
| **stock-transfer-stocktake** | 棚卸拡張（InventoryCountList, stocktakeApi 等） |

### prisma/

| パス | 役割 |
|------|------|
| `schema.prisma` | Session, InventoryChangeLog, InventoryChangeEvent/Line, OrderPendingLocation, RefundPendingLocation |
| `migrations/` | マイグレーション |

### scripts/

| ファイル | 役割 |
|----------|------|
| `call-inventory-snapshot-daily.js` | 日次スナップショット API の HTTP 呼び出し |

---

## 2. Remix の loader/action がある routes 一覧と触る Shopify API スコープ

ルートは **flatRoutes** でファイルベース。使用スコープは `shopify.app.toml` の `[access_scopes]` に一括定義：

```toml
scopes = "read_inventory,read_inventory_transfers,read_locations,read_products,write_inventory,write_inventory_shipments,write_inventory_shipments_received_items,write_inventory_transfers,read_orders"
```

### 一覧（loader / action / 主な API 利用）

| ルートファイル | loader | action | 主な役割・触る API リソース |
|----------------|--------|--------|-----------------------------|
| **app.tsx** | ✅ 認証＋getShopPlan | なし | レイアウト。GraphQL: shop.plan, locations, currentAppInstallation.activeSubscriptions |
| **app._index.tsx** | なし | なし | ホーム（Outlet の shopPlan 使用） |
| **app.settings.tsx** | ✅ locations, metafield 読取 | ✅ metafieldsSet | 設定。currentAppInstallation.metafield（settings_v1） |
| **app.plan.tsx** | ✅ getShopPlan | ✅ createAppSubscription | 課金。activeSubscriptions, 課金 Mutation |
| **app.history.tsx** | ✅ locations, inventoryTransfers | ✅ ページネーション等 | 履歴一覧。inventoryTransfers（ページネーション） |
| **app.history.$id.tsx** | ✅ inventoryTransfer(id), shipments, lineItems | なし | 履歴詳細 |
| **app.inventory-count.tsx** | ✅ locations, metafield 読取 | ✅ metafieldsSet | 棚卸。在庫カウント・設定・productGroups 等のメタフィールド |
| **app.inventory-info.tsx** | ✅ locations, metafield, DB 履歴 | ✅ あり | 在庫情報・変動履歴。DB: InventoryChangeLog |
| **app.loss.tsx** | ✅ locations, metafield | ✅ metafieldsSet | ロス設定・履歴メタフィールド |
| **app.purchase.tsx** | ✅ locations, metafield | ✅ metafieldsSet | 仕入設定・履歴メタフィールド |
| **app.order.tsx** | ✅ locations, metafield | ✅ metafieldsSet | 発注設定・履歴メタフィールド |
| **app.adjustment.tsx** | ✅ locations, metafield | ✅ metafieldsSet | 調整設定・履歴メタフィールド |
| **app.export-change-history-csv.tsx** | なし | ✅ CSV 出力 | 認証＋DB/履歴取得＋CSV 生成 |
| **app.keepalive.tsx** | ✅ authenticate.admin | なし | セッション維持 |
| **app.additional.tsx** | なし | なし | 追加ページ |
| **api.inventory.apply-change.tsx** | OPTIONS のみ | ✅ 在庫変更適用 | Bearer/POS 認証。GraphQL: inventorySetQuantities 等。DB: Event/Line, InventoryChangeLog |
| **api.log-inventory-change.tsx** | OPTIONS のみ | ✅ ログ記録 | Bearer/POS 認証。GraphQL: location(id)。DB: InventoryChangeLog |
| **api.pos-stocktake-complete.tsx** | OPTIONS のみ | ✅ 棚卸確定 | Bearer/POS 認証。メタフィールド read/write（inventory-count と同様） |
| **api.inventory-snapshot-daily.tsx** | なし | ✅ 日次スナップショット | Bearer INVENTORY_SNAPSHOT_API_KEY。Session 全件→各ショップ GraphQL・メタフィールド |
| **api.staff-members.tsx** | ✅ authenticate.public, staffMembers | なし | スタッフ一覧。GraphQL: staffMembers |
| **api.reclassify-change-history.tsx** | なし | ✅ 履歴振替 | Bearer RECLASSIFY/INVENTORY_SNAPSHOT_API_KEY。DB: InventoryChangeLog.updateMany |
| **webhooks.inventory_levels.update.tsx** | なし | ✅ 在庫レベル更新 | authenticate.webhook。GraphQL: location, 在庫。DB: OrderPendingLocation, RefundPendingLocation, InventoryChangeLog 等 |
| **webhooks.orders.updated.tsx** | なし | ✅ 注文更新 | GraphQL: shop.ianaTimezone, location, 注文・履行。DB: OrderPendingLocation, InventoryChangeLog |
| **webhooks.refunds.create.tsx** | なし | ✅ 返品 | GraphQL: refund(id), refundLineItems。DB: RefundPendingLocation, InventoryChangeLog |
| **webhooks.app.uninstalled.tsx** | なし | ✅ アンインストール | DB: Session.deleteMany(shop) |
| **webhooks.app.scopes_update.tsx** | なし | ✅ スコープ更新 | DB: Session.update(scope) |
| **webhooks.compliance.tsx** | ✅ 405 用 | ✅ data_request/redact | DB: Session, InventoryChangeLog, OrderPendingLocation, RefundPendingLocation 削除等 |
| **auth.$.tsx** | ✅ redirect | なし | 認証後 /app/settings へ |
| **$.tsx** | ✅ redirect | なし | shop/host があれば /app へ、それ以外は 404 |
| **_index/route.tsx** | あり | あり | トップ |
| **auth.login/route.tsx** | あり | あり | ログイン |

### スコープとリソース対応（要約）

- **read_inventory / write_inventory**: 在庫レベル・inventorySetQuantities・スナップショット・Webhook 在庫更新
- **read_inventory_transfers / write_inventory_transfers**: 入出庫履歴（inventoryTransfers）、転送作成
- **read_locations**: 全画面・API でロケーション取得
- **read_products**: 商品・バリアント情報
- **write_inventory_shipments / write_inventory_shipments_received_items**: 入庫・履行関連
- **read_orders**: 注文更新 Webhook・履行・売上ログ

API は **Admin GraphQL のみ**（REST 未使用）。エンドポイントは `https://${shop}/admin/api/2026-01/graphql.json`（API_VERSION = "2026-01"）。

---

## 3. 外部 API・DB・サービスへの依存関係マップ

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        stock-transfer-pos アプリ                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐     ┌──────────────────────────────────────────────────┐  │
│  │ app/routes/  │     │ Shopify Admin API (GraphQL)                      │  │
│  │ app/utils/   │────▶│ https://${shop}/admin/api/2026-01/graphql.json   │  │
│  │ shopify.     │     │ ・shop, locations, currentAppInstallation       │  │
│  │ server.ts    │     │ ・inventoryTransfers, inventorySetQuantities    │  │
│  └──────────────┘     │ ・metafieldsSet, staffMembers, 課金              │  │
│         │             │ ・refund, orders, shipments, lineItems           │  │
│         │             └──────────────────────────────────────────────────┘  │
│         │                                                                   │
│         │             ┌──────────────────────────────────────────────────┐  │
│         └────────────▶│ Prisma (PostgreSQL) - DATABASE_URL                │  │
│                       │ ・Session (PrismaSessionStorage)                  │  │
│                       │ ・InventoryChangeLog                             │  │
│                       │ ・InventoryChangeEvent / InventoryChangeEventLine │  │
│                       │ ・OrderPendingLocation, RefundPendingLocation     │  │
│                       └──────────────────────────────────────────────────┘  │
│                                                                             │
│  外部からの呼び出し（Bearer 認証）:                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Cron / スクリプト → api.inventory-snapshot-daily (INVENTORY_SNAPSHOT_│   │
│  │   API_KEY), api.reclassify-change-history (RECLASSIFY_*_API_KEY)     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 外部 API

| サービス | 用途 | 使用箇所 |
|----------|------|----------|
| **Shopify Admin API（GraphQL）** | 在庫・転送・ロケーション・商品・注文・返品・メタフィールド・課金・スタッフ | `app/shopify.server.ts` の `admin.graphql`、各ルート・`app/utils/*.ts` |

- Storefront API・その他外部 HTTP サービスは未使用。

### データベース

| 種類 | 役割 | 使用箇所 |
|------|------|----------|
| **Prisma（PostgreSQL）** | セッション・在庫履歴・イベント・一時データ | `app/db.server.ts`（PrismaClient）、`app/shopify.server.ts`（PrismaSessionStorage）、api.* / webhooks.* / app.inventory-info / app.export-change-history-csv |

- Supabase / Redis / キュー: 未使用（コード・package.json に依存なし）。

### その他サービス

- キュー・ジョブサーバー: なし（日次スナップショットは Cron が API を叩く形）。
- extensions 内の「SCAN_QUEUE_KEY」等は POS 側のローカルストレージキー名であり、サーバーキューではない。

---

## 4. 環境変数の使用箇所一覧（キーのみ・値は不要）

コード・設定から参照されている環境変数キー一覧です。

| キー | 主な参照箇所 |
|------|------------------|
| `SHOPIFY_API_KEY` | app/shopify.server.ts, app/routes/app.tsx, app/utils/refresh-offline-session.ts |
| `SHOPIFY_API_SECRET` | app/shopify.server.ts, api.inventory.apply-change, api.log-inventory-change, api.pos-stocktake-complete, refresh-offline-session.ts |
| `SCOPES` | app/shopify.server.ts（カンマ区切りで scopes に渡す） |
| `SHOPIFY_APP_URL` | app/shopify.server.ts, vite.config.ts |
| `SHOP_CUSTOM_DOMAIN` | app/shopify.server.ts（任意） |
| `SHOPIFY_APP_HANDLE` | app/routes/app.plan.tsx（課金 URL 用、未設定時 "app"） |
| `CUSTOM_APP_STORE_IDS` | app/routes/app.tsx（カンマ区切り、inhouse 扱いにするショップ） |
| `APP_DISTRIBUTION` | app/routes/app.tsx（"inhouse" / "public"） |
| `ENABLE_PLAN_DEBUG` | app/routes/app.tsx（"1" でプラン debug 情報を返す） |
| `NODE_ENV` | app/utils/inventory-change-log.ts, app/utils/schemas.ts, app/db.server.ts |
| `INVENTORY_SNAPSHOT_API_KEY` | app/routes/api.inventory-snapshot-daily.tsx, api.reclassify-change-history.tsx, scripts/call-inventory-snapshot-daily.js |
| `INVENTORY_SNAPSHOT_API_URL` | scripts/call-inventory-snapshot-daily.js（未設定時は argv[2]） |
| `SNAPSHOT_CONCURRENCY` | app/routes/api.inventory-snapshot-daily.tsx（日次スナップショット並列数） |
| `RECLASSIFY_CHANGE_HISTORY_API_KEY` | app/routes/api.reclassify-change-history.tsx（未設定時は INVENTORY_SNAPSHOT_API_KEY） |
| `DATABASE_URL` | prisma/schema.prisma（Prisma が参照） |
| `HOST` | vite.config.ts（開発時 URL 正規化用） |
| `FRONTEND_PORT` | vite.config.ts（デフォルト 8002） |
| `PORT` | vite.config.ts（サーバーポート、デフォルト 3000） |

- `import.meta.env.*` の使用はなし。すべて `process.env.*`。

---

## 5. 認証・セキュリティ・API・スコープ・課金の監査結果

実施内容: Webhook HMAC・OAuth state・authenticate 使用・API バージョン・スコープ・Billing の検証。

### 5.1 認証・セキュリティ

#### Webhook の HMAC 署名検証 ✅ 問題なし

すべての Webhook エンドポイントで `authenticate.webhook(request)` を使用しており、Shopify のライブラリ内で HMAC 検証が行われている。

| ファイル | 行 | 内容 |
|----------|-----|------|
| `app/routes/webhooks.refunds.create.tsx` | 81 | `await authenticate.webhook(request)` |
| `app/routes/webhooks.inventory_levels.update.tsx` | 23 | `await authenticate.webhook(request)` |
| `app/routes/webhooks.orders.updated.tsx` | 18 | `await authenticate.webhook(request)` |
| `app/routes/webhooks.app.scopes_update.tsx` | 6 | `await authenticate.webhook(request)` |
| `app/routes/webhooks.app.uninstalled.tsx` | 6 | `await authenticate.webhook(request)` |
| `app/routes/webhooks.compliance.tsx` | 21 | `await authenticate.webhook(request)`（コメントで HMAC 検証の説明あり: 6 行目） |

#### OAuth コールバックと state パラメータ ⚠️ 要確認

- **`app/routes/auth.$.tsx`**（7 行目）: `await authenticate.admin(request)` のみ実行し、state の明示的な検証は行っていない。
- OAuth フローと state 検証は **@shopify/shopify-app-react-router** の `shopifyApp()`（`app/shopify.server.ts`）側で行われている想定。
- **推奨**: ライブラリのドキュメントまたはソースで、コールバック時に state 検証が行われていることを確認すること。

#### authenticate.admin() / authenticate.webhook() / authenticate.public() の使用 ✅ 適切

| 種別 | 使用箇所 | 備考 |
|------|----------|------|
| **admin** | `app.tsx` 208, `app.inventory-count.tsx` 1319/2321, `app.loss.tsx` 30/206, `app.purchase.tsx` 247/362, `app.adjustment.tsx` 33/209, `app.order.tsx` 341/542, `app.history.$id.tsx` 10, `app.plan.tsx` 12/28, `app.history.tsx` 64/323, `app.inventory-info.tsx` 115/564, `app.settings.tsx` 659/699, `app.keepalive.tsx` 7, `auth.$.tsx` 7, `app/export-change-history-csv.server.ts` 77 | 管理画面・レイアウトで適切に使用 |
| **webhook** | 上記 6 つの webhooks.* ルート | すべての Webhook で使用 |
| **public** | `app/routes/api.staff-members.tsx` 23 | POS 等からの公開 API 用で `authenticate.public(request)` を使用 |

- **API ルート（POS 用）**: `api.inventory.apply-change.tsx`, `api.log-inventory-change.tsx`, `api.pos-stocktake-complete.tsx` は **JWT（POS セッショントークン）** を `Authorization` ヘッダーで検証（`jose` の `jwtVerify` + `SHOPIFY_API_SECRET`）。Webhook ではないため `authenticate.webhook` は不要で、現状の設計で妥当。
- **Cron 用**: `api.inventory-snapshot-daily.tsx` は **Bearer トークン**（`INVENTORY_SNAPSHOT_API_KEY`）で認証（111–120 行目）。管理者セッション不要のため適切。

---

### 5.2 API バージョン

#### バージョン表記の統一 ✅ 対応済み（2025-03-14）

| 場所 | バージョン | ファイル・行 |
|------|------------|--------------|
| Webhook 登録設定 | `2026-01` | `shopify.app.toml` 12 行目 |
| アプリサーバー（Admin API） | `ApiVersion.January26`（2026-01） | `app/shopify.server.ts` |
| GraphQL 設定 | `ApiVersion.January26` | `.graphqlrc.ts` |
| Webhook/API 内の直接 fetch | `2026-01` | 各ルート（変更なし） |

**ハードコードで 2026-01 を使用しているファイル:**

| ファイル | 行 | 定数名 |
|----------|-----|--------|
| `app/routes/webhooks.refunds.create.tsx` | 12 | `API_VERSION = "2026-01"` |
| `app/routes/webhooks.inventory_levels.update.tsx` | 10 | `API_VERSION = "2026-01"` |
| `app/routes/webhooks.orders.updated.tsx` | 12 | `API_VERSION = "2026-01"` |
| `app/routes/api.inventory.apply-change.tsx` | 32 | `API_VERSION = "2026-01"` |
| `app/routes/api.log-inventory-change.tsx` | 12 | `API_VERSION = "2026-01"` |
| `app/routes/api.pos-stocktake-complete.tsx` | 16 | `API_VERSION = "2026-01"` |
| `app/routes/api.inventory-snapshot-daily.tsx` | 17 | `API_VERSION = "2026-01"` |
| `app/routes/app.inventory-count.tsx` | 35, 264, 1180 | `ADMIN_GRAPHQL_API_VERSION = "2026-01"` |

- **対応**: `app/shopify.server.ts` および `.graphqlrc.ts` を `ApiVersion.January26`（2026-01）に変更し、アプリ全体で 2026-01 に統一した。

#### 非推奨 API（2024-01 以降）の使用

- コード上、明示的に 2024-01 以前のエンドポイントや非推奨フィールドを参照している箇所は見当たらない。
- `staffMembers` の権限周りは 5.3 を参照。

---

### 5.3 スコープ・権限

#### shopify.app.toml と実際の API 呼び出し

- **定義スコープ**（`shopify.app.toml` 44–45 行目）:  
  `read_inventory`, `read_inventory_transfers`, `read_locations`, `read_products`, `write_inventory`, `write_inventory_shipments`, `write_inventory_shipments_received_items`, `write_inventory_transfers`, `read_orders`
- 在庫・転送・ロケーション・商品・注文・入庫関連の利用は上記スコープと一致している。

#### スコープの不一致 ✅ 対応済み（2025-03-14）

- **`api.staff-members.tsx`** で **`staffMembers`** クエリを使用している。
- **対応**: **shopify.app.toml** および **shopify.app.public.toml** の `scopes` に **`read_users`** を追加した。Plus/Advanced 等で要確認の場合は Partner Dashboard で確認すること。

#### 必要以上に広いスコープ

- 宣言されているスコープは在庫・転送・ロケーション・商品・注文・入庫に限定されており、**過度に広いスコープは要求していない**。

#### .env の SCOPES と toml の一致 ✅ 対応済み（2025-03-14）

- **`app/shopify.server.ts`**: `SCOPES` が未設定の場合は **DEFAULT_SCOPES**（toml の `scopes` と同一の文字列）をフォールバックとして使用するように変更した。これにより .env に SCOPES がなくても toml と一致したスコープで動作する。

---

### 5.4 Billing API（課金）とプレミアム機能のガード

#### 課金確認なしでプレミアム機能にアクセス可能 ✅ 対応済み（2025-03-14）

- **対応**: `app/routes/app.tsx` の loader に、**公開アプリかつ Pro 未加入**（`distribution === "public"` かつ `plan !== "pro"`）のときに、Pro 専用パス（`/app/inventory-info`, `/app/purchase`, `/app/loss`, `/app/order`, `/app/inventory-count`, `/app/adjustment`）へ直接アクセスした場合は **`redirect("/app/plan")`** するガードを追加した。URL 直叩きでプレミアム機能にアクセスできなくなっている。

---

### 5.5 監査サマリー

| 項目 | 結果 | 対応 |
|------|------|------|
| Webhook HMAC | ✅ すべて `authenticate.webhook` で検証 | 特になし |
| OAuth state | ⚠️ ライブラリ任せ | ライブラリで state 検証されているか確認推奨 |
| authenticate 使用 | ✅ 適切 | 特になし |
| API バージョン | ✅ 2026-01 に統一 | shopify.server.ts / .graphqlrc.ts を January26 に変更済み |
| 非推奨 API | ✅ 明示的な使用なし | 特になし |
| スコープと API の一致 | ✅ read_users 追加 | shopify.app.toml / shopify.app.public.toml に read_users 追加済み |
| SCOPES と toml | ✅ フォールバック追加 | SCOPES 未設定時は DEFAULT_SCOPES（toml 同一）を使用 |
| プレミアム機能のガード | ✅ 実装済み | app.tsx loader で Pro 専用パスへの直アクセスを /app/plan へ redirect |

---

以上が POS Stock（stock-transfer-pos）の全体監査レポートです。
