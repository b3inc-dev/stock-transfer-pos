# 棚卸：完了ステータス・未確定下書きの上書きリスク確認

**目的**: 読み込み・確定処理・画面遷移において、完了ステータスや他グループの groupItems、未確定の自動保存（下書き）が意図せず上書きされないかを徹底確認した結果を記録する。

**確認日**: 2026-02-28

---

## 1. writeInventoryCounts を呼んでいる箇所（すべて確認済み）

| 箇所 | 内容 | リスク | 対策状況 |
|------|------|--------|----------|
| **InventoryCountList.jsx** | 確定処理 4 経路（差異あり/なし・まとめて/単一） | ローカル組み立てで他グループの groupItems が欠けた count をそのまま write すると他グループのステータスが消える | ✅ 全経路で `mergeCountWithStorage(fromStorage, locallyBuilt)` を適用済み（ストレージをベースにマージしてから write） |
| **InventoryCountList.jsx** L480-487 | draft ステータス→in_progress に更新（readInventoryCountById 取得後） | `updated = allCounts.map(c => c.id === idStr ? { ...c, status: "in_progress" } : c)` で **c をそのまま spread** しているため groupItems は保持される | ✅ 問題なし |
| **InventoryCountProductGroupSelection.jsx** L68-74 | 同上（draft→in_progress） | 同上 | ✅ 問題なし |
| **stocktakeApi.js** readInventoryCounts() L744-747 | countName 付与・ステータス補正（in_progress→completed）時のみ write | `countsWithName` は read した counts をベースに status/countName だけ追加。groupItems は触らない | ✅ 問題なし |
| **stocktakeApi.js** L452-453 | チャンク未使用時の初回マイグレーション | `parsed` はメインキーから読んだ全件。全件をそのまま write | ✅ 問題なし |

---

## 2. 読み込み・一覧更新（ストレージは上書きしない）

| 箇所 | 内容 | リスク | 備考 |
|------|------|--------|------|
| **InventoryCountConditions.jsx** | refresh / loadMore / バックグラウンド詳細取得 | `setCounts(...)` は **ローカル state のみ**。writeInventoryCounts は呼ばない | ✅ 一覧表示の更新のみ。失敗時も setCounts([]) しない方針済み |
| **InventoryCountConditions.jsx** L321-332 | readInventoryCountById で取得した full を一覧の行にマージ | `setCounts(prev => prev.map(x => x.id === idStr ? { ...x, groupItems: full.groupItems, ... } : x))`。**ストレージには書かない** | ✅ 表示用 state の更新のみ |
| **stocktakeApi.js** fixCountsStatusOnly | 読み取り時のステータス補正（表示用）。completed は上書きしない | 返り値は表示・後続の read 用。fixCountsStatusOnly 内で write はしない | ✅ 既存コメントの通り「確定済みは未処理に戻さない」 |

---

## 3. 下書き（draft）の保存・復元

| 内容 | リスク | 備考 |
|------|--------|------|
| **下書きの保存** | InventoryCountList の useEffect で `SHOPIFY.storage.set(INVENTORY_COUNT_DRAFT_*, payload)` のみ。**writeInventoryCounts は呼ばない** | ✅ 下書きは別キーにのみ保存。本番の棚卸メタフィールドは触らない |
| **下書きの復元** | loadProducts 内でストレージから読んで `setLines(...)` するだけ。**writeInventoryCounts は呼ばない** | ✅ 復元は画面表示のみ |
| **完了/キャンセル済み** | 完了・キャンセル済みの棚卸は下書きを復元しない・API の groupItems を優先するロジックあり | ✅ 既存実装で保護済み |
| **確定後の下書き削除** | clearAllInventoryCountDraftsForCount で draft キーのみ delete。本番メタは触らない | ✅ 問題なし |

---

## 4. 画面遷移と「親の count」の受け渡し

| 遷移 | 以前のリスク | 対策 |
|------|--------------|------|
| **コンディション一覧 → 商品グループ選択** | 一覧の count は list 用で軽量（groupItems 欠けている場合あり）のまま親に保持される | 商品グループ選択側で readInventoryCountById により fullCount を取得。**今回、商品グループ選択→商品リストへ進むときに `params.count`（= effectiveCount = fullCount）を親で setCount するよう変更済み**（StocktakeScreen.jsx）。これで商品リストには fullCount が渡り、確定時の buildUpdatedCountFromLocalState が他グループも持った count を前提にできる |
| **確定後の遷移** | handleAfterConfirm で setCount(updatedCount) してからコンディション or 商品グループリストへ遷移。updatedCount は merge 済み toWrite の元になった locallyBuilt（画面用）なので、全グループ入りでない可能性はある | 表示は親 state の count で行う。**永続化は必ず mergeCountWithStorage 経由の toWrite で行っている**ため、ストレージ上の他グループはマージで保持される |

---

## 5. 追加で実施した修正（2026-02-28）

1. **StocktakeScreen.jsx**  
   - `handleSelectProductGroup` 内で `params?.count` が渡されていれば `setCount(params.count)` を実行するよう変更。  
   - 商品グループ選択で「グループを選択」したときに、fullCount（readInventoryCountById 済み）を親に反映し、商品リストで受け取る count が常に groupItems 付きになるようにした。

2. **InventoryCountList.jsx**（前回対応）  
   - 確定時の write 全 4 経路で、`readInventoryCountsRaw()` で取得した該当件（fromStorage）と locallyBuilt を `mergeCountWithStorage(fromStorage, locallyBuilt)` でマージし、その結果（toWrite）だけを write するように変更済み。  
   - これにより、親の count が一覧由来で他グループの groupItems が無くても、ストレージにあった他グループの groupItems は上書きされない。

---

## 6. 結論

- **完了ステータス・他グループの groupItems が上書きされるリスク**: 確定処理の 4 経路はすべて `mergeCountWithStorage` でストレージとマージしてから write するため、他グループを消してしまう書き込みはしていない。
- **下書きが本番データを上書きするリスク**: 下書きは別ストレージキーのみで、writeInventoryCounts は呼ばないためなし。
- **読み込み・一覧更新**: いずれもストレージの「全件置き換え」は行わず、表示用 state の更新か、readInventoryCounts 内の status/countName の補正のみ。補正時も spread で groupItems を保持。
- **画面遷移**: 商品グループ選択から商品リストへ渡す count を、fullCount を親に反映するよう変更済み。確定時の write もマージ済みで保護されている。

以上の確認と修正により、読み込み・確定・画面遷移のいずれにおいても、完了ステータスや他グループの確定内容・未確定の自動保存が意図せず上書きされる経路はないと判断できる。
