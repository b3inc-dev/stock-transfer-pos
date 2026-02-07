# 進捗と今後の流れ

`REQUIREMENTS_FINAL.md` を基準に、**現在の実装状況**と**この後の進め方**を整理したドキュメントです。

---

## 📊 現在の進捗サマリー（更新: 2025-01）

| 項目 | 状態 | 備考 |
|------|------|------|
| **Phase 1** 管理画面の設定拡張 | ✅ 完了 | 表示ロケーション・配送・許可設定・表示件数（初期） |
| **Phase 2** 入出庫履歴管理画面 | ✅ ほぼ完了 | 一括CSV のみ調整中（一時非表示） |
| **Phase 3** ロス登録 | ✅ 完了 | 管理画面 + POS 別拡張で実装済み |
| **Phase 4** 棚卸 | 🟡 一部 | POS は準備中プレースホルダー。管理画面は仮ページ |
| **64KB 制限対策** | ✅ 対応済み | ロス・棚卸を別拡張 `stock-transfer-loss` に分離 |

---

## 1. 管理画面の構成

### 1.1 ナビゲーション（`app.tsx`）

- ✅ 設定 → `/app`
- ✅ 入出庫履歴 → `/app/history`
- ✅ ロス登録履歴 → `/app/loss`
- ✅ 棚卸 → `/app/inventory-count`

### 1.2 設定画面（`/app`）`app.settings.tsx`

- ✅ 店舗グループ・配送会社・表示ロケーション
- ✅ 強制キャンセル・過剰入庫・予定外入庫の許可
- ✅ **表示件数（初期）**: 出庫履歴 / 入庫 / 商品リスト / 検索リスト（最大・推奨は API 準拠）

### 1.3 入出庫履歴（`/app/history`）

- ✅ 一覧・フィルター・ページネーション・モーダル・個別CSV・予定外入庫表示
- ⏸️ 一括CSV: 調整中（一時非表示）

### 1.4 ロス登録履歴（`/app/loss`）

- ✅ **実装済み**: 履歴一覧・ロケーション/ステータスフィルター・CSV（一覧/明細）
- データ: `currentAppInstallation` metafield `loss_entries_v1`

### 1.5 棚卸（`/app/inventory-count`）

- ✅ 仮ページあり（準備中メッセージ）
- ❌ 商品グループ・棚卸ID発行・履歴は未実装

---

## 2. POS UI 拡張（2つに分離）

### 2.1 `stock-transfer-tile`（在庫処理・出庫/入庫）

- **Tile**: 「在庫処理」／「出庫 / 入庫」
- **Modal**: メニュー → **出庫（移管）**・**入庫（受領）** のみ
- ロス・棚卸は**含めない**（64KB 対策のため別拡張へ分離）
- ✅ `screens` フォルダ削除済み。Loss/Stocktake 関連コードはすべて除去

### 2.2 `stock-transfer-loss`（ロス・棚卸）※新規

- **Tile**: 「ロス・棚卸」／「ロス登録 / 棚卸」
- **Modal**: メニュー → **ロス登録** / **棚卸（準備中）**
- **ロス登録**: コンディション（ロケーション・日付・担当者・理由）→ 商品リスト → 確定で在庫マイナス調整 → ロス登録リスト（フィルター・詳細・キャンセル）
- **棚卸**: 準備中プレースホルダーのみ
- データ: 同上 `loss_entries_v1`。`screens/loss/*` に実装

---

## 3. 実施済み作業の時系列

1. **404 解消**: `app.loss`・`app.inventory-count` 仮ページ作成
2. **表示件数（初期）**: 設定に追加。最大・推奨は API 実態に合わせて出庫250/100、入庫250/100、商品250、検索50
3. **商品/検索分離**: 商品リストと検索リストを別設定に変更
4. **ロス登録本実装**:
   - POS: `LossScreen` ＋ `loss/`（Conditions, ProductList, HistoryList, lossApi）
   - 管理: `app.loss` で履歴・フィルター・CSV
5. **64KB 超過対応**:
   - dynamic import は効果なし（単一バンドルのまま）
   - **ロス・棚卸を別拡張 `stock-transfer-loss` に分離**
   - `stock-transfer-tile` から Loss/Stocktake・`screens` を削除し、出庫/入庫専用に縮小

---

## 4. この後の流れ

1. **動作確認**
   - `npm install` を実行し、`extensions/*` の依存を解消
   - `shopify app dev` で **両拡張** がビルドされることを確認
   - POS で **在庫処理** タイル → 出庫/入庫、**ロス・棚卸** タイル → ロス登録/棚卸（準備中）が動くか確認
   - 管理画面の **ロス登録履歴** で一覧・フィルター・CSV が使えるか確認

2. **棚卸の本実装**（未着手）
   - 管理: 商品グループ・棚卸ID発行・履歴（`app.inventory-count`）
   - POS: `stock-transfer-loss` の棚卸フロー（ID 入力 → 商品スキャン・実数入力 → 完了）
   - 必要なら `stock-transfer-loss` が 64KB を超えないか確認

3. **その他**
   - 入出庫の一括CSV 仕様が決まり次第、再実装
   - 必要に応じて README 等のドキュメント更新

---

## 5. 主要ファイル一覧

| 役割 | パス |
|------|------|
| 設定（TOP） | `app/routes/app.settings.tsx` |
| 入出庫履歴 | `app/routes/app.history.tsx` |
| ロス登録履歴 | `app/routes/app.loss.tsx` |
| 棚卸（仮） | `app/routes/app.inventory-count.tsx` |
| POS 出庫/入庫 | `extensions/stock-transfer-tile/` |
| POS ロス・棚卸 | `extensions/stock-transfer-loss/` |

---

**更新日**: 2025-01  
**元ドキュメント**: `REQUIREMENTS_FINAL.md`
