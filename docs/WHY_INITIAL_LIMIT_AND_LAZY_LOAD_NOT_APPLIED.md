# アプリ表示件数（初回読み込み）と「一覧タップ後にAPI取得」が反映されない要因

**日付**: 2026-02-25

## 1. アプリ表示件数（初回読み込み）が棚卸・ロス・仕入・発注・調整で読み込めていない要因

### 1.1 管理画面で保存している内容

**ファイル**: `app/routes/app.settings.tsx`

| 設定ラベル | 保存キー | 使う想定 |
|------------|----------|----------|
| 履歴一覧リスト | `outbound.historyInitialLimit`（出庫）<br>`inbound.listInitialLimit`（入庫） | 履歴一覧の**初回取得件数** |
| 商品リスト | `productList.initialLimit` | 商品リストの初回表示件数 |
| 検索リスト | `searchList.initialLimit` | 検索結果の初回表示件数 |

※ 画面上は「履歴一覧リスト」1つで、出庫・入庫・ロス等に適用と説明されている。

---

### 1.2 出庫・入庫で反映されている理由

- **出庫（tile）**: `ModalOutbound.jsx` で bootstrap により metafield から設定を取得。`fetchTransfersForOriginAll(originLocationGid, { first: historyLimit })` の **first** に `settings?.outbound?.historyInitialLimit` を渡している。→ **API の取得件数が設定どおり**になる。
- **入庫**: `Modal.jsx` で `fetchSettings()` を呼び、`fetchTransfersForDestinationAll(..., { first: listInitialLimit })` の **first** に `inbound.listInitialLimit` を渡している。→ **同様に反映されている。**

---

### 1.3 棚卸・ロス・仕入・発注・調整で反映されていない要因

#### ロス・仕入・発注・調整（チャンク保存方式）

- **データの持ち方**: 履歴は metafield を**チャンク分割**して保存している（例: ロスは `loss_entries_v2_meta` ＋ `loss_entries_v2_0`, `loss_entries_v2_1`, ...）。
- **設定の使われ方**:  
  - `getLossChunkSize()` / `getPurchaseChunkSize()` / `getOrderChunkSize()` / `getAdjustmentChunkSize()` が **fetchSettings()** を呼び、`settings?.outbound?.historyInitialLimit` を **チャンクサイズ**（1チャンクあたりの件数）として使っている。
  - この値が使われるのは **データ保存時** および **V1→V2 マイグレーション時** のみ。**読み取り時には使っていない**。
- **初回表示の実装**:  
  - `readLossEntriesFirstPage()` / `readPurchaseEntriesFirstPage()` / `readOrderEntriesFirstPage()` 等は、**「チャンク0を丸ごと1つ取得して返す」**だけ。
  - チャンク0に何件入っているかは **過去にマイグレーション or 保存したときの chunkSize** で決まっており、**現在の設定の「初回表示件数」は読み取り時に適用されていない**。
- **結果**: 設定を「50件」にしても、既存のチャンク0が100件なら100件返る。**「初回は設定の N 件だけ取得する」という動きになっていない。**

**該当API**:  
- `extensions/stock-transfer-loss/src/screens/loss/lossApi.js`（getLossChunkSize / readLossEntriesFirstPage）  
- `extensions/stock-transfer-purchase/src/screens/purchase/purchaseApi.js`（getPurchaseChunkSize / readPurchaseEntriesFirstPage）  
- `extensions/stock-transfer-order/src/screens/order/orderApi.js`（getOrderChunkSize / readOrderEntriesFirstPage）  
- `extensions/stock-transfer-adjustment/src/screens/loss/adjustmentApi.js`（同様）

#### 棚卸

- **データの持ち方**: 棚卸一覧も metafield をチャンク分割して保存（`inventory_counts_v1` または `inventory_counts_v1_c0`, `_c1`, ...）。
- **設定の使われ方**:  
  - `stocktakeApi.js` に **getStocktakeListLimit()** があり、`fetchSettings()` で `settings?.outbound?.historyInitialLimit` を読んで 1～250 にクランプして返している。
  - しかし **readInventoryCountsFirstPage()** は **getStocktakeListLimit() を呼んでいない**。先頭チャンクをそのまま取得して返しているだけ。
- **結果**: 棚卸一覧の「初回表示件数」設定は**読み取り処理で参照されておらず、反映されていない。**

**該当**: `extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeApi.js`  
- `getStocktakeListLimit()` は定義されているが、`readInventoryCountsFirstPage()` 内で未使用。

---

### 1.4 まとめ（表示件数が効かない理由）

| 機能 | 設定が効いているか | 要因 |
|------|--------------------|------|
| 出庫 | ✅ | API の `first` に historyInitialLimit を渡している |
| 入庫 | ✅ | API の `first` に listInitialLimit を渡している |
| 棚卸 | ❌ | readInventoryCountsFirstPage が getStocktakeListLimit を参照していない |
| ロス | ❌ | historyInitialLimit はチャンク分割サイズ（保存時）にのみ使用。初回表示は「チャンク0をそのまま返す」だけ |
| 仕入 | ❌ | 同上 |
| 発注 | ❌ | 同上 |
| 調整 | ❌ | 同上 |

---

## 2. 一覧をタップした際に画面遷移してからAPIを取得する仕様が反映されていない要因

### 2.1 期待する動き（ユーザー要望）

- **一覧画面を開いたとき**: 履歴一覧や商品グループ一覧で **いきなり全件（または大量）のAPI取得をしない**。
- **行をタップして画面遷移したとき**: そのタイミングで **その1件（または必要なデータ）をAPIで取得する**。

### 2.2 現状の実装

#### 履歴一覧（ロス・仕入・発注・棚卸）

- **一覧画面のマウント時**に、useEffect から **refreshXxx()** が呼ばれ、その中で **readXxxFirstPage()**（または readInventoryCountsFirstPage）が実行されている。
  - 例: `LossHistoryList.jsx` の `useEffect(..., [sessionLocationGid])` → `refreshLossHistory()` → `readLossEntriesFirstPage()`。
  - 例: `OrderHistoryList.jsx` の `useEffect(..., [sessionLocationGid])` → `refreshOrderHistory()` → `readOrderEntriesFirstPage()`。
  - 例: `InventoryCountConditions.jsx` の `useEffect(() => { refresh(); }, [refresh])` → `readInventoryCountsFirstPage()`。
- **行をタップしたとき**:  
  - `onTapHistoryEntry(entry)` 等で **detailId** をセットし、詳細は **fullEntriesByIdRef.current.get(id)** や **entries** から取得している。  
  - つまり **既に readXxxFirstPage で取ってあるデータを表示しているだけ**で、**タップ時に新たにAPIは呼んでいない**。

#### 商品グループ一覧（棚卸）

- 棚卸一覧でカードをタップすると `onTapCount(c)` が呼ばれ、必要に応じて **readInventoryCounts()**（全件）を呼ぶケース（draft→in_progress 更新時）はある。
- ただし**一覧の表示データ自体**は、一覧画面を開いた時点で **refresh() → readInventoryCountsFirstPage()** で取得済み。タップは「既に取得した count を渡して次の画面へ遷移」している。

### 2.3 結論

- **「一覧を開いた時点ではAPIを呼ばず、行をタップして画面遷移してからAPIで取得する」という仕様のコードは、現状の実装にはなっていない。**
- 現状は **「一覧表示時に readXxxFirstPage / readInventoryCountsFirstPage で先頭チャンクを取得 → タップ時はメモリ上のデータで詳細表示」** という動き。
- そのため「実装したが反映されていない」というより、**「一覧タップ後にAPI取得」する仕様そのものが、まだ実装されていない**状態。

---

## 3. 今後の対応の方向性（参考）

### 3.1 アプリ表示件数（初回読み込み）を棚卸・ロス・仕入・発注・調整で効かせるには

- **ロス・仕入・発注・調整**:  
  - readXxxFirstPage() で「チャンク0を丸ごと返す」のではなく、**設定の N 件（historyInitialLimit）だけを返す**ようにする。  
  - 例: チャンク0をパースしたあと、`list.slice(0, limit)` のように先頭 N 件に切り、hasMore は「チャンク0の長さ > N または chunkCount > 1」で判定する。  
  - その N を **getXxxChunkSize() と同様に fetchSettings() から取得**する。
- **棚卸**:  
  - readInventoryCountsFirstPage() の戻り件数を、**getStocktakeListLimit()** で取得した N に合わせて制限する（先頭チャンクを取ったあと、counts を N 件にスライスし、hasMore を適切に立てる）。

### 3.2 一覧タップ後にAPI取得にするには

- **一覧画面**:  
  - マウント時には **readXxxFirstPage() を呼ばない**（entries / counts を空で表示するか、「タップして読込」用のプレースホルダーのみ表示）。
- **行タップ時**:  
  - 画面遷移後に、**その1件のIDだけ**で API を呼ぶ（例: 1件取得用の readXxxEntryById(id) や、棚卸なら readInventoryCounts のうち該当 id だけ返す API など）し、取得結果で詳細画面を描画する。
- 既存の「先頭チャンクで一覧＋タップでメモリ上の詳細」から、「一覧は最小限 or 空 → タップでAPI取得」に変更する実装が必要。

---

## 4. 関連ドキュメント

- **設定が各拡張でどう使われているか**: `docs/WHY_SETTINGS_NOT_APPLIED.md`
- **管理画面の設定項目**: `app/routes/app.settings.tsx`（アプリ表示件数の入力・保存）
