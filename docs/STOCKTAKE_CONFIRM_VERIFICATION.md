# POS棚卸確定処理の検証メモ（2026-02-28）

REQUIREMENTS_FINAL.md に基づき、確定処理まわりを実装と照らして確認した結果です。

**再確認**: 7項目とも現行コード（InventoryCountList.jsx 確定4経路・stocktakeApi.js write/read/fixCountsStatusOnly・単一グループ用 resolvedAllIds/groupIdsForCheck 対応含む）で再検証済み。

---

## 再確認チェックリスト（7項目）

| # | 確認項目 | 結果 | 補足 |
|---|----------|------|------|
| 1 | アプリタイル上の待機時間をできる限りなくす処理になっているか | ✅ | 全4経路で「toast / onAfterConfirm / setSubmitting(false)」を先に実行し、read/write/clear はバックグラウンド。ユーザーが待つのは差異あり時の在庫調整APIのみ。（商品グループごと表示・まとめて表示・単一商品グループのみのいずれも同様） |
| 2 | 確定ボタン押下後、確実に成功するまで自動保存内容が消えないか（商品グループごと・まとめて表示・単一商品グループのみ） | ✅ | `clearAllInventoryCountDraftsForCount` は write が成功した `.then` 内でのみ呼ばれる。失敗時は `.catch` でトーストのみで clear は呼ばない。単一グループは count 単位キー＋LEGACY 削除で clear。 |
| 3 | 確定処理は差異あり・差異なしどちらも問題なく処理されるか（商品グループごと・まとめて表示・単一商品グループのみ） | ✅ | 4経路すべて実装済み。差異あり時は adjust 失敗で catch し成功トーストは出さない。差異なし時はバックグラウンド write 失敗時のみ後からエラートースト。単一グループは resolvedAllIds/groupIdsForCheck でステータス「完了」が正しく書き込まれる。 |
| 4 | 成功トーストを出したのに差異調整・ステータス変更がされない可能性はないか | 差異調整: ✅ なし / ステータス: ⚠️ write 失敗時のみ | 差異調整はトースト前に await 済みのため「トースト＝差異調整済み」。ステータス（メタ）はバックグラウンド write 失敗時のみ未反映の可能性あり（その場合は後からエラートースト）。 |
| 5 | 確定失敗したのに一部商品の在庫調整がされてしまう可能性はないか | ✅ なし | `adjustInventoryToActual` は1回の mutation で全件実行。成功なら全件・失敗なら throw で全件未更新。部分だけ在庫が変わることはない。 |
| 6 | 何かしらの処理で棚卸ID全体や他グループのステータスが完了→未処理に変わってしまう可能性はないか | ✅ なし | fixCountsStatusOnly / readInventoryCounts で `status === "completed"` は上書きしない。確定時は fromStorage ?? count とリトライで他グループの groupItems を落とさない。 |
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

**結論: ✅ ない**

- **fixCountsStatusOnly**（stocktakeApi.js 335–369）: `c?.status === "completed"` のときは **そのまま return c** しており、部分取得で groupItems が欠けていても「未処理」に戻さない（コメント・363–364 行）。
- **readInventoryCounts**（701–746）: 同様に `c?.status === "completed"` なら return c。`!isCompleted && c.status === "completed"` のときも return c で上書きしない（734–735）。
- **確定時の write**では、更新するのは「当該棚卸IDの1件」だけ。他棚卸IDは `list.map((c) => ... ? toWrite : c)` で **そのまま** 渡しているため、他IDの status は read 結果のまま。`mergeCountWithStorage` は **当該 count のみ** で、fromStorage の groupItems をベースに locallyBuilt で上書きし、status は allDone から再計算。他グループの完了済み groupItems は fromStorage に含まれるため、完了→未処理にはならない。
- 下書き保存・draft 更新で write する箇所（InventoryCountList 533, InventoryCountProductGroupSelection 74）は、いずれも **readInventoryCounts() で全件取得** したうえで「1件だけ status を in_progress にした配列」を渡しており、既存の completed な棚卸IDを in_progress に書き換える処理はない。

したがって、何かしらの処理で「棚卸ID全体」や「他商品グループのステータス」が完了から未処理に変わる経路はない。

**※ 事例対応（2026-02-28）**  
「1つの棚卸IDで完了と未完了が混在しているときに、既に完了していたグループのステータスが未処理に戻ってしまう」事象が報告された。原因は、バックグラウンド write 時に `readInventoryCountsRaw()` が空配列を返す、または当該棚卸IDが list に含まれない場合に `fromStorage` が undefined となり、`mergeCountWithStorage(undefined, locallyBuilt)` の結果として **locallyBuilt の groupItems だけ**（今回確定したグループのみ）が書かれ、既存の他グループの groupItems が消えていたこと。  
**対応**: 確定後のバックグラウンド write の4経路すべてで、`toWrite = mergeCountWithStorage(fromStorage ?? count, locallyBuilt)` に変更。`fromStorage` が無いときはメモリ上の `count`（親 state）をマージの土台に使い、既存の他グループの groupItems を落とさないようにした（InventoryCountList.jsx）。

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

## 10. 単一グループの棚卸で「棚卸完了しました」トースト後もステータスが「完了」に変わらない（2026-02-28 対応）

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
| 何かしらの処理で完了→未処理に変わる可能性 | ❌ なし（fixCountsStatusOnly/readInventoryCounts で completed は上書きしない・他IDはそのまま） |
| 空や少ない件数でメタを上書きしてデータが消える可能性 | ❌ 空配列はブロック済み。少ない件数で上書きする場合は write 内で existing の不足分を補完するガードを追加済み。 |
| 在庫調整（adjust）の処理に不具合はないか | ✅ 全件一括・失敗時は全件未更新。Throttled 時は runWithThrottleRetry とリトライ条件の追加で対応済み。不正IDは除外され invalidCount で通知。 |
