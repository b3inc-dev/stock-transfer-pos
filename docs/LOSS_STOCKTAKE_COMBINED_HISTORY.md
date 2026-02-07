# ロスと棚卸が一緒だった拡張の履歴

**目的**: 昔、ロスと棚卸が同じ拡張（同じファイル群）で実装されていたときの履歴を参照するため。

---

## 1. いつ「一緒」だったか

- **コミット**: `6f49493`  
  **日付**: 2026年1月31日  
  **メッセージ**: 「管理画面メニュー: s-app-nav(設定・入出庫履歴・ロス・棚卸)、shopify-app-react-router 1.0、docs追加」

このコミットで **stock-transfer-loss** 拡張が追加されたとき、**ロス用**と**棚卸用**の両方の画面が同じ拡張に入っていました。

---

## 2. 当時の stock-transfer-loss の構成（6f49493）

| パス | 内容 |
|------|------|
| `src/Modal.jsx` | **ロスと棚卸の両方**を扱うモーダル。`LossScreen` と `StocktakeScreen` を import し、メニューで切り替え。 |
| `src/screens/LossScreen.jsx` | ロス用の画面ルーター。 |
| `src/screens/StocktakeScreen.jsx` | 棚卸用の画面ルーター。 |
| `src/screens/loss/` | ロス専用（LossConditions, LossProductList, LossHistoryList, lossApi, FixedFooterNavBar）。 |
| `src/screens/stocktake/` | 棚卸専用（InventoryCountConditions, InventoryCountList, InventoryCountProductGroupSelection, stocktakeApi.js）。 |

つまり「ロスと棚卸が一緒になったファイル」は、このときの **`extensions/stock-transfer-loss/`** 一式です。

---

## 3. 昔の内容を今見る方法（Git）

ターミナルでリポジトリのルートにいる状態で、次のようにすると **6f49493 時点**の内容を確認できます。

```bash
# ロス＋棚卸が一緒だったときの Modal.jsx の中身を表示
git show 6f49493:extensions/stock-transfer-loss/src/Modal.jsx

# 棚卸用画面ルーター
git show 6f49493:extensions/stock-transfer-loss/src/screens/StocktakeScreen.jsx

# 棚卸コンディション画面
git show 6f49493:extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountConditions.jsx
```

特定ファイルを一時的に復元して比較したい場合の例です。

```bash
# 6f49493 時点の Modal.jsx を一時ファイルとして保存
git show 6f49493:extensions/stock-transfer-loss/src/Modal.jsx > /tmp/Modal_loss_stocktake_6f49493.jsx
```

---

## 4. その後どうなったか（4分割）

- **要件**: POS拡張を「出庫・入庫・ロス・棚卸」の **4拡張に分割**（REQUIREMENTS_FINAL.md、EXTENSION_VERIFICATION_4SPLIT.md）。
- **stock-transfer-loss**: **ロスのみ**にし、棚卸用の以下を削除。  
  - `src/screens/StocktakeScreen.jsx`  
  - `src/screens/stocktake/` 一式
- **stock-transfer-stocktake**: 棚卸専用の**新規拡張**として作成。  
  - 上記で削除した棚卸用コードを **stock-transfer-stocktake** 側にコピーし、そこで利用。

そのため、**現在の stock-transfer-loss** には `StocktakeScreen.jsx` も `screens/stocktake/` もありません。  
「昔のロス＋棚卸が一緒の実装」は **Git の 6f49493 に残っている履歴**として参照できます。

---

## 5. 関連ドキュメント

| ドキュメント | 内容 |
|--------------|------|
| **REQUIREMENTS_FINAL.md** | 4分割の説明（stock-transfer-loss＝ロスのみ・棚卸関連ファイル削除）。 |
| **docs/EXTENSION_VERIFICATION_4SPLIT.md** | 4分割後の検証。ロス拡張から棚卸用ファイルを削除したことの記載。 |
| **docs/STOCKTAKE_LOSS_TO_STOCKTAKE_MIGRATION_VERIFICATION.md** | 4分割前の loss にあった棚卸（`screens/stocktake/` 等）を stocktake 拡張へ移行した際の照合結果。 |
| **docs/FAITHFUL_REPRODUCTION_TODO.md** | 分割前は stock-transfer-loss 内に StocktakeScreen と `screens/stocktake/` があった、という参照先の説明。 |

---

## 6. まとめ

- **ロスと棚卸が一緒だった実装の履歴**: **Git のコミット `6f49493`** に残っています。
- **当時の「一緒のファイル」**: `extensions/stock-transfer-loss/` 一式（とくに `src/Modal.jsx` がロス・棚卸の両方を持つ入口）。
- **中身を確認する**: `git show 6f49493:extensions/stock-transfer-loss/src/Modal.jsx` などで参照可能です。
