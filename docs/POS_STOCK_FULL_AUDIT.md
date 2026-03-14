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

## 6. バグ・実行時エラーになりうる箇所の監査

実施内容: 非同期処理・型・データ安全性・Shopify 固有のバグパターンに絞ったコード検索。

---

### 6.1 非同期処理

#### 6.1.1 await 忘れ・Promise 未処理（.then のみ / 戻り値無視）

| ファイル | 行 | 内容 | リスク |
|----------|-----|------|--------|
| **app/routes/app.tsx** | 159 | `reportUsageRecord(admin, ...).catch(() => {})` | await なし。失敗が握りつぶされ、原因追跡が困難。 |
| **app/routes/app.tsx** | 266 | `fetch("/app/keepalive", ...).catch(() => {});` | await なし（意図的でも、エラーが伝播しない）。 |
| **extensions/stock-transfer-purchase/.../PurchaseHistoryList.jsx** | 585 | `fetchLocations().then((list) => { ... })` | fetchLocations の reject が未処理になりうる。 |
| **extensions/stock-transfer-stocktake/.../InventoryCountConditions.jsx** | 489 | `fetchLocations().then((list) => setAllLocations(...))` | 同上。 |
| **extensions/stock-transfer-loss/.../LossHistoryList.jsx** | 262 | `fetchLocations().then((list) => { if (mounted) ... })` | 同上。 |
| **extensions/stock-transfer-order/.../OrderHistoryList.jsx** | 271 | 同上 | 同上。 |
| **extensions/stock-transfer-adjustment/.../AdjustmentHistoryList.jsx** | 254 | 同上 | 同上。 |
| **extensions/stock-transfer-inbound/src/Modal.jsx** | 651-652 | 設定取得を `.then(...).catch(...)` のみで処理 | await に統一した方が安全。 |

その他、`refreshPending().catch()`、`ensureInventoryActivatedAtLocation(...).catch()`、`refreshOutboundHistory().catch()`、`processScanQueue().catch()`、`tick().catch()` など、**.catch() のみで await していない**箇所が extensions 内に多数あり（InboundListScreen, ModalOutbound, OrderProductList, PurchaseProductList, LossProductList, AdjustmentProductList 等）。エラーをログや UI に反映していないと原因追跡が難しくなる。

**推奨:** 重要な処理は `await` し、catch 内でログ出力または UI 表示を行う。fire-and-forget にする場合はコメントで意図を明示する。

---

#### 6.1.2 Remix の loader/action でエラー時に json({ error }) を返さずクラッシュしうる箇所

| ファイル | 行 | 内容 | リスク |
|----------|-----|------|--------|
| **app/routes/app.tsx** | 244-250 | `catch (e) { ... throw e; }` | エラーを再スローしており、`json({ error })` を返さず画面がクラッシュ。 |
| **app/routes/app.loss.tsx** | 29-66 | loader 全体 | try/catch なし。`authenticate.admin` や `admin.graphql` / `.json()` の throw でそのままクラッシュ。 |
| **app/routes/app.adjustment.tsx** | 32-66 | loader 全体 | 同上。 |
| **app/routes/app.order.tsx** | 340-381 | loader 全体 | 同上。 |
| **app/routes/app.purchase.tsx** | 246- | loader 全体 | 同上。 |
| **app/routes/app.history.$id.tsx** | 8-79 | loader | try/catch はあるが、catch 内で `throw new Response(..., 500)` にしており、JSON ではなく HTML エラーになる。必要に応じて `json({ ok: false, error })` を返す選択肢あり。 |
| **app/routes/app.history.tsx** | 62-159 | loader | try で開始しているが、loader 全体を囲む catch がなく、途中の throw でクラッシュしうる。 |
| **app/routes/app.settings.tsx** | 657- | loader | try/catch なし。同上。 |
| **app/routes/app.plan.tsx** | 11- | loader | 同上。 |
| **app/routes/app.inventory-info.tsx** | 113- | loader | 同上。 |

**推奨:** 各 loader/action の最上位で try/catch し、catch 時は `return json({ ok: false, error: "..." })` や適切な Response を返す。`app.tsx` の catch では `throw e` ではなく、ユーザー向けメッセージとともに `json({ error: msg })` を返すか、エラーページ用の Response を返す。

---

#### 6.1.3 try/catch のない API 呼び出し（関数単位）

- **app:** `app.inventory-count.tsx` の `getMetafieldValueWithSession` 等、内部で try なしの fetch がある。呼び出し元の loader 側で catch されている箇所もあるが、関数単位では try/catch がない。
- **extensions:** `stocktakeApi.js`, `inboundHelpers.js`, `orderApi.js`, `lossApi.js`, `purchaseApi.js`, `adjustmentApi.js`, `modalHelpers.js`, `OutboundReadyToShipEdit.jsx` の `fetch("shopify:admin/api/graphql.json", ...)` は、いずれも **async 関数の直下**で try ブロックなし。throw 時は呼び出し元に伝播するが、ローカルで catch していない。

**推奨:** 呼び出し元で確実に catch している場合は優先度は低い。新規コードでは API 呼び出しを try/catch で囲み、エラーメッセージを返す形にするとよい。

---

### 6.2 型・データ安全性

#### 6.2.1 TypeScript で `any` が使われている箇所（抜粋・優先度高）

| ファイル | 行付近 | 内容 |
|----------|--------|------|
| **app/utils/ensure-inventory-activated-server.ts** | 91, 94, 97, 98, 162, 219, 240, 241 | `(data as any)?.nodes`, `(node as any)?.id` 等 |
| **app/routes/webhooks.refunds.create.tsx** | 18, 53, 138, 150, 238, 273, 341, 358 等 | 引数・変数の `any`、`(db as any).refundPendingLocation` 等 |
| **app/routes/webhooks.inventory_levels.update.tsx** | 89, 100, 204, 277, 303 等 | 同上。`(db as any).inventoryChangeLog` 等 |
| **app/routes/webhooks.orders.updated.tsx** | 92, 104, 168, 208, 293, 299 等 | 同上。 |
| **app/routes/api.inventory.apply-change.tsx** | 147, 151, 167, 168, 177, 178, 444 | `(sessionStorage as any)`, `(s: any)` 等 |
| **app/utils/inventory-set-quantities-server.ts** | 104, 204, 207, 266, 268, 316, 369, 372 | `(json as any)?.data?...` 等 |
| **app/routes/app.inventory-count.tsx** | 146, 150, 656, 2759, 2763, 2766 等 | `(c as any)?.groupItems`, `(it: any)` 等 |

**リスク:** 型安全性を捨てており、リファクタ時や実行時の null/undefined アクセスで事故になりやすい。可能な範囲で型定義と optional chaining に置き換えるとよい。

---

#### 6.2.2 null/undefined 無チェックアクセス（optional chaining 推奨）

| ファイル | 行 | 内容 | リスク |
|----------|-----|------|--------|
| **app/routes/app.order.tsx** | 641 | `variantData.data.nodes.forEach` | `variantData` または `variantData.data` が null/undefined のときランタイムエラー。`variantData?.data?.nodes?.forEach` 推奨。 |
| **app/routes/app.purchase.tsx** | 743 | `(variantData.data.nodes as any[]).forEach` | 同上。`variantData?.data?.nodes` を事前にチェックするか optional chaining を使用。 |
| **app/export-change-history-csv.server.ts** | 206 | `shopTimezone = shopTzData.data.shop.ianaTimezone` | if ブロック内で使用しているが、型上は `shopTzData?.data?.shop?.ianaTimezone` の方が安全。 |
| **app/routes/app.purchase.tsx** | 101 | `data.data.inventoryAdjustQuantities.userErrors`（console.error 内） | 直前の if で `data?.data?.inventoryAdjustQuantities?.userErrors` を参照しているが、console では `.` のみ。統一推奨。 |

**推奨:** GraphQL レスポンスや API 戻り値は `res?.data?.xxx` のように optional chaining でアクセスし、`nodes` 等の配列は `Array.isArray(x) ? x : []` でフォールバックする。

---

### 6.3 Shopify 固有のバグパターン

#### 6.3.1 セッション取得できなかった場合の処理漏れ

- **app/routes/api.staff-members.tsx**（23-26 行）: `const authResult = await authenticate.public(request); const { admin } = authResult;` の直後に **admin の null チェックなし**で `admin.graphql` を実行。型上 `admin` が optional になりうる場合はクラッシュの原因になりうる。
- **その他ルート**（app.tsx, app.loss, app.order, app.purchase, app.adjustment, app.history, app.inventory-count 等）: `const { admin } = await authenticate.admin(request);` の直後に `admin` を利用。`authenticate.admin` が失敗時は throw するため、成功時は `admin` は存在する想定。ただし型定義で `admin` が optional になっていれば、null チェックを入れた方が安全。

**推奨:** `authenticate.public` の戻り値型で `admin` が optional なら、`if (!admin) return new Response(..., { status: 401 });` などを入れる。

---

#### 6.3.2 GraphQL のエラーレスポンス（errors[]）を無視している箇所

| ファイル | 行付近 | 内容 |
|----------|--------|------|
| **app/routes/app.history.$id.tsx** | 69-70 | `const data = await resp.json(); const transfer = data?.data?.inventoryTransfer`。`data.errors` 未チェック。 |
| **app/utils/inventory-change-log.ts** | 49, 131, 158 | `await resp.json()` で `data` のみ使用。`errors` 未チェック。 |
| **app/utils/timezone.ts** | 80 | `const { data } = await resp.json()`。`errors` 未チェック。 |
| **app/utils/ensure-inventory-activated-server.ts** | 77, 151, 198, 227 | graphql の戻り値の `data` のみ使用。`errors` 未チェック。 |
| **app/routes/api.pos-stocktake-complete.tsx** | 145-146 | `appInstJson` の `errors` 未チェック。 |
| **app/routes/app.settings.tsx** | 674-676 | `const data = await resp.json();` のあと `data?.data?.locations` のみ使用。`data.errors` 未チェック。 |
| **app/routes/app.purchase.tsx** | 411, 452, 487, 526, 600 | 複数箇所で `await resp.json()` / `data` 使用。一部で `data?.errors` は見ているが、すべての graphql 呼び出しで `errors` をチェックしているわけではない。 |
| **app/routes/webhooks.refunds.create.tsx** | 49-50 | `refundData` の `errors` 未チェック。 |
| **app/routes/webhooks.inventory_levels.update.tsx** | 128, 148, 157 | タイムゾーン・ロケーション・SKU 取得の各 `response.json()` で `errors` 未チェック。 |
| **app/routes/webhooks.orders.updated.tsx** | 各 request の .json() | 同様に `errors` 未チェックの箇所あり。 |
| **app/utils/billing.ts** | 144, 215 | `data?.data?.appUsageRecordCreate` 等は userErrors をチェックしているが、トップレベルの `data.errors`（GraphQL errors）は未チェック。 |

**注:** `api.staff-members.tsx` は `result.errors && result.errors.length > 0` をチェックして 500 を返しており、この点は問題なし。

**推奨:** GraphQL レスポンス取得後に `if (data?.errors?.length) { ... }` で分岐し、ログ出力または適切なエラー応答を返す。

---

#### 6.3.3 Storefront API と Admin API の混同

- 検索範囲では **Storefront API の利用は見当たりませんでした**。Admin API（`/admin/api/.../graphql.json` または `admin.graphql`）のみで、混同はなさそうです。

---

#### 6.3.4 Rate limit（429 エラー）のリトライ処理がない API 呼び出し

以下のファイルでは、Admin GraphQL 呼び出しに **429/Throttle 時のリトライ処理がない**。

| 種別 | ファイル |
|------|----------|
| **app/utils** | `ensure-inventory-activated-server.ts`, `inventory-change-log.ts`, `timezone.ts` |
| **app/routes** | `api.staff-members.tsx`, `app.settings.tsx`, `app.loss.tsx`, `app.order.tsx`, `app.purchase.tsx`, `app.adjustment.tsx`, `app.history.tsx`, `app.history.$id.tsx`、各 **webhooks.***.tsx**（自前 fetch で Admin GraphQL） |
| **extensions** | `inboundHelpers.js`, `orderApi.js`, `lossApi.js`, `purchaseApi.js`, `modalHelpers.js`, `ModalOutbound.jsx`（直接 fetch、リトライなし） |

**参考（リトライを入れている箇所）:**  
`api.inventory.apply-change.tsx`, `inventory-set-quantities-server.ts`, `app.inventory-count.tsx`, `extensions/.../stocktakeApi.js`, `extensions/.../adjustmentApi.js`, `extensions/common/applyInventoryChange.js`。

**推奨:** Webhook や loader で多用されている Admin API 呼び出しに、429 受信時にリトライ（指数バックオフなど）を入れると、負荷時や API 制限に強い挙動になる。

---

### 6.4 優先度まとめ

| 優先度 | 項目 | 主な対応 | 対応状況 |
|--------|------|----------|----------|
| **最優先** | Remix loader の try/catch 不足と app.tsx の `throw e` | loader/action 最上位で try/catch し、catch 時は `json({ error })` または適切な Response を返す。app.tsx では再スローせずエラー応答を返す。 | ✅ 対応済み（app.tsx, app.order, app.purchase, app.loss, app.adjustment, app.history, app.settings, app.plan の各 loader で try/catch と throw new Response(JSON.stringify({ error })) を追加） |
| **最優先** | null でクラッシュしうるプロパティアクセス | `app.order.tsx` 641 行の `variantData.data.nodes` を `variantData?.data?.nodes` に変更し、配列でない場合は `[]` でフォールバック。同様の箇所を optional chaining で統一。 | ✅ 対応済み（app.order.tsx, app.purchase.tsx で variantNodes = variantData?.data?.nodes ?? [] に変更） |
| **高** | GraphQL の `errors` 未チェック | app.history.$id, inventory-change-log, timezone, api.pos-stocktake-complete, app.settings, webhooks 等で `data.errors` をチェックし、エラー時はログまたはエラー応答を返す。 | ✅ 対応済み（上記ファイルおよび ensure-inventory-activated-server, billing, webhooks.refunds, webhooks.inventory_levels, webhooks.orders に errors チェック追加） |
| **高** | await なしの Promise 利用（fetchLocations().then 等） | extensions の HistoryList 系で `await fetchLocations()` に変更するか、.then 内で .catch し、reject をログまたは UI に反映。 | ✅ 対応済み（PurchaseHistoryList, InventoryCountConditions, LossHistoryList, AdjustmentHistoryList, OrderHistoryList, Inbound Modal で async IIFE + await + try/catch に変更） |
| **高** | `any` の多用 | 型定義を追加し、`as any` を減らす。特に webhooks と apply-change 周り。 | 未対応（リファクタ時に段階的に対応推奨） |
| **中** | authenticate 後の `admin` の null チェック | 型が optional なら `if (!admin) return ...` を入れる（api.staff-members 等）。 | ✅ 対応済み（api.staff-members.tsx に admin の null チェック追加） |
| **中** | 429/rate limit リトライのない API 呼び出し | Webhook・loader で使う GraphQL 呼び出しにリトライ処理を検討。 | ✅ 対応済み（`app/utils/graphql-with-retry.ts` を追加し、各 loader/action/API/Webhook で `withGraphQLRetry(admin)` を適用。429/503 時に最大3回リトライ・指数バックオフ） |
| **低** | optional chaining に統一すべき `.` のみのアクセス | 上記の null クラッシュ修正とあわせて、レスポンスアクセスを `?.` に統一。 | ✅ 一部対応済み（export-change-history-csv.server.ts, app.purchase.tsx の console.error 内を optional chaining に変更） |

---

## 7. Phase 4 — セキュリティ監査

実施内容: 機密情報・インジェクション・フロントエンド・Remix 固有の観点でコードベースを検索・確認。

---

### 7.1 機密情報

#### 7.1.1 API キー・シークレットのハードコード

| 確認結果 | 詳細 |
|----------|------|
| **✅ 問題なし** | `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` はすべて **環境変数**（`process.env.SHOPIFY_API_*`）から取得している。 |
| 参照箇所 | `app/shopify.server.ts`（15–16, 35 行）、`app/routes/app.tsx`（245 行）、`app/routes/api.log-inventory-change.tsx`（37 行）、`api.pos-stocktake-complete.tsx`（35 行）、`api.inventory.apply-change.tsx`（55 行）、`app/utils/refresh-offline-session.ts`（24–25 行）、`scripts/call-inventory-snapshot-daily.js`（6 行）、`api.inventory-snapshot-daily.tsx`（116 行）、`api.reclassify-change-history.tsx`（24 行）。 |
| 結論 | ソースコード内に API キー・シークレットの**リテラル文字列は存在しない**。 |

#### 7.1.2 console.log による機密出力

| ファイル | 行 | 内容 | リスク |
|----------|-----|------|--------|
| **app/shopify.server.ts** | 32 | `console.log("[shopify.server] shopify object keys:", Object.keys(shopify));` | 機密値は出していない。 |
| **app/shopify.server.ts** | 36 | `console.log("[shopify.server] SHOPIFY_API_SECRET at startup:", secret ? \`set (length=${secret.length})\` : "NOT SET");` | **⚠️ 低リスク**：値は出さず「設定済み＋長さ」のみ。本番ではログ削減推奨。 |
| その他 | 各所 | `console.log/warn` は idempotencyKey・orderId・shop 等の**業務ID**のみ。トークン・API キー・パスワードの出力はなし。 | 問題なし。 |

**対応:** `shopify.server.ts` で上記 `console.log` を `NODE_ENV !== "production"` のときのみ実行するように変更済み。

#### 7.1.3 .gitignore による .env の除外

| 確認結果 | 詳細 |
|----------|------|
| **✅ 問題なし** | `.gitignore` に **`.env`** および **`.env.*`** が含まれている（14–15 行）。 |
| 結論 | 環境変数ファイルがリポジトリにコミットされるリスクは抑えられている。 |

---

### 7.2 インジェクション

#### 7.2.1 GraphQL クエリへのユーザー入力

| 確認結果 | 詳細 |
|----------|------|
| **✅ 変数利用** | 検索・一覧系の GraphQL はすべて **変数**（`variables: { query: ... }`）で渡しており、クエリ文字列への**文字列連結**はしていない。 |
| エスケープ | `app.inventory-count.tsx`・`app.inventory-info.tsx`・`app.purchase.tsx` 等で、検索語は `query.replace(/"/g, '\\"')` や `escapeSku(sku)`（`sku:${s.replace(/"/g, '\\"')}`）で **二重引用符のみ**エスケープしてから変数に渡している。 |
| **⚠️ 注意** | Shopify の検索クエリ構文（`sku:xxx` 等）に他のメタ文字（`\`・改行・`*` の悪用等）がある場合、現状のエスケープでは不十分な可能性がある。必要に応じて Shopify ドキュメントの検索構文を確認し、エスケープを強化する。 |
| 結論 | **GraphQL インジェクション**（クエリの書き換え）のリスクは低い。検索語の**検索構文インジェクション**は低〜中リスクとして記載。 |

#### 7.2.2 SQL / DB クエリ

| 確認結果 | 詳細 |
|----------|------|
| **✅ 問題なし** | **Prisma のみ**使用。`$queryRaw` / `$executeRaw` / `whereRaw` / `Prisma.sql` の使用は**なし**。 |
| 結論 | ユーザー入力をそのまま SQL に埋め込んでいる箇所はない。Prisma のパラメータ化されたクエリで安全。 |

---

### 7.3 フロントエンド（XSS 等）

#### 7.3.1 dangerouslySetInnerHTML

| 確認結果 | 詳細 |
|----------|------|
| **✅ 使用なし** | プロジェクト全体で **`dangerouslySetInnerHTML` の使用は 0 件**。 |

#### 7.3.2 innerHTML / document.write / eval

| 確認結果 | 詳細 |
|----------|------|
| **✅ 使用なし** | `innerHTML`・`document.write`・`eval(` の使用は**なし**。 |
| 結論 | ユーザー入力をそのまま DOM に流し込んでいる箇所はない。Polaris 等のコンポーネント経由の表示で問題なし。 |

---

### 7.4 Remix 固有

#### 7.4.1 action の formData のバリデーション

| ルート / 処理 | バリデーション | 備考 |
|----------------|----------------|------|
| **app.plan.tsx** | ✅ `plan === "lite" \|\| plan === "pro"` のみ許可。それ以外は `return null`。 | 問題なし。 |
| **app.settings.tsx** | ✅ `JSON.parse(raw)` 後、`sanitizeSettings(incoming)` で型・許容値を正規化。`version === 1` チェックあり。 | 問題なし。 |
| **app.export-change-history-csv** | ✅ `exportChangeHistoryCsv` 内で `authenticate.admin` 後に formData を取得。日付・ID は Prisma の `where` に渡すのみ（パラメータ化）。 | 問題なし。 |
| **app.inventory-count.tsx** | ✅ 対応済み。 | `ALLOWED_ACTION_TYPES` ホワイトリストで未定義の action は 400 拒否。検索語・ids/skus 配列・CSV・countId/groupId・JSON payload に上限（MAX_SEARCH_QUERY_LENGTH, MAX_IDS_ARRAY_LENGTH, MAX_CSV_BODY_LENGTH, MAX_ID_FIELD_LENGTH, MAX_JSON_PAYLOAD_LENGTH）を設け、超過時は 400 で返す。 |
| **app.inventory-info.tsx** | ✅ `intent` を String 化し、`query` は GraphQL 変数用に trim のみ。 | 許容範囲。 |
| **app.purchase.tsx / app.order.tsx / app.history.tsx / app.adjustment.tsx / app.loss.tsx** | ✅ いずれも `authenticate.admin` 後に formData。日付・ID・JSON 等は String/Number 化や `sanitizeSettings` 等で正規化。 | 特段の問題なし。 |

**推奨:** `app.inventory-count.tsx` の action で、`actionType` を固定リストと照合し、`ids`・`csv` 等の長さ・形式の上限を設けるとより安全。

#### 7.4.2 認証チェックの有無（public ルート）

| ルート | 認証 | 備考 |
|--------|------|------|
| **_index/route.tsx** | なし（ログインフォーム用） | 想定どおり。 |
| **auth.login/route.tsx** | `login(request)` | 認証フロー用。 |
| **auth.$.tsx** | `authenticate.admin(request)` | 保護されている。 |
| **app.*（app.tsx, app.settings, app.plan, app.inventory-count 等）** | すべて **`authenticate.admin(request)`** | 保護されている。 |
| **app.export-change-history-csv** | `exportChangeHistoryCsv` 内で **`authenticate.admin(request)`** | 保護されている。 |
| **api.inventory-snapshot-daily** | **Bearer API キー**（`INVENTORY_SNAPSHOT_API_KEY`）のみ。Shopify セッションなし。 | Cron 用として設計どおり。 |
| **api.reclassify-change-history** | **Bearer API キー**（`RECLASSIFY_CHANGE_HISTORY_API_KEY` 等）のみ。 | 運用・手動実行用として設計どおり。 |
| **api.staff-members** | **`authenticate.public(request)`**。失敗時は 401。 | POS からスタッフ一覧取得用。意図した公開 API。 |
| **api.log-inventory-change / api.pos-stocktake-complete / api.inventory.apply-change** | **`authenticate.pos(request)`** または session token（jose 検証） | 保護されている。 |
| **webhooks.*** | **`authenticate.webhook(request)`**（HMAC 検証） | 保護されている。 |

**結論:** public として想定されているのは `_index`・`auth.login`・`api.staff-members`（public 認証）・API キー認証の 2 本のみ。それ以外の app/api/webhook は認証済み。**認証漏れのルートはなし**。

---

### 7.5 その他（情報開示・エラーハンドリング）

| ファイル | 内容 | リスク |
|----------|------|--------|
| **app/routes/api.staff-members.tsx** | catch 節で `stack: e?.stack` を JSON で返している（62–65 行）。 | **⚠️ 本番でスタックトレースがクライアントに返る**。情報開示・攻撃の手がかりになる可能性。 |

**対応:** `api.staff-members.tsx` の catch で、`NODE_ENV === "production"` のときは `stack` をレスポンスに含めないように修正済み。

---

### 7.6 Phase 4 サマリー

| 項目 | 結果 | 対応 |
|------|------|------|
| 機密情報のハードコード | ✅ なし。すべて環境変数。 | 特になし。 |
| console での機密出力 | ✅ 対応済み。 | shopify.server.ts で NODE_ENV !== "production" のときのみログ出力。 |
| .gitignore で .env 除外 | ✅ 除外済み。 | 特になし。 |
| GraphQL インジェクション | ✅ 変数利用。検索語は一部エスケープのみ。 | 必要に応じて検索構文のエスケープを強化。 |
| SQL/DB インジェクション | ✅ Prisma のみ。raw なし。 | 特になし。 |
| dangerouslySetInnerHTML / innerHTML / eval | ✅ 使用なし。 | 特になし。 |
| formData のバリデーション | ✅ 対応済み（inventory-count 含む）。 | app.inventory-count に actionType ホワイトリスト・検索語/ids/csv/JSON/countId/groupId の長さ上限を実装済み。 |
| 認証漏れルート | ✅ なし。 | 特になし。 |
| エラー時の stack 返却 | ✅ 対応済み。 | api.staff-members で本番時は stack を返さないよう修正済み。 |

---

以上が POS Stock（stock-transfer-pos）の全体監査レポートです。
