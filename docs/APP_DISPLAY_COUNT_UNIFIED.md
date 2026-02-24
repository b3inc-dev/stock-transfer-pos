# アプリ表示件数（初回読み込み）の統一と読込ボタン

**日付**: 2026-02

---

## 1. 設定の統一

### 変更内容

- **1入力に統一**: 「初回読み込み件数」を1つだけ設定し、**履歴一覧リスト・商品リスト・検索リスト**のすべてに同じ値を使用するようにしました。
- **適用先**: 出庫・入庫・仕入・発注・ロス・棚卸・調整のすべてで、読み込み時間の差が出ないように同一件数で統一しています。
- **保存時の反映**: 入力値を変更して保存すると、次の4つに同時に反映されます。
  - `outbound.historyInitialLimit`（出庫履歴）
  - `inbound.listInitialLimit`（入庫リスト）
  - `productList.initialLimit`（商品リスト・上限250）
  - `searchList.initialLimit`（検索リスト・API制限のため最大50に自動でキャップ）

### 補足テキスト

- 入力欄下の説明は「**最大250件、推奨100件。（検索リストはAPI制限により最大50件）**」のみに変更しました（最大数・推奨数のみの記載）。

### デフォルト値

- 初回読み込み件数: **100**
- 商品リストのデフォルトも 100 に変更（従来の 250 から変更）。

---

## 2. 読込ボタンの配置（出庫・入庫に合わせる）

### ルール

- **履歴一覧リスト・商品リスト**: 設定数以上のデータがあるとき、**ヘッダー**に「読込」ボタンを表示する。
- **検索リスト**: 設定数以上の検索結果があるとき、**検索結果の最下部**に「読込」ボタンを表示する。
- 処理方法とUIは**出庫・入庫**の実装に合わせる。

### 実装済み

| 機能 | 履歴一覧（ヘッダー読込） | 商品リスト（ヘッダー読込） | 検索リスト（最下部読込） |
|------|---------------------------|-----------------------------|----------------------------|
| 出庫 | ✅ 既存（APIページネーション） | ✅ 既存 | ✅ 既存 |
| 入庫 | ✅ 既存（APIページネーション） | ✅ 既存 | ✅ 既存 |
| 棚卸 | ✅ 追加（表示件数スライス＋読込） | ✅ 既存（さらに読み込む） | ✅ 設定件数で取得・既存UI |
| ロス | ✅ 追加（表示件数スライス＋読込） | 要確認 | 要確認 |
| 発注 | ✅ 追加（表示件数スライス＋読込） | 要確認 | 要確認 |
| 仕入 | ✅ 追加（表示件数スライス＋読込） | 要確認 | 要確認 |
| 調整 | ✅ 追加（表示件数スライス＋読込） | 要確認 | 要確認 |

- **棚卸**: `InventoryCountConditions.jsx` で設定の初回件数を使用し、超過分はヘッダーに「読込」を表示。クリックで表示件数を増加（クライアント側）。
- **ロス**: `LossHistoryList.jsx` で同様に設定の初回件数＋ヘッダー「読込」を追加済み。
- **発注**: `OrderHistoryList.jsx` で設定取得・表示件数制限・ヘッダー「読込」を追加済み。
- **仕入**: `PurchaseHistoryList.jsx` で設定取得・表示件数制限・一覧上部に「読込」を追加済み。
- **調整**: `AdjustmentHistoryList.jsx` で設定取得・表示件数制限・ヘッダー「読込」を追加済み。

### 発注・仕入・調整について

- 履歴がメタフィールド全件取得のため、**棚卸・ロスと同じパターン**で対応済みです。
  - 設定から `outbound.historyInitialLimit` を読み、初回はその件数だけ表示。
  - 超過分があるときはヘッダー（発注・調整）または一覧上部（仕入）に「未読み込み一覧リストがあります。（過去分）」＋「読込」ボタンを表示し、クリックで表示件数を増やす（クライアント側で `listToShowSlice` を拡張）。

---

## 3. 変更ファイル一覧

- **設定画面**: `app/routes/app.settings.tsx`
  - アプリ表示件数を1入力に統一。
  - 補足を「最大250件、推奨100件。（検索リストはAPI制限により最大50件）」のみに変更。
  - デフォルトの `productList.initialLimit` を 100 に変更。
- **棚卸履歴**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountConditions.jsx`
  - `fetchSettings` で設定取得、`historyDisplayLimit` で表示件数制限。
  - ヘッダーに「読込」ボタン（設定数以上のとき）、`listToShowSlice` で描画。
- **ロス履歴**: `extensions/stock-transfer-loss/src/screens/loss/LossHistoryList.jsx`
  - 上記と同様に設定取得・表示件数制限・ヘッダー「読込」を追加。
- **棚卸商品リスト**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx`
  - 未読込時のデフォルトを 250 → 100 に変更（設定と統一）。
- **発注履歴**: `extensions/stock-transfer-order/src/screens/order/OrderHistoryList.jsx`
  - `fetchSettings` で設定取得、`historyDisplayLimit` で表示件数制限。ヘッダーに「読込」ボタン、`listToShowSlice` で描画。
- **仕入履歴**: `extensions/stock-transfer-purchase/src/screens/purchase/PurchaseHistoryList.jsx`
  - 同様に設定取得・表示件数制限・一覧上部に「読込」を追加。
- **調整履歴**: `extensions/stock-transfer-adjustment/src/screens/loss/AdjustmentHistoryList.jsx`
  - 同様に設定取得・表示件数制限・ヘッダー「読込」を追加。
