# 開発ストアでの確かめ方 — `@idempotent` の PR（#107・#108・#109・#110）を main に入れる前

T さん 11/23 5:10 の決定: **#107・#108・#109 は、開発ストアで 7 つのタイルを全部確かめてから main に入れる。** 2 段目の #110 も同じ確かめに入れます。
この文書はその手順だけです。マージ・本番に出す・スイッチをオンにする・Render の値を変える操作はしていません。

- **【T】** は T さんがやるところ、**【係】** はエージェントがやるところです。
- 開発ストアは **`bbbincbbb` だけ**を使います（新しく作らない）。
- **自社用の POS Stock - Ciara と Ciara の店には、何もしません**（1 章）。

| PR | 中身 | 先（base） | 先頭 | 何に効くか |
|---|---|---|---|---|
| #107 | 設計（docs だけ） | `main` | `52e5f43` | — |
| #108 | ★ キーの部品・サーバー apply-change の `inventorySetQuantities`・`inventoryActivate` に `@idempotent` | `main` | `e34783e` | POS のロス・仕入・調整・棚卸・入庫補正（サーバー） |
| #109 | 呼び出し元の無い在庫の書き込みのコードを消す | `main` | `3b91804` | POS の拡張 6 つ（ロス・調整・発注・仕入・棚卸・出庫）のビルド |
| #110 | ★ 管理画面の棚卸・発注・仕入れに `@idempotent` | #108 のブランチ | `798f142` | 管理画面（サーバー） |

どれも **API の版は 2026-01 のまま**です（2026-01 では `@idempotent` は付けても付けなくてもよい）。なので「動きが前と同じか」「在庫・移管が 1 回だけ動くか」を確かめます。

---

## 1. Ciara の本番に触れないための決まり

| やらない | 理由 |
|---|---|
| main にマージする | Render の `pos-stock`（公開用）は main を見ていて、マージで本番に出る（`docs/DEPLOY.md` §2）。自社用 `pos-stock-ciara` の設定は未確認なので、同じく出ると考える |
| `npm run deploy:inhouse` | 自社用（POS Stock - Ciara・`shopify.app.toml`・client_id `906bc9eb…`）の新しい版を Ciara の店に出してしまう |
| `npm run deploy:public` | 公開用（POS Stock）の新しい版を、入れている**すべての店**に出してしまう（開発ストアだけでは済まない） |
| `shopify app dev` を自社用の toml（`shopify.app.toml`）で動かす | 開発ストアに自社用は入っていない。間違えて Ciara の店を選ぶおそれがある |
| Render の `pos-stock`・`pos-stock-ciara` のブランチ・環境変数を変える・Manual Deploy | 本番のサーバーが変わる |
| Render のデータベースにつなぐ | 本番のデータ。手元のデータベースだけを使う（3.3） |

使うのは **手元のパソコンで動かす `shopify app dev`（公開用の toml・開発ストアを指定）だけ**です。
Shopify の説明では、`app dev` の変更は**選んだ開発ストアだけ**に効き、ほかの店のアプリの URL には効きません。止めたあとも開発ストアには残り、`shopify app dev clean` で出している版に戻ります（[Test apps locally](https://shopify.dev/docs/apps/build/cli-for-apps/test-apps-locally)）。

---

## 2. なぜ Render でなく手元で動かすか

- 管理画面（#110）は、`app dev` が開発ストアにだけ手元のサーバーの URL（トンネル）を渡すので、手元のコードで動きます。
- **POS のタイルは違います。** タイルはサーバーの URL を拡張の中に決め打ちで持っています（`extensions/common/appUrl.js` の `getAppUrl()` → 公開用は `https://pos-stock.onrender.com`）。何もしないと、`app dev` で出したタイルでも **Render の本番（main のコード）** を呼び、#108 の確かめになりません。
- そこで、**手元のファイルだけ**で `appUrl.js` の公開用の URL をトンネルの URL に書きかえます（4.3。コミットしない・deploy しない）。
- Render で確かめる道（別の Render のサービスを作ってブランチを出す）は、**費用がかかる**ので T さんの承認が要ります。この手順書では使いません（8 章）。

---

## 3. 準備

### 3.1 【T】開発ストアと POS

- 開発ストアの myshopify のドメインを控える（管理画面 → 設定 → ドメイン。`○○.myshopify.com`。管理画面の名前 `bbbincbbb` と違うことがある）。
- 開発ストアに **公開用の POS Stock**（「POS Stock - Ciara」ではない）が入っていること。料金プランは **Pro のテストのプラン**を選んでおく（#105 の手順書 2.2。開発ストアはテスト課金で請求なし。Lite だと使えないタイルがある）。
- ロケーションが **2 つ以上**（出庫・入庫に要る）。
- 確かめに使う商品を 3 つ決める（在庫を追跡しているもの）。A・B はロケーション 1 と 2 の両方に在庫、C は**ロケーション 2 に在庫の記録が無い**もの（有効化の経路）。
- POS のアプリ（iPad か iPhone）に開発ストアでログインできること。
- （できれば）**251 件以上**の商品が入った棚卸の商品グループを 1 つ（250 件ずつに分けて書く経路）。

### 3.2 【係】まとめたブランチを作る（手元だけ・push しない）

```bash
git fetch origin
git switch -c local/idem-devstore origin/claude/idempotent-stage2-admin   # #108 + #110
git merge --no-edit origin/claude/idempotent-stage5-unused                 # #109
git merge --no-edit origin/claude/idempotent-migration-design              # #107（docs だけ）
git log --oneline -6
```

- 2026-11-23 に試した結果: 3 つはぶつからずにまとまる。
- まとめたあと `node --experimental-strip-types --test tests/*.test.mjs` は、付け忘れの見張りが 1 つ失敗する（#109 で消えた所が `PENDING` に残るため）。手元の確かめでは気にしなくてよい。main に入れるときは `PENDING` を `extensions/stock-transfer-inbound/src/inboundApi.js: 3`・`extensions/stock-transfer-tile/src/ModalOutbound.jsx: 8` の 2 つだけにする（後から入れる方の PR で直す）。ほかの失敗 2 つ（`vite` が読めない）は前からのもの。
- **このブランチは push しない。** 終わったら消す（7 章）。

### 3.3 【T】手元のデータベースと設定

```bash
npm ci
docker run -d --name pos-stock-dev-db -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
```

フォルダの一番上に `.env` を作る（**コミットしない**。Render の値は使わない）:

```text
DATABASE_URL=postgresql://postgres:dev@localhost:5432/pos_stock_dev
APP_DISTRIBUTION=public
```

```bash
npx prisma migrate deploy   # 手元のデータベースに表を作る
```

- `SHOPIFY_API_KEY`・`SHOPIFY_API_SECRET`・`SCOPES`・`SHOPIFY_APP_URL` は `shopify app dev` が入れるので書かない。

---

## 4. 動かす

### 4.1 【T】公開用の toml を選んで `app dev`

```bash
npm run config:use -- shopify.app.public.toml
npx shopify app dev --config shopify.app.public.toml --store <3.1 のドメイン>
```

- 画面に出る **アプリの名前が「POS Stock」**、**ストアが開発ストア**であることを確かめる。違ったら Ctrl+C で止める。
- 画面に出るトンネルの URL（`https://…trycloudflare.com` のような形。推測で、CLI の版で出方が違う）を控える。決まった URL を使いたいときは自分のトンネルを作って `--tunnel-url` で渡す。

### 4.2 【T】管理画面が手元で動いているか

開発ストアの管理画面 → アプリ → POS Stock を開く。`app dev` の画面に、開いた画面のアクセスの行が出ること。

### 4.3 【T】POS のタイルが手元を呼ぶようにする（手元だけ）

`extensions/common/appUrl.js` の 1 行だけを、**手元で**書きかえる:

```js
const PROD_APP_URL_PUBLIC = "https://<4.1 のトンネルの URL のホスト>";
```

- `APP_MODE = "public"` のままにする。
- 保存すると `app dev` が拡張を作り直す。POS のアプリでタイルを開き直す（開発のプレビューの開き方は `app dev` の画面の案内どおり）。
- **確かめ**: POS でロスの画面を開き、何か 1 つ読み込ませる → `app dev` の画面に `/api/…` の行が出ること。出なければ、まだ Render を呼んでいるので先へ進まない。
- **このファイルはコミットしない。deploy しない。** 終わったら必ず戻す（7 章）。

---

## 5. 7 つのタイルで押すところと見るところ

各行で「Shopify の在庫（または移管）が**ちょうど 1 回だけ**動く」ことを見ます。在庫は、開発ストアの管理画面 → 商品 → その商品 → 在庫 →「調整履歴」で見ます。

**押し直しの試し（★の行）**: 確定を押した直後に POS の端末を機内モードにし、エラーが出たら機内モードを戻して、同じ画面でもう一度確定を押す。在庫は 1 回分だけ動いていること（前の送信が通っていたら、同じキーなので Shopify が 2 回目を動かさない／アプリの `appEventId` が止める）。

| # | タイル | 押すところ | 通るコード | 見るところ |
|---|---|---|---|---|
| 1 | **ロス** | 商品 A をロケーション 1 で 1 個ロス → 確定。★ もう 1 回（A を 1 個）で押し直しの試し | POS → apply-change（#108）`loss_entry` | A の在庫が 1 回ごとに −1。アプリのロス履歴に 1 行ずつ |
| 2 | **仕入** | 商品 A を 2 個で仕入れを作って確定 → その仕入れをキャンセル。★ 確定で押し直しの試し | apply-change（#108）`purchase_entry`・`purchase_cancel` | +2 が 1 回、キャンセルで −2 が 1 回 |
| 3 | **調整** | 商品 B を「今の数 + 3」に調整 → 確定。商品 **C をロケーション 2** で 5 に調整（在庫の記録が無い所） | apply-change（#108）`adjustment`・有効化（`inventoryActivate`） | B が 1 回だけ変わる。C がロケーション 2 に付いて 5 が 1 回だけ |
| 4 | **棚卸** | 1 つの商品グループの実数を入れて確定。★ 押し直しの試し。（あれば）251 件以上のグループを確定 | apply-change（#108）`inventory_count`（今の数と照らして書く） | 差のある商品だけ実数に 1 回。251 件以上でも全部入る |
| 5 | **入庫** | 6 の出庫をロケーション 2 で受け取る: 一部だけ受け取り → 残りを受け取り。予定より 1 個多く受け取って入庫補正 | 受領は拡張から（3 段目でキーを付ける・今は前のまま）。入庫補正は apply-change（#108）`inbound_transfer` | 受け取った数だけ 1 回。補正の 1 個が 1 回 |
| 6 | **出庫** | ロケーション 1 → 2 に商品 A・B を 1 個ずつ出庫して確定。下書きで保存 → 開き直して明細を 1 つ足す | 拡張から（4 段目でキーを付ける・今は前のまま）。#109 で使っていない関数を消した | 管理画面 → 在庫移管 に移管が **1 つだけ**。下書きの明細が足される |
| 7 | **発注** | POS で発注を 1 件作る → 管理画面の「発注」でその発注を承認 → 承認を取り消す → もう一度承認 | POS は記録だけ（#109 で使っていない関数を消した）。承認は管理画面（#110）`inventoryTransferCreateAsReadyToShip` | 1 回目の承認で移管が 1 つ。取り消して承認し直すと**新しい移管**がもう 1 つ（前と同じ動き） |

### 5.1 管理画面（#110）

| # | 画面 | 押すところ | 見るところ |
|---|---|---|---|
| 8 | 棚卸 | 4 の棚卸の別のグループを管理画面で「このグループを確定」→「リセット」→ **もう一度「このグループを確定」** | 確定で実数に、リセットで元の数に、**3 回目の確定でまた実数に**なる（戻したあとの送り直しが書かれる） |
| 9 | 棚卸 | 「一括確定」→「一括リセット」 | 1 回ずつ動く |
| 10 | 仕入 | 未入庫の仕入れを「入庫確定」→「キャンセル」 | +数が 1 回、−数が 1 回 |
| 11 | 押し直し | 8 か 10 の確定を押した直後に、ブラウザの開発ツールでオフラインにする → 戻して同じ画面でもう一度押す | 在庫が 1 回分だけ動く。エラーの文に「Shopify で在庫（または移管）を確かめてから押し直す」が出る |

### 5.2 どのタイルでも

- タイルが開く・一覧と履歴が出る・エラーにならない（#109 で消したコードを、どこからも呼んでいないことの確かめ）。
- POS の画面に「処理中」が残り続けない。

---

## 6. ログで見るところ

### 6.1 手元（`app dev` の画面）

| 出てほしい | 出てはいけない |
|---|---|
| 確定のたびに `/api/inventory/apply-change` の行（ロス・仕入・調整・棚卸・入庫補正） | `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`・`IDEMPOTENCY_CONCURRENT_REQUEST` |
| 管理画面の確定のたびに `[inventory-count] action actionType=confirm_stocktake_group` など | `[inventory-count] inventorySetQuantities uncertain` |
| | `[inventory-set-quantities-server] ambiguous chunk`・`ロールバック失敗` |
| | `[executePurchaseReceive] uncertain`・`[executePurchaseCancel] uncertain` |
| | `@idempotent` が要る・知らない directive といったエラー（2026-01 では出ないはず） |
| | `Invalid session token`（4.3 の URL の書きかえが合っていない） |

- 押し直しの試し（★）のときは、apply-change の答えが `completed`（前の結果を返す）か、2 回目が来ない、のどちらか。`partial_failed` + `idempotencyIssue` が出たら止めて【係】に知らせる。

### 6.2 Render（本番に触れていないことの確かめ）

Render → `pos-stock`（公開用）・`pos-stock-ciara`（自社用）→ **Events** と **Logs**:

- 確かめている間に **新しい Deploy が無い**こと（`Your service is live` の新しい行が無い）。
- `pos-stock` の Logs に、開発ストアのドメインからの `/api/inventory/apply-change` が**来ていない**こと（来ていたら POS がまだ Render を呼んでいる → 4.3 をやり直す。その間の操作は main のコードで動いている）。
- `pos-stock-ciara` の Logs は、ふだんどおり（Ciara の店の操作だけ）。

### 6.3 Shopify

- 開発ストアの管理画面の「調整履歴」と「在庫移管」（5 章の表）。
- 版: このブランチは `ApiVersion.January26`（`app/shopify.server.ts`）と拡張の `api_version = "2026-01"` のまま。試しのあとで変わっていないことを `git diff origin/main -- app/shopify.server.ts extensions/*/shopify.extension.toml` で見る（出るのは 0 行）。

---

## 7. 終わったら

1. 【T】`app dev` を Ctrl+C で止める。
2. 【T】`npx shopify app dev clean --config shopify.app.public.toml --store <3.1 のドメイン>`（開発ストアを、出している版の POS Stock に戻す）。
3. 【T】`git checkout -- extensions/common/appUrl.js`（4.3 の書きかえを戻す）→ `git status` で変わったファイルが無いこと。
4. 【T】`git switch main && git branch -D local/idem-devstore`。`docker rm -f pos-stock-dev-db`。`.env` を消す。
5. 【T】#79 に結果を 1 行（下の形）。

```text
【確かめ】開発ストア bbbincbbb・#107+#108+#109+#110（先頭 52e5f43 / e34783e / 3b91804 / 798f142）
1 ロス OK / 2 仕入 OK / 3 調整 OK / 4 棚卸 OK / 5 入庫 OK / 6 出庫 OK / 7 発注 OK / 8〜11 管理画面 OK
押し直し（★）: 在庫は 1 回 / ログ: IDEMPOTENCY_ なし / Render: 新しい Deploy なし
```

おかしかった所があれば、タイルの番号・押したところ・ログの行（トークン・お客様の情報は書かない）を書く。

---

## 8. main に入れる順（全部 OK のあと・T さんの承認で）

| 順 | すること | 出るもの |
|---|---|---|
| 1 | #107 を main へ | docs だけ |
| 2 | #108 を main へ | Render `pos-stock`（と、main を見ていれば `pos-stock-ciara`）にサーバーが出る。拡張は変わらない |
| 3 | #110 の base を main に変えて、main へ | 管理画面のサーバーが出る |
| 4 | #109 を main に合わせ、`PENDING` を 3.2 の 2 つにしてから main へ | 拡張のコードだけが変わる（Render は動きが同じ） |
| 5 | 拡張を出すとき（4 のあと・別に承認） | `npm run deploy:public`・`npm run deploy:inhouse` は #109 の拡張を出すときだけ。1〜3 はサーバーだけなので要らない |

- 1 つずつ入れて、自社用（Ciara）で 1 日以上見てから次へ（設計 5 章の推奨）。
- 各マージのあと、Render の Logs で `Your service is live` と、6.1 の「出てはいけない」行が無いことを見る。
- Render で確かめる道（費用がかかる。承認が要る）: `pos-stock` と同じ設定の別のサービスを作り、ブランチ `local/idem-devstore` を push して出し、開発ストア用の別のアプリ（Dev Dashboard で作る）の URL をそこへ向ける。この手順書では使わない。

---

## 未確認・推測

- `app dev` のトンネルの URL の出方・POS での開発のプレビューの開き方は、Shopify CLI の版で違う（推測）。画面の案内に従う。
- `pos-stock-ciara` が main を見て自動で出るかは未確認（`docs/DEPLOY.md` の再監査）。1 章では「出る」と考えて main に入れない。
- 開発ストアの myshopify のドメインは T さんが画面で確かめる。
