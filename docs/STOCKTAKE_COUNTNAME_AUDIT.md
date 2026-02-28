# 棚卸ID（countName）・ロケーション・商品グループが空白で上書きされないための監査メモ

**日付**: 2026-02  
**目的**: 画面表示・読み込み・確定処理時に countName や locationId / productGroupIds / groupItems が空白で上書きされ、「IDだけ残った」レコードが増える要因をなくす。

---

## 0. 今まで発生した空白上書きの要因と対策の対応（全対策が打てている根拠）

以下は、**実際に起きた／想定された「空白で上書き」の要因**と、**それぞれにどの対策で対応しているか**の一覧です。すべての要因に 1 つ以上の対策が紐づいており、かつその対策は実装で必ず通るため、「全て対策が打てている」根拠になります。

| # | 発生した要因（何が起きていたか） | 対策（どこで防いでいるか） | 対策が効く根拠 |
|---|----------------------------------|----------------------------|----------------|
| 1 | **確定後バックグラウンドで write するとき**、`merged` が `readInventoryCountsRaw()` の戻り + toWrite で組み立てられ、**readInventoryCountsRaw は countName を付与しない**ため、**他件の countName が欠けたまま write され、既存の countName が空白で上書きされた**。 | **ensureCountNamesBeforeWrite** を `writeInventoryCounts` の先頭で実行。 | すべての write は `writeInventoryCounts` を経由し、その中で必ず「欠けている countName にのみ番号を付与」してから保存する。呼び出し元が raw の list だけ渡しても、write 前に補完される。 |
| 2 | **渡した counts の一部が minimal や欠損**（例: list 由来・過去の不具合で main に欠損が残っている）のとき、**既存の locationId / productGroupIds / groupItems が空白で上書きされた**。 | **mergeExistingNonBlank(counts, existing)** を write の先頭（既存読取の直後）で実行。 | 既存を読んだうえで「渡された counts のうち空白の項目は既存の値で補完」する。空白で既存を上書きするオブジェクトは保存されない（補完された値で保存される）。 |
| 3 | **確定時の toWrite** が `mergeCountWithStorage(fromStorage, locallyBuilt)` で、**`...locallyBuilt` により** 一覧由来で稀に **countName / locationId が空白の count** を親から受け取った locallyBuilt が **fromStorage の有効な値を上書きし、toWrite が空白になって write された**。 | **mergeCountWithStorage** 内で、fromStorage に有効値があり locallyBuilt が空白の項目は **fromStorage の値で上書きし直す**。 | 確定時の toWrite は必ず mergeCountWithStorage を経由する。戻りオブジェクトで「fromStorage の有効値 > locallyBuilt の空白」となる項目は明示的に fromStorage を採用しているため、toWrite が空白で write に回る経路はない。 |
| 4 | **「id はあるが countName または locationId が空白」のレコード**が何らかの経路で配列に混ざり、**そのまま保存されると新規に空白のIDが永続化される**（または既存がそのレコードで上書きされる）。 | **filterInvalidCountsBeforeWrite(counts)** を write 直前に実行。 | 保存対象は「4 のあとの arr」だけ。4 で「id あり & (countName または locationId が空白)」の要素は配列から除外されるため、そのようなオブジェクトがメタフィールドに保存されるコードパスは存在しない。 |
| 5 | **readInventoryCounts 内で countName を補完して write するとき**、raw 由来の他項目（locationId / groupItems 等）が欠損したまま write され、既存の full が欠損で上書きされた。 | 上記 **mergeExistingNonBlank** と **filterInvalidCountsBeforeWrite**（write 内で必ず実行）。 | writeInventoryCounts は常に「既存読取 → mergeExistingNonBlank → ensureCountNames → filterInvalid」を経る。readInventoryCounts から呼ばれる場合も同じ経路のため、欠損のまま保存されることはない。 |
| 6 | **readInventoryCountsFirstPage** で main が配列でチャンク0が無いときに `writeInventoryCounts(parsed)` する。**parsed が legacy で countName や locationId が欠損**していると、そのまま write されて空白が永続化された。 | **ensureCountNamesBeforeWrite** + **mergeExistingNonBlank** + **filterInvalidCountsBeforeWrite**（いずれも write 内で実行）。 | この経路でも write は writeInventoryCounts のみ。必ず上記 3 段階を通過するため、欠損のまま保存されることはない。 |
| 7 | **管理画面**で list 由来の inventoryCounts を **updatedCounts** として write するとき、**他件が minimal（groupItems 等欠け）**のまま full を上書きし、既存の groupItems / locationId 等が空白で上書きされた。 | **writeInventoryCountsChunked** 内で **mergeExistingNonBlank** + **ensureCountNamesOnCounts** + **filterInvalidCountsBeforeWrite**。 | 管理画面の write はすべて writeInventoryCountsChunked のみ。既存読取の直後に mergeExistingNonBlank で「空白の項目は既存で補完」し、さらに filter で不完全レコードを保存対象から外す。 |
| 8 | **一覧表示**で readInventoryCountById のバックグラウンドマージ時に **full.countName を一覧行に反映していなかった**。結果として、既存データに countName があっても一覧では空白に見え、その状態で別の write が行われた場合に「空白の count」が渡されるリスクがあった。 | **InventoryCountConditions.jsx** で readInventoryCountById の結果をマージする際、**full.countName** を明示的にマージ対象に含める。 | 表示時点で countName が補完されるため、一覧から遷移した count が空白で渡される可能性が減る。加えて、write 側の mergeCountWithStorage と filterInvalidCountsBeforeWrite で二重に防いでいる。 |

**結論（全て対策が打てている根拠）**

- 上記 **1～8 の要因**は、いずれも **write の単一入口（writeInventoryCounts / writeInventoryCountsChunked）** と **mergeCountWithStorage** のいずれかで発生しうるもの。
- その **write 入口**では、**必ず**「既存読取 → mergeExistingNonBlank → ensureCountNames(OnCounts) → filterInvalidCountsBeforeWrite」を経た **arr だけ**が保存される。
- **merge 入口**では、**mergeCountWithStorage** で「fromStorage の有効値で空白を上書きし直す」ため、toWrite が空白で write に回る経路はない。
- したがって、**今まで発生した／想定した空白上書きの要因はすべて、上記のいずれかの対策で塞がれており、全て対策が打てている**と言える。

---

## 1. 書き込み（write）経路

| 呼び出し元 | 渡すデータ | 対策 |
|------------|------------|------|
| `writeInventoryCounts(merged)`（InventoryCountList：確定後バックグラウンド） | `readInventoryCountsRaw()` の list + toWrite | **ensureCountNamesBeforeWrite** を writeInventoryCounts 内で実行。欠けている件にのみ番号を付与し、既存の countName は変更しない。 |
| `writeInventoryCounts(updated)`（InventoryCountList / InventoryCountProductGroupSelection：status を in_progress に） | `readInventoryCounts()` の allCounts を map で 1 件だけ更新 | readInventoryCounts() は countName を付与して返すため、updated に countName が含まれる。さらに ensureCountNamesBeforeWrite で二重に保護。 |
| `writeInventoryCounts(parsed)`（readInventoryCountsFirstPage：チャンク未存在時） | メタフィールドの parsed 配列 | ensureCountNamesBeforeWrite で補完。 |
| `writeInventoryCounts(countsWithName)`（readInventoryCounts） | 自前で countName を付与した配列 | もともと countName 付き。ensureCountNamesBeforeWrite は既存を変更しない。 |

**ロケーション・商品グループ・groupItems の空白上書き防止（2026-02 追加）**  
- **POS** `writeInventoryCounts`: 書き込み前に **readInventoryCountsRaw()** で既存を取得し、**mergeExistingNonBlank(counts, existing)** を実行。渡された counts のうち locationId / productGroupIds / groupItems / items が空白の件は、既存の値を補完してから書くため、既存のロケーション・グループが空白で上書きされない。
- **管理画面** `writeInventoryCountsChunked`: 同様に書き込み前に **readInventoryCountsChunked(admin)** で既存を取得し、**mergeExistingNonBlank(counts, existing)** を実行してから保存。

**絶対に空白のIDを生成しない（2026-02 追加）**  
- **POS** / **管理画面** とも、書き込み直前に **filterInvalidCountsBeforeWrite(counts)** を実行。`id` があるのに `countName` または `locationId` が空白のレコードは配列から除外し、保存しない。そのため「空白のID」を新規に永続化することはない。

**バックアップを残す（2026-02 追加）**  
- 書き込みの直前に、現在の棚卸一覧（minimal：id, locationId, status, countName, createdAt, productGroupIds 等）をメタフィールド **inventory_counts_backup_v1** に 1 世代だけ保存（約 60KB 以内）。本体の書き込みに失敗した場合や不具合時の復元の手がかりとして利用可能。

**結論**: すべての write は **ensureCountNamesBeforeWrite**（countName）→ **mergeExistingNonBlank**（locationId / productGroupIds / groupItems 等）→ **filterInvalidCountsBeforeWrite**（不完全レコードを保存しない）の順で処理し、その前に **バックアップ** を保存する。

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
| **mergeCountWithStorage** | fromStorage + locallyBuilt | **2026-02 修正**: `...fromStorage, ...locallyBuilt` のあと、locallyBuilt が countName / locationId / locationName / productGroupIds を空白にしている場合は **fromStorage の値を維持**するよう明示的に上書きしない。これにより確定時の toWrite が親の count（一覧由来で稀に空白）で上書きされても、read で得た fromStorage の値で補正される。 |

**結論**: 表示・読み込み経路では、list チャンク・フルチャンク・readInventoryCountById のいずれも countName を保持するか、バックグラウンドマージで full.countName を反映しており、表示で空白に上書きされる経路はなし。

---

## 3. ナビゲーション・setCount（ストレージを書かない）

| 箇所 | 内容 |
|------|------|
| StocktakeScreen setCount(updatedCount) | buildUpdatedCountFromLocalState の戻り（countName あり）。 |
| StocktakeScreen setCount(c) | toMinimalCount(c) の戻り（countName あり）。 |
| StocktakeScreen setCount(null) | 戻る操作で現在の count をクリアするだけ。write は呼ばない。 |

---

## 4. 防御ポイント

- **countName**: **writeInventoryCounts** / **writeInventoryCountsChunked** の書き込み前に **ensureCountNamesBeforeWrite(counts)** を必ず実行する。呼び出し元が readInventoryCountsRaw のみで list を組み立てて渡しても、欠けている countName が補完され、他件が空白で上書きされない。
- **locationId / productGroupIds / groupItems / items**: 書き込み前に **readInventoryCountsRaw()**（POS）または **readInventoryCountsChunked(admin)**（管理画面）で既存を取得し、**mergeExistingNonBlank(counts, existing)** で「渡された counts のうち空白の項目は既存の値で補完」してから書く。何らかのアクション・表示・読み込み・確定時に空白で上書きされて「IDだけ残った」レコードが増えるのを防ぐ。
- **空白のIDを絶対に作らない**: 書き込み直前に **filterInvalidCountsBeforeWrite(counts)** で、`id` はあるが `countName` または `locationId` が空白のレコードを除外。そのようなレコードは保存しない。
- **バックアップ**: 毎回の書き込み前に、現在の一覧（minimal）をメタフィールド **inventory_counts_backup_v1** に 1 世代保存（60KB 以内）。復元の手がかりとして利用可能。

**merge 時の空白上書き防止（2026-02 追加）**  
- **InventoryCountList** の **mergeCountWithStorage(fromStorage, locallyBuilt)**: 確定時に `toWrite = mergeCountWithStorage(fromStorage, locallyBuilt)` でマージするが、`...locallyBuilt` により locallyBuilt の空白が fromStorage の有効な値を上書きする可能性があった。修正で、戻りオブジェクトについて「fromStorage に有効値があり locallyBuilt が空白の項目」は fromStorage の値で上書きし直すようにした。これにより、一覧から渡された count が稀に countName/locationId 空白でも、readInventoryCountsRaw で得た fromStorage の値が toWrite に残る。

**既に空白で上書きされてしまったレコードの復元について**  
メタフィールドに一度空白で保存されると、その時点で上書き前の値は失われるため、**ロケーション・商品グループ・groupItems の復元はできない**。バックアップや別ログが無い限り復元不可。**棚卸ID（countName）のみ**「棚卸IDを修復」で番号の再付与が可能。今後の発生を防ぐため、上記 mergeExistingNonBlank により「書き込み時に既存の非空白を空白で上書きしない」ようにしている。

---

## 5. 空白混入が起こりうる箇所と対策一覧（再発防止）

| 箇所 | 空白が混入しうる理由 | 対策 |
|------|----------------------|------|
| **InventoryCountList 確定時** | `toWrite = mergeCountWithStorage(fromStorage, locallyBuilt)` で `...locallyBuilt` が fromStorage を上書き。親の count が一覧由来で稀に countName/locationId 空白のとき toWrite が空白になる。 | **mergeCountWithStorage** 内で、fromStorage に有効値があり locallyBuilt が空白の項目は fromStorage で上書きし直す。 |
| **write に渡す merged の「他件」** | `merged = list.map(c => ... ? toWrite : c)` の `c` が readInventoryCountsRaw() の戻り。過去の不具合で main に minimal や欠損が残っていると c が空白を持つ。 | **writeInventoryCounts** 内で **mergeExistingNonBlank(counts, existing)**。既存の同一 id から補完。補完後も空白なら **filterInvalidCountsBeforeWrite** で保存対象から除外。 |
| **readInventoryCountsFirstPage** | main が配列でチャンク0が無いときに `writeInventoryCounts(parsed)`。parsed が legacy で欠損している可能性。 | **ensureCountNamesBeforeWrite** と **filterInvalidCountsBeforeWrite** で補完または除外。 |
| **readInventoryCounts 内の write** | countName 欠けを補完した countsWithName を書き戻す。他項目は raw 由来で欠損の可能性。 | **writeInventoryCounts** 内で **mergeExistingNonBlank** と **filterInvalidCountsBeforeWrite**。 |
| **管理画面の updatedCounts** | action で inventoryCounts が list 由来の minimal の場合、他件が groupItems 欠け。 | **writeInventoryCountsChunked** で **mergeExistingNonBlank**。既存の full から groupItems 等を補完。**filterInvalidCountsBeforeWrite** で id ありで countName/locationId 空白の件は保存しない。 |

---

## 6. 「他に絶対残っていない」根拠

### 6.1 書き込み経路の唯一性

- **棚卸データをメタフィールドに保存するコードは、次の2つだけです。**
  - **POS**: `extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeApi.js` の **export async function writeInventoryCounts(counts)**
  - **管理画面**: `app/routes/app.inventory-count.tsx` の **async function writeInventoryCountsChunked(admin, counts, ownerId)**
- リポジトリ内で `inventory_counts_v1` / `inventory_counts_v1_c*` を**書く**のは上記2関数のみ。  
  （検索結果: 他ファイルの metafieldsSet は product_groups / settings / loss / order 等の別キー用。棚卸用キーを書きに使っているのはこの2箇所のみ。）

→ **「棚卸の空白上書き」は、必ずこのどちらかの関数の引数 `counts` が原因になる。** それ以外の経路でメタフィールドが書き換わることはない。

### 6.2 2つの書き込み関数の共通ガード（必ず通る処理）

どちらの関数も、**実際にメタフィールドを書きに出す直前**に、次の順で必ず実行される。

| 順序 | 処理 | 役割 |
|------|------|------|
| 1 | **既存読取** | POS: readInventoryCountsRaw() / 管理画面: readInventoryCountsChunked(admin) |
| 2 | **mergeExistingNonBlank(counts, existing)** | 渡された `counts` のうち、locationId / productGroupIds / groupItems / items が空白の件は、既存の値で補完。既存の非空白を空白で上書きしない。 |
| 3 | **ensureCountNamesBeforeWrite** / **ensureCountNamesOnCounts** | countName が欠けている件にのみ番号を付与。既存の countName は変更しない。 |
| 4 | **filterInvalidCountsBeforeWrite(counts)** | `id` はあるが `countName` または `locationId` が空白のレコードを配列から除外。**そのようなオブジェクトはこのあと書き込みループに渡らない。** |

→ **「id があり、かつ countName または locationId が空白のオブジェクト」がメタフィールドに保存されるコードパスは存在しない。**  
（保存されるのは 4 のあとの `arr` だけであり、4 でそれらは除外されている。）

### 6.3 呼び出し元の網羅と、merge での補正

- **writeInventoryCounts の呼び出し元（POS）**  
  - stocktakeApi.js: `writeInventoryCounts(parsed)`（readInventoryCountsFirstPage）、`writeInventoryCounts(countsWithName)`（readInventoryCounts）  
  - InventoryCountList.jsx: `writeInventoryCounts(updated)`（draft→in_progress）、`writeInventoryCounts(merged)`（確定後・4経路）  
  - InventoryCountProductGroupSelection.jsx: `writeInventoryCounts(updated)`（draft→in_progress）  
- **writeInventoryCountsChunked の呼び出し元（管理画面）**  
  - repair_count_names、create_inventory_count、update_stocktake_quantity、confirm_stocktake_group、reset_stocktake_group、confirm_stocktake_all、reset_stocktake_all、cancel_stocktake_group、cancel_stocktake の各 action。

いずれの呼び出し元でも、「渡す配列」に混ざりうるのは  
- read の戻り（既存または list 由来の minimal）、  
- または **mergeCountWithStorage(fromStorage, locallyBuilt)** の結果（toWrite）  
のいずれか。  

- **mergeCountWithStorage** では、**fromStorage に有効値があり locallyBuilt が空白の項目は fromStorage で上書きする**ようにしているため、確定時の toWrite が一覧由来の空白で上書きされる経路はない。  
- そのうえで、**実際に書くのは writeInventoryCounts / writeInventoryCountsChunked のどちらかだけ**であり、両方とも上記 1～4 のガードを必ず通す。

### 6.4 結論

- 棚卸メタフィールドを**書きに使う**コードは **writeInventoryCounts** と **writeInventoryCountsChunked** の 2 つだけである。  
- その 2 つは、**どちらも**「既存読取 → mergeExistingNonBlank → ensureCountNames → filterInvalidCountsBeforeWrite」を経た後だけを保存する。  
- したがって、**「id はあるが countName または locationId が空白のレコード」がメタフィールドに保存されるコードパスは存在しない。**  
- さらに、確定時に「一覧由来の空白」で toWrite が上書きされる可能性は、**mergeCountWithStorage** の修正で塞いでいる。  

以上が、「他に空白上書きの要因が絶対に残っていない」と言える根拠です。
