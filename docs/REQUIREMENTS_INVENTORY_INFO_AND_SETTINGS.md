# 在庫情報・設定タブ化 実装可否検討

**作成日**: 2026年2月  
**対象**: 在庫高/在庫変動履歴、ロス区分設定、メニュー・設定の構成変更

---

## 📌 概要

以下3つの追加機能およびメニュー・設定の再構成について、実装可否を検討する。

| 機能 | 概要 | 可否 |
|------|------|------|
| **在庫高** | 合計・ロケーション別の上代・原価、日付指定表示、CSV出力 | 部分的に可能（制限あり） |
| **在庫変動履歴** | Shopify変動履歴の一覧化、アクティビティ種別表示、CSV出力 | 部分的に可能（要自前集計） |
| **ロス区分設定** | 設定からロス理由（破損/紛失等）を登録 | ✅ 可能 |

---

## 1. 在庫高 / 在庫情報

### 1.1 要件

- 合計（上代と原価）
- ロケーション別（上代と原価）
- 日付指定でその日付時の在庫高情報の表示
- CSV出力可能

### 1.1a MVPで「確定」する仕様（ここが実装の基準）

管理画面の「在庫情報」ページ（`/app/inventory-info`）は、以下 **2タブ** 構成で実装する。

1. **在庫高（評価）**: いま／過去日付の在庫高（数量・上代・原価）
2. **変動履歴**: 変動ログ（アプリ実行分 + Webhook）

> 重要: Shopify API は「過去日時点の在庫」を直接返さないため、**過去日付は日次スナップショット（DB）** で表示する（本ドキュメント内 2.5 / 6.2 で方針確定済み）。

### 1.2 実装可否

| 項目 | 可否 | 根拠・方法 |
|------|------|------------|
| **現在時点の在庫高** | ✅ 可能 | `inventoryLevel`（数量）＋ `inventoryItem.unitCost`（原価）＋ `productVariant.price`（上代）を組み合わせて算出 |
| **合計・ロケーション別** | ✅ 可能 | 上記APIで取得したデータを集計 |
| **日付指定の過去在庫** | ⚠️ 制限あり | **Shopify API は過去時点の在庫スナップショットを直接返さない**。代替案は下記 |
| **CSV出力** | ✅ 可能 | 取得したデータをCSV形式で出力 |

### 1.3 日付指定の過去在庫の対応案

| 方法 | 可否 | 説明 |
|------|------|------|
| **A. 自前スナップショット** | ✅ 推奨 | 日次バッチで在庫データをMetafield/DBに保存。指定日は保存済みデータから表示 |
| **B. Shopify Reports API** | 要確認 | Analytics > Reports の月次在庫スナップショット（2023年10月以降）があるが、API公開状況は要検証 |
| **C. 変動履歴から逆算** | △ 重い | 変動履歴を遡って積み上げ計算。データ量・期間によっては非現実的 |

**推奨**: 日付指定が必要な場合は **A. 自前スナップショット** を採用し、日次ジョブで `inventoryLevel` を取得して保存する。

### 1.4 データ取得のイメージ

```graphql
# 在庫数量・ロケーション
inventoryLevels(first: 250, query: "location_id:xxx") {
  nodes {
    quantities(names: ["available"]) { quantity }
    item { id, variant { id, sku, price }, unitCost { amount } }
    location { id, name }
  }
}
# productVariant.price = 上代、inventoryItem.unitCost = 原価
# 数量 × 単価 で合計を算出
```

### 1.5 画面仕様（MVP確定）: 在庫高（評価）タブ

#### 1.5.1 フィルター（画面上部）

- **日付**（必須）
  - **今日**: 「現在時点」表示（Shopify APIから取得してその場で集計）
  - **過去日付**: 「日次スナップショット」表示（DBから取得）
- **ロケーション**（任意）
  - `全ロケーション`（デフォルト）
  - `1つ選択`（MVPは単一選択でOK。複数選択は将来拡張）
- **SKU検索**（任意）
  - SKUの部分一致（MVPはSKUのみ。商品名/JANは将来拡張）
- **表示粒度**（任意）
  - `ロケーション別サマリー`（デフォルト）
  - `明細（SKU別）`

#### 1.5.2 表示項目（ロケーション別サマリー）

- ロケーション名
- 合計数量
- 上代合計（= 数量 × 上代 の合計）
- 原価合計（= 数量 × 原価 の合計）

#### 1.5.3 表示項目（明細：SKU別）

- SKU
- 商品名（variant title / product title など、取得できる範囲で）
- ロケーション名
- 数量（available）
- 上代（variant.price）
- 上代合計（数量×上代）
- 原価（inventoryItem.unitCost）
- 原価合計（数量×原価）

> 注意（仕様として固定）: **上代・原価が未設定の場合は 0 として計算**する（表示は `-` ではなく `0` でOK）。「未設定の件数」を別に表示するのは将来拡張。

#### 1.5.4 CSV（MVP確定）

CSVは「サマリー」と「明細」を分ける（画面の表示粒度と同じ）。

- **CSV: ロケーション別サマリー**
  - `date`（YYYY-MM-DD。今日の場合も当日を入れる）
  - `mode`（`current` / `snapshot`）
  - `shop`
  - `locationId`
  - `locationName`
  - `totalQuantity`
  - `totalRetailValue`（上代合計）
  - `totalCostValue`（原価合計）

- **CSV: 明細（SKU別）**
  - `date`
  - `mode`（`current` / `snapshot`）
  - `shop`
  - `locationId`
  - `locationName`
  - `inventoryItemId`
  - `variantId`
  - `sku`
  - `productTitle`
  - `variantTitle`
  - `availableQuantity`
  - `unitRetailPrice`
  - `retailValue`（availableQuantity×unitRetailPrice）
  - `unitCost`
  - `costValue`（availableQuantity×unitCost）

> 仕様固定: CSVは **UTF-8**（BOMは任意。既存CSV方針に合わせる）。金額は小数を含みうるので「文字列」ではなく「数値」を出す（ただしCSV自体は文字）。

---

## 2. 在庫変動履歴 / 在庫情報

### 2.1 要件

- Shopifyの商品調整履歴の一覧化
- ロケーション別、SKU別の在庫変動履歴の一覧表示
- 期間指定やロケーション指定で対象の一覧表示
- アクティビティ項目: 売上/返品/入庫/出庫/ロス/棚卸/管理画面の変動 を可視化
- CSV出力可能

### 2.2 Shopify APIの状況

| データソース | API | 可否 | 備考 |
|--------------|-----|------|------|
| **InventoryAdjustmentGroup** | GraphQL | △ 要確認 | mutation の戻り値としては存在。**履歴のクエリ用ルートがAPIに存在するか要検証**（コミュニティで要望あり） |
| **Analytics Reports** | Reports API | 要確認 | 2025年7月頃、調整履歴レポートが Analytics に追加。API経由の取得可否は要確認 |
| **アプリ独自データ** | Metafield/監査ログ | ✅ 可能 | 入庫/出庫/ロス/棚卸はアプリが記録しているため一覧化可能 |

### 2.3 実装方針（推奨）

**アプリで記録している変動** を中心に一覧を構築する。

| アクティビティ | データソース | 可否 |
|----------------|--------------|------|
| **入庫** | 入庫監査ログ、Transfer | ✅ |
| **出庫** | Transfer、Shipment | ✅ |
| **ロス** | loss_entries_v1 | ✅ |
| **棚卸** | inventory_counts_v1 | ✅ |
| **売上** | Orders API | ✅ |
| **返品** | Refunds API | ✅ |
| **管理画面の変動** | InventoryAdjustmentGroup クエリ or Webhook | △ |

- **売上・返品**: `orders`（FULFILLED 等）、`refunds` から在庫変動を推定
- **管理画面の変動**: `inventoryAdjustQuantities` 等の mutation 実行元が「管理画面」の場合。  
  InventoryAdjustmentGroup の履歴クエリが使えれば取り込み可能。使えない場合は、**inventory_levels/update Webhook** で変動を検知して自前保存する方法が現実的。

### 2.4 データ構造案（自前保存する場合）

```typescript
type InventoryChangeLog = {
  id: string;
  date: string;
  inventoryItemId: string;
  sku: string;
  locationId: string;
  locationName: string;
  activity: "sales" | "return" | "inbound" | "outbound" | "loss" | "stocktake" | "admin";
  delta: number;  // 変動量（+/-）
  quantityAfter?: number;
  referenceId?: string;  // 注文ID、Transfer ID 等
};
```

### 2.5 保存先の確定（Metafieldに残すもの / Prisma DBに持つもの）

#### 結論（MVPからこの方針で固定）

- **在庫スナップショット（過去日付の在庫高）**: **Prisma DB（必須）**
- **在庫変動履歴（Change Log）**: **Prisma DB（必須）**
- **仕入/発注/ロス/棚卸などの「入力データ（伝票データ）」そのもの**: **Metafield（既存方針のまま）**

#### 理由（やさしく）

- **Metafieldは1つの値にサイズ上限があり**、日次スナップショットや変動履歴のように「大量に増えるデータ」を入れるのに向きません。
- **変動履歴は検索（期間/SKU/ロケーション）や集計が前提**なので、DBの方が安全で速いです。

#### 参照ID（「どの操作が原因の変動か」を必ず追えるようにする）

在庫変動ログ（DB）には、以下の **source（参照元）情報** を必ず保存します。

- **sourceType**: 変動の原因種別  
  例: `inbound_transfer`, `outbound_transfer`, `loss_entry`, `inventory_count`, `purchase_entry`, `purchase_cancel`, `order_sales`, `refund`, `admin_webhook`
- **sourceId**: 参照元ID  
  - Transfer由来なら Transfer ID（例: `gid://shopify/InventoryTransfer/...`）
  - Metafield由来（ロス/棚卸/仕入/発注）なら **エントリーID**（例: `loss_...`, `count_...`, `purchase_...`, `order_...`）
- **adjustmentGroupId（任意）**: アプリが在庫調整mutationを実行した場合は、戻り値の `InventoryAdjustmentGroup` ID（取れる場合）を保存
- **idempotencyKey（必須）**: 二重登録防止用キー（Webhook重複やリトライ対策）

#### アプリ実行分の idempotencyKey ルール（仕入キャンセルを含む）【確定】

アプリが「在庫調整mutation」を実行する系（ロス/棚卸/仕入/仕入キャンセル/入出庫の強制キャンセル等）は、**同じ処理が二重に走ってもログが1回分しか作られない**ように、行（1商品×1ロケーション）ごとに `idempotencyKey` を固定ルールで作る。

- **基本フォーマット**:
  - `sourceType:sourceId:locationId:inventoryItemId`
- **例（仕入キャンセル）**:
  - `purchase_cancel:purchase_abc123:gid://shopify/Location/1:gid://shopify/InventoryItem/999`
- **DB制約（要件）**:
  - `@@unique([shop, idempotencyKey])` を必須にする（同じキーは二重登録できない）

> これにより、通信の再送・二重タップ・同時実行が起きても、ログ二重登録をDBで防げる（= 二重在庫調整も防ぎやすい）。

#### Webhook由来（管理画面など外部での変動）の扱い

- `inventory_levels/update` Webhook から入った変動は、**reason（理由）が取れない前提**で `sourceType = admin_webhook` としてログ化します。
- `idempotencyKey` は、少なくとも以下の組み合わせで作ります（重複が来ても同じキーになるようにする）:
  - `shop + inventoryItemId + locationId + updatedAt + available`

### 2.6 画面仕様（MVP確定）: 変動履歴タブ

#### 2.6.1 フィルター（画面上部）

- **期間**（必須）
  - `開始日` / `終了日`（デフォルト: 直近30日）
- **ロケーション**（任意）
  - `全ロケーション`（デフォルト）
  - `1つ選択`（MVPは単一選択でOK）
- **SKU検索**（任意）
  - SKUの部分一致（MVPはSKUのみ）
- **アクティビティ種別**（任意・複数選択）
  - `inbound` / `outbound` / `loss` / `stocktake` / `purchase_entry` / `purchase_cancel` / `admin_webhook`
  - （MVP外）`sales` / `return` は後工程
- **並び順**
  - `新しい順`（デフォルト）/ `古い順`

#### 2.6.2 一覧の表示項目（1行）

- 発生日時（timestamp）
- SKU
- ロケーション名
- アクティビティ（activity / sourceType）
- 変動量（delta）
- 変動後数量（quantityAfter。取れない場合は空欄）
- 参照ID（sourceId。例: Transfer ID、loss_...、count_...、purchase_...）

> 仕様固定: Webhook由来は理由が取れない前提なので **activityは `admin_webhook`** として表示する（推測分類はしない）。

#### 2.6.3 CSV（MVP確定）

- **CSV: 変動履歴（フィルター結果そのまま）**
  - `shop`
  - `timestamp`（ISO）
  - `date`（YYYY-MM-DD、検索・集計しやすいように別列で持つ）
  - `locationId`
  - `locationName`
  - `inventoryItemId`
  - `variantId`（取れる場合）
  - `sku`
  - `activity`（画面表示と同じ値）
  - `delta`
  - `quantityAfter`（空欄可）
  - `sourceType`
  - `sourceId`
  - `idempotencyKey`
  - `note`（任意。アプリ実行分で取れる場合のみ。Webhookは基本空欄）

### 2.7 Webhookの差分（delta）計算ルール（MVP確定）

`inventory_levels/update` の payload は **在庫の「最新値（available）」** を返すため、変動量（delta）を出すには「直前の値」を参照する必要がある。

- **基本ルール**
  - 同一 `shop + inventoryItemId + locationId` の直近ログの `quantityAfter` を `prevAvailable` として参照し、
  - `delta = payload.available - prevAvailable`
  - `quantityAfter = payload.available`

- **直前値が取れない場合（初回など）**
  - `prevAvailable` が無い場合は `delta = null`（または 0）にせず、**空欄（null）として保存**する
  - ただし `quantityAfter` は payload.available を保存する

> 仕様固定: 初回から無理に差分を埋めない（誤差が出るより安全）。運用上必要なら「初回は delta=0 扱い」へ変更するが、それはMVP外。

### 2.8 DB設計（MVP確定の補足）

既に 2.5 で「DB必須」は確定しているため、MVPでは以下を満たす index/制約 を入れる。

- `InventorySnapshot`
  - `@@index([shop, date])`
  - `@@index([shop, locationId, date])`
  - `@@index([shop, inventoryItemId, date])`
  - （推奨）`@@unique([shop, date, locationId, inventoryItemId])`（同一日同一在庫の重複を防ぐ）

- `InventoryChangeLog`
  - `@@index([shop, timestamp])`
  - `@@index([shop, locationId, timestamp])`
  - `@@index([shop, inventoryItemId, timestamp])`
  - `@@index([shop, sku, timestamp])`（sku検索をMVPで入れるため）
  - `@@unique([shop, idempotencyKey])`（Webhook重複・リトライ対策）

---

## 3. ロス区分登録設定

### 3.1 要件

- 管理画面の設定からロス理由（破損/紛失/その他 等）を登録
- POSのロス登録で設定済みの区分から選択

### 3.2 実装可否

**✅ 可能**

- **参照**: 既存の配送業者（carriers）・サプライヤー（suppliers）設定と同様のUIで実装
- **保存**: SettingsV1 に `lossReasons` を追加
- **POS**: 現在ハードコードしている `REASONS`（破損/紛失/その他）を、設定から読み込んだ一覧に差し替え

### 3.3 データ構造案

```typescript
type LossReasonOption = {
  id: string;
  label: string;   // 表示名（例: 破損、紛失）
  sortOrder?: number;
};
// SettingsV1 に lossReasons?: LossReasonOption[] を追加
// デフォルト: [{ id: "damage", label: "破損" }, { id: "lost", label: "紛失" }, { id: "other", label: "その他" }]
```

### 3.4 修正ファイル

- `app.settings.tsx`: ロス設定セクション追加、`lossReasons` の CRUD
- `LossConditions.jsx`: 設定APIから `lossReasons` を取得し、REASONS の代わりに使用

---

## 4. メニュー・設定の再構成

### 4.1 管理画面メニュー

| 順 | メニュー | 内容 | URL例 |
|----|----------|------|-------|
| ① | 在庫情報 | 在庫高 / 在庫変動履歴 | `/app/inventory-info` |
| ② | 入出庫 | 入出庫履歴 | `/app/history` |
| ③ | 仕入 | 仕入履歴 | `/app/purchase` |
| ④ | ロス | ロス履歴 | `/app/loss` |
| ⑤ | 発注 | 発注履歴 | `/app/order` |
| ⑥ | 棚卸 | 商品グループ設定 / 棚卸ID発行 / 履歴 | `/app/inventory-count` |

### 4.2 設定のタブ化（棚卸と同構成）

| タブ | 内容 |
|------|------|
| ① アプリ設定 | 店舗設定（表示ロケーション等）、アプリ表示件数設定 |
| ② 出庫設定 | 出庫設定（強制キャンセル等）、配送設定（carriers） |
| ③ 入庫設定 | 過剰入庫許可、予定外入庫許可、表示件数 |
| ④ 仕入設定 | サプライヤー設定 |
| ⑤ ロス設定 | ロス区分設定（lossReasons） |

### 4.3 実装可否

**✅ 可能**

- 既存の `app.settings.tsx` をタブ構造にリファクタリング
- 棚卸（`app.inventory-count`）と同様のタブUIを採用

---

## 5. 実装優先度・依存関係（調査結果反映）

| 優先度 | 機能 | 依存 | 工数目安 | 調査結果 |
|--------|------|------|----------|----------|
| 1 | ロス区分設定 | なし | 小 | ✅ 実装可能 |
| 2 | メニュー・設定タブ化 | なし | 中 | ✅ 実装可能 |
| 3 | 在庫高（現在時点） | なし | 中 | ✅ 実装可能（API で取得） |
| 4 | 在庫変動履歴（アプリ分） | なし | 中〜大 | ✅ 実装可能（mutation 戻り値を保存） |
| 5 | 在庫高（日付指定） | 自前スナップショット + Cron | 大 | ✅ 実装可能（Prisma + Render Cron） |
| 6 | 在庫変動履歴（売上・返品） | Orders/Refunds API | 大 | ✅ 実装可能（API で取得） |
| 7 | 在庫変動履歴（管理画面） | Webhook | 大 | ✅ 実装可能（`inventory_levels/update` Webhook） |

---

## 6. 深掘り調査結果

### 調査サマリー

| 項目 | 調査結果 | 実装可否 | 推奨方法 |
|------|----------|----------|----------|
| **InventoryAdjustmentGroup 履歴クエリ** | ❌ ルートクエリは存在しない | △ 部分的 | Webhook + 自前保存 |
| **日次スナップショット** | ✅ 実装可能 | ✅ 可能 | Prisma DB + Render Cron |
| **Analytics Reports API** | ❌ API 経由の直接取得は不可 | ❌ 不可 | 自前実装（Webhook + スナップショット） |

---

### 6.1 InventoryAdjustmentGroup の履歴取得用クエリの有無

### 6.1 InventoryAdjustmentGroup の履歴取得用クエリの有無

#### 調査結果

**❌ ルートクエリは存在しない**

- **確認内容**: Shopify Admin GraphQL API の公式ドキュメントを確認
- **発見事項**:
  1. `InventoryAdjustmentGroup` は **mutation の戻り値としてのみ存在**
  2. `inventoryAdjustQuantities`, `inventorySetQuantities`, `inventoryMoveQuantities` の戻り値として返される
  3. **履歴を一覧取得するルートクエリ（例: `inventoryAdjustmentGroups`）は存在しない**
  4. コミュニティフォーラムで要望は上がっているが、現時点では未実装

#### 代替手段

| 方法 | 可否 | 実装方法 |
|------|------|----------|
| **A. node(id:) クエリ** | △ 部分的 | 既知の `InventoryAdjustmentGroup` ID があれば `node(id: "gid://...")` で取得可能。ただし、ID を事前に知っている必要がある |
| **B. Webhook で記録** | ✅ 推奨 | `inventory_levels/update` Webhook を購読し、変動をリアルタイムで記録 |
| **C. アプリ実行分のみ記録** | ✅ 実装済み | アプリが実行した `inventoryAdjustQuantities` 等の戻り値（`InventoryAdjustmentGroup`）を自前で保存 |

#### 推奨実装方針

**アプリ実行分**: mutation の戻り値として `InventoryAdjustmentGroup` を受け取り、自前で保存  
**管理画面実行分**: `inventory_levels/update` Webhook で検知し、変動を記録

```typescript
// 1. shopify.app.toml に Webhook を追加
[[webhooks.subscriptions]]
topics = ["inventory_levels/update"]
uri = "/webhooks/inventory_levels/update"

// 2. app/routes/webhooks.inventory_levels.update.tsx
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  
  // payload の構造（要検証）:
  // {
  //   inventory_item_id: string,
  //   location_id: string,
  //   available: number,
  //   updated_at: string,
  //   reason?: string  // 理由が含まれるか要確認
  // }
  
  // 変動履歴として保存
  await saveInventoryChange({
    shop,
    inventoryItemId: payload.inventory_item_id,
    locationId: payload.location_id,
    activity: "admin", // 管理画面の変動と判定
    delta: payload.available - (await getPreviousQuantity(...)),
    date: new Date().toISOString(),
  });
  
  return new Response();
};
```

**注意**: `inventory_levels/update` Webhook の payload に `reason` が含まれるかは要検証。含まれない場合は、変動量とタイミングから推測する必要がある。

---

### 6.2 日付指定の過去在庫を実現する日次スナップショットの運用設計

#### 要件

- 指定日時点の在庫高（数量・上代・原価）を表示
- 日次で自動実行
- Render 環境での実装

#### 実装設計

##### A. スナップショット取得ロジック

```typescript
// app/routes/api.snapshot-inventory.tsx または app/routes/cron.daily-snapshot.tsx
export const action = async ({ request }: ActionFunctionArgs) => {
  // 認証: Render Cron からのリクエストを検証（API Key 等）
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { admin } = await authenticate.admin(request);
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // 全ロケーション取得
  const locations = await admin.graphql(`
    query GetLocations {
      locations(first: 250) {
        nodes { id, name }
      }
    }
  `);

  // 各ロケーションの在庫を取得
  const snapshots = [];
  for (const location of locations.data.locations.nodes) {
    const inventory = await admin.graphql(`
      query GetInventoryLevels($locationId: ID!) {
        inventoryLevels(first: 250, query: $locationId) {
          nodes {
            quantities(names: ["available"]) { quantity }
            item {
              id
              variant { id, sku, price }
              unitCost { amount }
            }
            location { id, name }
          }
        }
      }
    `, { variables: { locationId: location.id } });

    // 集計
    for (const level of inventory.data.inventoryLevels.nodes) {
      const qty = level.quantities[0]?.quantity || 0;
      const cost = parseFloat(level.item.unitCost?.amount || "0");
      const price = parseFloat(level.item.variant?.price || "0");
      
      snapshots.push({
        date,
        inventoryItemId: level.item.id,
        sku: level.item.variant?.sku || "",
        locationId: location.id,
        locationName: location.name,
        quantity: qty,
        costTotal: qty * cost,
        priceTotal: qty * price,
      });
    }
  }

  // Metafield または Prisma DB に保存
  await saveInventorySnapshot(admin.graphql, date, snapshots);
  
  return new Response(JSON.stringify({ success: true, count: snapshots.length }), {
    headers: { "Content-Type": "application/json" },
  });
};
```

##### B. データ保存先の選択

| 方式 | メリット | デメリット | 推奨度 |
|------|----------|------------|--------|
| **Metafield** | 実装が簡単、既存パターンと統一 | データ量制限（250KB/値）、検索が困難 | △ 小規模向け |
| **Prisma DB** | 検索・集計が容易、データ量制限なし | スキーマ変更・マイグレーション必要 | ✅ 推奨 |

**推奨**: Prisma DB に `InventorySnapshot` テーブルを追加

```prisma
model InventorySnapshot {
  id            String   @id @default(cuid())
  date          String   // YYYY-MM-DD
  shop          String
  inventoryItemId String
  sku           String
  locationId    String
  locationName  String
  quantity      Int
  costTotal     Float    // 原価合計
  priceTotal    Float    // 上代合計
  createdAt     DateTime @default(now())
  
  @@index([shop, date])
  @@index([shop, inventoryItemId, date])
  @@index([shop, locationId, date])
}
```

##### C. Render Cron の設定

**Render での Cron ジョブ設定**:

1. **Render Dashboard** → **Cron Jobs** → **New Cron Job**
2. **設定**:
   - **Name**: `daily-inventory-snapshot`
   - **Schedule**: `0 2 * * *`（毎日 2:00 UTC = 11:00 JST）
   - **Command**: `curl -X POST https://stock-transfer-pos.onrender.com/api/cron/daily-snapshot -H "Authorization: Bearer ${CRON_SECRET}"`
   - **Environment**: `CRON_SECRET` を環境変数に設定

**代替案（Render Cron が使えない場合）**:

- **外部 Cron サービス**: GitHub Actions Scheduled Workflows、EasyCron 等
- **アプリ内スケジューラー**: `node-cron` 等のライブラリ（サーバーが常時起動している必要あり）

##### D. 取得時のクエリ

```typescript
// 指定日の在庫高を取得
const snapshot = await prisma.inventorySnapshot.findMany({
  where: {
    shop: shopDomain,
    date: "2026-02-04", // 指定日
  },
});

// ロケーション別集計
const byLocation = snapshot.reduce((acc, s) => {
  if (!acc[s.locationId]) {
    acc[s.locationId] = { locationName: s.locationName, costTotal: 0, priceTotal: 0 };
  }
  acc[s.locationId].costTotal += s.costTotal;
  acc[s.locationId].priceTotal += s.priceTotal;
  return acc;
}, {});
```

---

### 6.3 Analytics Reports API による在庫レポート取得の可否

#### 調査結果

**⚠️ 限定的に利用可能、ただし API 経由の直接取得は困難**

- **確認内容**: Shopify Analytics Reports の API 公開状況を確認
- **発見事項**:
  1. **Analytics Reports は主に管理画面 UI 向け**
  2. **GraphQL Admin API に Reports 用のクエリは存在しない**（2026-01 時点）
  3. **REST Admin API にも Reports エンドポイントは存在しない**
  4. 2025年7月に追加された「在庫調整履歴レポート」は **Analytics UI 内でのみ閲覧可能**

#### 代替手段

| 方法 | 可否 | 説明 |
|------|------|------|
| **A. Analytics UI のスクレイピング** | ❌ 非推奨 | 技術的には可能だが、ToS 違反の可能性・不安定 |
| **B. 自前でデータ収集** | ✅ 推奨 | Webhook + 自前スナップショットで実装 |
| **C. Shopify Plus の Analytics API** | 要確認 | Shopify Plus 限定の Analytics API が存在する可能性（要検証） |

#### 結論

**Analytics Reports API は実用的ではない**。日次スナップショット + Webhook による自前実装を推奨。

---

## 7. 実装推奨フロー

### Phase 1: 現在時点の在庫高（日付指定なし）

1. `inventoryLevels` + `inventoryItem.unitCost` + `variant.price` で取得
2. ロケーション別・合計を集計
3. CSV出力

**工数**: 中（2-3日）

### Phase 2: 日次スナップショット

1. Prisma スキーマに `InventorySnapshot` 追加
2. Cron ジョブ用エンドポイント作成
3. Render Cron 設定（または外部サービス）
4. 指定日取得ロジック実装

**工数**: 大（5-7日）

### Phase 3: 在庫変動履歴（アプリ分 + Webhook）

1. アプリ実行分: mutation 戻り値の `InventoryAdjustmentGroup` を保存
2. Webhook: `inventory_levels/update` を購読し、変動を記録
3. Orders/Refunds API から売上・返品の変動を取得
4. 一覧画面・フィルター・CSV出力

**工数**: 大（7-10日）

---

## 8. 実装時の注意事項

### 8.1 InventoryAdjustmentGroup の保存タイミング

- **アプリ実行時**: `inventoryAdjustQuantities`, `inventorySetQuantities` 等の mutation 実行直後に戻り値を保存
- **既存コードの修正**: 既存の在庫調整処理（ロス・棚卸等）に `InventoryAdjustmentGroup` の保存ロジックを追加

### 8.2 日次スナップショットの実行時間

- **推奨時刻**: 深夜（2:00 UTC = 11:00 JST）に実行
- **理由**: 在庫変動が少ない時間帯で、正確なスナップショットを取得可能
- **エラーハンドリング**: Cron ジョブ失敗時のリトライ・通知機能を実装

### 8.3 Webhook の信頼性

- **重複処理**: Webhook は複数回送信される可能性があるため、冪等性を確保
- **遅延**: Webhook の到着が遅れる可能性があるため、リアルタイム性を求めない設計に

### 8.4 データ量の考慮

- **スナップショット**: 日次 × 全SKU × 全ロケーション = 大量データ
- **対策**: 古いスナップショット（例: 1年以上前）の自動削除機能を実装
- **Prisma クエリ**: インデックスを適切に設定し、パフォーマンスを確保

---

## 9. 参照

- **InventoryAdjustmentGroup**: https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryAdjustmentGroup
- **InventoryChange**: https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryChange
- **InventoryItem unitCost**: Shopify GraphQL `inventoryItem { unitCost { amount } }`
- **既存設定**: `app/routes/app.settings.tsx`（carriers 等）
- **ロス理由**: `extensions/stock-transfer-loss/src/screens/loss/LossConditions.jsx`（REASONS 定数）
