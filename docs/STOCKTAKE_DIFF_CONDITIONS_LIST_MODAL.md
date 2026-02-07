# 棚卸 差分一覧：コンディション・商品リスト・Modal

**作成日**: 2026年2月3日  
**比較対象**:
- **統合版**: `stock-transfer-loss/src/`（ロス・棚卸メニューを持つ Modal 内の棚卸）
- **4分割版**: `extensions/stock-transfer-stocktake/`（棚卸専用拡張）

---

## 1. Modal.jsx の差分

| 項目 | 統合版 (stock-transfer-loss/src/Modal.jsx) | 4分割版 (extensions/stock-transfer-stocktake/src/Modal.jsx) |
|------|-------------------------------------------|------------------------------------------------------------|
| **配置** | ロス・棚卸の両方を含む統合 Modal | 棚卸専用 Modal |
| **view 構造** | `VIEW.MENU` / `VIEW.LOSS` / `VIEW.STOCKTAKE` の3種 | 棚卸のみ（view なし） |
| **body** | `view === STOCKTAKE` のとき `StocktakeScreen` | 常に `StocktakeScreen` |
| **onBack** | `goMenu`（メニュー画面に戻る） | `handleBackFromConditions` = `dismissModal()`（モーダル閉じ） |
| **s-page heading** | `"在庫調整"`（メニュー時） | `"棚卸"` |
| **posModalApi** | なし（export が `async ()` で api 受け取りなし） | あり（`apiArg?.navigation` を保持） |
| **スキャナー** | `view === STOCKTAKE && stocktakeView === PRODUCT_LIST` のとき `pushScanToQueueForStocktake_` | `stocktakeView === PRODUCT_LIST` のとき同様（Modal 内に pushScanToQueue_ の棚卸分は未実装・InventoryCountList 側で処理） |
| **ヘッダー・フッター** | `view === MENU \|\| view === STOCKTAKE` のとき `setHeader(null)`, `setFooter(null)` | 常に StocktakeScreen が setHeader/setFooter を制御 |
| **StocktakeScreen へ渡す props** | `onBack`, `setHeader`, `setFooter`, `onViewChange`（liteMode なし） | 上記に加え `liteMode`, `onToggleLiteMode` |

**補足**:
- 4分割版 Modal の `pushScanToQueue_` は `LOSS_SCAN_QUEUE_KEY` を参照しており棚卸では使われない。棚卸のスキャンは InventoryCountList 内で `SCAN_QUEUE_KEY` を直接読み書きしている。
- 統合版では棚卸用に `pushScanToQueueForStocktake_` を Modal 内で定義し、スキャン時に呼び出している。

---

## 2. コンディションページ（InventoryCountConditions）の差分

| 項目 | 統合版 (stock-transfer-loss/.../InventoryCountConditions.jsx) | 4分割版 (extensions/.../InventoryCountConditions.jsx) |
|------|--------------------------------------------------------------|------------------------------------------------------|
| **FixedFooterNavBar** | `../loss/FixedFooterNavBar.jsx` | `../common/FixedFooterNavBar.jsx` |
| **stocktakeApi** | `toLocationGid`, `toLocationNumericId` なし | `toLocationGid`, `toLocationNumericId` を import |
| **props** | `liteMode`, `onToggleLiteMode` なし | `liteMode`, `onToggleLiteMode` あり |
| **loadNames** | `locationGid` で現在ログイン中のロケーション名を取得しない | `locationGid` がある場合に `getLocationName(locationGid)` で取得 |
| **refresh のフィルタ** | `locationGid ? allCounts.filter(c => c.locationId === locationGid)`（厳密一致） | `toLocationNumericId` / `toLocationGid` で数値・GID 両対応の緩いマッチ |
| **ロケーション名** | フィルタ後 `filtered.length === 0 && allCounts.length > 0` のときのフォールバックなし | 上記のとき `filtered = allCounts` にフォールバック |
| **Footer 左ボタン** | `leftLabel="戻る"`, `onLeft={onBack}` | `leftLabel` = 軽量モード（liteMode ? "画像表示:OFF" : "画像表示:ON"）, `onLeft={onToggleLiteMode}` |
| **Footer 右ボタン** | `rightLabel={loading ? "取得中..." : "再取得"}` | `rightLabel={loading ? "読込中..." : "再取得"}` ※要確認: 要件では「再読込」 |
| **ステータス表示** | `状態: {statusJa}`（テキストのみ） | `<s-badge tone={statusBadgeTone}>{statusJa}</s-badge>` |
| **getStatusBadgeTone** | 未使用 | `stocktakeHelpers.js` から import |
| **空表示** | `取得中...` / `表示できる棚卸IDがありません` | `読み込み中...` / `表示できる棚卸IDがありません` |

---

## 3. 商品リストページ（InventoryCountList）の差分

| 項目 | 統合版 (stock-transfer-loss/.../InventoryCountList.jsx) | 4分割版 (extensions/.../InventoryCountList.jsx) |
|------|--------------------------------------------------------|------------------------------------------------|
| **fetchSettings** | `../loss/lossApi.js` から import | `./stocktakeApi.js` から import |
| **FixedFooterNavBar** | `../loss/FixedFooterNavBar.jsx` | `../common/FixedFooterNavBar.jsx` |
| **ヘッダー 軽量ボタン** | ラベル「軽量」 | ラベル「画像表示」 |
| **ヘッダー 在庫ボタン** | （コメント）「在庫再取得」 | （コメント）「在庫更新」 |
| **在庫更新エラー** | `toast("在庫再取得エラー: ...")` | `toast("在庫更新エラー: ...")` |
| **console.log** | あり（`[InventoryCountList] Header useEffect`） | あり（同上）※本番前整理推奨 |
| **その他** | ほぼ同一のロジック・UI | ほぼ同一 |

**補足**: 両版とも `liteMode` は内部 state（UI_PREFS_KEY から復元）で、親からは渡されない。商品リスト画面の軽量モードはコンポーネント内で完結している。

---

## 4. StocktakeScreen の差分

| 項目 | 統合版 (stock-transfer-loss/.../StocktakeScreen.jsx) | 4分割版 (extensions/.../StocktakeScreen.jsx) |
|------|-----------------------------------------------------|---------------------------------------------|
| **InventoryCountConditions へ渡す props** | `liteMode`, `onToggleLiteMode` なし | `liteMode`, `onToggleLiteMode` あり |
| **その他** | 同一 | 同一 |

---

## 5. 要件との対応（REQUIREMENTS_FINAL.md）

| 要件 | 統合版 | 4分割版 |
|------|--------|---------|
| 軽量モード・UI設定の永続化 | メニューで切り替え、コンディションには未渡し | Modal からコンディションに渡し、商品リストは内部で prefs 利用 |
| 「在庫再取得」→「在庫更新」 | 在庫再取得のまま | 在庫更新に変更済み |
| 読み込み表示「読み込み中...」統一 | 「取得中...」のまま | 「読み込み中...」に変更 |
| ボタン内「読込中...」 | 「取得中...」 | 「読込中...」 |
| 「再取得」→「再読込」 | 「再取得」のまま | コンディションは「再取得」（要確認） |

---

## 6. 修正時に優先すべき版

**4分割版**を正とする（REQUIREMENTS_FINAL.md の4分割・名称統一に準拠）。

統合版を参照する場合、以下の点で4分割版の方が要件に沿っている：
- 軽量モードをコンディションで切替可能
- 在庫更新の名称
- 読み込み表示の統一
- ロケーションフィルタの toLocationGid / toLocationNumericId による互換性
