# Partner Dashboard と公開用 Render の手順 — POS Stock

T が上から順に押すための手順。**オンにする（外へ送る）のは、#80・#82 が main に入り、T が決めたあと**。それまでは 1〜3 だけ先にやってよい（作るだけでは何も請求されない）。

根拠:
- 料金プランとメーター: `docs/PARTNER_PRICING_SETUP_STEPS.md`（PR #80/#82 の版）・DECISIONS D15/D16
- メーターの作り方と決まり: https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-usage-charges 【事実 2026-11-22 に読んだ】
- App Events API のトークン: https://shopify.dev/docs/apps/build/app-events/send-events 【事実】

画面の名前（ボタンの文字）は Shopify が変えることがある。見つからないときは近い名前を探す。

---

## 1. 料金プランを 4 つ作る（Partner Dashboard）

1. https://partners.shopify.com → Apps → **POS Stock**（公開用。client_id `41d3…8239`）
2. Distribution → **Pricing**（または Pricing content → Manage）→ 方式で **Shopify App Pricing（Managed pricing）** を選ぶ
3. Public plans → Add を 4 回。下の表のとおりに入れて Save

| | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| Plan handle（後から変えられない） | `lite-3` | `lite-10` | `pro-3` | `pro-10` |
| 表示名（Display name） | Lite - 3 locations | Lite - 10 locations | Pro - 3 locations | Pro - 10 locations |
| Billing | Monthly | Monthly | Monthly | Monthly |
| 月額（USD） | 20 | 40 | 60 | 120 |
| Free trial（日） | 7 | 7 | 14 | 14 |
| Redirect URL | `/app` | `/app` | `/app` | `/app` |
| 使用量のメーター | なし | `extra_location_lite`（2 章） | なし | `extra_location_pro`（2 章） |

- **表示名と handle の両方に `lite` / `pro` と `3` / `10` を入れる**。アプリは Admin API の契約名（表示名）で、Partner API を使うときは handle で Lite/Pro と 3/10 を読む【事実: `getPlanFromActiveSubscriptions`・`getMaxLocationsFromSubscriptionName`、D16「項目の handle を名前として読む」】。
- handle は**ハイフン**で `lite-3` のようにする。**アンダースコア（`lite_3`）だと 3/10 を読めない**【事実: `app/utils/billing.ts` の `getMaxLocationsFromSubscriptionName` は `-3`・`3 locations`・前後が区切りの `3` だけを読む。`_` は区切りにならない】。表示名の `Lite - 3 locations` は読める。
- 使用量のあるプランは月額だけ（年額だけのプランとは組めない）【事実: setup-usage-charges】。
- 各プランの「特徴（Top features）」は ja.md / en.md 9 章の「使える機能」を貼る。日本語と英語で 1 回ずつ Edit → Save。

## 2. 使用量のメーターを 2 つ作る

1. Pricing で **Lite - 10 locations** を開く → usage meter を作る
   - event handle: `extra_location_lite`
   - 料金の形: **Fixed**、1 単位 **US$4**
2. **Pro - 10 locations** も同じ: handle `extra_location_pro`、Fixed、1 単位 **US$12**
3. 3 か所のプランには付けない（アプリも送らない）【事実: D15】

- handle はアプリが送る `event_handle` と同じでないと請求されない（Logs に「App event」とだけ出る）【事実: setup-usage-charges】。違う handle にしたら、Render の `APP_EVENTS_HANDLE_LITE` / `APP_EVENTS_HANDLE_PRO` も同じにする。
- Shopify 側に上限（cap）は無い。アプリ側の上限は `APP_EVENTS_USAGE_MAX_UNITS`（既定 50 か所）【事実: D15】。
- アンインストールのあと 24 時間で期間が閉じ、それより後のイベントは `PERIOD_CLOSED` で失敗する【事実: setup-usage-charges】。

## 3. アプリの handle を控える

- Partner Dashboard のアプリの URL や設定に出る英数字の handle（例 `pos-stock`）。プラン選択ページの URL（`admin.shopify.com/store/<店>/charges/<handle>/pricing_plans`）に使う【事実: `PARTNER_PRICING_SETUP_STEPS.md` 6 章】。

## 4. Partner API client を作る（#82 を使うときだけ）

1. Dev Dashboard → 組織の設定（Organization settings）→ Users → Security → **Partner API clients** → Add Partner API client
2. 名前: `pos-stock-subscription` など。権限は **Manage apps だけ**
3. 出たトークンをすぐ控える（ページを離れると見られない）
4. **Partner Dashboard（partners.shopify.com）の URL の数字**を控える（`PARTNER_API_ORG_ID`。Dev Dashboard の数字ではない）
5. 公開用アプリの ID（数字）を控える（`PARTNER_API_APP_ID`）

- 作るには組織の App development の権限・Manage financials の権限・確認済みの仕事用メールが要る【事実: `PARTNER_PRICING_SETUP_STEPS.md` 6-2】。
- POS Stock・Location Stock・Review Q&A で client を分ける（上限は client ごとに 4 回/秒）【事実: D16】。

## 5. 公開用 Render（`pos-stock`）の環境変数

**自社用（Ciara）の Render には入れない。** 秘密の値はチャットやコミットに書かない。

### 5.1 まず確かめる（今の値）

| 名前 | あるべき値 | 根拠 |
|---|---|---|
| `APP_DISTRIBUTION` | 空（または `public`） | `plan-distribution.ts` |
| `CUSTOM_APP_STORE_IDS` | 空 | 同上 |
| `ENABLE_PLAN_DEBUG` | 無い（確かめる間だけ `1`） | `shop-plan.server.ts` |
| `SCOPES` | 公開用 toml の `scopes` と同じ | `app/shopify.server.ts` |
| `SHOPIFY_APP_HANDLE` | 3 章の handle | `app/routes/app.plan.tsx` |
| `INVENTORY_SNAPSHOT_API_KEY` | 在庫高の毎日の記録を使うなら、Render の Cron Job と同じ値（`docs/CRON_JOB_SETUP_GUIDE.md`）。公開用に Cron Job があるかは【T】が確かめる | `api.inventory-snapshot-daily.tsx` |

### 5.2 使用量（#80）— 入れるのは #80 が main に入ってから

| 名前 | 値 |
|---|---|
| `APP_EVENTS_CLIENT_ID` | **公開用アプリの client ID**（`SHOPIFY_API_KEY` と同じ値）。App Events API はアプリ自身の client ID と secret でトークンを取る【事実: send-events】 |
| `APP_EVENTS_CLIENT_SECRET` | 公開用アプリの client secret（`SHOPIFY_API_SECRET` と同じ値） |
| `APP_EVENTS_HANDLE_LITE` / `APP_EVENTS_HANDLE_PRO` | 省略可（既定 `extra_location_lite` / `extra_location_pro`） |
| `APP_EVENTS_USAGE_MAX_UNITS` | 省略可（既定 50） |
| `APP_EVENTS_API_VERSION` | 省略可（既定 `2026-10`） |
| `APP_EVENTS_USAGE_ENABLED` | **最後に** `1`（T の承認のあと）。入れるまでは数だけ DB に `disabled` で残る |

### 5.3 Partner API（#82）— 入れるのは #82 が main に入ってから

| 名前 | 値 |
|---|---|
| `PARTNER_API_TOKEN` | 4 章のトークン |
| `PARTNER_API_ORG_ID` | 4 章の Partner Dashboard の URL の数字 |
| `PARTNER_API_APP_ID` | 4 章のアプリの ID |
| `PARTNER_API_VERSION` | 省略可（既定 `2026-10`） |
| `PARTNER_API_SUBSCRIPTION_ENABLED` | **最後に** `1`（T の承認のあと） |

## 6. 開発ストアで確かめる（`bbbincbbb`）

1. アプリを開く → 料金プラン → Shopify のプラン選択ページで **Pro - 10 locations** を選ぶ（テスト課金）
2. `ENABLE_PLAN_DEBUG=1` の間だけ、`planDebug.planSource`（`partner` / `admin`）と `partnerStatus` を見る（#82）
3. ロケーションが 11 か所以上なら、料金プランの画面に「10 ロケーションを超えた分」が出る（#80）
4. Dev Dashboard → アプリ → **Logs** → Type「App billing event」で、イベントが `OK` か見る。`NO_MATCHING_METER` は handle の違い、`NO_SUBSCRIPTION` は契約なし【事実: setup-usage-charges】
5. 終わったら `ENABLE_PLAN_DEBUG` を消す

- 【未確認】開発ストアのテスト課金が Partner API の `activeSubscription` に出るか（出なければ Admin API の結果を使うので止まらない。D16）。
- 【未確認】開発ストアで使用量のイベントが通るか。shopify.dev のコミュニティに「開発ストアで 503 が続く」という報告がある（https://community.shopify.dev/t/app-events-api-repeatedly-returns-http-503-for-metered-plan-marked-free-on-development-stores/36239）。失敗はアプリが `failed` で残して送り直す（D15）。

## 7. チェック

- [ ] 1. 4 つのプラン（表示名と handle に lite/pro と 3/10）
- [ ] 2. メーター 2 つ（`extra_location_lite` $4・`extra_location_pro` $12）
- [ ] 3. `SHOPIFY_APP_HANDLE`
- [ ] 4. Partner API client（使うなら）
- [ ] 5.1 今の値の確認
- [ ] 5.2 / 5.3 は #80・#82 のあと。`…_ENABLED=1` は T の承認のあと
- [ ] 6. 開発ストアで確かめた
