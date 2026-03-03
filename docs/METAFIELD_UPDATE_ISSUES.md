# 棚卸メタフィールド更新処理で処理ができない／不具合になる可能性の洗い出し

## 1. 読み取り（readInventoryCountsRaw）まわり

### 1.1 メインキー取得にリトライがない（重大）
- **場所**: `stocktakeApi.js` 246–255行付近
- **内容**: メインキー（`INVENTORY_COUNTS_KEY`）取得の `graphql(gql)` に `runWithThrottleRetry` がかかっていない。
- **結果**: Throttle・一時的なネットエラー・タイムアウトで即失敗し、確定後のバックグラウンド write 全体が落ちる。ユーザーはすでに「完了」表示のためタイルを閉じやすく、リトライも走らない。
- **対応案**: メインキー取得も `runWithThrottleRetry` で囲む。

### 1.2 メインキーの JSON パース失敗で空配列を返す（重大・データ消失リスク）
- **場所**: `stocktakeApi.js` 257–261行付近
- **内容**: `JSON.parse(raw)` が失敗したときに `return []` している（throw していない）。
- **結果**:
  - メタが壊れている・不正 JSON のときに `readInventoryCountsRaw()` が `[]` を返す。
  - UI 側は `list = []` と解釈し、`fromStorage = undefined` → 2回目の read も同様なら `doMergeAndWrite([], count)` となり、**更新対象の 1 件だけ**を `writeInventoryCounts` に渡す。
  - `writeInventoryCounts` 内で read が失敗して `existing = []` の場合も、`mergeExistingNonBlank(merged, [])` は渡された `merged` をそのまま返すため、**他棚卸がすべて消え、1件だけが残る**。
- **対応案**: パース失敗時は `return []` にせず throw する。または「既に他件が存在するはずなのに list が空」のときは書き込みを行わずエラーにする。

### 1.3 レスポンス body 取得失敗で実質的に空リストになる
- **場所**: `stocktakeApi.js` 58–69行（graphql 内）
- **内容**: `res.text().catch(() => "")` で body 取得に失敗すると `text = ""`。続けて `json = text ? JSON.parse(text) : {}` で `{}` になり、`json.data` は `undefined`。
- **結果**: `readInventoryCountsRaw` 側では `raw = d?.currentAppInstallation?.metafield?.value ?? "[]"` となり `"[]"`。パースで `[]` が返り、1.2 と同様のデータ消失リスク。
- **対応案**: graphql で `data` が無い／不正なときは throw する。read 側でも「空かつ他件があるはず」の場合は 1.2 と同様に扱う。

---

## 2. マージまわり

### 2.1 mergeExistingNonBlank で groupItems をマージしていない（他グループが未完了に見える）
- **場所**: `stocktakeApi.js` 899–932行、特に 925–927行
- **内容**: `out.groupItems` は「`!hasGroupItems && exGroupItems` のときだけ `ex.groupItems` で上書き」しており、**両方ある場合はマージしていない**。
- **結果**: 確定で渡す `c` に「今回確定したグループの groupItems だけ」が入っていると、既存の他グループの `ex.groupItems` が採用されず、書き込み後は他グループの groupItems が欠ける。管理画面や POS で他グループが「未完了」と表示される。
- **対応案**: 管理画面と同様に `out.groupItems = { ...exGroupItems, ...out.groupItems }` のように「既存をベースに今回の更新で上書き」する。

### 2.2 fromStorage が一覧用ミニマル（groupItems なし）のとき
- **場所**: `InventoryCountList.jsx` の `doMergeAndWrite(list, fromStorage)` に渡す `fromStorage`
- **内容**: `fromStorage` は `readInventoryCountsRaw()` の結果から取っている。通常はフルオブジェクトだが、別経路で一覧用の軽量データだけが混ざると `groupItems` が無い。
- **結果**: `mergeCountWithStorage(fromStorage, locallyBuilt)` で `mergedGroupItems = { ...fromStorage.groupItems, ...locallyBuilt.groupItems }` となり、**今回のグループの groupItems しか残らない**。他グループが欠け、他グループが未完了表示になる。
- **対応案**: `readInventoryCountsRaw` が返す件は常にフルであることを保証する。または `mergeCountWithStorage` で「fromStorage に groupItems が無い場合は書き込み対象にしない／再読する」などのガードを入れる。

### 2.3 該当 count が list に無いときに親の count（ミニマル）を base にしている
- **場所**: `InventoryCountList.jsx` 2119–2123行
- **内容**: 1回目の read で `fromStorage = list.find(...)` が undefined のとき、2回目の read でも見つからなければ `doMergeAndWrite(list2, fromStorage2 ?? count)` となり、**親から渡された `count`**（一覧用で groupItems が無い可能性）を base にしている。
- **結果**: `mergeCountWithStorage(count, locallyBuilt)` で、`count.groupItems` が無いと確定後オブジェクトの groupItems が「今回のグループのみ」になり、他グループが消えた状態で保存される。
- **対応案**: 該当 id が list に無い場合は「読み取り失敗 or 不整合」とみなし、書き込みを中止するか、少なくとも一覧用の `count` をそのまま base にせず再読またはエラーにする。

---

## 3. 書き込み（writeInventoryCounts）まわり

### 3.1 内部で read が失敗すると existing = [] のまま上書き
- **場所**: `stocktakeApi.js` 1004–1010行
- **内容**: `readInventoryCountsRaw()` が throw すると `existing = []` のまま。`mergeExistingNonBlank(counts, existing)` は `existing.length === 0` で `counts` をそのまま返す。
- **結果**: 呼び出し元（UI）が「1件だけ」の list を渡していた場合（1.2 の経路）、**全件がその1件だけに置き換わり、他棚卸が消える**。
- **対応案**: 1.2 の「空リストを返さない／空のときは書かない」とセットで、`writeInventoryCounts` 側でも「existing が空かつ counts が 1 件だけのときは上書きしない」などのガードを検討する。

### 3.2 バッチ書き込みの途中失敗で中途半端な状態になる
- **場所**: `stocktakeApi.js` 1176–1186行（本体チャンク）、1220–1230行（list 等）
- **内容**: メタフィールドを複数バッチ（メイン＋LIST＋INDEX＋VERSION）で順次書き込んでおり、**トランザクションはない**。
- **結果**: 途中のバッチで Throttle やネットエラーで失敗すると、それまで書いた分だけ反映された状態になる。次回 read でチャンク数と中身が食い違う・list と main が不整合になる可能性がある。
- **対応案**: リトライで全体を再実行する設計のまま、可能なら「書き込み前に現状を退避し、失敗時に復元」などは別フェーズで検討。少なくとも「部分成功」を避けるのは難しいため、リトライと 3.1 のガードで影響を抑える。

### 3.3 楽観ロックのバージョン取得タイミング
- **場所**: UI で `getInventoryCountsVersion()` を呼んでから、read → merge → `writeInventoryCounts(merged, expectedVersion)` までに時間が空く。
- **内容**: その間に他タブ／管理画面で保存されると、`writeInventoryCounts` 内の `currentVersion !== expectedVersion` でエラーになる。
- **結果**: 意図した動作（競合防止）だが、ユーザーには「他の操作で更新されています」と出て、今回の確定が保存されない。バックグラウンド実行のため、ユーザーが原因を把握しづらい。
- **対応案**: 仕様として明示し、エラートーストで「画面を再読み込みしてから再度確定してください」と案内する（既存のメッセージで足りる）。

---

## 4. 実行タイミング・ライフサイクル

### 4.1 メタ更新がバックグラウンドのため完了前にタイルが閉じられる
- **場所**: `InventoryCountList.jsx` の確定後処理全体
- **内容**: 在庫調整・履歴送信のあと、トースト／onAfterConfirm／setSubmitting(false) を先に実行し、メタの read/write は `runThisWrite` でバックグラウンドに回している。
- **結果**: ユーザーが「完了」を見てタイルを閉じると、バックグラウンドの write がキャンセルまたは実行されない。メタが更新されず、管理画面は未完了のまま。POS はローカルで「完了」に見えているが、商品リストはメタを読むため未完了表示になる。
- **対応案**: 「メタフィールドの更新を完了してから『棚卸を完了しました』とする」設計に変更し、write を await してから UI 完了にする（前回提案した最適解）。

### 4.2 リトライ回数・待機時間
- **場所**: `InventoryCountList.jsx` 217–218行、`stocktakeApi.js` の THROTTLE_RETRY_* / BATCH_WRITE_DELAY_MS 等
- **内容**: バックグラウンドリトライは 3 回、Throttle 用は 4 回など。チャンク数が多いと 2 秒×3 や 3.5 秒×4 で数十秒かかる可能性がある。
- **結果**: バックグラウンドのままでは、タイルが閉じられるとリトライも含めてすべて止まる。await に変更すれば、その間は「処理中」表示が続くが、確実に完了 or エラーまで届く。
- **対応案**: 4.1 の「write を await」とセットで、リトライ・待機時間は現状のままでよい。必要なら「処理中」の文言で「しばらくお待ちください」を補足する。

---

## 5. まとめ（優先度）

| 優先度 | 項目 | リスク | 対応の方向性 |
|--------|------|--------|----------------|
| 高 | 1.2 パース失敗で `[]` を返す | 他棚卸のデータ消失 | パース失敗は throw。または「空かつ他件があるはず」は書かない |
| 高 | 4.1 バックグラウンドで write | メタが更新されず管理画面が未完了 | write を await してから「完了」表示 |
| 高 | 2.1 groupItems をマージしていない | 他グループが未完了表示 | `mergeExistingNonBlank` で groupItems を `{ ...ex, ...out }` でマージ |
| 中 | 1.1 メインキー取得にリトライなし | Throttle 等で read が落ちる | メインキー取得を `runWithThrottleRetry` で囲む |
| 中 | 3.1 existing 空で上書き | 1.2 と組み合わせでデータ消失 | existing が空のときは上書きしない／エラーにするガード |
| 中 | 2.3 list に無いとき count を base | 他グループの groupItems 欠落 | 該当 id が無いときは書かない or 再読／エラー |
| 低 | 1.3 graphql の body 失敗で data 未定義 | 空リスト経由のデータ消失 | graphql で data 不正時は throw |
| 低 | 3.2 バッチ途中失敗 | 部分反映による不整合 | リトライで全体再実行。トランザクションは別検討 |

上記を踏まえて、まずは「1.2」「4.1」「2.1」から手を付けると、処理ができない／不具合になる可能性を大きく減らせます。
