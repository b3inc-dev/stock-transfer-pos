# 棚卸実装 専門監査レポート

**監査日**: 2026年3月  
**対象**: 棚卸確定フロー（POS Extension + 管理画面）  
**参照**: REQUIREMENTS_FINAL.md、STOCKTAKE_COUNTNAME_AUDIT.md、実装コード

---

## 1. アプリタイル上の待機時間をできる限りなくす処理方法になっているか

### 結論: **✅ 要件を満たしている**

- **差異あり（在庫調整あり）**
  - `adjustInventoryToActual` を **await で同期的に実行**し、**成功した場合のみ**  
    `toast("棚卸を完了しました")` → `onAfterConfirm(locallyBuilt)` → `setSubmitting(false)` でUIを先に完了。
  - `readInventoryCountsRaw` → `writeInventoryCounts` → `clearAllInventoryCountDraftsForCount` は **すべてバックグラウンド**（`runThisWrite` を `setTimeout` で直列キューに積むだけ）で実行され、ユーザーは待たされない。

- **差異なし**
  - 在庫調整APIは呼ばれず、`buildUpdatedCountFromLocalState` でローカル組み立て → 即時 `toast` / `onAfterConfirm` / `setSubmitting(false)`。  
    read/write/clear は上記と同様にバックグラウンドのみ。

- **待機が発生するのは**
  - 差異あり時のみ「在庫調整APIが成功するまで」の一度。  
    その後のメタフィールド read/write/下書き削除は待機させない設計で一貫している。

**根拠コード**:  
`InventoryCountList.jsx` の `handleComplete`（まとめて・単一・差異あり/なしの4経路すべて）で、  
トースト・`onAfterConfirm`・`setSubmitting(false)` の後に `runThisWrite` をキューに積み、  
`next.then(...).catch(...)` でバックグラウンド完了/失敗のみ処理。

---

## 2. 確定ボタン押下後、確実に成功するまで自動保存（下書き）が消えないか

### 結論: **✅ 要件を満たしている**

- `clearAllInventoryCountDraftsForCount` は **write が成功した後の `.then(writeResult => { if (writeResult) { clear... } })` 内でのみ** 呼ばれている。
- バックグラウンド write が失敗した場合は `.catch` でトースト＋ログのみで、`clear` は呼ばれない。
- したがって「確定がメタフィールドに反映されるまで」下書きは削除されず、  
  商品グループごと表示・まとめて表示・単一商品グループのみのいずれも同じ挙動。

**根拠コード**:  
`InventoryCountList.jsx` 内で `clearAllInventoryCountDraftsForCount` を検索すると、  
いずれも `next.then((results) => { const writeResult = results?.[1]; if (writeResult) { clear... } })` または  
`next.then((toWrite) => { if (toWrite) { clear... } })` の形で、write 成功後に限定されている。

---

## 3. 確定処理は差異あり・差異なしどちらも問題なく処理されるか（商品グループごと・まとめて・単一）

### 結論: **✅ いずれの組み合わせも処理される**

| パターン | 差異あり | 差異なし |
|---------|----------|----------|
| 商品グループごと表示 | `itemsToAdjust` で対象行のみ `adjustInventoryToActual` → 成功後 UI 完了 → バックグラウンド write | `itemsToAdjust.length === 0` で調整スキップ → 即時 UI 完了 → バックグラウンド write |
| まとめて表示 | `allItemsToAdjust` で全編集可能行を一度に `adjustInventoryToActual` → 同様 | `allItemsToAdjust.length === 0` で同様 |
| 単一商品グループのみ | 上記「グループごと」の特殊ケース。`resolvedAllIds` / `groupIdsForCheck` で単一でも `allDone` が true になり、`mergeCountWithStorage` で `locallyBuilt.status === "completed"` のときは常に `status: "completed"` で書くガードあり。 | 同様に差異なしパスで即時完了 → バックグラウンド write |

- 在庫調整は **1回の `inventorySetQuantities` で全件まとめて実行**しており、  
  一部だけ反映される partial 更新は発生しない（成功なら全件、失敗なら0件）。

**根拠コード**:  
`stocktakeApi.js` の `adjustInventoryToActual` 内コメント  
「在庫数の反映は1回の mutation で全件まとめて実行するため、途中で『一部だけ在庫調整された』状態にはならない」。  
`InventoryCountList.jsx` の `handleComplete` で、`isMultipleMode` / `itemsToAdjust.length` / `allItemsToAdjust.length` による分岐で上記4経路が実装されている。

---

## 4. 「棚卸が完了しました」と成功トーストを出したのに、差異調整・ステータス変更がされない可能性

### 結論: **✅ アプリ側の実装としてはそのような不整合は起こらない**

- トースト「棚卸を完了しました」は、**差異ありのときは `adjustInventoryToActual` が例外なく成功した直後にのみ** 表示される。  
  調整が throw した場合は catch でエラートースト＋`setSubmitting(false)`＋`return false` となり、成功トーストは出ない。
- 差異なしのときは在庫調整は行わず、メタフィールドのステータス更新はバックグラウンド write で行う。  
  ここで失敗すると「確定後の保存に失敗」トーストが出るが、「棚卸を完了しました」の後に別途表示される設計。
- **理論上のギャップ**: Shopify の `inventorySetQuantities` が HTTP 200 で成功を返したが、  
  実際の在庫は反映されていない（API/ストア側の不具合）というケースは、アプリ側では検知できない。  
  その場合は「トーストは成功だが実在庫は未反映」となり得るが、**アプリ実装の不具合ではなく API/インフラ側の事象**として扱う範囲。

**推奨**: 必要であれば、重要棚卸後に管理画面や別APIで在庫を1件だけ取得し、期待値と一致するか検証するオプションを検討できる。

---

## 5. 確定失敗したのに一部商品の在庫調整がされてしまう可能性

### 結論: **✅ 発生しない**

- `adjustInventoryToActual` は **1回の GraphQL mutation `inventorySetQuantities` に全件を渡して一括実行**している。  
  ループで1件ずつ在庫更新しているわけではない。
- この mutation が失敗すると例外となり、`inventoryAdjustmentSuccess` は true にならず、  
  成功トースト・onAfterConfirm・メタ write は一切実行されない。
- したがって「確定は失敗と表示されたが、一部だけ在庫が変わっている」という状態は、  
  現在の実装では起こらない。

**根拠コード**:  
`stocktakeApi.js` の `adjustInventoryToActual` 内で、  
`quantities` をまとめて `input.quantities` に渡し、1回の `graphql(m, { input })` で実行。  
失敗時は `throw` し、リトライし尽くした後も throw のまま。

---

## 6. 何かしらの処理で棚卸ID全体や他グループのステータスが「完了→未処理」に戻る可能性

### 結論: **✅ 実装で保護されている（list 時は完了を維持）**

- **保護されている箇所**
  - **mergeCountWithStorage**（確定時バックグラウンド write）  
    - `locallyBuilt.status === "completed"` のときは常に `status = "completed"` で上書き。  
    - さらに `fromStorage?.status === "completed"` かつ base に groupItems が無い場合も「判定できないので完了を維持」し、`status = "completed"` のままにしている。  
    → 確定後の write で「完了→未処理」に戻ることはない。
  - **fixCountsStatusOnly**（list 用・フルチャンク両方で使用）  
    - **groupItems がない場合**（`!hasGroupItems`＝list 由来のミニマムデータ）は、  
      「部分取得（list 等で groupItems なし）のときは completed をそのまま返す」として **`c?.status === "completed"` のときは変更せず return c**。  
      → 一覧表示で「完了」が「未処理」に表示されることはない。
  - **readInventoryCounts**（POS の `readInventoryCounts()`）  
    - 内部の `countsFixed` で「`c?.status === "completed" && hasGroupItems && !allDone`」のときのみ  
      `status: "in_progress"` に変更し、かつ `needsUpdate` を立てて **write する**。  
    - ここで「完了だが一部グループの groupItems が欠けている」**不整合データ**を修復する意図。  
    - フルデータを読んだうえでのみ write するため、通常の「全グループ完了・groupItems 揃い」のデータが誤って in_progress で上書きされることはない。

**まとめ**
- 表示・永続化とも、**完了→未処理**に変わる経路は意図した不整合修復（完了なのに groupItems が欠けている場合の write）のみ。  
  list 表示では completed はそのまま返すため、一覧で完了が未処理に見える事象は発生しない。

---

## 7. 全ての情報が空のままメタフィールドを上書きし、棚卸IDのデータが消えて復元できなくなる可能性

### 結論: **✅ POS 側はガードあり / ⚠️ 管理画面側に空上書きの余地あり**

### POS（Extension）の writeInventoryCounts

- **空配列で上書きするケースのブロック**
  - `arr.length === 0`（保存対象が0件）のとき、  
    メインキーの現在値を読んで、`parsed` が配列またはチャンクで **データが存在する**場合は  
    `throw new Error("棚卸データを空にすることはできません...")` で **write を実行しない**。
- **既存データの補完**
  - 毎回 `readInventoryCountsRaw()` で `existing` を取得し、  
    `mergeExistingNonBlank(counts, existing)` で「渡された counts の空白項目を existing で補完」。  
    さらに `merged.length < existing.length` のときは、**existing にしか無い件を merged に追加**してから保存するため、  
    他棚卸IDが消えて「空で上書き」されることはない。
- **既存読取失敗時**
  - `existing = []` となり、`mergeExistingNonBlank(counts, [])` は渡された `counts` をそのまま返す。  
    このとき、呼び出し元が「1件だけ更新したつもりの `merged`」を渡していれば、  
    `counts` が 1 件だけの配列になり、**他棚卸IDが既に存在する場合に、それらが消える**リスクは理論上ある。  
    ただし実際の呼び出しでは、確定フローは「read → 当該1件を toWrite に差し替え → 全件の配列を渡す」ため、  
    read が完全に失敗して `list` が空のときは `merged = [toWrite]` となり、  
    write 内の再 read が成功すれば `existing` で補われ、不足分がマージされる。  
    write 内の read も失敗した場合に限り、他棚卸が消える可能性がある（**ネットワーク/障害時の限定的リスク**）。

### 管理画面の writeInventoryCountsChunked

- **空で上書きするガードが無い**
  - `payloads.length === 0`（＝ `arr.length === 0`）のとき、  
    **「既存にデータがあるか」のチェックなし**で、  
    `metafields` に `value: "[]"` / `"{}"` を設定して **そのまま保存**している。
  - そのため、何らかの経路で「保存対象がすべて filterInvalidCountsBeforeWrite で除外され、arr が空」になると、  
    既存の棚卸データがすべて空で上書きされ、**復元不能**になり得る。

**推奨**
- 管理画面の `writeInventoryCountsChunked` で、  
  **payloads.length === 0 のときは、POS と同様に「現在のメタフィールドにデータがあるなら保存しない」** ガードを入れる。  
  （既存を read し、配列またはチャンクで length > 0 なら throw するなど。）

---

## 監査サマリ

| # | 観点 | 結果 | 備考 |
|---|------|------|------|
| 1 | アプリタイル待機時間の最小化 | ✅ 問題なし | UI 先完了・read/write/clear はバックグラウンドで一貫 |
| 2 | 確定成功まで下書きを消さない | ✅ 問題なし | clear は write 成功後の .then 内のみ |
| 3 | 差異あり/なし・表示モード別の確定 | ✅ 問題なし | 4経路とも処理され、在庫調整は一括で部分反映なし |
| 4 | 成功トーストなのに調整/ステータス未反映 | ✅ アプリ実装上はなし | API が 200 なのに実在庫未反映は API 側の範疇 |
| 5 | 確定失敗なのに一部だけ在庫調整 | ✅ 発生しない | 1回の mutation で全件のため |
| 6 | 完了→未処理に戻る可能性 | ✅ 問題なし | fixCountsStatusOnly は groupItems なし（list）のとき completed をそのまま返す。永続は不整合修復時のみ write |
| 7 | 空でメタフィールド上書き・復元不能 | ✅ POS はガードあり / ⚠️ 管理画面は要対策 | 管理画面で payloads.length === 0 のときの空上書き防止を推奨 |

---

## 推奨対応（優先度順）

1. **管理画面の空上書き防止（高）**  
   `writeInventoryCountsChunked` で、`payloads.length === 0` の場合に、  
   現在のメタフィールドに棚卸データが存在するなら保存をブロックする。

2. **バックグラウンド write 失敗時の再試行・通知（任意）**  
   既に `runWithBackgroundWriteRetry` と失敗時トーストがあるため必須ではないが、  
   必要に応じて「下書きは残したまま、後から再確定できる」旨をユーザーに明示する表示を検討できる。

3. **管理画面の空上書き防止**  
   本監査に基づき、`app.inventory-count.tsx` の `writeInventoryCountsChunked` に  
   `payloads.length === 0` かつ `existing.length > 0` のときは保存をブロックするガードを追加済み。

以上を監査結果および推奨とします。
