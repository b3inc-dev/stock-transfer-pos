# 仕入機能 実装プラン

**作成日**: 2026年2月5日  
**前提**: 発注機能はほぼ実装完了。仕入実装に進行する。

---

## 1. 発注の実装状況（ほぼ完了）

| 項目 | 状態 | 備考 |
|------|------|------|
| 管理画面 `/app/order` | ✅ 完了 | app.order.tsx：一覧・フィルター・モーダル・CSV・承認・発注先編集・原価・販売価格 |
| POS拡張 `stock-transfer-order` | ✅ 完了 | OrderConditions / OrderProductList / OrderHistoryList |
| 発注→仕入予定（#P0000） | ✅ 完了 | 「仕入に反映」で purchase_entries_v1 に保存 |
| 設定（発注先マスタ・仕入サプライヤー連動） | ✅ 完了 | app.settings.tsx ④仕入設定・⑤発注設定 |

**残り（任意）**: 仕入予定一覧画面で #P0000 と #B0000 を同じ一覧に表示（仕入画面実装時に一緒にやる想定）。

---

## 2. 仕入の現状と不足しているもの

### 2.1 すでにあるもの

- **データ**: `purchase_entries_v1` に発注から作成した #P0000 形式の仕入予定が保存されている（app.order.tsx の createPurchaseFromOrder）
- **型**: `PurchaseEntry` が app.order.tsx で定義済み（id, purchaseName, locationId, items, status: pending | received | cancelled 等）
- **設定**: 仕入設定タブ（サプライヤー）が app.settings.tsx にあり、発注先マスタと連動済み
- **ナビ**: app.tsx に「仕入」リンク（`/app/purchase`）があるが、**ルートが未作成のため 404 になる**

### 2.2 まだないもの

| 項目 | 内容 |
|------|------|
| **管理画面** | `/app/purchase` のルートファイル（app.purchase.tsx）が存在しない |
| **POS拡張** | `stock-transfer-purchase` 拡張が存在しない（出庫・入庫・ロス・棚卸・発注のみ） |
| **仕入確定API** | POSで「確定」したときの在庫プラス調整（inventoryAdjustQuantity）＋在庫変動履歴（DB）への記録 |
| **仕入キャンセルAPI** | 在庫を戻す（マイナス調整）＋冪等性（idempotencyKey）＋在庫変動履歴 |

---

## 3. 仕入実装の進め方（推奨順）

要件書（REQUIREMENTS_PURCHASE_AND_ORDER.md）に沿った実装順です。

### Phase A: 管理画面「仕入履歴」（/app/purchase）

- **目的**: 発注から作った #P0000 を一覧で見られるようにする。のちに #B0000（POSから作成）も同じ一覧に表示。
- **やること**:
  1. `app/routes/app.purchase.tsx` を新規作成
  2. ロス履歴（app.loss.tsx）／発注（app.order.tsx）をベースに、以下を実装
     - loader: ロケーション一覧取得 ＋ `purchase_entries_v1` の metafield 取得
     - 一覧: 仕入ID（purchaseName）、入庫先、サプライヤー、日付、商品数・数量合計、ステータス
     - フィルター: ロケーション、日付範囲、ステータス（pending / received / cancelled）
     - モーダル: 行クリックで商品明細モーダル表示
     - CSV: 一覧用・詳細用（モーダルから）
     - キャンセル: ステータスが active/received のとき「キャンセル」ボタン → Action で在庫戻し＋冪等性（後述）
- **データ**: 既存の `purchase_entries_v1` をそのまま利用。PurchaseEntry 型は app.order.tsx から export して利用するか、app.purchase.tsx で同型を定義。

### Phase B: 仕入「確定」・「キャンセル」の API（管理画面・POS 共通）

- **確定（入庫）**:
  - 対象: status が `pending` の PurchaseEntry
  - 処理: 各 item について `inventoryAdjustQuantity`（プラス）で在庫増加
  - 在庫変動履歴（Prisma DB）に `sourceType: purchase_entry`, `sourceId: PurchaseEntry.id` でログを残す
  - status を `received`、`receivedAt` を設定して metafield 更新
- **キャンセル**:
  - 要件書「仕入キャンセル仕様」に従う
  - ステータスが既に `cancelled` なら何もしないで ok を返す（冪等）
  - 在庫変動ログに `idempotencyKey`（例: `purchase_cancel:${purchaseId}:${locationId}:${inventoryItemId}`）を保存し、DB で重複を防ぐ
  - 同じ idempotencyKey が既にあれば在庫調整はスキップして ok を返す
  - 在庫: 仕入で増やした数量と同じぶん、同じロケーションでマイナス調整
  - status を `cancelled`、`cancelledAt` を設定して metafield 更新

これらは Action（app.purchase.tsx の Action と、のちに POS 用 API があればそこでも）から呼ぶ共通ロジックにするとよい。

### Phase C: POS 拡張「仕入」（stock-transfer-purchase）

- **目的**: POS から直接仕入を立ち上げ、#B0000 で管理する。
- **やること**:
  1. `extensions/stock-transfer-purchase` を新規作成（stock-transfer-order / stock-transfer-loss をベース）
  2. コンディション画面: ロケーション（入庫先）・サプライヤー・日付・配送業者・配送番号・到着予定日・スタッフ
  3. 商品リスト画面: 検索・スキャンで商品追加、数量入力（プラス＝入庫数）、確定で確認モーダル → 確定 API 呼び出し（在庫プラス＋purchase_entries_v1 に #B0000 で保存）
  4. 履歴一覧: 仕入履歴の一覧・詳細（管理画面と同じデータソース）
  5. #B0000 連番: 既存の #P0000 と重複しないよう、POS 由来は #B0000 で採番（要件書・REQUIREMENTS_FINAL の記載に合わせる）

### Phase D: 管理画面での「入庫確定」ボタン（任意）

- 発注から作った #P0000 は「仕入予定」なので、実際の入庫は POS で行う想定。  
  管理画面から「この仕入予定を入庫済みにする」ボタンを用意する場合は、Phase B の確定 API を呼ぶだけの UI を app.purchase.tsx に追加する。

---

## 4. データ・API の整理

- **保存先**: 既存どおり `currentAppInstallation.metafield`（namespace: `stock_transfer_pos`, key: `purchase_entries_v1`）
- **PurchaseEntry.status**: `pending`（未入庫）| `received`（入庫済み）| `cancelled`（キャンセル）
- **#P0000**: 発注から作成（既に実装済み）
- **#B0000**: POS から新規作成（Phase C で実装）
- **在庫変動履歴**: 確定時は `purchase_entry`、キャンセル時は `purchase_cancel`。idempotencyKey はキャンセルで必須。

---

## 5. 実装状況

- **Phase A**: ✅ 完了（2026-02-05）
  - `app/routes/app.purchase.tsx` を新規作成
  - 仕入履歴一覧（purchase_entries_v1）、フィルター（入庫先ロケーション・ステータス）、商品明細モーダル、CSV出力（表示中／モーダル）、キャンセル（ステータス＋cancelledAt のみ更新。在庫戻しは Phase B）
  - `app.order.tsx` の `PurchaseEntry` 型に `cancelledAt?` を追加

## 6. 次の一歩

**Phase A は完了。Phase B（確定・キャンセル時の在庫調整＋冪等性）から着手することを推奨します。**

- 既存の `purchase_entries_v1` と PurchaseEntry 型をそのまま使える
- 発注で「仕入に反映」した #P0000 が一覧で確認できるようになる
- ロス／発注の画面構成を流用できるため、実装が進めやすい

Phase A ができたら、Phase B（確定・キャンセル API）→ Phase C（POS 仕入拡張）の順で進めると、仕入機能が一通りつながります。

---

## 7. 進行メモ（2026-02-05）

### 発注CSVに「発注先コード」を追加済み

- **対象**: 管理画面 発注のCSV出力
- **変更内容**:
  - `OrderCsvColumn` に `destinationCode`（発注先コード）を追加
  - 設定画面「発注設定」のCSV出力項目に「発注先コード」を追加可能に
  - デフォルトのCSV列に「発注先」の直後に「発注先コード」を含める
  - 出力値: 発注先マスタで「発注先名」に一致する行の `code`（未設定時は空）
- **ファイル**: `app.settings.tsx`（型・validColumns・ALL_CSV_COLUMNS・ラベル）、`app.order.tsx`（CSV出力時の case "destinationCode"）

### 仕入の実装方針（原則）

- **UI**: ロス登録・入庫のUIをそのまま使用し、**処理だけ組み替える**
  - ロス: 在庫マイナス調整 → 仕入: **在庫プラス調整**（入庫と同じ `inventoryAdjustQuantities` のプラス値）
  - 入庫: Transfer の lineItems が起点 → 仕入: **検索・スキャンで自由に商品追加**（ロスと同じ）
- **参照**: 要件の詳細は `docs/REQUIREMENTS_PURCHASE_AND_ORDER.md` 第1章（仕入）、キャンセル仕様は同ドキュメント「仕入キャンセル仕様【確定】」

---

## 8. 進行順（実装の進め方）

仕入IDの立ち上げは **①発注から** と **②仕入管理画面から** の2通りが必要。管理画面では履歴一覧から商品リストを開き、入庫の商品リスト同様に「仕入の処理（入庫確定）」を行う。

| 順 | フェーズ | 内容 | 状態 |
|----|----------|------|------|
| **1** | **Phase B** | 仕入「入庫確定」・「キャンセル」の API（在庫調整込み） | ✅ 完了 |
| **2** | **管理画面：入庫確定UI** | 仕入詳細モーダルに「入庫確定」ボタン（status=pending のとき表示）。押下で Phase B の確定 API を呼ぶ | ✅ 完了 |
| **3** | **管理画面：新規仕入作成** | 商品リストを登録して仕入IDを立ち上げる（「新規仕入」→ 入庫先・サプライヤー・日付等 → 商品追加 → 登録で #A0000 等を発行） | ✅ 完了 |
| **4** | **Phase C** | POS 拡張 `stock-transfer-purchase`（コンディション・商品リスト・確定で #B0000 保存） | 未着手 |

- **Phase B** が無いと、どこからも「入庫確定」ができないため最優先。
- その次に、管理画面で **履歴から入庫確定** できるように **入庫確定ボタン** を追加。
- **新規仕入作成** は、発注以外で仕入IDを増やす入口（管理画面から商品リスト登録で1件作成）。
- **Phase C** は POS から直接 #B0000 で仕入する拡張。
