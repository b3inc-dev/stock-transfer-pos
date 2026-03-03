# 棚卸管理画面 loader の「syntax error」検証（根拠）

## 結論

- **loader 経路で「syntax error, unexpected end of file」を起こす箇所は、すべて throw しない実装に揃えた。**
- **親レイアウト `app.tsx` の getShopPlan** も `resp.json()` を使っていたため、空応答で throw する可能性があった。**`resp.text()` + `JSON.parse` の try/catch に変更済み。**
- **「他に絶対に問題がない」とは言い切れない**理由（ネットワーク・認証・他モジュール）を下に記載する。

---

## 1. loader 内で JSON を読む／パースする箇所（すべて throw しない）

| 順番 | 箇所 | 内容 | 根拠 |
|------|------|------|------|
| 1 | `getShopTimezone(admin)` | GraphQL で shop.ianaTimezone 取得 | `timezone.ts`: `resp.text()` → 空なら "UTC"。`JSON.parse(text)` は **内側の try/catch** で囲み、失敗時は "UTC"。外側の catch でも "UTC"。**throw しない**。 |
| 2 | `readListMainKeyOnly(admin)` | list メタ単一キー取得 | `safeJsonFromResponseForLoader(listResp, {})` を使用。空・不正 JSON 時は **defaultVal を返すだけ**で throw しない。`JSON.parse(raw)` は try/catch で **return []**。 |
| 3 | `readMainKeyOnly(admin)` | main メタ単一キー取得 | **修正済み**: `safeJsonFromResponseForLoader(mainResp, null)` を使用。空・不正 JSON 時は **null を返す**。`JSON.parse(raw)` は try/catch で **return null**。 |
| 4 | `getInventoryCountsVersion(admin)` | バージョンメタ取得 | `safeJsonFromResponseForLoader(resp, {})` を使用。**throw しない**。戻り値は number（パース失敗時は 1）。 |
| 5 | `locResp` / `appResp` / `settingsResp` のパース | 3 本の GraphQL レスポンス | いずれも **safeJsonFromResponseForLoader(resp, {})** で取得。**throw しない**。 |
| 6 | `groupsRaw` の利用 | productGroups の JSON 文字列 | `JSON.parse(groupsRaw)` は **try/catch** 内。失敗時は `productGroups = []`。**throw しない**。 |
| 7 | `settingsRaw` の利用 | 設定の JSON 文字列 | `JSON.parse(settingsRaw)` は **try/catch** 内。失敗時はデフォルト列のまま。**throw しない**。 |
| 8 | `inventoryCounts.map(...)` (list 補正) | list 用 status 補正 | 全体が **try/catch** で囲まれており、catch では「そのまま」で続行。**throw しない**。 |
| 9 | `inventoryCounts.map(...)` (main 補正) | main 用完了判定補正 | 全体が **try/catch** で囲まれており、catch では `inventoryCounts = []`。**throw しない**。 |
| 10 | `nodesResp`（コレクション表示用） | nodes(ids) の GraphQL | **safeJsonFromResponseForLoader(nodesResp, {})** を使用。外側も **try/catch** で `collectionDisplayMap = {}`。**throw しない**。 |

上記のとおり、**loader 内のすべての「レスポンス body のパース」と「メタフィールド値の JSON.parse」は、throw しないか try/catch で握りつぶしている。**

---

## 2. 親レイアウト（app.tsx）の getShopPlan

- 棚卸ページを開くとき、**先に app.tsx の loader が実行される**。その中で `getShopPlan(admin)` が呼ばれ、`resp.json()` をそのまま使っていた。
- 空・不正な GraphQL 応答だと `resp.json()` が **syntax error** を throw する。getShopPlan 内は try/catch で握りつぶしていたが、**念のため `resp.text()` + `JSON.parse` の try/catch に変更**し、パース失敗時も throw しないようにした。

## 3. その他の loader 内の例外の可能性

| 要因 | 挙動 | 備考 |
|------|------|------|
| `authenticate.admin(request)` | 認証失敗時は **throw**（401 等） | Remix の認証層。loader の **外側の try/catch** で捕捉され、`loadError: true` とメッセージを返す。**「syntax error」にはならない**。 |
| `admin.graphql(...)` の **ネットワーク失敗** | fetch の Promise が **reject** | その時点で loader が throw。外側の try/catch で捕捉され、`loadError: true` と **そのエラーメッセージ**（例: "Failed to fetch"）を返す。**「syntax error」にはならない**。 |
| `parseCountNameNumber` | 数値化のみ。`parseInt` は throw しない | 例外は出さない。 |
| `getDateInShopTimezone` | 日付フォーマットのみ。throw しない | 例外は出さない。 |

したがって、**「syntax error, unexpected end of file」というメッセージ**に限れば、loader 内の JSON まわりは **すべて安全側に寄せている**。

---

## 4. 「絶対に問題がない」と言い切れない理由

- **認証・ネットワーク**: 上記のとおり、認証失敗やネットワークエラーでは別のメッセージで `loadError: true` になる可能性はある。
- **action や他ルート**: 棚卸の **action**（保存・確定・修復など）や **api.pos-stocktake-complete** など、loader 以外の経路はこの検証の対象外。そこでの `.json()` や `JSON.parse` が未対策の場合は、同様の syntax error が出る余地がある。
- **実行環境**: Shopify や Node のバージョン・制限・一時的な API 不調など、コード以外の要因で不具合が出る可能性はゼロではない。

---

## 5. 実ログで判明した原因（2026-03 本番ログ）

Render ログの **SYNTAX_ERROR_ORIGIN** のスタックから、以下が確定した。

- **発生箇所**: `admin.graphql()` の**内側**。Shopify API クライアント（`lib/clients/common.ts` の `throwFailedRequest` → `NewGraphqlClient.request`）が、GraphQL レスポンスをパースする際に「syntax error, unexpected end of file」を **throw** している。
- **呼び出し元**: loader の `Promise.all` 内の **getInventoryCountsVersion** および **readMainKeyOnly**。いずれも `admin.graphql()` を 1 回呼ぶだけだが、その**前**にクライアント側でレスポンスをパースしており、当プロジェクトの `safeJsonFromResponseForLoader` には到達していない。
- **対応**:  
  - **getInventoryCountsVersion** / **readMainKeyOnly** / **readListMainKeyOnly** の関数全体を try/catch で囲み、throw 時はそれぞれ **1** / **null** / **[]** を返す。  
  - loader 内の locations / app / settings 用の **admin.graphql()** 3 本も、**graphqlOrEmpty** で try/catch し、失敗時は `{ data: {} }` の Response を返す。  
  これにより、Shopify API が空・不正レスポンスを返しても loader は落ちず、画面は空データで表示される。

---

## 6. まだエラーが出る場合の原因特定（仮説に頼らない方法）

**「syntax error, unexpected end of file」がまだ出る場合**、コード上で「ここは安全」としている箇所の外で throw している可能性がある（例: 認証ライブラリ内部の `.json()`、別ルートの実行順など）。

そのため、**実際に throw している場所をログで特定する**ための処理を入れてある。

1. **棚卸管理画面でエラーを再現する**（該当 URL を開いて「データの読み込みに失敗しました…」を出す）。
2. **Render のログ**（Dashboard → 該当サービス → Logs）を開く。
3. ログ内で **`SYNTAX_ERROR_ORIGIN`** を検索する。
4. 直後に出ている **スタックトレース** の**いちばん上（先頭）**が、**実際に例外を投げているファイルと行**。

- **`[app layout loader]`** と出ている → 親レイアウト（`app.tsx`）の loader、またはその中で呼んでいる `authenticate.admin` / `getShopPlan` のどこかで発生。
- **`[inventory-count loader]`** と出ている → 棚卸ルートの loader 内（またはその中で呼んでいる関数）で発生。

スタックの先頭のファイル名・行番号が分かれば、**仮説ではなく「その箇所の `.json()` または `JSON.parse` を安全パースに変える」** という修正ができる。

---

## 7. まとめ（根拠付き）

- **loader 経路で「syntax error, unexpected end of file」を出す箇所は、コード上すべて「throw しない」実装に変更済み。**  
  根拠: 上記 1 の一覧（各箇所で `safeJsonFromResponseForLoader` または try/catch を利用）。
- **「他に絶対に問題・不具合はない」とは断言できない。**  
  根拠: 上記 2・3（認証・ネットワーク・action 他経路・環境要因）。
- **まだエラーが出る場合は、Render ログの `SYNTAX_ERROR_ORIGIN` とスタックで発生箇所を特定し、その箇所を修正する。**  
  根拠: 上記 5（ログによる原因特定手順）。
