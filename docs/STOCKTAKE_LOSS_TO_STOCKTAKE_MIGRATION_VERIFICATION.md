# 棚卸：4分割前の loss から stocktake 拡張への移行漏れ徹底確認

**参照元（4分割前）**: `extensions/stock-transfer-loss/src/screens/stocktake/` および `StocktakeScreen.jsx`  
**比較先**: `extensions/stock-transfer-pos/extensions/stock-transfer-stocktake/src/screens/stocktake/` および `StocktakeScreen.jsx`

**確認日**: 全ファイルの行数・バイト比較および diff により実施。

---

## 1. 構成の対応関係

| ファイル | loss（行数） | stocktake（行数） | 内容一致 |
|----------|-------------|-------------------|----------|
| **InventoryCountConditions.jsx** | 593 | 601 | **差分あり**（後述） |
| **InventoryCountList.jsx** | 2712 | 2712 | **完全同一**（cmp で IDENTICAL） |
| **InventoryCountProductGroupSelection.jsx** | 292 | 292 | **完全同一**（cmp で IDENTICAL） |
| **stocktakeApi.js** | 946 | 947 | **差分あり**（後述） |
| **StocktakeScreen.jsx** | 202 | 202 | **完全同一**（cmp で IDENTICAL） |

- loss の **Modal.jsx** は「ロス」専用で **StocktakeScreen を一切参照していない**（`LossScreen` のみ表示）。
- 棚卸は **stocktake 拡張の Tile → Modal → StocktakeScreen** のみで利用され、loss 拡張の Modal からは呼ばれない。
- したがって「移行」は **loss リポジトリ内の `screens/stocktake/` を stocktake 拡張へコピーしたもの** として扱い、そのコピー漏れ・ロジック欠落がないかを確認した。

---

## 2. 完全同一であるファイル（移行漏れなし）

以下の 3 ファイルは **バイト単位で一致**（`cmp` で IDENTICAL）しており、**1 行も漏れていない**。

1. **InventoryCountList.jsx**（2712 行）  
   - 棚卸リスト・商品カウント・スキャン・検索・下書き・確定・在庫調整・確定モーダルまで全て同一。
2. **InventoryCountProductGroupSelection.jsx**（292 行）  
   - 商品グループ選択・グループ単位の在庫数表示・次へ遷移まで同一。
3. **StocktakeScreen.jsx**（202 行）  
   - コンディション → 商品グループ選択 → リストの画面遷移と `onViewChange` 連携まで同一。

---

## 3. 差分があるファイル（移行漏れではなく stocktake 側の改善）

### 3.1 InventoryCountConditions.jsx

| 箇所 | loss（4分割前） | stocktake（移行先） | 評価 |
|------|------------------|----------------------|------|
| **loadNames 内の locationGid 処理** | `if (locationGid) {` でロケーション名取得 | `if (locationGid && !locMap.has(locationGid)) {` で取得 | stocktake 側が重複取得を避ける改善。ロジックの欠落なし。 |
| **filtered の初期化** | `let filtered = allCounts;` | `let filtered = Array.isArray(allCounts) ? allCounts : [];` | stocktake 側が null/undefined 対策で安全。欠落なし。 |
| **コメント** | 「✅ 降順にソート（作成日時の新しい順）」 | 同コメントなし（ソート処理は同じ） | コメントの有無のみ。処理は同一。 |
| **Footer leftLabel** | `leftLabel="戻る"` | `leftLabel="閉じる"` | 文言差のみ。閉じるボタン課題は全拡張共通。 |
| **空リスト時のメッセージ** | 「表示できる棚卸IDがありません」のみ | viewMode に応じ「未完了の棚卸はありません」「完了済みの棚卸はありません」等を出し分け | stocktake 側が UX 改善。欠落なし。 |
| **locationName のフォールバック** | `locationGid ? ... : "全ロケーション"` | `locationGid ? ... : "ロケーション取得中..."` | 文言差。取得前の状態を明示する改善。 |

いずれも **loss にしかない処理が stocktake にない** という移行漏れはなく、stocktake 側の **文言・安全性・UX の改善** のみ。

### 3.2 stocktakeApi.js

| 箇所 | loss（4分割前） | stocktake（移行先） | 評価 |
|------|------------------|----------------------|------|
| **toLocationGid のコメント** | 「locationIdをGID形式に変換（ロスと同じ処理）」 | 「ロケーションIDをGID形式に正規化（フィルタ・店舗名取得で共通利用）」 | コメントのみ。関数の役割は同じ。 |
| **getLocationName** | `const loc = locations.find((l) => l.id === locationId);` | `const gid = toLocationGid(locationId);` の後、`locations.find((l) => l.id === gid \|\| l.id === locationId)` | stocktake 側が **GID／数値 ID 両方** に対応。ロケーション名取得の欠落・後退なし。 |

こちらも **移行漏れはなく**、stocktake 側の **ロケーション ID の扱いの強化** のみ。

---

## 4. stocktakeApi.js の export 一覧（両拡張で一致）

両方とも以下の 14 個の export があり、**名前・役割とも一致**（行番号のみ 1 行差あり）。

- searchVariants  
- readInventoryCounts  
- writeInventoryCounts  
- readProductGroups  
- fetchProductsByGroup  
- fetchProductsByGroups  
- getCurrentQuantity  
- toLocationGid  
- toLocationNumericId  
- adjustInventoryToActual  
- fetchLocations  
- getLocationName  
- getProductGroupName  
- resolveVariantByCode  

**移行漏れの export はなし。**

---

## 5. loss 側で棚卸が参照されている場所

- **Modal.jsx**  
  - 棚卸・StocktakeScreen・InventoryCount 系の参照は **一切なし**（ロス用の LossScreen のみ）。
- **screens/stocktake/** および **StocktakeScreen.jsx**  
  - 上記の 5 ファイルのみが棚卸処理。これらはすべて stocktake 拡張に存在し、うち 3 ファイルは完全同一、2 ファイルは上記のとおり stocktake 側が同等以上。

よって、**loss 側にだけあって stocktake に「ない」棚卸処理は存在しない**。

---

## 6. 結論：移行漏れの有無

| 確認項目 | 結果 |
|----------|------|
| 棚卸処理のコードが stocktake に存在するか | ✅ すべて存在（5 ファイルとも）。 |
| 行・バイトレベルで完全一致しているファイル | ✅ 3 ファイルが完全同一（List / ProductGroupSelection / StocktakeScreen）。 |
| 差分のある 2 ファイルに移行漏れがあるか | ✅ なし。stocktake 側のコメント・文言・安全性・getLocationName の GID 対応の改善のみ。 |
| loss の Modal から棚卸が呼ばれているか | ✅ 呼ばれていない（ロス専用）。棚卸は stocktake 拡張の Tile → Modal → StocktakeScreen のみ。 |
| stocktakeApi の export の欠落 | ✅ なし。14 個とも両拡張で一致。 |

**4分割前の loss に含まれていた棚卸処理は、stocktake 拡張に漏れなく移行できている。**  
差分は「文言・コメント・null 安全・ロケーション ID の扱い」などの改善のみで、**処理の欠落や後退はない。**
