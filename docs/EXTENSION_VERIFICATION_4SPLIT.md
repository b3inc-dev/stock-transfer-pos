# 4拡張分割 要件照合・検証結果

各拡張が「単一機能のみ」かつ「要件どおり漏れなく実装されているか」を確認した結果です。

---

## 1. stock-transfer-tile（出庫のみ / ModalOutbound.jsx）

### 要件
- **出庫のみ**：メニュー → 出庫コンディション → 出庫リスト、出庫履歴条件 → 履歴詳細 → 編集
- 確定・下書き保存・配送準備完了（OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md に準拠）

### 検証結果
| 項目 | 状態 |
|------|------|
| エントリ | `shopify.extension.toml` → `pos.home.modal.render` = `./src/ModalOutbound.jsx` ✅ |
| メニュー | `MenuScreen` は「メニュー（出庫）」＋「出庫」ボタンのみ（入庫ボタンなし）✅ |
| 画面 | `SCREENS.MENU` / `OUTBOUND_COND` / `OUTBOUND_HIST_COND` / `OUTBOUND_LIST` / `OUTBOUND_HIST_DETAIL` のみ ✅ |
| 入庫画面 | なし（`INBOUND_COND` / `INBOUND_LIST` 等への遷移・表示なし）✅ |
| スキャナー | 出庫コンディションで配送番号自動入力、出庫リストでキュー積みのみ（**入庫リスト分岐は削除済み**）✅ |

### 実施した修正
- **死コード削除**: スキャナー購読内の `if (sc === SCREENS.INBOUND_LIST)` 分岐を削除（本拡張では INBOUND_LIST に遷移しないため不要）

### 補足
- `buildInboundNoteLine_` や `inboundDraftKey` 等の「inbound」名のヘルパーは、**出庫履歴詳細で「入庫済み／予定外入庫」等を表示するため**に使用しており、入庫機能のUIではない。出庫のみ要件に対して問題なし。

---

## 2. stock-transfer-inbound（入庫のみ / Modal.jsx）

### 要件
- **入庫のみ**：入庫コンディション → シップメント選択 or 入庫リスト

### 検証結果
| 項目 | 状態 |
|------|------|
| エントリ | `shopify.extension.toml` → `pos.home.modal.render` = `./src/Modal.jsx` ✅ |
| 画面 | `SCREENS.INBOUND_COND` / `INBOUND_SHIPMENT_SELECTION` / `INBOUND_LIST` のみ ✅ |
| 出庫画面 | なし（OutboundConditions / OutboundList 等の参照なし）✅ |
| ページ見出し | 「入庫」✅ |

### 実施した修正
- 特になし（既に入庫専用構成）

### 補足
- 「出庫元」は Transfer の「origin」表示用ラベルであり、出庫機能のUIではない。

---

## 3. stock-transfer-loss（ロスのみ）

### 要件
- **ロスのみ**：コンディション → 商品リスト → 確定、履歴

### 検証結果
| 項目 | 状態 |
|------|------|
| エントリ | `shopify.extension.toml` → `pos.home.modal.render` = `./src/Modal.jsx` ✅ |
| 表示 | `Modal.jsx` は `LossScreen` のみレンダー（heading="ロス"）✅ |
| 棚卸画面 | なし（StocktakeScreen の参照・表示なし）✅ |

### 実施した修正
- **未使用コード削除**: 本拡張では使わない棚卸用ファイルを削除  
  - `src/screens/StocktakeScreen.jsx` 削除  
  - `src/screens/stocktake/` 一式削除（`InventoryCountConditions.jsx`, `InventoryCountList.jsx`, `InventoryCountProductGroupSelection.jsx`, `stocktakeApi.js`）

### ビルド
- `esbuild src/Modal.jsx --bundle` でビルド成功を確認済み。

---

## 4. stock-transfer-stocktake（棚卸のみ）

### 要件
- **棚卸のみ**：コンディション → 商品グループ選択 → 商品リスト → 確定

### 検証結果
| 項目 | 状態 |
|------|------|
| エントリ | `shopify.extension.toml` → `pos.home.modal.render` = `./src/Modal.jsx` ✅ |
| 表示 | `Modal.jsx` は `StocktakeScreen` のみレンダー（heading="棚卸"）✅ |
| ロス画面 | なし（LossScreen の参照・表示なし）✅ |

### 実施した修正
- **ロス拡張への依存解消**: 棚卸拡張内に「ロス専用」パス（`../loss/`）を参照していたため、以下で自立化。  
  1. **共通UI**  
     - `src/screens/common/FixedFooterNavBar.jsx` を新規作成（ロス拡張の FixedFooterNavBar と同構成）  
  2. **API**  
     - `stocktakeApi.js` に `fetchSettings()` を追加（AppInstallation metafield 取得、ロス拡張と同仕様）  
  3. **import 変更**  
     - `InventoryCountConditions.jsx`: `../loss/FixedFooterNavBar.jsx` → `../common/FixedFooterNavBar.jsx`  
     - `InventoryCountList.jsx`: `../loss/lossApi.js` の `fetchSettings` → `./stocktakeApi.js`、`FixedFooterNavBar` → `../common/FixedFooterNavBar.jsx`  
     - `InventoryCountProductGroupSelection.jsx`: `../loss/FixedFooterNavBar.jsx` → `../common/FixedFooterNavBar.jsx`

### ビルド
- `esbuild src/Modal.jsx --bundle` でビルド成功を確認済み。

---

## まとめ

| 拡張 | 役割 | 他機能混入 | 漏れ | 対応内容 |
|------|------|------------|------|----------|
| stock-transfer-tile | 出庫のみ | なし | なし | 入庫リスト用スキャナー分岐を削除 |
| stock-transfer-inbound | 入庫のみ | なし | なし | なし |
| stock-transfer-loss | ロスのみ | なし | なし | 棚卸用ファイルを削除 |
| stock-transfer-stocktake | 棚卸のみ | なし | なし | loss 依存を解消（common + fetchSettings） |

4拡張とも「単一機能のみ」で、要件に対する漏れはありません。必要に応じて `shopify app dev` で動作確認してください。
