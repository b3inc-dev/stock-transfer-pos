# 棚卸 確定処理の種類と処理内容

## 1. 確定処理の種類

棚卸の確定は **1種類** です。フッターの「確定」ボタンから実行されます。

| 種類 | トリガー | 説明 |
|------|----------|------|
| 確定モーダル経由 | フッター「確定」→ 確認モーダル「確定する」 | 在庫調整を実行し、groupItems に結果を保存 |

---

## 2. 処理の流れ

### 2.1 単一グループモード（商品グループ1つ）

1. **調整対象の算出**: `currentQuantity !== actualQuantity` の行のみ抽出
2. **在庫調整 API**: `adjustInventoryToActual` → `inventorySetQuantities` で実数を反映
3. **メタフィールド保存**: `groupItems[productGroupId]` に確定済みデータを保存
4. **ステータス更新**: 全グループ確定時は `status: "completed"`

### 2.2 複数グループモード（まとめて表示）

1. **編集可能行をグループごとに集約**: `linesByGroup`
2. **カウントありグループのみ処理**: `actualQuantity > 0` または `currentQuantity !== actualQuantity` がある場合
3. **在庫調整 API**: 全グループ分を一括で `adjustInventoryToActual`
4. **メタフィールド保存**: 各グループの `groupItems[groupId]` に保存
5. **未カウントグループ**: スキップしてトースト表示

---

## 3. 確定エラー防止（2025-02 修正）

### 対応内容

`inventorySetQuantities` の入力に **`ignoreCompareQuantity: true`** を指定し、compareQuantity の比較チェックをスキップするようにしました。

- compareQuantity 不一致エラー（在庫更新後・マイナス在庫等）を防止
- マイナス在庫 → 0 確定時のエラーも防止

### マイナス入力の対応

棚卸のみ **マイナス在庫（-999〜999999）の入力** を許可しています。

- `QtyControlCompact_3Buttons`: min={-999}
- `setActualQuantity` / `updateActualQuantity`: -999〜999999 の範囲
- `adjustInventoryToActual`: quantity に Math.max(0,...) を適用せず、負の値もそのまま反映

---

## 4. Modal.jsx（棚卸）の実装内容

| 項目 | 内容 |
|------|------|
| **構成** | Extension 内で StocktakeScreen をレンダリング |
| **ルート** | s-page > s-stack > header / s-scroll-box(body) / footer |
| **永続化** | UI_PREFS_KEY（liteMode 等）|
| **スキャン** | LOSS_SCAN_QUEUE_KEY でスキャンキュー管理 |
| **モーダル閉じ** | posModalApi / globalThis.navigation / SHOPIFY.action の順で dismiss を試行 |
| **エラー境界** | ErrorBoundary で未捕捉例外をキャッチ |

---

## 5. 関連ファイル

| ファイル | 役割 |
|----------|------|
| `Modal.jsx` | 棚卸モーダルルート、StocktakeScreen、UI Prefs、スキャンキュー |
| `InventoryCountList.jsx` | 確定ボタン、確定モーダル、handleComplete、数量入力（-999〜999999）|
| `stocktakeApi.js` | `adjustInventoryToActual`, `ignoreCompareQuantity: true` |
