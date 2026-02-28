# 棚卸ID（countName）が空白で上書きされないための監査メモ

**日付**: 2026-02  
**目的**: 画面表示・読み込み・確定処理時に countName が空白で上書きされる要因をなくす。

---

## 1. 書き込み（write）経路

| 呼び出し元 | 渡すデータ | 対策 |
|------------|------------|------|
| `writeInventoryCounts(merged)`（InventoryCountList：確定後バックグラウンド） | `readInventoryCountsRaw()` の list + toWrite | **ensureCountNamesBeforeWrite** を writeInventoryCounts 内で実行。欠けている件にのみ番号を付与し、既存の countName は変更しない。 |
| `writeInventoryCounts(updated)`（InventoryCountList / InventoryCountProductGroupSelection：status を in_progress に） | `readInventoryCounts()` の allCounts を map で 1 件だけ更新 | readInventoryCounts() は countName を付与して返すため、updated に countName が含まれる。さらに ensureCountNamesBeforeWrite で二重に保護。 |
| `writeInventoryCounts(parsed)`（readInventoryCountsFirstPage：チャンク未存在時） | メタフィールドの parsed 配列 | ensureCountNamesBeforeWrite で補完。 |
| `writeInventoryCounts(countsWithName)`（readInventoryCounts） | 自前で countName を付与した配列 | もともと countName 付き。ensureCountNamesBeforeWrite は既存を変更しない。 |

**結論**: すべての write は **writeInventoryCounts** を経由し、その先頭で **ensureCountNamesBeforeWrite** が必ず実行されるため、空白で上書きされる書き込み経路はなし。

---

## 2. 表示・読み込み（read / setState）経路

| 箇所 | データの出どころ | countName の扱い |
|------|------------------|------------------|
| **InventoryCountConditions** refresh | readInventoryCountsFirstPage の result.counts | list 経路: チャンクは toMinimalCountForList で書き込まれたデータ（countName あり）。fixCountsStatusOnly は `...c` で countName を維持。 |
| **InventoryCountConditions** loadMore | readInventoryCountsPage の counts | 上記と同様。list 経路は toMinimalCountForList 由来。フルチャンク経路は parseChunkAndMergeParts → countMeta に countName が含まれる。 |
| **InventoryCountConditions** バックグラウンド詳細マージ | readInventoryCountById(full) | **full.countName** をマージ対象に含めるよう修正済み。一覧行に countName が無くても詳細取得で補完。 |
| **InventoryCountProductGroupSelection** effectiveCount | readInventoryCountById(fetched) | mergeCountParts で countMeta を展開するため countName が含まれる。 |
| **toMinimalCount**（Conditions） | 一覧の c | `countName: c.countName` を付与。 |
| **toMinimalCountForList**（stocktakeApi） | 書き込み用の c | `countName: c.countName` を付与。list チャンクはこれで保存。 |
| **fixCountsStatusOnly** | 各 count c | 戻りは `c` または `{ ...c, status, completedAt }` のみ。countName は維持。 |
| **buildUpdatedCountFromLocalState** | count をスプレッド | `return { ...count, groupItems, status, completedAt, items }` のため countName は維持。 |
| **mergeCountWithStorage** | fromStorage + locallyBuilt | `...fromStorage, ...locallyBuilt`。locallyBuilt は buildUpdatedCountFromLocalState の戻り（count 由来）のため countName あり。 |

**結論**: 表示・読み込み経路では、list チャンク・フルチャンク・readInventoryCountById のいずれも countName を保持するか、バックグラウンドマージで full.countName を反映しており、表示で空白に上書きされる経路はなし。

---

## 3. ナビゲーション・setCount（ストレージを書かない）

| 箇所 | 内容 |
|------|------|
| StocktakeScreen setCount(updatedCount) | buildUpdatedCountFromLocalState の戻り（countName あり）。 |
| StocktakeScreen setCount(c) | toMinimalCount(c) の戻り（countName あり）。 |
| StocktakeScreen setCount(null) | 戻る操作で現在の count をクリアするだけ。write は呼ばない。 |

---

## 4. 単一の防御ポイント

- **writeInventoryCounts** の先頭で **ensureCountNamesBeforeWrite(counts)** を必ず実行すること。
- 呼び出し元が readInventoryCountsRaw のみで list を組み立てて渡しても、書き込み前に欠けている countName が補完され、他件が空白で上書きされない。
