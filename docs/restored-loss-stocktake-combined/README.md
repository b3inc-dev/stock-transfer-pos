# ロスと棚卸が一緒だった拡張（復元版）

**復元元コミット**: `f4b0878`（分ける前の最新）  
**復元日**: 2026年2月

---

## このフォルダについて

4分割（ロス専用・棚卸専用に分ける）**前**の、**ロスと棚卸が同じ拡張に入っていたとき**の `stock-transfer-loss` 一式を、Git から復元したコピーです。

参照用に置いてあります。現在の `extensions/stock-transfer-loss`（ロスのみ）や `extensions/stock-transfer-stocktake`（棚卸のみ）はそのままです。

---

## 中身

- **extensions/stock-transfer-loss/** … 当時の拡張一式
  - `src/Modal.jsx` … ロスと棚卸の両方を持つモーダル（LossScreen と StocktakeScreen を切り替え）
  - `src/screens/LossScreen.jsx` … ロス用
  - `src/screens/StocktakeScreen.jsx` … 棚卸用
  - `src/screens/loss/` … ロス専用（LossConditions, LossProductList, LossHistoryList 等）
  - `src/screens/stocktake/` … 棚卸専用（InventoryCountConditions, InventoryCountList 等）

---

## 元に戻したい場合

この復元版を「今の loss 拡張」に反映したい場合は、次のようにコピーできます（上書きになるので注意）。

```bash
# 例: 復元版で現在の loss 拡張を上書きする場合（必要ならバックアップを取ってから）
cp -R docs/restored-loss-stocktake-combined/extensions/stock-transfer-loss/* extensions/stock-transfer-loss/
```

通常は参照用としてこのフォルダのままにしておき、必要なファイルだけコピーする使い方で十分です。
