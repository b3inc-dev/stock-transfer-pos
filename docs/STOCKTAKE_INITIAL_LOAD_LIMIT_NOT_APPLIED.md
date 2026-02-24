# 棚卸で「読み込み件数」（初回表示件数）が反映されない要因

## 1. 想定している動き・デフォルト（保存前）

- **未保存時のデフォルト**: 履歴一覧リスト **100件**、商品リスト **250件**、検索リスト **50件**
- **設定**: 管理画面の「アプリ表示件数（初回読み込み）」→ **履歴一覧リスト**（`outbound.historyInitialLimit`）、**商品リスト**（`productList.initialLimit`）、**検索リスト**（`searchList.initialLimit`）
- **棚卸**: POS の棚卸一覧は `readInventoryCountsFirstPage()` で取得し、**先頭 N 件**（N = 設定の履歴一覧リスト件数、1〜250、未設定時 100）だけ返す想定。
- **実装**: `stocktakeApi.js` の `getStocktakeListLimit()` が `fetchSettings()` で `settings?.outbound?.historyInitialLimit` を読み、`readInventoryCountsFirstPage()` 内で `counts.slice(0, listLimit)` を適用している。

---

## 2. 読み込み件数が反映されない主な要因

### 2.1 設定が POS で読めていない（最も有力）

**場所**: `extensions/stock-transfer-stocktake/.../stocktakeApi.js` の `fetchSettings()`

- 設定は **App Installation の metafield**（`stock_transfer_pos` / `settings_v1`）に保存されている。
- POS 拡張から `fetchSettings()` で同じ metafield を GraphQL 取得している。
- **エラー時や `version !== 1` のとき**は、フォールバックとして  
  `return { version: 1, carriers: [] };`  
  だけ返している。
- この戻り値には **`outbound` が含まれない**。
- `getStocktakeListLimit()` では  
  `Number(settings?.outbound?.historyInitialLimit ?? 100)`  
  としているため、`outbound` が無い場合は **常に 100** になる。

**結果**: 管理画面で 20 件などに変更していても、POS 側で設定取得に失敗していると **100 件** で固定され、「読み込み件数が反映されていない」ように見える。

**想定される原因**:
- 管理画面で一度も「保存」していない（metafield が無い or 古い）
- POS 起動時やネットワークの一時不調で GraphQL が失敗している
- アプリのインストール状況により、管理画面と POS で別の App Installation を参照している（公開版と自社版の切り替えなど）

---

### 2.2 チャンク保存形式の影響（件数は「上限」である点）

- 棚卸データは **チャンク単位**（`inventory_counts_v1_c0`, `_c1`, ...）で保存されている。
- 初回は **チャンク 0 だけ** を取得し、その結果に `slice(0, listLimit)` をかけて返している。
- チャンク 0 に元々入っている件数が **listLimit より少ない**場合（例: 5 件しかない）は、**5 件しか返らない**。
- つまり「設定より少なく表示される」ことはあり得るが、「設定より多く表示される」場合は、**listLimit が効いていない**（上記 2.1 で 100 固定になっているなど）可能性が高い。

---

### 2.3 ロケーション絞り込みの影響

- `readInventoryCountsFirstPage()` の返却件数は、**ロケーションで絞り込む前**の件数。
- `InventoryCountConditions.jsx` では、取得後に `filterByLocation(filtered, locationGid)` で **現在ロケーションのみ** に絞っている。
- そのため、「設定 20 件」で 20 件返ってきても、その中で現在ロケーションに該当するのが 5 件なら、**一覧に表示されるのは 5 件**。
- 「反映されていない」が「思ったより少ない」という意味の場合は、この絞り込みの影響もある。

---

## 3. 確認・対処のポイント

1. **管理画面で保存されているか**
   - 設定画面で「履歴一覧リスト」の件数を変更したあと、**必ず「保存」** しているか確認する。

2. **POS 側で設定が読めているか**
   - `fetchSettings()` がエラーや `version !== 1` でフォールバックしていないか。
   - 必要なら、一時的に `getStocktakeListLimit()` 内で  
     `console.log('[getStocktakeListLimit]', listLimit, settings?.outbound);`  
     などを追加し、実際に使われている値と `outbound` の有無を確認する。

3. **デフォルト戻り値の改善（実装側の対策）**
   - `fetchSettings()` のフォールバックで  
     `return { version: 1, carriers: [] };`  
     ではなく、  
     `return { version: 1, carriers: [], outbound: { historyInitialLimit: 100 } };`  
     のように **`outbound.historyInitialLimit` を明示的に含める**と、  
     「設定が読めなかったときも 100 で統一される」ことがはっきりし、  
     別の経路で `outbound` が混ざったときに不整合が起きにくくなる（挙動は現状と同じで、意図が明確になる）。

---

## 4. 「表示できる棚卸IDがありません」になる要因（対応済み）

- **原因**: 初回は「チャンク0」だけを取得してからロケーションで絞る。チャンク0に対象ロケーションの棚卸が含まれていないと、絞り後が 0 件になり「表示できる棚卸IDがありません」と表示されていた。
- **対応**: ロケーション絞りで 0 件だが取得件数がある場合、**次のチャンクを自動で追加取得**し、マージしてから再フィルタする。対象ロケーションの棚卸が後続チャンクにあれば表示される。

## 5. 商品リストが「指定件数より多く遅い」要因（対応済み）

### 5.1 設定デフォルト

- **原因**: 設定未読時や `fetchSettings` エラー時のフォールバックに `productList` がなく、`settings?.productList?.initialLimit ?? 100` で **100** が使われていた。また「未保存時は商品リスト250」の仕様に対して、フォールバックが 100 のままだった。
- **対応**: `fetchSettings` のデフォルト戻り値に `productList: { initialLimit: 250 }`, `searchList: { initialLimit: 50 }` を追加。商品リストの未読時デフォルトを **250** に統一（`?? 100` → `?? 250`）。

### 5.2 保存済み ID リスト（SKU/CSV 等）経路で件数制限が未適用だった（対応済み）

- **事象**: 商品リストが約 450 件などあるとき、「長時間読み込み中...」のまま **一括で全件取得**され、設定した表示件数（100 や 250）が効いていなかった。
- **原因**: `stocktakeApi.js` の `fetchProductsByGroups` に **2 つの取得経路** がある。
  1. **コレクション経路**: `productFirst` を `products(first: productFirst)` に渡しており、ここでは表示件数が効く。
  2. **inventoryItemIdsByGroup 経路**: 棚卸生成時に保存した `inventoryItemIds`（SKU/CSV グループや管理画面で保存した ID リスト）で取得する場合、**productFirst / initialLimit を参照していなかった**。保存 ID を 50 件ずつバッチで **全件** 取得していたため、450 件なら 450 件すべて取得し長時間読み込みになっていた。
- **対応**: inventoryItemIdsByGroup 経路でも `productFirst` / `initialLimit` を適用するように変更。
  - 初回は `savedInventoryItemIds.slice(0, effectiveFirst)` のみ取得（例: 250 件）。
  - 「さらに読み込む」では `offset` / `limit` で `savedInventoryItemIds.slice(offset, offset + pageSize)` を取得。
  - 取得時に既にページング済みのため、この経路では後段の `uniqueVariants.slice(offset, offset + limit)` は行わず、`hasMoreFromSavedIds` で「さらに読み込む」を表示。

## 6. 履歴一覧の「さらに読み込み」の仕様（対応済み）

### 6.1 読み込み単位

- **想定**: 読込ボタン1回で「設定の履歴一覧数（例: 100件）」ずつ読み込む（棚卸リストの100件であり、チャンク数ではない）。
- **旧挙動**: 保存はバイト単位チャンク（約32KB）のため、1タップで「1チャンク分」だけ取得しており、チャンクあたり件数が少ないと何度もタップしないと最新が出ていた。
- **対応**: 「さらに読み込み」で **listLimit（設定の履歴一覧数）件に達するまで複数チャンクを連続取得**するように変更。1タップで最大100件（設定値）まで追加される。

### 6.2 並び順（新しい順）

- **想定**: 一覧は **新しい順**（作成日時の降順）で表示する。
- **旧挙動**: チャンクは保存順（古い→新しい）で 0, 1, 2... だったため、初回は「先頭チャンク＝古いデータ」が表示され、最新は後ろのチャンクで何度も読込が必要だった。
- **対応**: 初回は **最後のチャンク**（ newest ）を取得。さらに読み込みは **逆順**（最後の1つ前、その前…）でチャンクを取得するように変更。表示は従来どおり `createdAt` 降順でソート。

---

## 7. まとめ

| 要因 | 内容 | 対処 |
|------|------|------|
| 設定が POS で読めていない | `fetchSettings()` が失敗 or version 不一致で `outbound` なし → 常に 100 件 | 管理画面で保存済みか確認。`fetchSettings` のデフォルトに `outbound` / `productList` / `searchList` を含める（対応済み） |
| チャンク 0 に対象ロケーションが無い | 初回チャンクのみ取得してロケーション絞り → 0 件で「表示できる棚卸IDがありません」 | 絞り後 0 件のとき次のチャンクを自動取得して再フィルタ（対応済み） |
| 商品リストのデフォルト | 未読時・エラー時に `productList` が無く 100 で計算されていた | デフォルト 250・フォールバックに `productList` を含める（対応済み） |
| 保存 ID 経路で件数未適用 | inventoryItemIdsByGroup 経路で productFirst を参照せず全件取得していた | 初回は effectiveFirst 件のみ取得、さらに読み込むで offset/limit 対応（対応済み） |
| ロケーション絞り込み | 取得後に現在ロケーションのみ表示するため、表示件数が設定より少なくなることがある | 仕様どおり |
| 履歴一覧の読込単位 | 1タップで1チャンクのみで件数が少なく、最新まで何度もタップが必要だった | 1タップで listLimit 件まで複数チャンク取得（対応済み） |
| 履歴一覧の並び | チャンク先頭から読むため古い順に読まれていた | 最後のチャンクから逆順で取得し新しい順に（対応済み） |

「設定した読み込み件数が反映されていない」と感じる場合は、まず **POS で実際に使われている listLimit（と `settings.outbound`）がどうなっているか** を上記のログなどで確認するのが有効です。
