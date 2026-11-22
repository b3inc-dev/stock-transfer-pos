# 料金（Shopify App Pricing）を本番に出す手順 — POS Stock

対象: #80（超えたロケーションを App Events API で報告）・#82（契約を Partner API でも読む。#80 の上に積んだ PR）

- この手順は下書きです。マージ・本番に出す操作・スイッチをオンにすることはしていません
- T がやるところは **【T】**、エージェントがやるところは **【係】**
- 公開用「POS Stock」だけの話です。自社用（Ciara）は変わりません（7. を参照）

---

## 0. 順番（これ以外の順にしない）

1. Partner Dashboard でプランとメーターを作る
2. 公開用の Render `pos-stock` に環境変数を入れる（送るスイッチはまだ入れない）
3. migration の時刻を確かめる
4. #80 を main へ → #82 を main へ
5. 開発ストアで確かめる（`shopify app execute`）
6. **ここまで OK のときだけ** `APP_EVENTS_USAGE_ENABLED=1`

---

## 1. 【T】Partner Dashboard（公開用「POS Stock」）

Partner Dashboard → アプリ → POS Stock → 配布 → 価格 → Managed pricing

### プラン（4 つ。月額）

| 表示名（例） | 内部計画ハンドル | メーター |
|---|---|---|
| Lite - 3ロケーション | `lite-3` | なし |
| Lite - 10ロケーション | `lite-10` | `extra_location_lite`・Fixed・1 単位 $4 |
| Pro - 3ロケーション | `pro-3` | なし |
| Pro - 10ロケーション | `pro-10` | `extra_location_pro`・Fixed・1 単位 $12 |

- 内部計画ハンドルは **ハイフン**（`lite-3`）。アンダースコア（`lite_3`）はアプリが受け付けません。**あとから変えられない** ので打ち間違いに注意
- 表示名に「Lite」「Pro」と「3」「10」を入れる
- メーターのあるプランは月額だけにする（年額だけのプランには付けられない）
- 金額・無料期間は T が決めたものを入れる（目安は `PARTNER_PRICING_SETUP_STEPS.md`）
- メーターの handle を上と違う文字にしたときは、2. で `APP_EVENTS_HANDLE_LITE` / `APP_EVENTS_HANDLE_PRO` を同じ文字にする

### Partner API client（使うときだけ）

Dev Dashboard → Organization settings → Users → Security → Partner API clients → Add

- 権限は **Manage apps** だけ
- 出たトークンはすぐ控える（もう見られない）
- POS Stock 用に 1 つ（Location Stock・Review Q&A とは分ける）

### アプリの handle を控える

Partner Dashboard のアプリの URL や「App handle」に出る文字。2. の `SHOPIFY_APP_HANDLE` に使います。

---

## 2. 【T】Render の環境変数（公開用 `pos-stock` だけ）

Render → `pos-stock` → Environment

| 名前 | 値 | 要るか |
|---|---|---|
| `SHOPIFY_APP_HANDLE` | 1. で控えた handle | 入れる（無いと `pos-stock` を使う。違っていたらプラン選択ページが開かない） |
| `PARTNER_API_SUBSCRIPTION_ENABLED` | `1` | 使うときだけ |
| `PARTNER_API_TOKEN` | 1. のトークン（秘密） | 使うときだけ |
| `PARTNER_API_ORG_ID` | Partner Dashboard の URL の数字 | 使うときだけ |
| `PARTNER_API_APP_ID` | 公開用アプリの ID | 使うときだけ |
| `PARTNER_API_VERSION` | 省略（既定 `2026-10`） | いらない |
| `APP_EVENTS_USAGE_ENABLED` | **まだ入れない** | 6. で入れる |

- `APP_EVENTS_CLIENT_ID` / `APP_EVENTS_CLIENT_SECRET` は入れなくてよい（無いときは `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` を使う）
- `PARTNER_API_ORG_ID` は Dev Dashboard の数字ではなく、**Partner Dashboard**（partners.shopify.com）の URL の数字
- 自社用 `pos-stock-ciara` には **何も入れない**
- 保存で Render がやり直しになっても、中身はまだ古いコードなので大丈夫です

---

## 3. 【係】migration の時刻を確かめる（マージの直前）

- #80 の migration: `prisma/migrations/20261121130000_add_app_usage_report`
- 2026-11-22 の main の最新: `20261008120000_add_inventory_count_documents`（#80 のほうが後なので今は OK）
- マージの直前に、もう一度 main の最新と比べる。main に後の時刻のものが入っていたら、#80 の migration の時刻を main の最新より後へ付け直してから T にカード

```bash
git fetch origin
git ls-tree --name-only origin/main prisma/migrations/ | tail -3
```

---

## 4. 【T】#80 → #82 の順にマージ

### #80

1. カードで承認 → main へマージ
2. Render `pos-stock` が「Live」になるまで待つ
   - 起動のとき `npm run setup`（`prisma migrate deploy`）で、本番の DB に `AppUsageReport` の表が 1 つ増えます。スイッチはオフなので外へは何も送りません

### #82

1. **#82 の行き先（base）が `main` になっているか見る**
   - #80 のブランチを消していれば GitHub が自動で `main` に替えます
   - 替わっていなければ PR の「Edit」→ base を `main` にする（【係】がやってもよい）
   - `claude/pos-stock-app-events-usage` のままマージすると、main に入りません
2. カードで承認 → main へマージ
3. Render `pos-stock` が「Live」になるまで待つ

2026-11-22 の時点では #82 は main とぶつかりません。

---

## 5. 【T】開発ストアで確かめる

### 5.1 Shopify の契約を直接見る

パソコンの `stock-transfer-pos` のフォルダで（`<開発ストア>` は公開用アプリを入れた開発ストア。例: `bbbincbbb`）:

```bash
shopify app execute -c public -s <開発ストア>.myshopify.com -q '{ shop { id } currentAppInstallation { activeSubscriptions { name status test currentPeriodEnd } } }'
```

見るところ:

| 項目 | よい値 |
|---|---|
| `name` | 選んだプランの名前（Lite / Pro と 3 / 10 が入っている） |
| `status` | `ACTIVE` |
| `test` | `true`（開発ストアはテスト課金で請求なし） |
| `currentPeriodEnd` | 空でない |

`activeSubscriptions` が空なら、まだプランを選んでいません（5.2 の 1〜2 をしてからもう一度）。

### 5.2 画面で見る

1. 開発ストアで POS Stock を開く → 料金プラン →「プランを選ぶ」で Shopify の画面が開く
2. テストの Lite（10 か所）を選ぶ → アプリに戻る → プラン名が出る
3. ロケーションが 11 か所以上なら、料金プラン画面に「10 か所を超えた N か所 × $4」が出て、状態が「まだ報告していません」
4. POS の出庫・入庫が今まで通り使える
5. Pro でも同じことを見る（$12）

---

## 6. 【T】送るスイッチを入れる（5. が全部 OK のときだけ）

1. Render `pos-stock` → Environment → `APP_EVENTS_USAGE_ENABLED=1` → 保存（やり直しが走る）
2. 開発ストア（11 か所以上）で POS Stock を開く
3. Dev Dashboard → アプリ → **Logs**（Type: App billing event）に `OK` が出るのを見る
   - API の 202 は「受け取った」だけです。請求に載ったかは Logs で見ます

---

## 7. 自社用（Ciara）は変わらない

- 自社用（`APP_DISTRIBUTION=inhouse`）は Shopify に契約を聞かず、報告もしません（#82 で、報告の中でも DB・Shopify を触らないよう二重にしてあります）
- `pos-stock-ciara` が main を見て自動で出るかは未確認です。出た場合でも、増えるのは空の `AppUsageReport` の表だけです
- 【T】マージのあと Ciara で: 管理画面が開く・POS の出庫・入庫が今まで通り

---

## 8. 前の版に戻す

困ったら、上から順に。

1. **送るのを止める**: Render `pos-stock` → `APP_EVENTS_USAGE_ENABLED` を消す（または `0`）→ 保存。これで外へは送りません
2. **Partner API をやめる**: `PARTNER_API_SUBSCRIPTION_ENABLED` を消す → Admin API だけで読む（#82 より前と同じ）
3. **コードを戻す**: Render `pos-stock` → Events → 1 つ前の「Live」の版 → Rollback。【係】が revert の PR を作り、【T】がカードで承認してマージ（戻さないと次のマージでまた出る）
   - `AppUsageReport` の表は残りますが、古いコードは使わないので害はありません。消さない
4. **送ってしまった請求**: Shopify 側では同じキーは二度と載りません。取り消しは Partner Dashboard の請求の画面で扱う（アプリからは取り消せません）

Partner Dashboard のプランは消さないでください（店の契約が切れます）。

---

## 9. 一覧（チェック用）

- [ ] 【T】1. プラン 4 つ（ハイフンの handle）・メーター 2 つ
- [ ] 【T】1. Partner API client（使うときだけ）・アプリの handle を控える
- [ ] 【T】2. `pos-stock` に `SHOPIFY_APP_HANDLE`（＋ `PARTNER_API_*`）
- [ ] 【係】3. migration の時刻
- [ ] 【T】4. #80 マージ → Live
- [ ] 【T】4. #82 の base を main → マージ → Live
- [ ] 【T】5. `shopify app execute` と画面
- [ ] 【T】6. `APP_EVENTS_USAGE_ENABLED=1` → Logs で `OK`
- [ ] 【T】7. Ciara がいつも通り
