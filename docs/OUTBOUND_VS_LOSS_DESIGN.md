# 出庫処理の構成とロス登録への模範化

出庫（Outbound）のコンディション・リストの作り方を整理し、ロス登録に同様のパターンを当てはめるための設計メモです。

---

## 1. 出庫処理（Outbound）の構成

### 1.1 全体レイアウト（Modal.jsx）

- **`s-page`** 直下に **`s-stack`**（縦積み）
  - **上部固定ヘッダー**（任意）: `header` state があれば `s-box` → `s-divider`
  - **本体スクロール**: `s-scroll-box` 内に `body`（各画面）
  - **下部固定フッター**（任意）: `footer` state があれば `s-divider` → `s-box`
- **`header` / `footer`** は親の `useState` で保持し、各画面に **`setHeader` / `setFooter`** を渡す。
- 画面切り替え時に `clearBars()` で `setHeader(null)`, `setFooter(null)` し、各画面で必要なだけ再設定する。

### 1.2 コンディション画面（OutboundConditions）

#### データ取得

- **`bootstrap()`** を起動時に一度実行し、以下を **1本の GraphQL** で取得:
  - `locations(first: 250) { nodes { id name } }`
  - `currentAppInstallation.metafield`（設定: 配送会社・表示ロケーション等）
- 結果は **`appState.outbound`** に保存:
  - `allLocations`: ロケーション配列
  - `settings`: 設定オブジェクト
- **`useLocationsIndex(appState, setAppState)`** で `locations_cache_v1` も利用（名前解決用）。

#### UI パターン（ロケーション・配送業者）

- **「〇〇を設定」 / 「〇〇を変更」** ボタンでピッカーを開閉（`showOriginPicker` / `showDestPicker` / `showCarrierPicker`）。
- ピッカー内:
  - 候補を **`s-button` 一覧** で表示（選択中は `tone="success"`）
  - **「再取得」** ボタンで `bootstrap()` を再実行し、一覧を更新。
- 未取得・空のとき:
  - ロケーション: 「ロケーション一覧がありません（再取得を試してください）」
  - 出庫元がない場合: 「出庫元が取得できません。下の『出庫元を設定』から選択してください。」

#### ヘッダー・フッター

- **ヘッダー**: `setHeader(null)` のみ（コンディションでは使わない）。
- **フッター**: **`FixedFooterNavBar`** を使用:
  - `summaryLeft`: 出庫元名
  - `summaryRight`: 宛先名
  - `leftLabel`: 「戻る」, `onLeft`: `onBack`
  - `rightLabel`: 「次へ」, `onRight`: `onNext`, `rightDisabled`: `!canNext`
  - 任意で `middleLabel` / `onMiddle`（例: 軽量モード切替）。

#### その他

- `readValue(e)` で `onInput` / `onChange` から入力値を取得。
- 日付・配送業者・追跡番号など、必要に応じて同様の「表示＋変更ボタン＋ピッカー＋再取得」で統一。

### 1.3 リスト画面（OutboundList）・履歴

- リスト・履歴画面も **`setHeader` / `setFooter`** でヘッダー・フッターを設定。
- フッターでは **「戻る」** に加え、**「再取得」** や **「取得中...」** の右ボタンでデータ再読込。
- データ取得は **`adminGraphql`** で `fetch("shopify:admin/api/graphql.json", ...)` を呼ぶ共通ラッパーを使用。

### 1.4 GraphQL・データ取得の共通仕様

- **エンドポイント**: `fetch("shopify:admin/api/graphql.json", { method: "POST", ... })`
- **タイムアウト**: 約 20 秒。`setInterval` で監視し `AbortController` で中止。
- **エラー**: `userErrors` や `json.errors` を `throw new Error(...)` で呼び出し元に伝搬。
- ロケーション取得クエリ例:
  ```graphql
  query Locs($first: Int!) {
    locations(first: $first) { nodes { id name } }
  }
  ```

---

## 2. ロス登録（現状）との差分

| 項目 | 出庫 | ロス登録（現状） |
|------|------|------------------|
| **Modal レイアウト** | ヘッダー/フッター用 `useState` + `s-page` 内で固定ヘッダー・スクロール・固定フッター | `s-page` → `s-scroll-box` のみ。ヘッダー/フッター未使用 |
| **コンディション** | `setHeader` / `setFooter` を受け取り、フッターに `FixedFooterNavBar` | 受け渡しなし。戻る/開始/リストは画面内ボタンのみ |
| **ロケーション** | 「出庫元を設定」でピッカー開閉。一覧 + **再取得**。`bootstrap` で locations + 設定を一括取得 | 初回のみ `fetchLocations`。**再取得なし**。「取得中...」のまま抜け出せない場合あり |
| **変更ボタン** | 出庫元・宛先・配送業者それぞれ「〇〇を設定」「〇〇を変更」 | なし。常に全項目を一覧表示 |
| **担当者** | なし（出庫はロケーション・宛先・配送中心） | `getSessionStaffMemberId` で ID のみ。手入力で上書き。**一覧から選択は未実装** |
| **データ取得** | `adminGraphql`（Modal 内で定義） | `lossApi.graphql`（`fetch` は同等） |

---

## 3. ロス登録で「取得中...」のままになる要因

- **再取得がない**: 初回 `fetchLocations` が失敗 or 遅延すると、ユーザーが再試行できない。
- **エラー時の扱い**: `catch` で `console.error` のみ。トーストや `fetchingLocs = false` 後のリトライ UI がない。
- **親 state の更新**: `setLocations` で親の `locations` を更新しているが、 fetch がレスポンスを返さない（ハング or ネットワーク問題）場合、`fetchingLocs` が true のまま残りうる。

---

## 4. ロス登録へ出庫パターンを反映するイメージ

### 4.1 レイアウト・ヘッダー／フッター

1. **Loss 用 Modal** でも **`header` / `footer` の `useState`** を用意する。
2. **`s-page`** の構成を出庫と同様にする:
   - 任意の固定ヘッダー
   - `s-scroll-box` で本体
   - 任意の固定フッター
3. **LossConditions**（およびリスト系画面）に **`setHeader` / `setFooter`** を渡す。
4. コンディション画面のフッターに **`FixedFooterNavBar`** を使用:
   - 左: 「戻る」
   - 右: 「ロス登録開始」（`canStart` で `rightDisabled`）
   - 上段: ロケーション名・日付・理由などのサマリー（必要なら `summaryLeft` / `summaryRight` 等）。

※ `FixedFooterNavBar` は出庫と共通化するか、ロス用に同じ props 仕様のコンポーネントを `stock-transfer-loss` 内に用意する。

### 4.2 ロケーション取得

1. **「ロケーションを設定」＋「再取得」** のパターンに合わせる:
   - コンディション画面で「ロケーション: 〇〇」のように表示し、隣に **「ロケーションを設定」**（または「変更」）ボタン。
   - クリックでピッカー展開。ピッカー内に:
     - ロケーションの `s-button` 一覧（選択中は `tone="success"`）
     - **「再取得」** ボタン → `fetchLocations` 再実行（`lossApi` の `graphql` で OK）。
2. **初回取得**:
   - 画面マウント時などに 1 回 `fetchLocations` を実行。
   - 失敗時はトーストで通知し、`loading` を false に。一覧は空のまま「再取得を試してください」を表示。
3. **取得中**:
   - `loading` 中は「取得中...」を表示。フッターの右ボタンが「再取得」であれば、`rightDisabled={loading}` にして連打防止。

これで「取得中...」で止まる状況を避けつつ、出庫の「変更・再取得」操作と揃えられる。

### 4.3 日付・理由

- **日付**: 現状の `s-text-field type="date"` を維持しつつ、フッターのサマリーに「日付: 〇〇」を出してもよい。
- **理由**: 「理由を変更」でピッカーを開き、候補ボタン + カスタム入力。出庫の「配送業者を変更」と同じ UX でよい。

### 4.4 担当者（POS スタッフ）

- **現状**: `getSessionStaffMemberId` で現在のスタッフ ID のみ。手入力で上書き。
- **要望**: ロケーションと同様、**一覧から選択**したい。

**検討事項**:

- Admin API に **スタッフ一覧**（`staffMembers` 等）があれば、ロケーションと同様に「担当者を変更」＋一覧＋再取得で扱える。
- ただし **`read_users` スコープ** および **Shopify Plus / Advanced** 等の条件がありうる。  
  → まずは API でスタッフ一覧が取れるか・必要なスコープ・ストア条件を確認する。
- 一覧が使えない場合:
  - 現行どおり **現在スタッフをデフォルト表示**し、**「担当者」は任意のテキスト入力**のままにする。
  - あるいは、**「現在のスタッフ」のみ選択可能**にして、ロケーション風の 1 件ピッカーにする、などの折衷も可。

### 4.5 ロス登録リスト・商品リスト

- リスト系も **`setHeader` / `setFooter`** でヘッダー・フッターを設定。
- フッターは **「戻る」** と、必要なら **「再取得」**（「取得中...」）を持たせる。
- データ取得は `lossApi` の `readLossEntries` 等の既存 API を利用。  
  「再取得」で `readLossEntries` を再実行し、一覧を更新する形にすると、出庫のリスト・履歴と揃う。

---

## 5. 実装時の注意（ロス拡張側）

1. **`stock-transfer-loss` は別拡張**のため、出庫の `adminGraphql` / `useLocationsIndex` / `appState` は直接参照できない。
2. **`lossApi.graphql`** を継続利用する。エンドポイント・リクエスト形式は出庫と同じ。
3. **`FixedFooterNavBar`** は、出庫からコピーするか、同じ props 仕様でロス用に再実装する。
4. **ロケーション一覧**は、出庫と同様 `locations(first: 250) { nodes { id name } }` で取得。`lossApi` に `fetchLocations` が既にあるので、**「再取得」でそれを再実行**するだけでよい。
5. **エラー時**は必ず `loading` / `fetchingLocs` を false にし、トーストなどで通知。再取得ボタンでリトライできるようにする。

---

## 6. チェックリスト（ロスを出庫に模範する際）

- [ ] Loss Modal に `header` / `footer` の `useState` を追加し、`s-page` レイアウトを出庫と同じ構成にする。
- [ ] LossConditions / LossHistoryList / LossProductList に `setHeader` / `setFooter` を渡す。
- [ ] コンディションのフッターに `FixedFooterNavBar`（戻る / ロス登録開始 / サマリー）を出す。
- [ ] ロケーションを「〇〇を設定」＋ピッカー＋**再取得**に変更。初回取得失敗時はトースト＋「再取得を試してください」。
- [ ] 日付・理由を「変更」ボタン＋ピッカー形式にする（任意。既存のままでも可）。
- [ ] 担当者: スタッフ一覧 API の可否を調べ、使えれば「担当者を変更」＋一覧。無理なら現行の ID／名前入力または「現在スタッフ」のみ選択で検討。
- [ ] リスト画面のフッターに「再取得」を用意し、取得中は「取得中...」＋ `rightDisabled`。

---

**参照**: `extensions/stock-transfer-tile/src/Modal.jsx`（OutboundConditions, FixedFooterNavBar, bootstrap, InboundConditions の 再取得 等）
