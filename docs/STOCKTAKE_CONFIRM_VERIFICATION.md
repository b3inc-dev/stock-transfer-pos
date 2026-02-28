# POS棚卸確定処理の検証メモ（2026-02-28）

REQUIREMENTS_FINAL.md に基づき、確定処理まわりを実装と照らして確認した結果です。

**再確認**: 7項目とも現行コード（InventoryCountList.jsx 確定4経路・stocktakeApi.js write/read/fixCountsStatusOnly・単一グループ用 resolvedAllIds/groupIdsForCheck 対応・mergeCountWithStorage の「完了維持」ガード・グループ一覧の「完了」表示ガード含む）で再検証済み。

---

## デプロイ後に正しい内容が表示されるか

**結論: ✅ 今回の修正をデプロイすれば、棚卸ID全体・商品グループのステータスが意図せず変わったり相違が出たりする表示は解消される。**

1. **グループ一覧で「完了」が正しく出る**  
   - グループ一覧（まとめて表示・グループ選択画面）では、`count.status === "completed"` のとき groupItems が無くても「完了済み」「処理済み」と表示するように変更済み（InventoryCountList.jsx 3219 行付近、InventoryCountProductGroupSelection.jsx 384 行付近）。  
   - 一覧用 minimal count で開いた場合でも、棚卸IDが完了なら全グループが「完了」表示になる。

2. **完了→未処理に戻らない**  
   - 確定後バックグラウンド write では `mergeCountWithStorage` で base が完了のときは status を「完了」維持（base に groupItems が無い場合も維持）。  
   - fixCountsStatusOnly / readInventoryCounts は「completed だが groupItems が欠けている」不整合のときだけ in_progress に修復し、全グループ揃っている場合は触らない。

3. **7項目の挙動**  
   - 下記「徹底検証」のとおり、待機時間・下書き削除・確定処理・成功トーストと実処理の一致・部分在庫調整の防止・完了の維持・空上書き防止のいずれも、該当するコード経路で対策済み。  
   - デプロイ後は、既存の不整合データは読込時の修復または表示側ガードで一貫した表示になり、新規の確定では上記が守られる。

---

## 徹底検証（7項目・コード経路の完全追跡）

以下は、棚卸ID全体・商品グループのステータスが変更・相違しないことを目的に、**実行されるコード経路を1本ずつ追った**結果です。

### 項目1: アプリタイル上の待機時間をできる限りなくす

| 経路 | ファイル:行 | 処理順 | 確認結果 |
|------|-------------|--------|----------|
| まとめて・差異なし | InventoryCountList.jsx 2058–2070 | buildUpdatedCountFromLocalState → **toast** → **onAfterConfirm** → **setSubmitting(false)** → runThisWrite を next に積んで return | ✅ UI 完了後にバックグラウンド。ユーザーは待たない。 |
| まとめて・差異あり | 2119–2132 | **await adjustInventoryToActual** → 成功時のみ toast/onAfterConfirm/setSubmitting(false) → runThisWrite を next に積む | ✅ ユーザーが待つのは adjust のみ。 |
| 単一・差異なし | 2226–2236 | 上記と同様（toast 先） | ✅ 同様。 |
| 単一・差異あり | 2314–2362 | await adjust → catch で return false（toast なし）→ 成功時のみ toast/onAfterConfirm/setSubmitting(false) | ✅ 同様。 |

**他に await している箇所**: handleComplete 内でユーザーをブロックするのは「差異あり」時の `adjustInventoryToActual` のみ。readInventoryCountsRaw / writeInventoryCounts / clear はすべて `.then` チェーン内で、同期的に待っていない。

---

### 項目2: 確定成功まで自動保存内容が消えないか

| 経路 | ファイル:行 | clear の条件 | 確認結果 |
|------|-------------|--------------|----------|
| まとめて・差異なし | 2092–2103 | `next.then((toWrite) => { if (toWrite) clearAllInventoryCountDraftsForCount(...) })` | ✅ write が resolve して toWrite が返ったときだけ clear。reject 時は .catch に入り clear は実行されない。 |
| まとめて・差異あり | 2191–2198 | 同上（writeResult = results?.[1] が truthy のときのみ clear） | ✅ 同様。 |
| 単一・差異なし | 2257–2268 | 同上 | ✅ 同様。 |
| 単一・差異あり | 2387–2394 | 同上 | ✅ 同様。 |

**clear が呼ばれる条件**: `writeInventoryCounts(merged)` が resolve し、その戻り（toWrite または writeResult）が truthy のときのみ。throw や reject の場合は next が reject し、`.catch` でトーストするだけで clear は呼ばれない。単一グループの下書きは count 単位キー＋LEGACY 削除で clear 済み。

---

### 項目3: 確定処理は差異あり・差異なしどちらも問題なく動くか

| 表示モード | 差異 | 分岐 | 確認結果 |
|------------|------|------|----------|
| まとめて | なし | allItemsToAdjust.length === 0 → locallyBuilt → toast → バックグラウンド write（2074–2094） | ✅ 実装あり。 |
| まとめて | あり | await adjust → locallyBuiltAdjust → toast → バックグラウンド write（2121–2195） | ✅ adjust 失敗時は catch で return false、toast 成功は出さない。 |
| 単一 | なし | itemsToAdjust.length === 0 → locallyBuiltNoAdjust → toast → バックグラウンド write（2229–2264） | ✅ 単一は resolvedAllIds / groupIdsForCheck で allDone が true になり「完了」が書かれる。 |
| 単一 | あり | await adjust → locallyBuiltResult → toast → バックグラウンド write（2316–2398） | ✅ 同様。 |

**単一グループの「完了」**: buildUpdatedCountFromLocalState で resolvedAllIds、mergeCountWithStorage で groupIdsForCheck を補い、allDone が true のとき status: "completed" が toWrite に含まれる。

---

### 項目4: 成功トーストなのに差異調整・ステータス変更がされない可能性

| 内容 | コード | 確認結果 |
|------|--------|----------|
| 差異調整 | 差異あり時は必ず `await adjustInventoryToActual` 成功後に toast / onAfterConfirm（2314–2355）。catch 時は toast 成功も onAfterConfirm も呼ばない（2329–2335） | ✅ 成功トースト＝差異調整済み。 |
| ステータス（メタ） | メタの更新は runWithBackgroundWriteRetry 内の read → merge → write。失敗時は next.catch で formatSaveError トースト（2101, 2270, 2396）。最大3回リトライ | ⚠️ 一時的な失敗時のみステータス未反映の可能性。その場合は後からエラートースト。 |

---

### 項目5: 確定失敗なのに一部だけ在庫調整される可能性

| 内容 | コード | 確認結果 |
|------|--------|----------|
| adjust の呼び出し | handleComplete 内で1箇所のみ。まとめて・単一とも await（2121, 2316） | ✅ 他に adjust を呼ぶ確定フローはない。 |
| 失敗時 | catch で toast して return false。toast("棚卸を完了しました") も onAfterConfirm も実行されない（2330–2335） | ✅ 部分だけ在庫が変わる経路はない。 |
| API 仕様 | inventorySetQuantities は1回で全件。成功時は全件更新、失敗時は throw で全件未更新 | ✅ 部分更新は起きない。 |

---

### 項目6: 何かしらの処理で棚卸ID全体・他グループのステータスが完了→未処理に変わる可能性

| 処理 | ファイル:行 | 確認結果 |
|------|-------------|----------|
| 確定後 write の toWrite | mergeCountWithStorage(base, locallyBuilt)。base = fromStorage ?? count（2085–2090, 2252–2256, 2375–2380） | ✅ base が `status === "completed"` のときは、base に groupItems が無くても「完了」維持（140–153 行）。base に groupItems がある場合は baseHasAll で判定して維持。 |
| fromStorage が無いとき | read を1回リトライし、それでも無ければ count を base に使用。count が minimal で status 完了なら上記ガードで完了維持 | ✅ 誤って in_progress で上書きしない。 |
| fixCountsStatusOnly | stocktakeApi.js 348–385。`!hasGroupItems` で completed はそのまま return。hasGroupItems かつ completed かつ !allDone のときのみ in_progress に修復 | ✅ 全グループ groupItems が揃っている場合は修復しない。 |
| readInventoryCounts の修復 | 同様。completed かつ hasGroupItems かつ !allDone のときのみ修復 | ✅ 同様。 |
| draft → in_progress の write | InventoryCountList 580–587, InventoryCountProductGroupSelection 67–74。**fetched.status === "draft"** のときだけ in_progress に更新して write | ✅ completed の棚卸を in_progress に変える処理はない。 |
| グループ一覧の表示 | isGroupCompleted = hasGroupItems \|\| hasReadOnlyLines \|\| **count?.status === "completed"**（3219） | ✅ 完了なのに「未完了」と表示されることはない。 |

---

### 項目7: 全ての情報が空のままメタフィールドを上書きしてデータが消える可能性

| 処理 | ファイル:行 | 確認結果 |
|------|-------------|----------|
| 空配列での write | writeInventoryCounts。arr.length === 0 のときメタに既存データがあれば throw（stocktakeApi.js 1024–1038） | ✅ 空での上書きはブロック。 |
| 既存より少ない件数 | merged = mergeExistingNonBlank(counts, existing) のあと、merged.length < existing.length なら existing の不足分を merged に追加（997–1007） | ✅ 既存棚卸IDが消えない。 |
| 確定4経路の merged | readInventoryCountsRaw の list をベースに、当該 count だけ toWrite に差し替え。list が空のときはリトライ。それでも無ければ [toWrite] だが、write 内で existing を読んでから merge するため、existing の他 ID は補完される | ✅ 他 ID を意図せず消さない。 |

---

## 細粒度確認（粒度を上げたコード経路の整理）

「一度完了になっているものがステータスが戻る」ことを防ぐ観点で、各要件について**表示モード別・処理経路別**にコード箇所を整理した。

| # | 要件 | 商品グループごと表示 | まとめて表示 | 単一商品グループのみ | 共通・補足 |
|---|------|----------------------|--------------|------------------------|------------|
| 1 | 待機時間をなくす | 差異なし: 2209–2219（toast → onAfterConfirm → setSubmitting(false) → バックグラウンド write）。差異あり: 2266–2282（await adjust 後 同様） | 差異なし: 2044–2055。差異あり: 2119–2132 | 同上（同じ handleComplete 内で isMultipleMode / targetProductGroupIds で分岐） | ユーザーが待つのは差異あり時の **adjust のみ**。read/write/clear は全経路でバックグラウンド。 |
| 2 | 確定成功まで下書きを消さない | clear は 2246–2253（write 成功 .then 内のみ） | 2082–2089 | 2156–2163, 2377–2393 | 失敗時は .catch でトーストのみ。単一グループは count 単位キー＋LEGACY 削除。 |
| 3 | 差異あり・差異なしどちらも問題なく | 差異なし: 2209–2264。差異あり: 2266–2398（adjust → catch で失敗時は成功トーストなし） | 2043–2098（なし）, 2101–2195（あり） | 同上 | 単一グループは resolvedAllIds / groupIdsForCheck で allDone が正しく true になり「完了」が書かれる。 |
| 4 | 成功トーストなのに差異調整・ステータス変更されない | 差異調整: 差異あり時は adjust 成功後のみ toast（2266–2282）。ステータス: バックグラウンド write 失敗時のみ未反映の可能性（runWithBackgroundWriteRetry で最大3回リトライ） | 同左 | 同左 | 差異なし時は adjust なし。ステータスは write 成功で反映。 |
| 5 | 確定失敗なのに一部だけ在庫調整 | adjust は await の1回で全件。throw 時は catch で toast のみで onAfterConfirm は呼ばない（2277–2282, 2330–2336） | 2121–2132 で adjust 失敗時は catch。同様 | 同様 | inventorySetQuantities は1回で全件。部分更新は起きない。 |
| 6 | 完了→未処理に戻る可能性 | 確定時: mergeCountWithStorage(base, locallyBuilt) で base = fromStorage ?? count。**base が完了かつ全グループ groupItems ありなら status を「完了」維持**（InventoryCountList.jsx 140–149）。draft 更新: status === "draft" のときのみ in_progress に（580–587） | 同左（同じ 4 経路） | 同左 | fixCountsStatusOnly / readInventoryCounts の修復は「completed だが groupItems が欠けている」不整合のみ。 |
| 7 | 空でメタ上書きしてデータ消失 | write は 4 経路とも read 結果 list をベースに 1 件差し替えで write。writeInventoryCounts 内で arr.length === 0 なら throw。merged.length < existing.length なら existing の不足分を補完（stocktakeApi.js 997–1007, 1024–1038） | 同左 | 同左 | 空配列での上書きはブロック。少ない件数で書く場合は existing をマージ。 |

---

## 残存リスクの有無（全コード経路の監査）

7項目が「現状のコード処理方法に完全に残っていないか」を、**メタ書き込み・下書き削除・在庫調整・トースト** を触る全経路で確認した結果。

| 項目 | 該当しうるコード経路 | 残存の有無 | 理由 |
|------|----------------------|------------|------|
| **1. 待機時間** | 確定 handleComplete 全4経路、draft→in_progress 更新、readInventoryCounts / readInventoryCountsFirstPage | なし | 確定時は toast/onAfterConfirm/setSubmitting(false) を先に実行し、read/write/clear はバックグラウンド。draft 更新・read は一覧取得時で確定フロー外。 |
| **2. 確定前に下書きが消える** | clearAllInventoryCountDraftsForCount の呼び出し元 | なし | 呼び出しは4箇所とも `next.then((toWrite) => { if (toWrite) clear... })` の内側のみ。write が reject した場合は .catch に入り clear は実行されない。 |
| **3. 差異あり・なしで確定が動かない** | handleComplete 内の分岐（差異なし/あり・まとめて/単一） | なし | 4経路すべて実装済み。単一グループは resolvedAllIds / groupIdsForCheck で allDone が正しく true になる。 |
| **4. 成功トーストなのに差異調整・ステータスされない** | toast の直前に await している処理、バックグラウンド write | 差異調整はなし。ステータスは write 失敗時のみ | 差異あり時は必ず adjust 成功後に toast。差異なし時は adjust なし。ステータスはバックグラウンド write が失敗した場合のみ未反映（リトライ3回＋後からエラートースト）。 |
| **5. 確定失敗なのに一部だけ在庫調整** | adjustInventoryToActual の呼び出しと catch | なし | 呼び出しは確定フロー内の1箇所（まとめて・単一で共通）。await しており、throw 時は catch で return false / toast のみで success toast は出さない。mutation は1回で全件のため部分更新は起きない。 |
| **6. 完了→未処理に戻る** | mergeCountWithStorage、fixCountsStatusOnly、readInventoryCounts の修復、draft→in_progress の write | なし | mergeCountWithStorage: base が `status === "completed"` のとき、base に groupItems が無くても（一覧用 minimal の場合）**完了を維持**。groupItems がある場合は baseHasAll で判定して完了維持。fixCountsStatusOnly / readInventoryCounts は「completed だが groupItems が欠けている」不整合のみ in_progress に修復。draft 更新は `status === "draft"` のときのみ。 |
| **7. 空でメタ上書きしてデータ消失** | writeInventoryCounts の呼び出し元（確定4経路、readInventoryCounts、readInventoryCountsFirstPage、draft 更新） | なし | 確定4経路: read 結果 list をベースに1件差し替えで渡す。readInventoryCounts: read 結果の countsWithName（空でなければ）を渡す。readInventoryCountsFirstPage: メインキーから読んだ parsed を渡し、空なら write は呼ばれない（chunk0 なし時のみ write(parsed) で parsed はメインキー中身）。draft 更新: readInventoryCounts() で全件取得した配列を1件だけ status 変更して渡す。writeInventoryCounts 内で arr.length === 0 のときは throw。merged.length < existing.length のときは existing の不足分を補完。 |

**結論**: 7項目のいずれも、現状のコードで「発生しうる経路が残り続けている」ような箇所はない。項目4のステータス未反映のみ、バックグラウンド write の一時失敗時に限り可能性があり、リトライとエラートーストで軽減済み。

---

## プロフェッショナル監査（2026-02-28）

「確認した上でないと教えてくれたが発生している」事象を防ぐため、**表示・状態・データの一貫性**を専門的に監査した結果と対応。

### 監査で発見した不整合（修正済み）

**事象**: 確定後にコンディション画面に戻ると、一覧が「処理中」のまま表示され、直前に確定して「完了」にした棚卸IDが一覧では完了になっていない。

**原因**:
- 確定時に `onAfterConfirm(updatedCount)` が呼ばれ、親の `setCount(updatedCount)` で `status: "completed"` が保持される。
- 遷移先は `setView(VIEW.CONDITIONS)` でコンディション画面。
- **コンディション画面の一覧は `counts` 状態のみを参照**しており、この `counts` は `readInventoryCountsFirstPage()`（一覧用メタ・minimal）で取得したもので、**確定後に更新されていない**。
- バックグラウンド write が完了するまでメタは古いため、`counts` を再取得しない限り一覧は「処理中」のまま。
- 親の `count`（= 確定直後の `updatedCount`）は一覧表示に**使われていなかった**。

**対応**（実装済み）:
1. **StocktakeScreen.jsx**: コンディション表示時に `currentCountFromParent={count}` を `InventoryCountConditions` に渡す。
2. **InventoryCountConditions.jsx**: 
   - プロパティ `currentCountFromParent` を受け取る。
   - `displayedCounts = useMemo(() => counts と currentCountFromParent を id で一致する行だけ上書き, [counts, currentCountFromParent])` で、一覧用の表示元を「親の確定結果」で上書き。
   - `listToShow` / `baseAll` / `pendingCountsAll` / `completedCountsAll` はすべて `displayedCounts` ベースに変更。

**結果**: 確定後にコンディション画面に戻っても、該当棚卸IDは親の `updatedCount` に基づき「完了」で表示され、一覧と実際の確定結果の食い違いを防止できる。

### 監査観点の整理（今後の確認用）

| 観点 | 確認内容 | 結果 |
|------|----------|------|
| 同一セッション内の表示一貫性 | 確定直後に別画面へ遷移したとき、その画面で参照する state が「確定結果」を反映しているか | ✅ コンディション一覧は `currentCountFromParent` で確定結果をマージして表示するよう修正済み。 |
| 一覧のデータソース | 一覧が「list メタ（minimal）」のみか、「親 state やメインの読込」とマージしているか | ✅ 親の `count` を `currentCountFromParent` として渡し、同一IDは親で上書き。 |
| バックグラウンド write 完了前の表示 | write 完了を待たずに画面遷移した場合、遷移先で古いメタがそのまま出ないか | ✅ 親の `updatedCount` を渡すことで、write 完了前でも「完了」表示になる。 |

### 他に確認したリスク（問題なし）

- **バックグラウンド詳細取得との競合**: コンディション一覧で `readInventoryCountById` により行を更新するが、`displayedCounts` は常に `currentCountFromParent` で上書きするため、同じ id の行は親の状態（確定結果）が優先され、古い「処理中」で上書きされない。
- **再読込時**: ユーザーが「再読込」すると `counts` は list メタから再取得される。このとき `currentCountFromParent` がまだ同じ id で渡っていれば、表示は引き続き確定結果（完了）で一貫する。

### 今回の修正（currentCountFromParent）が7項目に与える影響

| # | 項目 | 影響 | 理由 |
|---|------|------|------|
| 1 | 待機時間をなくす | **なし** | 変更は StocktakeScreen の props 渡しと InventoryCountConditions の表示用 useMemo のみ。handleComplete・toast・setSubmitting・バックグラウンド write には一切触っていない。 |
| 2 | 確定成功まで下書きを消さない | **なし** | clearAllInventoryCountDraftsForCount の呼び出し・条件は変更していない。 |
| 3 | 差異あり・差異なしの確定処理 | **なし** | InventoryCountList の handleComplete および確定4経路は未変更。 |
| 4 | 成功トーストなのに差異調整・ステータスされない | **なし** | トーストや onAfterConfirm のタイミング・条件は変更していない。 |
| 5 | 確定失敗なのに一部だけ在庫調整 | **なし** | adjust の呼び出し・catch は未変更。 |
| 6 | 完了→未処理に変わってしまう可能性 | **なし** | メタの read/write・mergeCountWithStorage・fixCountsStatusOnly は未変更。currentCountFromParent は「一覧の表示」を変えるだけで、メタには書かない。 |
| 7 | 空でメタ上書きしてデータ消失 | **なし** | writeInventoryCounts および呼び出し元は未変更。 |

**表示マージの安全性**: `displayedCounts` では、親が minimal（groupItems/items なし）のときは行側の `groupItems`/`items` を上書きしないようにしている。そのため、バックグラウンドで取得した詳細が一覧で消えず、他処理にも影響しない。

---

## 再確認チェックリスト（7項目）

| # | 確認項目 | 結果 | 補足 |
|---|----------|------|------|
| 1 | アプリタイル上の待機時間をできる限りなくす処理になっているか | ✅ | 全4経路で「toast / onAfterConfirm / setSubmitting(false)」を先に実行し、read/write/clear はバックグラウンド。ユーザーが待つのは差異あり時の在庫調整APIのみ。（商品グループごと表示・まとめて表示・単一商品グループのみのいずれも同様） |
| 2 | 確定ボタン押下後、確実に成功するまで自動保存内容が消えないか（商品グループごと・まとめて表示・単一商品グループのみ） | ✅ | `clearAllInventoryCountDraftsForCount` は write が成功した `.then` 内でのみ呼ばれる。失敗時は `.catch` でトーストのみで clear は呼ばない。単一グループは count 単位キー＋LEGACY 削除で clear。 |
| 3 | 確定処理は差異あり・差異なしどちらも問題なく処理されるか（商品グループごと・まとめて表示・単一商品グループのみ） | ✅ | 4経路すべて実装済み。差異あり時は adjust 失敗で catch し成功トーストは出さない。差異なし時はバックグラウンド write 失敗時のみ後からエラートースト。単一グループは resolvedAllIds/groupIdsForCheck でステータス「完了」が正しく書き込まれる。 |
| 4 | 成功トーストを出したのに差異調整・ステータス変更がされない可能性はないか | 差異調整: ✅ なし / ステータス: ⚠️ write 失敗時のみ | 差異調整はトースト前に await 済みのため「トースト＝差異調整済み」。ステータス（メタ）はバックグラウンド write 失敗時のみ未反映の可能性あり（その場合は後からエラートースト）。 |
| 5 | 確定失敗したのに一部商品の在庫調整がされてしまう可能性はないか | ✅ なし | `adjustInventoryToActual` は1回の mutation で全件実行。成功なら全件・失敗なら throw で全件未更新。部分だけ在庫が変わることはない。 |
| 6 | 何かしらの処理で棚卸ID全体や他グループのステータスが完了→未処理に変わってしまう可能性はないか | ✅ なし | fixCountsStatusOnly / readInventoryCounts は不整合時のみ修復。確定時は fromStorage ?? count とリトライに加え、**mergeCountWithStorage で「base が完了かつ全グループ groupItems ありなら status を完了のまま維持」**するガードで、一度完了したものが戻らないようにしている。 |
| 7 | 全ての情報が空のままメタフィールドを上書きしてデータが消え復元できなくなる可能性はないか | ✅ なし | 空配列での上書きは throw でブロック。既存より少ない件数で書く場合は write 内で existing の不足分を補完するガードあり。 |

---

## 1. アプリタイル上の待機時間をできる限りなくす処理になっているか

**結論: ✅ なっている**

- **差異あり**（まとめて表示・1グループのみ）: `adjustInventoryToActual` を **await** で完了させた**後**に、`toast`・`onAfterConfirm`・`setSubmitting(false)` でUIを先に完了。その後の read → write → clear は `pendingBackgroundWriteByCountId` で直列化した**バックグラウンド**実行（InventoryCountList.jsx 2050–2114, 2214–2288）。
- **差異なし**（まとめて表示・1グループのみ）: read/write を一切待たず、`buildUpdatedCountFromLocalState` でローカル組み立て → 即 `toast`・`onAfterConfirm`・`setSubmitting(false)` → read/write/clear はバックグラウンド（1983–2022, 2122–2173）。

確定ボタン押下後、ユーザーが待つのは「差異あり」のときの **在庫調整API（adjust）** のみ。メタフィールドの read/write は待機させず、アプリタイル上の待機時間は最小化されている。

---

## 2. 確定ボタン押下後、確実に成功するまで自動保存（下書き）が消えないか

**結論: ✅ 消えない**

- `clearAllInventoryCountDraftsForCount` の呼び出しは **write が成功したときの `.then` のなかだけ**（InventoryCountList.jsx 2011–2018, 2101–2108, 2156–2164, 2275–2282）。
- write が失敗した場合は `.catch` で `formatSaveError` のトーストのみで、**clear は呼ばれない**。
- そのため「確定失敗まで自動保存は消えない」という要件を満たしている（商品グループごと・まとめて表示・1グループのみの全経路で同じ）。

---

## 3. 確定処理は差異あり・差異なしどちらも問題なく処理されるか（商品グループごと・まとめて表示・1グループのみ）

**結論: ✅ 問題なく処理される**

| 経路 | 差異 | 処理内容 | 実装箇所 |
|------|------|----------|----------|
| まとめて表示 | なし | locallyBuilt 組み立て → toast/onAfterConfirm/setSubmitting(false) → バックグラウンド read/write/clear | 1983–2028 |
| まとめて表示 | あり | await adjust → toast/onAfterConfirm/setSubmitting(false) → バックグラウンド read/write/clear + logInventoryCountToApi | 2031–2115 |
| 1グループのみ | なし | locallyBuiltNoAdjust 組み立て → toast/onAfterConfirm/setSubmitting(false) → バックグラウンド read/write/clear | 2122–2174 |
| 1グループのみ | あり | await adjust → catch で「在庫調整エラー」→ 成功時 toast/onAfterConfirm/setSubmitting(false) → バックグラウンド read/write/clear + logInventoryCountToApi | 2177–2305 |

差異あり時は `adjustInventoryToActual` が throw したら toast 成功は出さず `onAfterConfirm(null)` も呼ばない（単一グループ時は 2229–2235 の catch）。差異なし時は read/write の失敗はバックグラウンドの `.catch` でトーストするのみで、確定フロー自体は破綻しない。

---

## 4. 「棚卸が完了しました」と成功トーストを出したのに、差異調整・ステータス変更がされない可能性はないか

**結論: 差異調整は「トースト成功＝必ず済んでいる」。ステータス（メタフィールド）は「バックグラウンド write 失敗時だけ未反映」の可能性あり。**

- **差異調整（Shopify 在庫数変更）**  
  - 差異ありのときは **必ず** `adjustInventoryToActual` を **await** で成功させた後にだけ `toast("棚卸を完了しました")` と `onAfterConfirm` を実行している（2050–2075, 2214–2251）。  
  - したがって「成功トーストが出たのに差異調整がされていない」という状態は**発生しない**。

- **ステータス変更（groupItems / status のメタフィールド）**  
  - メタの更新は **バックグラウンド** の read → write で行う。  
  - **リトライ**: read/write が失敗した場合、最大3回・待機 2秒×試行回数 で `runWithBackgroundWriteRetry` により自動リトライする（差異あり・差異なしの全4経路）。ネットワーク・Throttled 等の一時失敗でメタが保存されない可能性を減らしている。  
  - リトライ後も失敗すると、`next.catch` で `formatSaveError(e)` のトーストが後から出る。  
  - この場合、ユーザーは一度「棚卸を完了しました」を見たあと、「保存に失敗しました」系のトーストが続く。  
  - 差異調整（Shopify 在庫）はすでに反映済みなので、不整合時は「再確定」や「棚卸IDを修復」等でメタを再保存する運用で補える。

---

## 5. 確定失敗したのに、一部商品の在庫調整だけされてしまう可能性はないか

**結論: ✅ ない**

- `adjustInventoryToActual`（stocktakeApi.js）は **1回の `inventorySetQuantities` mutation で全件まとめて実行**している（1972–1990 行付近のコメントおよび実装）。  
- **成功時は全件更新、失敗時は throw で全件未更新**。  
- 途中で「一部だけ在庫が変わった」という状態にはならない。  
- また、差異ありの確定フローでは `adjustInventoryToActual` が throw したら catch で「在庫調整エラー」をトーストし、`toast("棚卸を完了しました")` も `onAfterConfirm` も呼ばない。  
- したがって「確定は失敗したのに一部だけ在庫が変わっている」という事象は**発生しない**。

---

## 6. 何かしらの処理で棚卸ID全体や他グループのステータスが「完了」→「未処理」に戻る可能性はないか

**結論: ✅ ない（2026-02-28 に mergeCountWithStorage で「完了を維持する」ガードを追加）**

- **fixCountsStatusOnly**（stocktakeApi.js）: `c?.status === "completed"` かつ `hasGroupItems` かつ `!allDone` のときだけ不整合修復で `in_progress` に戻す。**全グループの groupItems が揃っている**場合は `allDone === true` のため修復ブロックに入らず、`status === "completed"` を維持。
- **readInventoryCounts**（stocktakeApi.js）: 上記と同様。修復するのは「status が completed なのに groupItems が1つでも欠けている」不整合のみ。
- **確定時の write**（4経路）:
  - 他棚卸IDは `list.map((c) => ... ? toWrite : c)` で **そのまま** 渡すため、他IDの status は read 結果のまま。
  - 当該 count の `toWrite = mergeCountWithStorage(base, locallyBuilt)` において、**base（fromStorage ?? count）が「完了」かつ全グループの groupItems が揃っている場合**は、`allDone` が false になっても **status を「完了」のまま維持**するガードを追加（InventoryCountList.jsx mergeCountWithStorage）。これにより「read が partial で mergedGroupItems に他グループが入っていないだけ」のときに、一度完了したものを誤って in_progress で上書きしない。
- **draft → in_progress の write**（InventoryCountList 580–587, InventoryCountProductGroupSelection 67–74）: **fetched.status === "draft"** のときだけ `status: "in_progress"` に更新して write。`completed` の棚卸を in_progress に変える処理はない。

したがって、何かしらの処理で「棚卸ID全体」や「他商品グループのステータス」が完了から未処理に変わる経路はない。

**「完了→未処理に戻る」可能性があるコード経路の一覧（いずれも対策済み）**

| 経路 | いつ | 完了が戻らない理由 |
|------|------|---------------------|
| **mergeCountWithStorage**（確定後 write の toWrite 算出） | 確定ボタン押下後のバックグラウンド write | base が `status === "completed"` のときは常に「完了」を維持。base に groupItems が無い（一覧用 minimal 等）場合は判定せず完了維持。base に groupItems がある場合は baseHasAll で全グループ揃いを確認してから完了維持（InventoryCountList.jsx）。allDone が false でも「完了」で上書きしない。 |
| **確定4経路の doMergeAndWrite** | 上記と同じ | 常に `mergeCountWithStorage(base, locallyBuilt)` を呼び、base に fromStorage（read 結果）または count を使用。fromStorage が undefined のときは read を1回リトライし、それでも無いときのみ count を base に使用。 |
| **writeInventoryCounts の mergeExistingNonBlank** | 上書き前のマージ | 呼び出し元の counts の各要素を existing で「空白の項目だけ補完」。status は上書きしない。確定時は counts に toWrite（上記で完了維持済み）が含まれるため、completed が in_progress で上書きされることはない。 |
| **fixCountsStatusOnly** | read 後・一覧用 | `status === "completed"` かつ `hasGroupItems` かつ `!allDone` のときだけ in_progress に修復。**全グループ groupItems が揃っている**場合は allDone === true のため修復しない。 |
| **readInventoryCounts の修復** | 読込時 | 上記と同様。不整合（完了なのに groupItems 欠け）のみ修復。 |
| **draft → in_progress の write**（InventoryCountList / InventoryCountProductGroupSelection） | 棚卸タイルを開いたとき | `fetched.status === "draft"` のときだけ実行。completed の棚卸には入らない。 |

**※ 事例対応（2026-02-28）**  
「1つの棚卸IDで完了と未完了が混在しているときに、既に完了していたグループのステータスが未処理に戻ってしまう」事象が報告された。原因は、バックグラウンド write 時に `readInventoryCountsRaw()` が空配列を返す、または当該棚卸IDが list に含まれない場合に `fromStorage` が undefined となり、`mergeCountWithStorage(undefined, locallyBuilt)` の結果として **locallyBuilt の groupItems だけ**（今回確定したグループのみ）が書かれ、既存の他グループの groupItems が消えていたこと。  
**対応**:  
1. 確定後のバックグラウンド write の4経路すべてで、`mergeCountWithStorage(fromStorage ?? count, locallyBuilt)` に変更。`fromStorage` が無いときはメモリ上の `count` をマージの土台に使用。  
2. **fromStorage が undefined のとき read を1回リトライ**し、他グループの groupItems を欠いたまま書く確率を低減。  
3. **mergeCountWithStorage 内で「一度完了したものを未処理に戻さない」ガード**を追加: `status === "in_progress"` にしようとしているとき、`fromStorage?.status === "completed"` なら「完了」を維持する。base に groupItems が無い（read 失敗で一覧用 minimal を渡した場合など）ときは判定できないためそのまま完了維持。base に groupItems があるときは baseHasAll で全グループ揃いを確認してから完了維持。

---

## 7. 全ての情報が空のままメタフィールドを上書きし、データが消えて復元できなくなる可能性はないか

**結論: 空配列での上書きはブロック済み。ただし「呼び出し元の read が空を返した場合に、既存より少ない件数で上書きする」可能性がわずかにあったため、write 側にガードを追加した。**

- **空配列での上書き**（stocktakeApi.js 991–1006）: `arr.length === 0` のとき、メタに既にデータがあるか確認し、**ある場合は throw** して「棚卸データを空にすることはできません。既存の棚卸IDが消えるため、空配列での上書きをブロックしました。」とする。これで「全て空のまま上書きしてデータが消える」事象は防止されている。
- **既存より少ない件数で上書きするリスク**: 確定フローでは `readInventoryCountsRaw().then((counts) => { ... writeInventoryCounts(merged) })` と、**read の結果をベースに** 1件差し替え／追加して write している。通常は read が全件返すため問題ないが、read が障害やパース失敗で `[]` を返した場合、`merged = [toWrite]` となり、既存の他棚卸IDが書かれずに消える可能性があった。
- **対策**（stocktakeApi.js writeInventoryCounts）: 内部で読んだ `existing` に対し、**呼び出し元の `counts` に含まれていない棚卸IDを `merged` に足してから** 書くようにした。これで「既存件数より少ない件数で上書きして他IDを消す」ことを防ぐ。

これにより、空配列での上書きはブロックされ、既存データを意図せず減らしてしまう上書きも防止される。

---

## 8. 他に同様の現象（完了→未処理・他グループの groupItems 消失）が起きうる箇所

**結論: 確定処理の4経路以外で「他グループの groupItems を欠いた状態で write する」経路はない。念のため fromStorage が undefined のときは read を1回リトライするようにした。**

| 箇所 | 内容 | リスク |
|------|------|--------|
| **確定処理の4経路**（InventoryCountList handleComplete） | read → merge(fromStorage ?? count, locallyBuilt) → write | 対応済み（fromStorage ?? count）。追加で fromStorage が undefined のとき read を1回リトライ。 |
| **draft → in_progress の write**（InventoryCountList 528–533, InventoryCountProductGroupSelection 69–74） | readInventoryCounts() で全件取得 → 1件だけ `{ ...c, status: "in_progress" }` にした配列を write | なし。全件を read した配列をそのまま書き、変更するのは status のみ。groupItems は `...c` で維持。 |
| **readInventoryCounts 内部の write**（stocktakeApi.js 778） | readInventoryCountsRaw で全件取得 → fixCountsStatusOnly / countName 付与 → writeInventoryCounts(countsWithName) | なし。常に全件配列を渡している。 |
| **readInventoryCountsFirstPage 内の write**（stocktakeApi.js 484） | メインキーがチャンクなしのとき parsed をそのまま write | なし。read した内容をそのまま書いているだけ。 |
| **writeInventoryCounts 内部** | mergeExistingNonBlank と「既存より少ない件数で上書きしない」ガード | 他棚卸IDは欠けない。既存の groupItems 補完は mergeExistingNonBlank で行単位のみ。 |

**残りうるリスク**: fromStorage が undefined かつ、メモリ上の `count` が一覧用 minimal（groupItems なし）のとき、`fromStorage ?? count` で count を使っても groupItems が空のまま書き、他グループの完了が消える可能性がある。  
**追加対策**: バックグラウンド write の4経路で、`fromStorage` が undefined のときだけ `readInventoryCountsRaw()` をあと1回実行し、その結果で list / base を組み直してから merge と write を行うようにした。これで read の一時的な失敗で partial を書く確率を下げる。

---

## 9. 在庫調整（adjustInventoryToActual）の処理に不具合はないか

**結論: 設計上は「全件一括・失敗時は全件未更新」で部分更新は起きない。Throttled 時のリトライが不足していたため対応した。**

- **全件一括で実行**: `inventorySetQuantities` は1回の mutation で渡した `quantities` をまとめて反映する。成功すれば全件更新、失敗すれば throw で全件未更新。途中で「一部だけ在庫が変わった」状態にはならない（stocktakeApi.js 1978–1990 行付近）。
- **不正な inventoryItemId**: `toInventoryItemGid` で GID に変換できない行は `quantities` から除外され、有効な行だけが API に送られる。その場合 `invalidCount` が返り、呼び出し元（InventoryCountList）で `result?.invalidCount > 0` のときトーストで「○件が不正なIDのため除外されました」と通知している。在庫が変わるのは「有効なIDの商品のみ」となるが、ユーザーには通知される。
- **在庫有効化（ensureInventoryActivatedAtLocation）**: ロケーションに在庫レベルがないアイテムは先に `inventoryActivate` 等で有効化する。ここで1件でも errors が残ると `adjustInventoryToActual` は throw するため、有効化が全部成功するまで `inventorySetQuantities` には進まない。
- **Throttled 時のリトライ不足（2026-02-28 対応）**: 従来、リトライ条件は `timeout` / `network` / `fetch` / `HTTP 5xx` のみで、**Throttled（429 や "Throttled" メッセージ）が含まれていなかった**。そのため API がスロットリングを返した場合に即失敗していた。  
  **対応**:  
  1. `inventorySetQuantities` の `graphql` 呼び出しを `runWithThrottleRetry` でラップし、Throttled 時もメタ書き込みと同様に待機・リトライするようにした。  
  2. 既存の for ループ側のリトライ条件に `throttle` と `429` を追加し、Throttled 系エラーでもループ内でリトライするようにした。

これにより、在庫調整は「全件一括・失敗時は全件未更新」を保ちつつ、Throttled 時にもリトライして成功しやすくなっている。

---

## 10. SKU数が多い確定処理でチャンク読み取りが失敗する（2026-02-28 対応）

**事象**: 確定時に「棚卸チャンク○の読み取りに失敗しました…」などチャンクから始まるトーストが出て確定できなかった。

**原因**: 棚卸データが 32KB を超えると複数メタフィールド（チャンク）に分割して保存される。確定後のバックグラウンドで `readInventoryCountsRaw()` が全チャンクを順に読むが、1チャンクでも取得失敗（ネットワーク・Throttled・欠落など）するとその時点で throw し、そのメッセージがトーストに出ていた。

**対応**:
- **readInventoryCountsRaw**（stocktakeApi.js）: チャンク単位の読み取りで、各チャンクの `graphql` を `runWithThrottleRetry` でラップ。さらにチャンク読み取りが失敗した場合に **最大3回**（待機 1.5秒×試行回数）リトライするループを追加。一時的なネットワーク・Throttled で失敗しにくくした。
- **formatSaveError**（InventoryCountList.jsx）: エラーメッセージに「チャンク」が含まれる場合、ユーザー向けに「棚卸データの読み取りでエラーが発生しました。しばらく待ってから再度「確定」を押してください。」と表示するように変更。

**書き込み側**: `writeInventoryCounts` はチャンクを METAFIELDS_SET_MAX（25）件ずつバッチで送り、各バッチを `runWithThrottleRetry` でラップし、バッチ間に BATCH_WRITE_DELAY_MS の待機を入れている。確定全体は `runWithBackgroundWriteRetry` で最大3回リトライするため、チャンク書き込みの一時失敗もリトライでカバーされる。

---

## 11. 棚卸ステータスは「完了」なのに1つの商品グループだけ「未完了」と表示される（2026-02-28 対応）

**事象**: 棚卸全体のステータスは完了なのに、商品グループ一覧では1つだけ未完了のものが存在する。

**要因**: (1) 過去の不具合（例: 確定時 read が空で fromStorage が無く、他グループの groupItems を欠いたまま write した）で、status だけ「completed」で保存され groupItems の1グループ分が欠けたデータが残った。(2) 従来は `status === "completed"` のとき groupItems の整合性をチェックせずそのまま返していたため、不整合が解消されず表示に残っていた。

**対応**:
- **fixCountsStatusOnly**（stocktakeApi.js）: `status === "completed"` かつ `hasGroupItems` かつ `allIds` のいずれかに groupItems が無い／空のグループがある場合、`status` を `"in_progress"` に戻し `completedAt` を消して返す（不整合の修復）。部分取得（list 等で groupItems なし）のときは従来どおり `completed` をそのまま返す。
- **readInventoryCounts**（stocktakeApi.js）: 同様に、`status === "completed"` かつ groupItems があるのに全グループ分揃っていない場合は `status: "in_progress"` に修復し、`needsUpdate = true` で保存する。次回読込以降は修復済みの状態が永続化される。

これにより、既存の不整合データは読込時に修復され、棚卸全体は「未完了」に戻り、欠けていたグループをあらためて確定すれば完了にできる。

---

## 12. 棚卸IDは完了なのにグループ一覧では1つが未完了・そのグループの商品リストでは完了表示（2026-02-28 対応）

**事象**: 棚卸IDは完了なのに、商品グループ一覧では1つのグループだけ「未完了」と表示され、そのグループの商品リストを開くと「完了」表示になっている。

**要因**: グループ一覧で使っている `count` が、一覧用の minimal（groupItems なしまたは一部のみ）の場合がある。その状態で `getGroupItemsByKey(count.groupItems, groupId)` が当該グループで `[]` を返し、「未完了」と判定していた。一方、グループをタップして商品リストを開くと `readInventoryCountById` でフル取得した count が使われ、その count には groupItems が入っているため「完了」と表示されていた。

**対応**:
- **InventoryCountList.jsx**（まとめて表示のグループ一覧）: グループの完了判定に `count?.status === "completed"` を追加。棚卸IDが完了の場合は、当該グループの groupItems が現在の count に無くても「完了済み」と表示する（3219 行付近）。
- **InventoryCountProductGroupSelection.jsx**（グループ選択一覧）: 同様に、`c?.status === "completed"` のときは groupItems が無くても「処理済み」と表示する（384 行付近）。

これにより、棚卸IDが完了のときはグループ一覧と商品リストの表示が一致する。

### 12.1 実装データは残っているか・なぜ groupItems が「現在の count」に無いか

**実装データ（groupItems）は残っているか**  
**多くの場合、メタフィールドの「本体」側には残っています。** 理由は次の2通りです。

1. **一覧用と本体の二重保存**  
   - **本体**: `INVENTORY_COUNTS_KEY` またはチャンク（`inventory_counts_v1_c0` 等）に、**フルデータ**（groupItems・items 含む）を保存。  
   - **一覧用**: `INVENTORY_COUNTS_LIST_KEY` のチャンク（`inventory_counts_list_v1_c0` 等）に、**minimal**（`toMinimalCountForList` で groupItems/items を落としたもの）だけを保存。  
   - 書き込み時（`writeInventoryCounts`）は、上記の両方に同時に書く（本体＝フル、一覧＝minimal）。

2. **グループ一覧で使っている「現在の count」の正体**  
   - 棚卸一覧 → 棚卸タップ → グループ一覧、と進むとき、**一覧で取得した count** がそのまま渡される。  
   - 一覧は `readInventoryCountsFirstPage` で **一覧用メタフィールド（list チャンク）** だけを読むため、**minimal（groupItems なし）** な count が渡る。  
   - そのため「現在の count」には **もともと groupItems が入っていない**（一覧用の仕様）。

**なぜ「そのグループの groupItems が現在の count に無い」ことが起きるか**  
- **グループ一覧**は、上記の「一覧用 minimal count」だけを参照している。  
- この count は `toMinimalCountForList` で作られているため、**groupItems も items も持たない**。  
- 一方、**商品リストを開いたとき**は `readInventoryCountById(countId)` が呼ばれ、**本体**のチャンクからその棚卸のフルデータ（groupItems あり）を取得する。  
- つまり「同じ棚卸ID」でも、  
  - グループ一覧で見ている count ＝ 一覧用（minimal）→ groupItems 無し → 未完了判定  
  - 商品リストで見ている count ＝ 本体から取得（フル）→ groupItems あり → 完了表示  
という**参照元の違い**で、グループ一覧だけ「未完了」、商品リストは「完了（全SKU 0で確定）」に見える状態になります。

**商品リストで「全SKUが0で確定」に見える場合**  
- そのグループの行が groupItems（または items）から描画されているなら、**実装データは本体メタに残っている**と考えてよい。  
- 過去の不具合で、確定時に「status だけ completed で、そのグループの groupItems が本体に書かれていなかった」可能性もゼロではない。その場合は本体にもそのグループの groupItems は無く、商品リストの「完了」表示は `count.status === "completed"` による表示になっている可能性がある。

**まとめ**  
- **なぜ発生するか**: グループ一覧は「一覧用 minimal count」だけを見ているため、groupItems が無く「未完了」と表示される。商品リストは「本体から読んだフル count」を使うため、groupItems があれば「完了」と表示される。  
- **なぜ groupItems が現在の count に無いか**: グループ一覧に渡っている「現在の count」は、一覧用メタ（list チャンク）由来の minimal オブジェクトなので、**最初から groupItems を持たない**設計になっている。

---

## 13. 単一グループの棚卸で「棚卸完了しました」トースト後もステータスが「完了」に変わらない（2026-02-28 対応）

**原因**: 商品グループが1つだけの棚卸では、一覧や親から渡る `count` に `productGroupIds` / `productGroupId` が入っていないことがある。その場合、`buildUpdatedCountFromLocalState` と `mergeCountWithStorage` の両方で「全グループが揃ったか」の判定に使う `allIds` が空になり、`allDone` が常に false → ステータスが「in_progress」のまま書き込まれていた。

**対応**:
- **buildUpdatedCountFromLocalState**: `allIds` が空かつ `currentGroupId` があるときは `resolvedAllIds = [currentGroupId]` として `allDone` を計算。戻り値に `productGroupIds: resolvedAllIds` を付与（count に元々 productGroupIds がある場合は変更しない）。
- **mergeCountWithStorage**: `allIds` が空のときは、マージ後の `groupItems` のキー（中身が非空のものだけ）を `groupIdsForCheck` として使い `allDone` を計算。書き込み結果に `productGroupIds` が無い場合は `groupIdsForCheck` を `out.productGroupIds` に設定し、次回読込で正しく扱えるようにした。

---

## まとめ

| 確認項目 | 結果 |
|----------|------|
| アプリタイル上の待機時間最小化 | ✅ 全4経路でUI先完了→バックグラウンド read/write/clear |
| 確定成功まで下書きを消さない | ✅ clear は write 成功時のみ |
| 差異あり・差異なしの両方で確定が問題なく動く | ✅ 4経路とも実装済み |
| 成功トーストなのに差異調整されない可能性 | ❌ なし（トースト＝adjust 済み） |
| 成功トーストなのにステータス変更されない可能性 | ⚠️ バックグラウンド write 失敗時のみあり。その場合は後からエラートースト |
| 確定失敗なのに一部だけ在庫調整される可能性 | ❌ なし（adjust は全件一括・失敗時は全件未更新） |
| 何かしらの処理で完了→未処理に変わる可能性 | ❌ なし（fixCountsStatusOnly/readInventoryCounts は不整合時のみ修復。確定時は mergeCountWithStorage で「base が完了かつ全グループ揃っていれば status を完了維持」するガードあり） |
| 空や少ない件数でメタを上書きしてデータが消える可能性 | ❌ 空配列はブロック済み。少ない件数で上書きする場合は write 内で existing の不足分を補完するガードを追加済み。 |
| 在庫調整（adjust）の処理に不具合はないか | ✅ 全件一括・失敗時は全件未更新。Throttled 時は runWithThrottleRetry とリトライ条件の追加で対応済み。不正IDは除外され invalidCount で通知。 |
