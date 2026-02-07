# 進捗状況と今後のステップ

**更新日**: 2026年1月27日

## 📊 全体進捗サマリー

### ✅ 完了している項目

#### 1. 管理画面の実装（Phase 1 & 2）
- ✅ **設定画面（`/app/settings`）**: 拡張完了
  - 表示ロケーション選択設定
  - 出庫・入庫・商品リストの表示件数設定
  - 各種許可設定（強制キャンセル、過剰入庫、予定外入庫）
- ✅ **入出庫履歴管理画面（`/app/history`）**: 実装完了
  - 履歴一覧表示（出庫・入庫統合表示）
  - フィルター機能（出庫ロケーション、入庫ロケーション、ステータス - 複数選択対応）
  - ページネーション（次へ/前へボタン、ページ表示）
  - モーダル表示（履歴クリックで商品リストをモーダル表示）
  - モーダルから個別CSV出力
  - 予定数/入庫数表示（分けて表示）
  - 予定外入庫表示（メモから抽出、薄い赤背景）
  - 予定外入庫を含めた数量計算（一覧表示に反映）
  - 予定外入庫の件数表示（一覧の状態横に表示）
- ✅ **ロス登録履歴管理画面（`/app/loss`）**: 実装完了
  - 履歴一覧表示
  - フィルター機能（ロケーション、日付範囲、理由、ステータス）
  - CSV出力機能（選択した履歴を一括CSV出力）
  - 詳細表示（商品明細表示）
- ✅ **棚卸管理画面（`/app/inventory-count`）**: 実装完了
  - 商品グループ設定
  - 棚卸ID発行処理
  - 履歴一覧表示、フィルター、CSV出力
- ✅ **ナビゲーションメニュー**: 更新完了（`/app/routes/app.tsx`）

#### 2. ロス登録機能（POS UI）の実装状況
- ✅ **コンディション画面**: 実装完了（`LossConditions.jsx`）
  - ✅ 自動保存・復元機能: 実装完了（入力値変更時に500msデバウンスで自動保存、確定時にクリア）
- ✅ **商品リスト画面**: 実装完了（`LossProductList.jsx`）- **エラー修正完了（2026-01-27）**
  - ✅ スキャナー処理を`Modal.jsx`に移動、出庫/入庫と同じ実装に統一
  - ✅ 設定から検索リストの表示件数を読み込むように修正
  - ✅ 自動保存・復元機能: 実装完了
- ✅ **履歴一覧画面**: 実装完了（`LossHistoryList.jsx`）
- ✅ **キャンセル機能**: 実装完了（`LossHistoryList.jsx`内で実装、在庫を戻す処理も含む）
- ✅ **データ保存**: 実装完了（Metafield方式、`loss_entries_v1`）
- ✅ **在庫調整**: 実装完了（`inventoryAdjustQuantity` GraphQL mutation）

#### 3. 棚卸機能（POS UI）
- ⏸️ **未実装**: 管理画面は実装済みだが、POS UI側の実装は未着手

---

## ⚠️ 現在の問題点

### 解決済みの問題

#### 問題1: ロス登録商品リスト画面の初期化エラー ✅ **解決完了**（2026-01-27）

**発生状況**:
- コンディション画面から「次へ」を押した瞬間にエラーが発生
- エラーメッセージ: `undefined is not an object (evaluating 'Object.prototype.hasOwnProperty.call(e,t)')`

**発生箇所**:
- スキャンキュー処理の初期化時
- `normalizeScanQueueObj_`、`pushScanToQueue_`、`processScanQueueOnce`関数

**原因の特定（2026-01-27）**:
1. **スキャナー処理の実装場所の違い**:
   - **出庫/入庫**: `Modal.jsx`の`Extension`コンポーネントで、タイルを開いた時点（コンポーネントマウント時）でscanner subscribeを開始
   - **ロス登録**: `LossProductList`コンポーネント内でscanner subscribeを開始（コンポーネントマウント時）
   - **問題**: `LossProductList`がマウントされる前にエラーが発生する可能性がある

2. **実装の違い**:
   - **出庫/入庫**: `Modal.jsx`で`screenRef`を使って現在の画面を追跡し、`OUTBOUND_LIST`または`INBOUND_LIST`の時だけキューに積む
   - **ロス登録**: `LossProductList`内で直接scanner subscribeを開始していた

**修正内容（2026-01-27）**:
1. ✅ **Modal.jsxにscanner subscribeを追加**: 出庫/入庫と同じように、タイルを開いた時点でscanner subscribeを開始
2. ✅ **LossScreenからviewを親に通知**: `onViewChange`コールバックで現在のviewを親コンポーネントに通知
3. ✅ **LossProductList内のscanner subscribeを削除**: 重複を避けるため、Modal.jsxで一元管理
4. ✅ **pushScanToQueue_をModal.jsxに移動**: 出庫/入庫と同じ実装に統一
5. ✅ **normalizeScanQueueObj_を出庫/入庫と同じ実装に修正**: `if (raw && typeof raw === "object")` でnullチェックとobjectチェックを同時に行う

**修正結果**: ✅ 完了（エラー解消確認済み）

---

## 📋 今後のステップ

### Phase 1: ロス登録機能のエラー修正（最優先）✅ 完了

**目標**: ロス登録商品リスト画面の初期化エラーを修正し、機能を完全に動作させる

**作業内容**:
1. ✅ **エラーの根本原因を特定** - 完了（2026-01-27）
   - スキャナー処理の実装場所の違いを特定
   - 出庫/入庫とロス登録の実装の違いを確認

2. ✅ **出庫/入庫の実装と完全に同じ実装にする** - 完了（2026-01-27）
   - ✅ `Modal.jsx`にscanner subscribeを追加（タイルを開いた時点で開始）
   - ✅ `LossScreen`からviewを親に通知する仕組みを追加
   - ✅ `LossProductList`内のscanner subscribeを削除
   - ✅ `pushScanToQueue_`を`Modal.jsx`に移動
   - ✅ `normalizeScanQueueObj_`を出庫/入庫と同じ実装に修正

3. ✅ **テストと検証** - 完了（2026-01-27）
   - ✅ タイルを開いた時点で「scanner subscribe start」トーストが表示されることを確認
   - ✅ コンディション画面から「次へ」を押して、エラーが発生しないことを確認
   - ✅ 商品スキャン機能が正常に動作することを確認
   - ✅ 在庫調整が正常に実行されることを確認

**修正完了日**: 2026年1月27日

---

### Phase 2: 棚卸機能（POS UI）の実装（中優先度）

**目標**: 棚卸機能のPOS UI側を実装し、管理画面で発行した棚卸IDを使って実数を入力できるようにする

**作業内容**:
1. **棚卸ID入力画面の実装**
   - 棚卸IDをスキャンまたは手動入力
   - 棚卸IDが存在し、ステータスが `draft` または `in_progress` であることを確認

2. **商品スキャン・入力画面の実装**
   - 対象商品グループに含まれる商品リストを表示
   - 商品をスキャンまたは手動選択
   - 実数を入力（現在の在庫数を実数に更新）
   - 確定ボタンで在庫調整を実行

3. **棚卸完了処理の実装**
   - 全ての商品の実数入力が完了したら「棚卸完了」ボタンで確定
   - 棚卸IDのステータスを `completed` に更新

4. **POS UIへの統合**
   - `/extensions/stock-transfer-tile/src/Modal.jsx` に棚卸機能を追加
   - メニュー画面に「棚卸」ボタンを追加

**実装ファイル**:
- `/extensions/stock-transfer-tile/src/Modal.jsx` に追加
- 必要に応じて `/extensions/stock-transfer-tile/src/screens/stocktake/` に分離

**予想作業時間**: 4-8時間

---

### Phase 3: 機能の改善と最適化（低優先度）

**目標**: 既存機能の改善と最適化

**作業内容**:
1. **入出庫履歴管理画面の改善**
   - ⏸️ 一括CSV出力機能の実装（一時的に非表示になっている）
   - 大量データへの対応（ページネーションの改善）

2. **ロス登録機能の改善**
   - ⏸️ キャンセル機能の実装（将来的に実装予定）
   - 履歴一覧画面の改善

3. **棚卸機能の改善**
   - 商品グループのネスト機能（必要に応じて）
   - 履歴一覧画面の改善

**予想作業時間**: 8-16時間（機能による）

---

## 📝 実装状況の詳細

### 管理画面の実装状況

| 画面 | ファイル | 実装状況 | 備考 |
|------|---------|---------|------|
| 設定 | `/app/routes/app.settings.tsx` | ✅ 完了 | 拡張設定項目を実装済み |
| 入出庫履歴 | `/app/routes/app.history.tsx` | ✅ 完了 | モーダル表示、CSV出力実装済み |
| ロス登録履歴 | `/app/routes/app.loss.tsx` | ✅ 完了 | フィルター、CSV出力実装済み |
| 棚卸 | `/app/routes/app.inventory-count.tsx` | ✅ 完了 | 商品グループ設定、棚卸ID発行実装済み |
| ナビゲーション | `/app/routes/app.tsx` | ✅ 完了 | 4つのページへのリンクを追加 |

### POS UI機能の実装状況

| 機能 | ファイル | 実装状況 | 備考 |
|------|---------|---------|------|
| 出庫処理 | `/extensions/stock-transfer-tile/src/Modal.jsx` | ✅ 完了 | 既存機能 |
| 入庫処理 | `/extensions/stock-transfer-tile/src/Modal.jsx` | ✅ 完了 | 既存機能 |
| ロス登録（コンディション） | `/extensions/stock-transfer-loss/src/screens/loss/LossConditions.jsx` | ✅ 完了 | 実装済み |
| ロス登録（商品リスト） | `/extensions/stock-transfer-loss/src/screens/loss/LossProductList.jsx` | ✅ 完了 | スキャナー処理をModal.jsxに移動、設定読み込み対応（2026-01-27） |
| ロス登録（コンディション） | `/extensions/stock-transfer-loss/src/screens/loss/LossConditions.jsx` | ✅ 完了 | 自動保存・復元機能実装（2026-01-27） |
| ロス登録（履歴一覧） | `/extensions/stock-transfer-loss/src/screens/loss/LossHistoryList.jsx` | ✅ 完了 | 実装済み |
| 棚卸（POS UI） | - | ❌ 未実装 | 管理画面のみ実装済み |

---

## 🎯 次のアクションアイテム

### 完了したタスク

1. **ロス登録商品リスト画面のエラー修正** - ✅ 完了（2026-01-27）
   - [x] エラーの根本原因を特定
   - [x] 出庫/入庫の実装と完全に同じ実装にする
   - [x] テストと検証（完了）

2. **ロス登録機能の微調整** - ✅ 完了（2026-01-27）
   - [x] モーダルの「キャンセル」を「戻る」に修正
   - [x] ロスコンディション画面の自動保存・復元機能を実装（500msデバウンス）
   - [x] 確定時の下書きクリア機能を確認（既に実装済み）

### 短期（1-2週間以内）

2. **棚卸機能（POS UI）の実装**
   - [ ] 棚卸ID入力画面の実装
   - [ ] 商品スキャン・入力画面の実装
   - [ ] 棚卸完了処理の実装
   - [ ] POS UIへの統合

### 中期（1ヶ月以内）

3. **機能の改善と最適化**
   - [ ] 入出庫履歴管理画面の改善（一括CSV出力）
   - [ ] ロス登録機能の改善（キャンセル機能）
   - [ ] 棚卸機能の改善（商品グループのネスト機能）

---

## 📚 参考情報

### 実装ファイルの場所

- **管理画面**: `/app/routes/`
- **POS UI（出庫・入庫）**: `/extensions/stock-transfer-tile/src/Modal.jsx`
- **POS UI（ロス登録）**: `/extensions/stock-transfer-loss/src/screens/loss/`
- **設定データ**: Shopify Metafield（`currentAppInstallation.metafield`）

### データ保存先

- **設定**: `stock_transfer_pos` / `settings_v1`
- **ロス登録**: `stock_transfer_pos` / `loss_entries_v1`
- **商品グループ**: `stock_transfer_pos` / `product_groups_v1`
- **棚卸ID**: `stock_transfer_pos` / `inventory_counts_v1`

### GraphQL API

- **在庫調整**: `inventoryAdjustQuantity` mutation
- **Transfer取得**: `inventoryTransfers` query
- **Shipment取得**: `inventoryShipment` query
- **商品検索**: `productVariants` query

---

## 💡 注意事項

1. **既存機能への影響**
   - 既存の出庫・入庫機能を壊さないよう注意
   - 設定項目のデフォルト値は既存の動作を維持するように設定

2. **パフォーマンス**
   - 履歴一覧の表示件数に制限を設ける（ページネーション対応）
   - 大量データのCSV出力は非同期処理を検討

3. **エラーハンドリング**
   - 在庫調整時のエラーを適切に処理
   - キャンセル処理時の差分調整を確実に実行

4. **UI/UX**
   - Shopify Polarisデザインガイドラインに準拠
   - POS UI Extensionの制約を遵守
   - タッチ操作に最適化
