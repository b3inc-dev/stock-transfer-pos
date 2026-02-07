# 棚卸 vs 入庫：検索リストからの商品追加の差分

入庫を正（参照実装）とし、棚卸を同じコード処理に揃えるための差分まとめ。

## 1. 入庫（正）の処理フロー

### 1.1 追加関数のシグネチャ
- **addOrIncrementByResolved(resolved, delta = 1, opts = {})**
  - `resolved`: `{ variantId, inventoryItemId, productTitle, variantTitle, sku, barcode, imageUrl }`（検索候補から組み立てたオブジェクト）
  - `delta`: 加算する数量（既存行は +delta、新規は receiveQty: delta）
  - **同期的**（ref で既存チェック → 即時 setRows/setExtras）

### 1.2 既存チェック
- **rowsRef.current** / **extrasRef.current** で最新の行リストを参照
- 既存判定: `String(r.inventoryItemId || "") === String(inventoryItemId)`
- 既存なら **incRow_** / **incExtra_** で数量加算のみ
- 新規なら **setExtras** で 1 件追加（在庫取得は行わない）

### 1.3 候補行（InboundCandidateRow）
- 候補 `c` から **resolved** を組み立て（variantId, inventoryItemId, productTitle, variantTitle, sku, barcode, imageUrl）
- **addOrIncrementByResolved(resolved, next, { toastOnExtra: true })** を呼ぶ
- **addQtyById** / **setAddQtyById** で「候補ごとの追加済み数量」を表示・更新
  - addOne: `setAddQtyById(prev => ({ ...prev, [vid]: cur + 1 }))`
  - commitAddByQty: `setAddQtyById(prev => ({ ...prev, [vid]: cur + next }))`
- 検索クリア時は **clearAddSearch_** 内で **setAddQtyById({})**

### 1.4 検索クリア
- 追加後は検索欄・候補はそのまま（クリアしない）
- ユーザーが検索欄の × で **clearAddSearch_** を呼んだときのみ候補と addQtyById をクリア

---

## 2. 棚卸（修正前）の差分

| 項目 | 入庫（正） | 棚卸（修正前） |
|------|------------|----------------|
| 追加関数の引数 | (resolved, delta, opts) | (c, quantityToAdd) で生の候補 `c` を渡している |
| 既存チェック | rowsRef / extrasRef で同期的に参照 | setLines(prev => ...) 内で prev を参照（非同期のため ref なし） |
| 新規追加時 | 在庫取得なし（入庫数だけ） | getCurrentQuantity を await してから追加（非同期） |
| 候補行 | resolved を組み立てて渡す | 候補 `c` をそのまま渡す |
| 追加済み数量表示 | addQtyById / setAddQtyById | 候補行内のローカル state (shownQty) のみ |
| 追加後の検索 | クリアしない | setQuery(""), setCandidates([]) でクリアしている |

---

## 3. 棚卸の修正方針（入庫に揃える）

1. **linesRef** を追加し、`lines` と同期させる（既存チェックを同期で行うため）。
2. **addLine(resolved, delta)** に変更
   - 第1引数は入庫と同じ **resolved** オブジェクト
   - 既存は **linesRef.current** で文字列比較 → 既存なら setLines で加算のみ（getCurrentQuantity は呼ばない）
   - 新規のみ **getCurrentQuantity** を await してから setLines で新行追加
3. **addQtyById** / **setAddQtyById** を state で持ち、候補行に渡す。
4. **InventoryCountCandidateRow** で
   - 候補 `c` から **resolved** を組み立て（入庫と同じ形）
   - **addLine(resolved, 1)** / **addLine(resolved, next)** を呼ぶ
   - **addQtyById[vid]** を表示し、addOne / commitAddByQty で **setAddQtyById** を更新
5. 追加後に **setQuery / setCandidates は呼ばない**（入庫と同様、検索はそのまま残す）。
6. 検索クリア時（query が空になったときなど）に **setAddQtyById({})** を実行する処理を追加可能（入庫の clearAddSearch_ に合わせる）。

---

## 4. 修正後の棚卸（入庫と同一のコード処理）

- **addLine(resolved, delta)**：第1引数は入庫と同じ **resolved**（variantId, inventoryItemId, productTitle, variantTitle, sku, barcode, imageUrl）。第2引数は加算数量（既定 1）。
- **linesRef**：`lines` と同期し、既存チェックは **linesRef.current** で同期的に実施。
- **既存**：`linesRef.current` で文字列比較 → 既存なら setLines で数量加算のみ（getCurrentQuantity は呼ばない）。
- **新規**：getCurrentQuantity を await してから setLines で新行追加。
- **InventoryCountCandidateRow**：候補 `c` から **resolved** を組み立て、**addLine(resolved, 1)** / **addLine(resolved, next)** を呼ぶ。**addQtyById** / **setAddQtyById** で表示・更新。
- **検索クリア**：query が空のときに **setAddQtyById({})** を実行（検索 effect 内）。
- **追加後**：setQuery / setCandidates は呼ばない（入庫と同様）。
- **スキャン**：resolveVariantByCode で **resolved** を組み立て、**addLine(resolved, 1)** を呼ぶ（検索追加と同一経路）。
