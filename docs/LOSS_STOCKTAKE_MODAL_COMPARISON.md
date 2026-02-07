# ロス・棚卸 Modal 比較：メニュー版 vs 4分割版

**作成日**: 2026年2月3日  
**目的**: `stock-transfer-loss/src/Modal.jsx`（ロス・棚卸メニューを持つ統合版）と、現在の4分割拡張の実装の差分を整理し、要件を満たす修正方針を把握する。

---

## 1. アーキテクチャの違い

### 1.1 統合版（stock-transfer-loss/src/Modal.jsx）

| 項目 | 内容 |
|------|------|
| **場所** | `stock-transfer-loss/src/Modal.jsx`（ルートの stock-transfer-loss、extensions 外） |
| **エントリ** | 1つのタイル「在庫調整」→ メニュー画面 → ロス or 棚卸を選択 |
| **view 構造** | `VIEW.MENU` / `VIEW.LOSS` / `VIEW.STOCKTAKE` の3段階 |
| **戻り先** | ロス・棚卸の「戻る」→ メニュー画面 → dismissModal でモーダル閉じ |

### 1.2 4分割版（現行 extensions）

| 項目 | 内容 |
|------|------|
| **場所** | `extensions/stock-transfer-loss/` と `extensions/stock-transfer-stocktake/` の2つ |
| **エントリ** | ロスタイル → 直接ロス、棚卸タイル → 直接棚卸（メニューなし） |
| **view 構造** | 各拡張内で単一機能のみ（ロス or 棚卸） |
| **戻り先** | コンディション画面の「戻る」→ `dismissModal()` でモーダル閉じ |

---

## 2. ページ遷移・要素別まとめ

### 2.1 ロス（両版とも同じ遷移フロー）

```
[コンディション] ←→ [商品リスト] ←→ [履歴一覧]
```

| 要素 | 担当コンポーネント | コード構造 | 備考 |
|------|-------------------|------------|------|
| **ヘッダー** | Modal（親）が `setHeader` で保持 | `s-page` > `s-stack` > `header ? <s-box>{header}</s-box>` | 各画面が `useEffect` で setHeader |
| **本文** | LossScreen 内で LossConditions / LossProductList / LossHistoryList を切り替え | 条件分岐で1つのコンポーネントのみ表示 | - |
| **フッター** | Modal（親）が `setFooter` で保持 | `footer ? <s-divider/><s-box>{footer}</s-box>` | FixedFooterNavBar で統一 |
| **モーダル** | 各画面内の `<s-modal>` | リセット確認、確定確認など | - |

#### ロス・フッター内容（画面別）

| 画面 | 左 | 中央 | 右 |
|------|----|------|-----|
| コンディション | 閉じる（dismissModal） | - | 次へ、履歴一覧 |
| 商品リスト | 戻る | 明細 N / 合計 M | 確定 |
| 履歴一覧 | 戻る | - | - |

#### ロス・確定処理

1. **商品リスト**で「確定」タップ → `rightCommand="--show"`, `rightCommandFor={CONFIRM_LOSS_MODAL_ID}` で確定モーダルを表示
2. モーダル内「確定する」→ `handleConfirm` 実行
3. `inventoryAdjustQuantity` で在庫マイナス調整
4. `writeLossEntries` で履歴保存（Metafield）
5. `onAfterConfirm()` → 履歴一覧へ遷移、conds クリア

---

### 2.2 棚卸（両版とも同じ遷移フロー）

```
[棚卸ID入力（コンディション）] 
  → [商品グループ選択]（複数グループの場合のみ）
  → [商品リスト]
```

| 要素 | 担当コンポーネント | コード構造 | 備考 |
|------|-------------------|------------|------|
| **ヘッダー** | Modal（親）が `setHeader` で保持 | ロスと同構造 | コンディション・商品グループ選択・商品リストで setHeader |
| **本文** | StocktakeScreen 内で InventoryCountConditions / InventoryCountProductGroupSelection / InventoryCountList を切り替え | 条件分岐で1つのコンポーネントのみ表示 | - |
| **フッター** | Modal（親）が `setFooter` で保持 | ロスと同構造 | FixedFooterNavBar（common） |
| **モーダル** | InventoryCountList 内の `<s-modal id={CONFIRM_INVENTORY_COUNT_MODAL_ID}>` | 確定確認モーダル | 入庫の確定モーダルを参考 |

#### 棚卸・フッター内容（画面別）

| 画面 | 左 | 中央 | 右 |
|------|----|------|-----|
| 棚卸ID入力（コンディション） | 閉じる | - | 軽量モード |
| 商品グループ選択 | 戻る | - | - |
| 商品リスト | 戻る | 在庫/実数、超過/不足 | 確定 |

#### 棚卸・確定処理

1. **商品リスト**で「確定」タップ → `rightCommand="--show"`, `rightCommandFor={CONFIRM_INVENTORY_COUNT_MODAL_ID}` で確定モーダルを表示
2. モーダル内「確定する」→ `handleComplete` 実行
3. `adjustInventoryToActual`（`inventorySetQuantities`）で絶対値設定
4. `writeInventoryCounts` で履歴更新（Metafield、groupItems に反映）
5. `onAfterConfirm()` → 棚卸ID入力（コンディション）に戻る、count 等クリア

---

## 3. 統合版 Modal vs 4分割版 Modal の差分

### 3.1 統合版（stock-transfer-loss/src/Modal.jsx）

- **view**: `VIEW.MENU` | `VIEW.LOSS` | `VIEW.STOCKTAKE`
- **メニュー画面**: 軽量モード ON/OFF、ロスボタン、棚卸ボタン
- **戻り**: ロス/棚卸の `onBack` は `goMenu`（メニューに戻る）
- **ヘッダー・フッター**: `view === MENU || view === STOCKTAKE` のとき null にクリア（useEffect）
- **スキャナー**: ロス商品リスト or 棚卸商品リストのときだけキューに積む（view + lossView/stocktakeView で判定）
- **棚卸用スキャンキュー**: `pushScanToQueueForStocktake_` を別途定義、キー `stock_transfer_pos_inventory_count_scan_queue_v1`

### 3.2 4分割版・ロス（extensions/stock-transfer-loss/src/Modal.jsx）

- **view**: なし（LossScreen のみ）
- **メニュー画面**: なし（タイルで直接ロス開始）
- **戻り**: `onBack` = `handleBackFromConditions` = `dismissModal()`（モーダル閉じ）
- **ヘッダー・フッター**: 常に LossScreen が setHeader/setFooter
- **スキャナー**: `lossView === LOSS_VIEW.PRODUCT_LIST` のときだけキューに積む
- **liteMode**: Modal で `useUiPrefs`、LossScreen に `liteMode` / `onToggleLiteMode` を渡す

### 3.3 4分割版・棚卸（extensions/stock-transfer-stocktake/src/Modal.jsx）

- **view**: なし（StocktakeScreen のみ）
- **メニュー画面**: なし（タイルで直接棚卸開始）
- **戻り**: `onBack` = `handleBackFromConditions` = `dismissModal()`（モーダル閉じ）
- **ヘッダー・フッター**: 常に StocktakeScreen が setHeader/setFooter
- **スキャナー**: `stocktakeView === STOCKTAKE_VIEW.PRODUCT_LIST` のときだけキューに積む（stocktakeApi.js 内のキー使用）
- **liteMode**: Modal で `useUiPrefs`、StocktakeScreen に `liteMode` / `onToggleLiteMode` を渡す

---

## 4. StocktakeScreen の軽量モードの差分

| 版 | liteMode / onToggleLiteMode |
|----|-----------------------------|
| 統合版・StocktakeScreen | なし（メニューで軽量モード切替） |
| 4分割版・StocktakeScreen | あり（InventoryCountConditions に渡す） |

4分割版では、InventoryCountConditions が `liteMode` / `onToggleLiteMode` を受け取り、フッターに軽量モードボタンを表示。

---

## 5. 確定処理の比較

### 5.1 ロス確定（両版とも同一ロジック）

| 項目 | 内容 |
|------|------|
| トリガー | 商品リストのフッター「確定」→ 確定モーダル表示 |
| モーダル | `CONFIRM_LOSS_MODAL_ID`、heading「ロスを確定しますか？」 |
| 表示内容 | ロケーション、明細/合計、日付、理由、スタッフ |
| ボタン | 戻る（モーダル閉じ）、確定する（handleConfirm） |
| API | `inventoryAdjustQuantity`（マイナス値で調整） |
| 履歴 | `writeLossEntries`（Metafield `loss_entries_v1`） |
| 完了後 | `onAfterConfirm()` → 履歴一覧へ |

### 5.2 棚卸確定（両版とも同一ロジック）

| 項目 | 内容 |
|------|------|
| トリガー | 商品リストのフッター「確定」→ 確定モーダル表示 |
| モーダル | `CONFIRM_INVENTORY_COUNT_MODAL_ID`、heading「棚卸を確定しますか？」 |
| 表示内容 | 在庫/実数、差分、調整対象件数、先頭1件＋「他X件」 |
| ボタン | 戻る（モーダル閉じ）、確定する（handleComplete） |
| API | `inventorySetQuantities`（絶対値設定） |
| 履歴 | `writeInventoryCounts`（Metafield `inventory_counts_v1`、groupItems 更新） |
| 完了後 | `onAfterConfirm()` → 棚卸ID入力（コンディション）へ |

---

## 6. 要件との対応状況（REQUIREMENTS_FINAL.md より）

### 6.1 4分割の要件

- 出庫・入庫・ロス・棚卸を各1拡張に分割 → **済**
- ロス拡張から棚卸関連ファイル削除 → **済**（extensions/stock-transfer-loss に棚卸なし）
- 棚卸は stock-transfer-stocktake に独立 → **済**

### 6.2 メニュー廃止の方針（出庫と同様）

- 出庫: タイルを開くと直接コンディション画面
- ロス: タイルを開くと直接ロスコンディション画面
- 棚卸: タイルを開くと直接棚卸ID入力（コンディション）画面

**統合版の「メニュー」は 4分割版では不要**（タイルがロス/棚卸で分かれているため）。

### 6.3 フッター・軽量モード

- ロス・棚卸には `liteMode` / `onToggleLiteMode` のサポートと UI 設定の永続化 → **4分割版で対応済み**

---

## 7. 修正が必要な場合のチェックリスト

統合版をベースに戻す、または統合版の挙動を 4分割版に合わせる場合は以下を確認：

1. **メニューを復活させるか**
   - 復活する場合: ロス・棚卸を1タイルにまとめ、`stock-transfer-loss` に統合 Modal を置く設計に戻す
   - 現状維持: 4分割のまま、ロス・棚卸は別タイルのまま

2. **軽量モードの受け渡し**
   - 棚卸の StocktakeScreen に `liteMode` / `onToggleLiteMode` が渡っているか → **4分割版で対応済み**

3. **スキャナー**
   - ロス・棚卸それぞれで商品リスト画面のときだけキューに積む → **4分割版で対応済み**

4. **戻る動作**
   - 統合版: コンディションの戻る → メニュー
   - 4分割版: コンディションの戻る → モーダル閉じ（POS に戻る）

---

## 8. ファイル一覧（参照用）

| 機能 | ファイル |
|------|----------|
| 統合版 Modal | `stock-transfer-loss/src/Modal.jsx` |
| 4分割・ロス Modal | `extensions/stock-transfer-loss/src/Modal.jsx` |
| 4分割・棚卸 Modal | `extensions/stock-transfer-stocktake/src/Modal.jsx` |
| ロス画面 | `extensions/stock-transfer-loss/src/screens/LossScreen.jsx` |
| 棚卸画面 | `extensions/stock-transfer-stocktake/src/screens/StocktakeScreen.jsx` |
| ロス確定 | `extensions/stock-transfer-loss/src/screens/loss/LossProductList.jsx`（handleConfirm） |
| 棚卸確定 | `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx`（handleComplete） |
| フッター共通 | `FixedFooterNavBar`（ロス: loss/、棚卸: common/） |
