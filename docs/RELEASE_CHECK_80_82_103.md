# #80 → #82 → #103 を main に入れるまでの確かめ方 — POS Stock（公開用）

対象の PR（どれも下書き・まだ main に入っていない。2026-11-23 時点）:

| PR | 中身 | 先（base） | 先頭 |
|---|---|---|---|
| #80 | 10 か所を超えたロケーションを App Events API で報告する（既定オフ） | `main` | `9511b54` |
| #82 | 契約を Partner API の `activeSubscription` でも読む（既定オフ）・POS のタイルでも 3 か所プランの多すぎを止める（#91） | #80 のブランチ | `c4b80c2` |
| #103 | shop/redact でその店の `AppUsageReport` も消す（D19・T さん 11/23 1:20 に「消す」と決定） | #82 のブランチ | `8a96eff` |

- この文書は手順だけです。マージ・本番に出す・スイッチをオンにする・Render の値を変える操作はしていません。
- **【T】** は T さんがやるところ、**【係】** はエージェントがやるところです。
- 自社用（POS Stock - Ciara）にも main のマージで配備が出ます（増えるのは空の表 1 つだけ。7 章）。
- くわしい背景は [#90 の手順書（RELEASE_APP_PRICING.md）](https://github.com/b3inc-dev/stock-transfer-pos/pull/90) と `docs/listing/partner-dashboard-steps.md`。この文書は「どこを押す・どのログを見る・どの順に入れる」を 1 本にまとめたものです。

---

## 0. 全体の順番

| # | いつ | 誰 | すること | 外へ送るか |
|---|---|---|---|---|
| 1 | main に入れる前 | 【T】 | Partner Dashboard でプラン 4 つとメーター 2 つを作る（1 章） | 送らない |
| 2 | main に入れる前 | 【T】 | 開発ストアでテストのプランを選び、契約の読み方を確かめる（2 章） | 送らない |
| 3 | main に入れる前 | 【T】 | Render `pos-stock` に `SHOPIFY_APP_HANDLE` を入れる（3 章） | 送らない |
| 4 | マージの直前 | 【係】 | migration の時刻・ぶつからないかを見直す（4 章） | — |
| 5 | | 【T】 | #80 を main へ → `pos-stock` が Live（5.1） | 送らない（スイッチはオフ） |
| 6 | | 【T】 | #82 の base を main に → main へ → Live（5.2） | 送らない |
| 7 | #82 が Live のあと | 【T】 | **`npm run deploy:public` を 1 回だけ**（5.3・T さん 11/23 0:55 の決定） | — |
| 8 | | 【T】 | #103 の base を main に → main へ → Live（5.4） | 送らない |
| 9 | 全部 Live のあと | 【T】 | 開発ストアで確かめる（6 章） | 送らない |
| 10 | 9 が全部 OK のとき | 【T】 | `APP_EVENTS_USAGE_ENABLED=1` → Dev Dashboard の Logs で `OK`（6.5） | **送る**（開発ストアはテスト課金） |

- **#80 と #82 は続けて入れる。間で `APP_EVENTS_USAGE_ENABLED=1` にしない。** #82 で期間のキーの書き方が変わるので、#80 だけでオンにすると同じ期間をもう一度送るおそれがある（推測。オフのまま続けて入れれば起きない）。
- `deploy:public` は #82 のあとに 1 回だけ。#103 は拡張と toml を変えないので、#103 のあとにもう一度出す必要はない（事実: #103 の変更は `app/utils/compliance-webhook.ts`・試験・docs だけ）。

---

## 1. 【T】Partner Dashboard（main に入れる前）

Partner Dashboard → アプリ → **POS Stock**（client_id `41d31838…`）→ 配布 → 価格 → Managed pricing

| 表示名（例） | 内部計画ハンドル | メーター |
|---|---|---|
| Lite - 3 locations | `lite-3` | なし |
| Lite - 10 locations | `lite-10` | `extra_location_lite`・1 単位 $4 |
| Pro - 3 locations | `pro-3` | なし |
| Pro - 10 locations | `pro-10` | `extra_location_pro`・1 単位 $12 |

- 内部計画ハンドルは **ハイフン**（`lite-3`）。アンダースコアはアプリが受け付けない。**あとから変えられない**。
- 表示名に「Lite」「Pro」と「3」「10」を入れる（アプリは名前で判定する）。
- アプリの handle（`admin.shopify.com/store/<店>/charges/<handle>/pricing_plans` の `<handle>`）を控える → 3 章で使う。

---

## 2. 【T】開発ストアで契約の読み方を確かめる（main に入れる前。コードは今のまま）

ここは **今の本番のコードのまま** できる確かめです。#80・#82 が読む値を Shopify が本当に返すかを、先に見ておきます。

### 2.1 開発ストアの準備

- 開発ストアは `bbbincbbb` だけを使う（新しく作らない）。
- myshopify のドメインは管理画面の名前（`bbbincbbb`）と違う。管理画面 → 設定 → ドメイン で `○○.myshopify.com` を控える（Location Stock の docs では `location-stock-indicator.myshopify.com` と書かれている。同じ店かは T さんが画面で確かめる）。
- 公開用の **POS Stock**（「POS Stock - Ciara」ではない）が入っているか見る。入っていなければ Partner Dashboard → POS Stock → テスト → 開発ストアにインストール。
- 管理画面 → 設定 → ロケーション で **有効なロケーションの数** を数えておく（6 章で 3 か所以下・4〜10 か所・11 か所以上で見え方が変わる）。

### 2.2 プランを選ぶ

1. 開発ストアの管理画面 → アプリ → POS Stock → 料金プラン →「プランを選ぶ」
2. Shopify のプランの画面で **Lite - 10 locations** を選ぶ（開発ストアはテスト課金で請求なし）
3. アプリに戻る

### 2.3 Admin API で契約を見る（パソコンの `stock-transfer-pos` のフォルダで）

```bash
shopify app execute -c public -s <2.1 のドメイン> -q '{ shop { id } currentAppInstallation { activeSubscriptions { id name status test currentPeriodEnd } } }'
```

| 項目 | よい値 | だめなとき |
|---|---|---|
| `name` | Lite / Pro と 3 / 10 が入っている | 入っていない → 1 章の表示名を直す |
| `status` | `ACTIVE` | 空・ほか → 2.2 をやり直す |
| `test` | `true` | `false` → 開発ストアでないか、テストになっていない。止めて相談 |
| `currentPeriodEnd` | 空でない | 空 → #80 は `missing_period` で送らない（止まりはしない） |

`shop.id`（`gid://shopify/Shop/<数字>`）を控える → 2.4 で使う。

### 2.4 Partner API で契約を見る（Partner API を使うときだけ）

Partner API client（権限は Manage apps だけ）のトークンを、ファイルに書かずにその場の変数に入れて聞きます。

```bash
read -s PARTNER_TOKEN   # トークンを貼って Enter（画面に出ない）
curl -s "https://partners.shopify.com/<Partner の数字>/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" -H "X-Shopify-Access-Token: $PARTNER_TOKEN" \
  -d '{"query":"query($appId: ID!, $shopId: ID!){ activeSubscription(appId:$appId, shopId:$shopId){ billingPeriod legacySubscriptionId currentBillingCycle{ startTime endTime } items{ handle } } }","variables":{"appId":"gid://shopify/App/<アプリの数字>","shopId":"<2.3 の shop.id>"}}'
unset PARTNER_TOKEN
```

- `<Partner の数字>` は **Partner Dashboard**（partners.shopify.com）の URL の数字。Dev Dashboard の数字ではない。
- よい答え: `activeSubscription` が空でなく、`items` に `lite-10` などの handle、`currentBillingCycle.endTime` がある。
- `activeSubscription: null` なら、開発ストアのテスト課金は Partner API に出ない（【未確認】の点）。その場合も #82 は Admin API の結果で決めるので止まらない（DECISIONS D16）。`PARTNER_API_SUBSCRIPTION_ENABLED` は入れなくてよい。
- 結果（よい／null／エラー）を #79 に 1 行書く（トークンは書かない）。

---

## 3. 【T】Render `pos-stock` の環境変数（main に入れる前）

Render → `pos-stock`（公開用）→ Environment

| 名前 | 値 | いつ |
|---|---|---|
| `SHOPIFY_APP_HANDLE` | 1 章で控えた handle | **#80 の前に入れる**（無いと `pos-stock` を使う。違うとプランの画面が開かない） |
| `PARTNER_API_TOKEN`・`PARTNER_API_ORG_ID`・`PARTNER_API_APP_ID` | 2.4 の値 | 使うときだけ。いつ入れてもよい（スイッチが無いと使わない） |
| `PARTNER_API_SUBSCRIPTION_ENABLED` | `1` | 2.4 で契約が見えたとき・#82 が Live になってから |
| `ENABLE_PLAN_DEBUG` | `1` | 6 章の間だけ。終わったら消す |
| `APP_EVENTS_USAGE_ENABLED` | **まだ入れない** | 6.5 |

- `APP_DISTRIBUTION=public`・`SCOPES`（`read_orders` なし）は #100 のとき入れ済み。変えない。
- 自社用 `pos-stock-ciara` には何も入れない。
- 保存すると Render がやり直しになる。中身はまだ今のコードなので大丈夫。

---

## 4. 【係】マージの直前に見直すこと

2026-11-23 に main `a7e2fc7` で試した結果:

- #80・#82・#103 のブランチは、どれも main の最新を含んでいる（main より遅れていない）。
- 手元で main に **#80 → #82 → #103 の順にマージ**してみて、3 つともぶつからなかった（26 ファイル）。
- migration: #80 の `20261121130000_add_app_usage_report` は、main の最新 `20261008120000_add_inventory_count_documents` より後。#82・#103 に migration は無い。

マージの直前にもう一度:

```bash
git fetch origin
git ls-tree --name-only origin/main prisma/migrations/ | grep -v lock | tail -1   # 20261121130000 より前なら OK
git merge-tree --write-tree --name-only origin/main origin/claude/pos-stock-shop-redact-usage   # ぶつかるファイルが出なければ OK
```

ぶつかったら、【係】が自分のブランチから合わせる PR を出してから T さんにカードを出す（ほかのブランチへ直接 push しない）。

---

## 5. 【T】main に入れる

### 5.1 #80

1. カードで承認 → main へマージ
2. Render → `pos-stock` → **Events** で新しい配備が「Live」になるまで待つ。**Logs** で見るもの:
   - `prisma migrate deploy` の行に `20261121130000_add_app_usage_report` が出て、`All migrations have been successfully applied`（または `applied`）
   - `==> Your service is live`
3. 自社用 `pos-stock-ciara` も同じく Live になる（main を見て自動で出る）。7 章を見る。

### 5.2 #82

1. **#82 の base が `main` になっているか見る**。#80 のブランチを消していれば GitHub が自動で替える。替わっていなければ PR の「Edit」→ base を `main`（【係】がやってもよい）。`claude/pos-stock-app-events-usage` のままマージすると main に入らない。
2. カードで承認 → main へマージ → `pos-stock` が Live。migration は無い。

### 5.3 `npm run deploy:public`（#82 が Live になったあと・1 回だけ）

パソコンの `stock-transfer-pos` のフォルダで、main の最新にしてから:

```bash
git checkout main && git pull
npm run deploy:public
```

- これで出るもの: #82 の POS の拡張（3 か所のプランで多すぎる店をタイルでも止める・#91）と、#100 の公開用 toml（`read_orders` を外す・注文の Webhook を受けない）。
- `deploy:public` は `APP_MODE` を `public` にして、toml の URL と合うか確かめてから出す。合わないと出さずに止まる（`docs/DEPLOY.md` 3 章）。
- 終わったら `git status` で `extensions/common/appUrl.js` が変わっていても **コミットしない**。
- Partner Dashboard → POS Stock → バージョン に新しい版が出る。
- #82 の Live から `deploy:public` までの間は、POS のタイルは前の拡張のまま（サーバーは新しい）。間をあけずに出す。

### 5.4 #103

1. **#103 の base が `main` になっているか見る**（今は #82 のブランチ）。替わっていなければ「Edit」→ `main`。
2. カードで承認 → main へマージ → `pos-stock` が Live。migration は無い。
3. `deploy:public` はしない（5.3 で出したものと同じ）。

---

## 6. 【T】開発ストアで確かめる（全部 Live のあと）

`ENABLE_PLAN_DEBUG=1` を入れておくと、管理画面のデータに `planDebug`（`planSource` が `partner` か `admin`・`partnerStatus`）が出ます。終わったら消す。

Render のログは: Render → `pos-stock` → **Logs**。右上の検索に下の `[...]` の文字を入れて絞る。

### 6.1 管理画面（#80・#82）

1. 開発ストアで POS Stock を開く → 料金プラン
2. 見るところ:

| ロケーションの数 | 選んだプラン | 画面に出ること |
|---|---|---|
| 3 か所以下 | Lite - 3 | ふつうに使える。超えた分の行は無い |
| 4 か所以上 | Lite - 3 / Pro - 3 | 「ロケーション数がプランと一致していません」。料金プラン以外の画面に入れない |
| 4〜10 か所 | Lite - 10 / Pro - 10 | ふつうに使える。超えた分の行は無い |
| 11 か所以上 | Lite - 10 | 「10 か所を超えた N か所 × $4」と「今の請求期間の分は、まだ Shopify に報告していません。」 |
| 11 か所以上 | Pro - 10 | 同じく × $12 |

3. Render のログで、**出ていないこと** を見る（出たら止めて #79 に書く）:
   - `[getShopPlan] could not read activeSubscriptions` … 契約が読めていない
   - `[getShopPlan] PARTNER_API_SUBSCRIPTION_ENABLED=1 but missing:` … Partner API の値が足りない（後ろに足りない名前が出る）
   - `[partner-subscription] lookup failed: reason=…` … Partner API に聞けなかった（このときも Admin API で決めるので止まらない）
   - `[getShopPlan] extra location usage report crashed` … 報告の処理が落ちた
4. スイッチがオフの間は、超えた分は DB に `disabled` で残るだけで、ログに `[app-events-usage] sent` は出ない（出たら止める）。

ロケーションが 11 か所に届かないときは、11 か所以上の行は見られない。開発ストアでロケーションを足すかは T さんが決める（足したら終わったあと止める・消す）。

### 6.2 POS（#82 の拡張・5.3 のあと）

1. POS アプリで開発ストアにログイン → POS Stock のタイル
2. 3 か所のプランで 4 か所以上のとき: タイルを開くと止まり「プランを上げてください」と要るプランが出る
3. 合っているプランのとき: 出庫・入庫・ロス・棚卸がいつも通り開く
4. Render のログに `[plan-gate] plan check failed` が続けて出ていない

### 6.3 shop/redact（#103）

本当の shop/redact はアンインストールの 48 時間後にしか来ません。まずは **今入っている店を消さない** 確かめをします。

```bash
shopify app webhook trigger --topic shop/redact --api-version 2026-01 \
  --delivery-method http --address https://pos-stock.onrender.com/webhooks/compliance
```

- CLI が公開用アプリの client secret を聞いてきたら、Partner Dashboard → POS Stock → 設定 の Secret を貼る（ファイルに書かない）。聞いてこない CLI の版もある（推測）。
- CLI の見本の本文は、ストアが架空の名前（`shop_domain` が見本の値）です。そのため消える行は 0 件です。
- Render のログで見るもの: `[compliance] shop/redact for <見本のドメイン>` のあとに `{ … appUsageReport: 0, session: 0 }` のような件数。**`appUsageReport` の名前が出ていれば #103 が動いている**。
- `[webhooks.compliance] authenticate error` が出たら、secret が公開用のものと違う。
- 本当の店で確かめる（開発ストアのアプリを外して 48 時間待つ）のは、開発ストアの POS Stock のデータが消えるのでしない。するかは T さんが決める。

### 6.4 自社用（Ciara）

- Ciara の管理画面が開く・POS の出庫・入庫がいつも通り（7 章）。

### 6.5 送るスイッチを入れる（6.1〜6.4 が全部 OK のときだけ・T さんの承認）

1. Render → `pos-stock` → Environment → `APP_EVENTS_USAGE_ENABLED` = `1` → 保存（やり直しが走る → Live を待つ）
2. 開発ストア（11 か所以上・Lite - 10 か Pro - 10）で POS Stock を開く（料金プランの画面でよい）
3. Render のログ:
   - よい: `[app-events-usage] sent shop=<ドメイン> units=<超えた数> handle=extra_location_lite key=…`
   - だめ: `[app-events-usage] send failed shop=… status=<数字>`（アプリが時間をおいてやり直す。8 回まで）
   - `[app-events-usage] over app-side limit` … 超えた数がアプリの上限（`APP_EVENTS_USAGE_MAX_UNITS`・既定 50）を超えた。送っていない
   - `[app-events-usage] no billing period` … 期間が読めない。送っていない
4. **Dev Dashboard の Logs で請求に載ったかを見る**（API の 202 は「受け取った」だけ）
   - Dev Dashboard（dev.shopify.com）→ アプリ → **POS Stock** → **Logs**
   - Type（種類）を **App billing event** に絞る → 開発ストアのドメインの行
   - `OK` ならよい。`NO_MATCHING_METER` はメーターの handle がアプリと違う（1 章の handle か `APP_EVENTS_HANDLE_LITE`/`_PRO` を合わせる）。`NO_SUBSCRIPTION` は契約が無い
5. 料金プランの画面が「今の請求期間の分は Shopify に報告済みです。」になる
6. 結果を #79 に 1 行書く

- 【未確認】開発ストアで使用量のイベントが通るか。shopify.dev のコミュニティに「開発ストアで 503 が続く」報告がある。`send failed status=503` が続くときは、オンのままでも二重にはならない（同じキー）が、止めるかは T さんが決める。
- 1 つの請求期間に 1 回だけ送る。同じ期間にもう一度画面を開いても送らない（ログに `sent` は 1 回）。

---

## 7. 自社用（Ciara）への影響

- main へのマージで `pos-stock-ciara` にも配備が出る（#100 のマージで確かめた）。
- 増えるのは空の `AppUsageReport` の表だけ（`CREATE TABLE IF NOT EXISTS`）。自社用は Shopify に契約を聞かず、報告もしない。
- #103: 自社用では shop/redact でデータを消さない（ログ `in-house app; skipped delete`）。
- 【T】#80・#82・#103 のそれぞれのあとで: Ciara の管理画面が開く・POS の出庫・入庫がいつも通り。
- `deploy:public` は公開用だけ。`deploy:inhouse` はしない。

---

## 8. 困ったとき（上から順に）

1. 送るのを止める: `pos-stock` の `APP_EVENTS_USAGE_ENABLED` を消す → 保存
2. Partner API をやめる: `PARTNER_API_SUBSCRIPTION_ENABLED` を消す → Admin API だけで読む
3. コードを戻す: Render → `pos-stock` → Events → 1 つ前の Live の版 → Rollback。【係】が revert の PR → 【T】がカードで承認してマージ（戻さないと次のマージでまた出る）。`AppUsageReport` の表は消さない
4. POS の拡張を戻す: Partner Dashboard → POS Stock → バージョン → 1 つ前の版を出す（【T】）

Partner Dashboard のプランは消さない（店の契約が切れる）。

---

## 9. チェック表（本番）

- [ ] 【T】1. プラン 4 つ（ハイフンの handle）・メーター 2 つ・アプリの handle を控えた
- [ ] 【T】2.2 開発ストアで Lite - 10 を選んだ
- [ ] 【T】2.3 `shopify app execute` で `ACTIVE`・`test: true`・`currentPeriodEnd` あり
- [ ] 【T】2.4 Partner API の答え（よい／null）を #79 に書いた（使うときだけ）
- [ ] 【T】3. `pos-stock` に `SHOPIFY_APP_HANDLE`（＋使うなら `PARTNER_API_*`）
- [ ] 【係】4. migration の時刻とぶつからないかを見直した
- [ ] 【T】5.1 #80 → `pos-stock`・`pos-stock-ciara` が Live・migration のログ
- [ ] 【T】5.2 #82 の base を main → マージ → Live
- [ ] 【T】5.3 `npm run deploy:public`（1 回だけ）・`appUrl.js` をコミットしない
- [ ] 【T】5.4 #103 の base を main → マージ → Live
- [ ] 【T】6.1 料金プランの画面・Render のログに警告なし
- [ ] 【T】6.2 POS のタイル
- [ ] 【T】6.3 shop/redact の試しで `appUsageReport` の件数が出た
- [ ] 【T】6.4 Ciara がいつも通り
- [ ] 【T】6.5 `APP_EVENTS_USAGE_ENABLED=1` → ログ `sent` → Dev Dashboard の Logs で `OK`
- [ ] 【T】終わったら `ENABLE_PLAN_DEBUG` を消した
