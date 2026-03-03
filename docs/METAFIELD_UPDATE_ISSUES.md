# 棚卸メタフィールド更新処理で処理ができない／不具合になる可能性の洗い出し

## 確認日・現状サマリ

- **管理画面**（`app.inventory-count.tsx`）: 読取失敗時ガード（readMainKeyOnly）、`mergeExistingNonBlank` の groupItems マージ、楽観ロックは実装済み。
- **POS**（`stocktakeApi.js` / `InventoryCountList.jsx`）: 以下を修正すると更新処理の不具合を防げる。

---

## 1. 読み取り（readInventoryCountsRaw）まわり

### 1.1 メインキー取得にリトライがない（重大） → **要修正**
- **場所**: `stocktakeApi.js` 246–255行付近
- **内容**: メインキー（`INVENTORY_COUNTS_KEY`）取得の `graphql(gql)` に `runWithThrottleRetry` がかかっていない。
- **結果**: Throttle・一時的なネットエラー・タイムアウトで即失敗し、確定後の write が落ちる。
- **対応**: メインキー取得を `runWithThrottleRetry` で囲む。

### 1.2 メインキーの JSON パース失敗で空配列を返す（重大・データ消失リスク） → **要修正**
- **場所**: `stocktakeApi.js` 257–261行付近
- **内容**: `JSON.parse(raw)` が失敗したときに `return []` している（throw していない）。
- **結果**: 不正 JSON のときに `[]` が返り、UI が 1 件だけを渡して write すると他棚卸が消える。
- **対応**: パース失敗時は throw する。

### 1.3 レスポンス body 取得失敗で実質的に空リストになる（低）
- **場所**: `stocktakeApi.js` graphql 内
- **内容**: body 取得失敗で `raw ?? "[]"` となり空とみなされる。
- **対応**: 1.2 の throw 化でパース失敗は検知可能。graphql 側の data チェックは別途検討。

---

## 2. マージまわり

### 2.1 mergeExistingNonBlank で groupItems をマージしていない（他グループが未完了に見える） → **要修正**
- **場所**: `stocktakeApi.js` の `mergeExistingNonBlank`
- **内容**: 両方に groupItems がある場合のマージがなく、`out.groupItems` のみで上書きしている。
- **結果**: 確定時に「今回のグループの groupItems だけ」で保存され、他グループの groupItems が消える。
- **対応**: 管理画面と同様に `out.groupItems = { ...exGroupItems, ...out.groupItems }` でマージする。

### 2.2 fromStorage が一覧用ミニマル（groupItems なし）のとき
- **対応**: 1.2 で read が throw するようにし、2.3 で「list に無いときは書かない」にすると、不正な fromStorage で書く経路を減らせる。

### 2.3 該当 count が list に無いときに親の count（ミニマル）を base にしている → **要修正**
- **場所**: `InventoryCountList.jsx` の `doMergeAndWrite(list2, fromStorage2 ?? count)`
- **内容**: 2回読んでも該当 id が無いときに `count`（一覧用・groupItems なしの可能性）を base にしている。
- **結果**: 他グループの groupItems が欠けた状態で保存される。
- **対応**: 該当 id が list に無い場合は書き込みせず、Promise.reject で「該当棚卸が取得できません。再読み込みしてから再度確定してください。」を返す。

---

## 3. 書き込み（writeInventoryCounts）まわり

### 3.1 内部で read が失敗すると existing = [] のまま上書き → **要修正**
- **場所**: `stocktakeApi.js` の `writeInventoryCounts`
- **内容**: read が throw すると `existing = []` のままマージし、渡された counts をそのまま書く。
- **結果**: 1.2 の経路で「1件だけ」が渡ると全件が 1 件に置き換わる。
- **対応**: existing が空で counts があるとき、1回だけ再読してまだ空なら新規ショップとして書く。再読で取得できた場合はその existing でマージする。

### 3.2 バッチ書き込みの途中失敗（低）
- リトライで全体再実行。トランザクションは別検討。

### 3.3 楽観ロック（仕様どおり）
- 競合時は「他の操作で更新されています」で保存しない。メッセージで案内済み。

---

## 4. 実行タイミング・ライフサイクル

### 4.1 メタ更新がバックグラウンドのため完了前にタイルが閉じられる
- 別案として「メタ更新を別場所で実行する」検討中。本ドキュメントでは更新処理自体の不具合修正を優先。

### 4.2 リトライ・待機時間
- 現状のままでよい。

---

## 5. 修正実施一覧（更新処理の完全性のため）

| 項目 | 対象 | 内容 |
|------|------|------|
| 1.1 | POS stocktakeApi.js | メインキー取得を `runWithThrottleRetry` で囲む |
| 1.2 | POS stocktakeApi.js | パース失敗時は `return []` ではなく throw |
| 2.1 | POS stocktakeApi.js | `mergeExistingNonBlank` で groupItems を `{ ...ex, ...out }` でマージ |
| 2.3 | POS InventoryCountList.jsx | 該当 id が list に無いときは doMergeAndWrite せず reject |
| 3.1 | POS stocktakeApi.js | 読取失敗時に 1 回再読。existing が空のまま counts が 1 件だけのときは上書きをブロック（他棚卸消失防止） |
