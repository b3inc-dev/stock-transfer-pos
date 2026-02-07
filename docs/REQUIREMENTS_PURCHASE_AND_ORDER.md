# 仕入・発注 機能 要件書

**作成日**: 2026年2月  
**対象**: POSアプリタイル・管理画面に追加する2機能  
**参照**: REQUIREMENTS_FINAL.md（既存ロス・入庫・棚卸の構成・用語に準拠）

---

## 📌 概要

既存のPOSタイル（出庫・入庫・ロス・棚卸）に、以下の2機能を追加する。

| 機能 | POS表記 | 管理画面表記 | 概要 | UIのベース | 主な違い |
|------|---------|--------------|------|------------|----------|
| **① 仕入** | 仕入 / 在庫処理 | 仕入 | Shopify注文書なしでもPOSから入庫を立ち上げ可能 | ロス登録の**入庫版** | 在庫プラス調整・サプライヤー選択可 |
| **② 発注** | 発注 / 在庫調整 | 発注 | 店舗→本社への必要商品の希望リスト登録 | ロス登録の**在庫調整なし版** | リスト化のみ・在庫は変更しない |

### サプライヤー登録

- **実現方法**: 管理画面の設定からサプライヤーを登録・管理
- **参照実装**: 既存の配送業者（carriers）設定と同様のUI・保存方式
- **保存先**: SettingsV1 に `suppliers` を追加（`currentAppInstallation.metafield`）

---

## 1. 仕入（Purchase / Receiving）

### 1.1 機能概要

- **目的**: Shopifyの注文書（Transfer）がなくても、POSから直接「入庫」を立ち上げられる
- **ユースケース**:
  - 伝票のみで届いた仕入・直送分の入庫
  - 注文書未連携の緊急入庫
  - 小ロットの手動入庫
- **将来の拡張**: 注文書（Shopify Transfer）との連携がスムーズにできるなら、連携したい

### 1.2 既存機能との関係

| 項目 | 入庫（既存） | 仕入（新規） |
|------|--------------|--------------|
| 起点 | 出庫元のTransfer必須 | Transfer不要・POSから直接開始 |
| 入庫先 | Transferに紐づくロケーション | コンディション画面で選択 |
| 商品リスト | TransferのlineItems | 検索・スキャンで自由に追加 |
| 数量 | 予定数あり・受領数を入力 | 数量を直接入力（予定数なし） |
| 在庫 | プラス調整（入庫） | プラス調整（入庫） |
| UIベース | InboundList / InboundShipmentSelection | **ロス登録の入庫バージョン** |

### 1.3 画面構成（POS）

#### ① コンディション画面

- **入力項目**:
  - ロケーション選択（必須）※入庫先ロケーション
  - **サプライヤー選択**（任意、管理画面で登録したサプライヤー一覧から選択）
  - 日付選択（必須、デフォルト: 今日）
  - 配送業者（任意）
  - 配送番号（任意、スキャン対応）
  - 到着予定日（任意）
  - スタッフ名（任意）
- **機能**:
  - 「次へ」で商品リスト画面へ遷移
  - 「履歴一覧」で履歴一覧画面へ遷移
  - 自動保存・復元（ロス登録と同様）
- **UI**: ロス登録のコンディション画面に近い構成＋入庫用（配送業者・番号・予定日）を追加

#### ② 商品リスト画面

- **表示**: ロス登録の商品リストと同等のUI/UX
  - 検索フィールド（商品名 / SKU / バーコード）
  - 検索結果リスト
  - 追加済み商品リスト
  - 数量コントロール（＋／数値／−）
- **機能**:
  - 商品スキャンまたは手動選択
  - **数量入力（プラス値＝入庫数量）**
  - 確定で確認モーダル → 在庫プラス調整
- **在庫調整**: `inventoryAdjustQuantity`（プラス値で入庫）

### 1.4 管理画面

#### 設定：サプライヤー登録（`/app/settings` に追加）

- **実装方針**: 既存の配送業者（carriers）設定UIと同様の構成
- **項目**: サプライヤー名、コード（任意）、表示順
- **機能**: 追加・編集・削除・並び替え

#### 仕入履歴（`/app/purchase`）

- **一覧項目**: 仕入ID、入庫先ロケーション、サプライヤー、日付、配送業者、配送番号、商品数、数量合計、ステータス
- **フィルター**: ロケーション、日付範囲、ステータス
- **詳細**: 商品明細のモーダル表示
- **CSV出力**: 一覧・詳細ともにCSV出力可能

### 1.5 データ構造（案）

```typescript
type PurchaseEntry = {
  id: string; // 仕入ID（例: purchase_${timestamp}_${random}）
  locationId: string;   // 入庫先ロケーションID
  locationName: string;
  supplierId?: string; // サプライヤーID（設定で登録したサプライヤー）
  supplierName?: string;
  date: string;        // YYYY-MM-DD
  carrier?: string;    // 配送業者
  trackingNumber?: string;
  expectedArrival?: string;
  staffName?: string;
  items: Array<{
    inventoryItemId: string;
    variantId: string;
    sku: string;
    title: string;
    quantity: number;  // 入庫数量（正の値）
  }>;
  status: "active" | "cancelled";
  createdAt: string;
};
```

### 1.6 注文書（Transfer）との連携（将来対応）

- **方針**: 連携がスムーズにできるなら連携したい
- **検討項目**:
  - 仕入リストに「Transfer ID」を任意で紐づけ
  - 管理画面・他システムで注文書と仕入を突き合わせ可能にする
  - POSで「既存入庫（Transfer）から読み込み」オプションを追加するか

---

## 2. 発注（Purchase Order / Order Request）

### 2.1 機能概要

- **目的**: 店舗が本社に「必要商品の希望」を発注としてリスト登録する
- **ユースケース**:
  - 店舗→本社への発注依頼
  - 必要商品・数量のリスト化
  - 在庫切れ前の補充依頼
- **特徴**: **在庫は変更しない**（リスト登録のみ）

### 2.2 既存機能との関係

| 項目 | ロス登録 | 発注（新規） |
|------|----------|--------------|
| 在庫調整 | あり（マイナス） | **なし** |
| 確定時の処理 | inventoryAdjustQuantity | なし（ Metafield への保存のみ） |
| 商品リスト | 数量入力→確定で在庫減 | 数量入力→確定でリスト保存 |
| UIベース | LossConditions / LossProductList | **ロス登録の在庫調整なし版** |

### 2.3 画面構成（POS）

#### ① コンディション画面

- **入力項目**:
  - 発注先（任意テキスト、例: 本社）
  - 日付選択（必須、デフォルト: 今日）
  - 希望納品日（任意）
  - 備考（任意）
  - スタッフ名（任意）
- **機能**:
  - 「次へ」で商品リスト画面へ遷移
  - 「履歴一覧」で履歴一覧画面へ遷移
  - 自動保存・復元
- **UI**: ロス登録のコンディション画面をベースに、理由→発注先・希望納品日等に置き換え

#### ② 商品リスト画面

- **表示**: ロス登録の商品リストと同等のUI/UX
  - 検索フィールド
  - 検索結果リスト
  - 追加済み商品リスト
  - 数量コントロール（希望数量）
- **機能**:
  - 商品スキャンまたは手動選択
  - 数量入力（希望数量）
  - **確定でリスト保存のみ（在庫調整は行わない）**
- **確定処理**: Metafield への保存のみ

### 2.4 管理画面

#### 発注履歴（`/app/order-request` または `/app/purchase-order`）

- **一覧項目**: 発注ID、発注店舗（ロケーション）、発注先、日付、希望納品日、商品数、数量合計、ステータス
- **フィルター**: ロケーション（発注元店舗）、日付範囲、ステータス
- **詳細**: 商品明細のモーダル表示
- **CSV出力**: 一覧・詳細ともにCSV出力可能
- **ステータス例**: 未処理 / 発送済み / キャンセル

### 2.5 データ構造（案）

```typescript
type OrderRequestEntry = {
  id: string;           // 発注ID（例: order_${timestamp}_${random}）
  locationId: string;   // 発注元ロケーション（店舗）
  locationName: string;
  destination?: string; // 発注先（例: 本社）
  date: string;         // YYYY-MM-DD
  desiredDeliveryDate?: string;
  note?: string;
  staffName?: string;
  items: Array<{
    inventoryItemId: string;
    variantId: string;
    sku: string;
    title: string;
    quantity: number;   // 希望数量
  }>;
  status: "pending" | "shipped" | "cancelled";
  createdAt: string;
};
```

---

## 3. 共通事項

### 3.1 POSタイル構成

| タイル | メイン表記 | サブ表記 | 管理画面表記 | 拡張名（例） |
|--------|------------|----------|--------------|--------------|
| 仕入 | 仕入 | 在庫処理 | 仕入 | stock-transfer-purchase |
| 発注 | 発注 | 在庫調整 | 発注 | stock-transfer-order |

- 既存タイル（出庫・入庫・ロス・棚卸）と同様のレイアウト・スタイルで追加
- カメラスキャン・軽量モード・画像表示ON/OFFは既存と統一

### 3.2 管理画面メニュー構成

```
① 在庫情報  （在庫高 / 在庫変動履歴）  /app/inventory-info
② 入出庫    （従来: 入出庫履歴）      /app/history
③ 仕入      （新規）                  /app/purchase
④ ロス      （従来: ロス履歴）        /app/loss
⑤ 発注      （新規）                  /app/order
⑥ 棚卸      （商品グループ設定/棚卸ID発行/履歴）  /app/inventory-count
```

※ 在庫情報の詳細は `docs/REQUIREMENTS_INVENTORY_INFO_AND_SETTINGS.md` を参照

### 3.2a 設定のタブ化（棚卸と同構成）

| タブ | 内容 |
|------|------|
| ① アプリ設定 | 店舗設定、アプリ表示件数設定 |
| ② 出庫設定 | 出庫設定、配送設定（carriers） |
| ③ 入庫設定 | 入庫設定（過剰/予定外許可、表示件数） |
| ④ 仕入設定 | サプライヤー設定 |
| ⑤ ロス設定 | ロス区分設定（lossReasons） |

### 3.3 ロス登録をベースとした構築方針

- **POS UI**: ロス登録（LossConditions / LossProductList / LossHistoryList）を**そっくりそのまま**流用して構築
- **管理画面**: ロス履歴（app.loss.tsx）の構成をそのまま流用
- **差分**:
  - 仕入: ロス「理由」→ サプライヤー選択・配送情報／在庫調整はプラス
  - 発注: ロス「理由」→ 発注先・希望納品日／在庫調整はなし

### 3.4 データ保存

- **保存先**: `currentAppInstallation.metafield`
  - 仕入: `purchase_entries_v1`
  - 発注: `order_request_entries_v1`
  - サプライヤー: SettingsV1 の `suppliers` に含める（`settings_v1`）
- **実装方針**: ロス登録と同様にMetafield方式を優先

#### 在庫変動履歴（DB）への参照ID記録（重要）

- 仕入は「在庫を増やす」ため、**確定時に在庫調整を行うだけでなく**、同時に **在庫変動履歴（Prisma DB）** にログを残す。
  - **sourceType**: `purchase_entry`
  - **sourceId**: `PurchaseEntry.id`（例: `purchase_...`）
- 仕入キャンセルは「在庫を戻す（マイナス調整で相殺）」ため、キャンセル時も同様にログを残す。
  - **sourceType**: `purchase_cancel`
  - **sourceId**: `PurchaseEntry.id`
- 発注は在庫を動かさないため、在庫変動履歴（DB）にはログを作らない（リスト保存のみ）。

#### 仕入キャンセル仕様（在庫を戻す / 冪等性 / 二重処理防止 / ログ）【確定】

この仕様は「ロスのキャンセル」と同じく、**在庫を元に戻す**操作です。ただし、ネットワークの再送や二重タップが起きても安全なように、**必ず冪等性（同じキャンセルを何回呼んでも結果が1回ぶんになる）**を担保します。

##### 1) 対象レコードとステータス

- **対象**: `purchase_entries_v1` の `PurchaseEntry`
- **ステータス**: `active | cancelled`
- **キャンセル日時**: `cancelledAt`（ISO文字列）

##### 2) 在庫を戻す（= マイナス調整で相殺）

- **キャンセル時の在庫調整**: 仕入確定で増やした数量と同じぶん、同じロケーションで **マイナス調整（delta = -quantity）** を行う
- **対象アイテム**: `PurchaseEntry.items[]` の `inventoryItemId` ごと
- **数量**: `items[].quantity`（仕入時に入れた数量）をそのまま使用

##### 3) 冪等性（同じキャンセルを2回実行しても在庫が二重に減らない）

キャンセル処理は、以下のどれが起きても安全になる必要があります。

- 同じ画面で「キャンセルする」を2回押した
- 通信失敗でアプリが再送した
- 管理画面とPOSが同時にキャンセルした

そのために **サーバー側**で次のルールを必ず守ります。

- **ルールA（早期終了）**: 対象 `PurchaseEntry.status` が既に `cancelled` なら、**在庫調整もログ作成もせず** `ok` を返す
- **ルールB（ログのユニーク制約で二重処理防止）**: 在庫変動ログ（Prisma DB）には `idempotencyKey` を必ず保存し、同じ `idempotencyKey` の重複登録をDBで防ぐ  
  - 例: `purchase_cancel:${purchaseId}:${locationId}:${inventoryItemId}`
- **ルールC（ログが既にあるなら在庫調整しない）**: もし `purchase_cancel` のログが既に存在する（= 過去にキャンセル処理が完了済み）なら、在庫調整はスキップして `ok` を返す

> ポイント: **「ステータス確認」だけだと同時実行で破れやすい**ため、DBのユニーク制約（idempotencyKey）を「最後の砦」にします。

##### 4) ログ記録（在庫変動履歴DB）

- **ログを残すタイミング**: キャンセルで在庫を動かしたら、必ず同時にログを残す
- **sourceType**: `purchase_cancel`
- **sourceId**: `PurchaseEntry.id`
- **delta**: `-items[].quantity`
- **idempotencyKey**: 上記ルールBの形式（**必須**）
- **note（任意）**: 画面で入力できるなら「仕入キャンセル」「担当者」などを入れる（Webhook由来は基本空欄）

#### サプライヤー型（SettingsV1 追加案）

```typescript
type SupplierOption = {
  id: string;
  name: string;      // サプライヤー名
  code?: string;     // コード（任意）
  sortOrder?: number;
};
// SettingsV1 に suppliers?: SupplierOption[] を追加
```

### 3.5 実装優先度

| 優先度 | 機能 | 理由 |
|--------|------|------|
| 1 | 発注 | 在庫調整なしで実装が軽い |
| 2 | 仕入 | 在庫プラス調整が必要、入庫フローと似ている |

---

## 4. 未決事項・検討項目

### 4.1 仕入

- [ ] 注文書（Transfer）連携の具体的な仕様
- [ ] 複数配送（シップメント）の必要性
- [x] 仕入のキャンセル時の在庫戻しの要否（要: 在庫を戻す。仕様は上記「仕入キャンセル仕様【確定】」）

### 4.2 発注

- [ ] 発注ステータスの運用（本社側での更新方法）
- [ ] 発注→出庫への自動変換の要否
- [ ] 発注先の選択肢を管理画面設定から登録するか（サプライヤー同様）

### 4.3 共通

- [ ] 拡張の分割方針（新規2拡張 vs 既存拡張への統合）
- [ ] 履歴表示件数・フィルターのデフォルト値

---

## 5. 参照

- **ロス登録**: REQUIREMENTS_FINAL.md 第2章
- **入庫**: REQUIREMENTS_FINAL.md 第1.2節、入庫拡張（stock-transfer-inbound）
- **棚卸**: REQUIREMENTS_FINAL.md 第3章
- **POS UI**: docs/POS_IMAGE_DISPLAY_PLACEMENT.md、docs/INBOUND_REFERENCE_DIFF_ITEMS.md
