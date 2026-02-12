# 在庫高「本日集計」でロケーションが1つしか表示されない要因

本日集計実行後、在庫高タブでロケーションが1件しか表示されない場合に、現在のコードで起こり得る要因を整理する。

---

## 0. コード不具合（修正済み）：本日選択時に「先頭1件」だけ表示していた

**事象**: `locationIds` は「すべて」なのに、本日を選択したときだけロケーションが1つしか表示されない。

**原因**: 本日分のスナップショットを「今日の日付に一致する**最初の1件**」だけ使っていたため。  
`app.inventory-info.tsx` の loader で、`todaySnapshot = savedSnapshots.snapshots.find((s) => s.date === todayInShopTimezone)` で **1件だけ**取得し、本日表示用の `currentInventory` を `[todaySnapshot]` の1件で作っていた。

**修正**: 本日分も「日付が今日のスナップショット」を **すべて** 使うように変更。  
`currentInventory` を `savedSnapshots.snapshots.filter((s) => s.date === todayInShopTimezone)` の結果で組み立てるようにした（同日は他日付と同様に `.filter` で全ロケーション分を表示）。

---

## 1. 表示側のフィルター（ロケーション選択）

**要因**: URL パラメータ `locationIds` に**1つだけ**ロケーション ID が入っている。

**動き**:
- ローダーで `locationIds` を `selectedLocationIds` として読み、`filteredSnapshots` は「この ID に一致するスナップショットだけ」に絞られる（`app.inventory-info.tsx` 139–147 行付近）。
- 在庫高タブでロケーションを**1つだけ**選んだ状態で本日集計したり、その状態の URL を開いたりすると、表示は常に 1 ロケーションになる。

**確認方法**:
- ブラウザのアドレスバーで `locationIds=...` を確認する。1 つだけなら「フィルターで 1 件に絞っている」状態。
- ロケーション選択を「すべて」に戻す（`locationIds` を削除した URL で開く）と、保存されている全ロケーションが表示される想定。

---

## 2. 保存時点で集計結果が 1 ロケーションだけだった

**要因**: 本日集計の「保存」時に、`aggregateSnapshotsFromItems` の結果（`newSnapshots`）に**1 ロケーション分しか入っていない**。

**起こり得るパターン**:

- **2-1. 取得した在庫アイテムが実質 1 ロケーションだけを持っていた**
  - `fetchAllInventoryItems` は `inventoryItems(first: 250, after: cursor)` でページングしている。
  - 各アイテムの `inventoryLevels(first: 250)` に、API が返すロケーションが 1 つしかない（または多くの商品が 1 ロケーションにしか在庫を持っていない）場合、集計結果も 1 ロケーションになり得る。
- **2-2. ページングが途中で止まっている**
  - エラー・タイムアウト・ネットワーク切れなどで `fetchAllInventoryItems` の while が途中で終わると、**最初の 1 ページ（最大 250 件）のアイテムだけ**で集計される。
  - その 250 件がたまたますべて「同じ 1 ロケーションにしか在庫がない」場合、保存されるスナップショットは 1 ロケーションだけになる。
- **2-3. GraphQL の制限・仕様**
  - `inventoryLevels(first: 250)` は「アイテムあたり最大 250 ロケーション」まで。ロケーション数が 250 以下なら本来は全ロケーション返る想定。
  - 何らかの理由で 1 ロケーション分しか返っていない場合は、集計結果も 1 件になる。

**確認方法**:
- 本日集計の action 内で、`newSnapshots.length` や `newSnapshots.map(s => s.locationId)` をログ出力し、「保存直前」に何件・どのロケーションが入っているか確認する。

---

## 3. Metafield のサイズ制限による切り詰め

**要因**: 日次スナップショットは `metafieldsSet` で 1 つの Metafield（JSON）に保存している。Shopify の Metafield の value には**サイズ上限**（例: 64KB など）があり、それを超えると保存が失敗したり、切り詰められたりする可能性がある。

**動き**:
- 日付×ロケーション数が多く、`snapshots` 配列が大きいと、`JSON.stringify({ version: 1, snapshots: updated })` が上限を超えることがある。
- 保存時にエラーになるか、あるいは（実装次第では）途中までしか書き込まれず、**読み取り時にパースできる範囲だけ**（例: 1 日分の 1 ロケーションだけ）になる可能性がある。

**確認方法**:
- 保存後の `getSavedSnapshots` で取得した JSON の長さと、`snapshots` の件数・日付・ロケーション数をログで確認する。
- `metafieldsSet` の `userErrors` にサイズや保存失敗のメッセージが出ていないか確認する。

---

## 4. コード上のポイント（参照箇所）

| 内容 | ファイル・箇所 |
|------|----------------|
| ロケーション一覧（API） | `app.inventory-info.tsx` loader: `LOCATIONS_QUERY`（first: 250）で取得。表示用の「全ロケーション」はここ。 |
| 本日集計の保存 | `app.inventory-info.tsx` action `intent === "saveTodaySnapshot"`: `fetchAllInventoryItems` → `aggregateSnapshotsFromItems` → `saveSnapshotsForDate`。 |
| 表示データのフィルター | `app.inventory-info.tsx` loader: `selectedLocationIds`（URL の `locationIds`）で `filteredSnapshots` を算出し、`snapshots` として返している。 |
| ロケーション別集計 | `app/utils/inventory-snapshot.ts`: `aggregateSnapshotsFromItems`（locationMap でロケーション単位に集計）。 |
| 全アイテム取得 | `app/utils/inventory-snapshot.ts`: `fetchAllInventoryItems`（inventoryItems のページング、各 item の inventoryLevels(first: 250)）。 |

---

## 5. 切り分けの手順（推奨）

1. **URL の `locationIds` を確認**
   - 1 つだけ指定されていないか確認。指定を外して再表示し、ロケーション数が増えるか見る。
2. **保存直後のログを確認**
   - 本日集計の action 内で `newSnapshots.length` と各 `locationId` をログ出力し、「保存時点で何ロケーション分あるか」を確認する。
3. **読み取り時のデータを確認**
   - 再ロード後、loader で `savedSnapshots.snapshots` のうち `date === 本日` の件数と `locationId` をログ出力し、Metafield から正しく複数ロケーションが読めているか確認する。
4. **Metafield のサイズを確認**
   - 保存する JSON の文字数（またはバイト数）が、Shopify の Metafield 制限内か確認する。

上記で「保存時は複数ロケーションあるが、表示は 1 件」なら 1 のフィルター、「保存時から 1 件」なら 2 または 3 を疑う。
