# App Store 提出チェックリスト — POS Stock（公開版）

- 対象: 公開アプリ「POS Stock」（`shopify.app.public.toml`、client_id `41d3…8239`、`https://pos-stock.onrender.com`）
- 調べた日: 2026-11-20（Shopify の公開ページと、この時点の `main` と開いている PR）
- 目的: 12/3 までに App Store へ出すための確認表。**12 月に出す他のアプリでも同じ表を使えるように**、前半（1〜3 章）はどのアプリにも共通、後半（4 章から）はこのアプリだけの内容にしている。
- この文書は docs だけの変更。アプリのコード・設定・本番・Partner の画面は何も変えていない。

## 印の意味

| 印 | 意味 |
|----|------|
| **【済】** | コードか設定で確かめた（根拠のファイルを書いている） |
| **【未】** | まだできていない。直す PR が要る |
| **【T】** | T が決める、または T が Partner / Render / 外部サービスで作業する |
| **【要確認】** | コードからは言い切れない。開発ストアで実際に試して確かめる |

古い docs（`PUBLIC_APP_REMAINING_TASKS.md`、`LISTING_ASSETS_GUIDE.md`、`APP_PRICING_SETUP_GUIDE.md` など）とこの文書が食い違うときは、この文書を正とする（例: 古い docs には「プラン制御は未実装」とあるが、今の `main` には実装がある）。

---

## 1. いちばん大事なこと: 提出できる本数に上限がある

2026-11-10 から、Shopify は新しいアプリの提出に上限をかけている。

- **審査中にできる新しいアプリは 1 組織につき 1 本だけ**。提出してから公開されるまで、その 1 本が枠を使う。
- **すでに公開しているアプリがあるなら、その全部が「有料の Shopify プランで動いている店」10 店以上に入っていないと、次の新しいアプリを出せない**。開発ストアと無料体験中の店は数えない。数は 1 日 1 回更新。
- 公開済みアプリの更新や、審査中アプリの出し直しはこの上限に入らない。
- 新しいアプリを出す人は、Partner アカウントで**本人確認**を済ませておく必要がある。
- 却下のあと、指摘を直さずに出し直すと**待ち期間（cooldown）**が付き、繰り返すほど長くなる。
- 公開後 6 か月インストール 0 のアプリは自動で外される。

出典:
- https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review （Submission limits / App submission paused）
- https://shopify.dev/changelog/posts/shopify-app-store-submission-requirements-build-grow-then-expand

**このため「POS Stock と Location Stock を両方 12/3 までに出す」はそのままではできない。** 1 本目を出して公開され、さらに 10 店に入るまで 2 本目は出せない（b3inc にすでに公開アプリがあれば、そのアプリも 10 店が要る）。12 月の他アプリも同じ。どれを先に出すかは T が決める（8 章）。

---

## 2. 共通チェックリスト（どのアプリでも使う）

各行の「出典」は Shopify の公開ページ。番号（1.1.1 など）は App Store requirements の番号。
主な出典:
- 要件一覧: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
- リスティングの書き方と数値: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- 提出の手順: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review

### 2.1 提出の前提（Partner / 組織）

| # | 確認すること | 出典 | 誰が |
|---|--------------|------|------|
| P1 | 1 章の上限にかからないか（審査中のアプリが他にない・公開済みアプリが 10 店以上） | submit-app-for-review | T |
| P2 | Partner アカウントの本人確認が済んでいる | changelog 2026-11-10 | T |
| P3 | 緊急連絡先（メール＋電話）を登録した（4.5.6） | requirements 4.5.6 | T |
| P4 | API 連絡先メールに「Shopify」の語（つづり違い・略も）が入っていない | submit-app-for-review | T |
| P5 | アプリの URL（ドメイン）に「Shopify」「Example」が入っていない | submit-app-for-review | コード側で確認 |
| P6 | 主な言語を選び、リスティングを 1 つ以上作った | submit-app-for-review | T |
| P7 | 保護された顧客データ: 要るなら申請、要らないなら「使わない」を選ぶ（**審査中は申請できない**） | submit-app-for-review | T（判断はコード調査をもとに） |
| P8 | 自動チェック（Automated checks）をすべて通した | submit-app-for-review | T（Partner で実行） |
| P9 | `noreply@shopify.com` を受信許可にした（審査の連絡が来る） | submit-app-for-review | T |

### 2.2 インストールと認証

| # | 確認すること | 出典 |
|---|--------------|------|
| A1 | インストールは Shopify の画面から始まる。**店のドメイン（myshopify.com）を手で入れさせない**（2.3.1） | requirements 2.3.1 |
| A2 | インストール直後・再インストール直後に、他の画面より先に OAuth（許可画面）が出る（2.3.2 / 2.3.4） | requirements 2.3.2, 2.3.4 |
| A3 | 許可のあと、アプリの画面へ移る（2.3.3） | requirements 2.3.3 |
| A4 | 埋め込みアプリは session token で認証し、サードパーティ Cookie なし・シークレットウィンドウでも動く（1.1.1） | requirements 1.1.1 |
| A5 | App Bridge の最新版を、ほかの script より先に読む（2.2.3） | requirements 2.2.3 |
| A6 | Admin API は GraphQL だけを使う（REST は新規の公開アプリでは不可）（2.2.4） | requirements 2.2.4 |
| A7 | 有効な TLS 証明書（3.1.1） | requirements 3.1.1 |
| A8 | **期限つきのオフライン アクセストークン**を使う（3.1.2） | requirements 3.1.2 |
| A9 | 必要なスコープだけを求める。理由を聞かれたら説明できる（3.2） | requirements 3.2 |

### 2.3 課金

| # | 確認すること | 出典 |
|---|--------------|------|
| B1 | 料金は Shopify App Pricing（旧 Managed Pricing）か Billing API だけで取る（1.2.1） | requirements 1.2.1 |
| B2 | 承認・辞退を正しく扱い、再インストール時はもう一度承認を求める（1.2.2） | requirements 1.2.2 |
| B3 | 店がサポートに連絡せず、再インストールもせずにプランを上げ下げできる（1.2.3） | requirements 1.2.3 |
| B4 | **Shopify App Pricing を使うなら、Billing API（`appSubscriptionCreate`）で新しい定期課金は作れない**。従量課金は App Events API で送り、上限額（cap）は使えない。公開プランは 8 つまで。開発ストアでは無料で試せる。プラン選択ページは `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans` | https://shopify.dev/docs/apps/launch/billing/managed-pricing |
| B5 | サブスクリプションが無い店は、プラン選択ページへ案内する | managed-pricing |
| B6 | リスティングの料金欄に、無料体験の日数や追加料金まで全部書く。画像やアイコンに値段を入れない（4.2.1〜4.2.3） | requirements 4.2 |

### 2.4 必須の webhook（顧客データの開示・削除）

| # | 確認すること | 出典 |
|---|--------------|------|
| W1 | `customers/data_request`・`customers/redact`・`shop/redact` を `compliance_topics` で登録する。**顧客データを持たないアプリも必須** | https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance |
| W2 | 受け取ったら 200 番台を返す。HMAC が正しくないときは 401 を返す。POST / JSON | privacy-law-compliance |
| W3 | 依頼された開示・削除は 30 日以内に終える。`shop/redact` はアンインストールの 48 時間後に届く | privacy-law-compliance |
| W4 | **ライブラリの `authenticate.webhook()` が返す `topic` は `CUSTOMERS_DATA_REQUEST` / `CUSTOMERS_REDACT` / `SHOP_REDACT` の大文字形**。`"customers/redact"` のような小文字・スラッシュの文字列と比べると一致せず、何も消さずに 200 を返してしまう | https://shopify.dev/docs/api/shopify-app-remix/latest/guide-webhooks （例の `switch` が大文字形） |

### 2.5 保護された顧客データ

| # | 確認すること | 出典 |
|---|--------------|------|
| D1 | 注文・返金・顧客・配送など「1 人の顧客や 1 件の注文につながるデータ」に触れるなら Level 1 以上。氏名・住所・電話・メールに触れるなら Level 2 | https://shopify.dev/docs/apps/launch/protected-customer-data |
| D2 | 公開アプリは Level 1 も Level 2 も審査がある。許可がないフィールドは消されて返る | protected-customer-data |
| D3 | Level 1 の約束: 必要最小限・目的を店に伝える・保存期間を決める・保存時も通信時も暗号化 など | protected-customer-data |

### 2.6 画面の質

| # | 確認すること | 出典 |
|---|--------------|------|
| Q1 | 審査を止めるエラー（404・500 など）や、一部を止める表示崩れがない（2.1.1 / 2.1.2） | requirements 2.1 |
| Q2 | どこから開いても画面で操作できる（2.1.3） | requirements 2.1.3 |
| Q3 | Shopify 管理画面・アプリ・他の連携先のデータが食い違わない（2.1.4） | requirements 2.1.4 |
| Q4 | テンプレートのままの画面・ダミー文言が残っていない（審査員が開いたときの印象。2.1.2 の表示の問題として指摘されうる） | requirements 2.1.2 |

### 2.7 POS UI extension（POS で動くアプリ）

| # | 確認すること | 出典 |
|---|--------------|------|
| S1 | POS で始められる操作は、すべて最後まで終えられる | best-practices（POS） |
| S2 | アプリの画面は POS のアプリ一覧（POS Apps）から開ける | best-practices（POS） |
| S3 | リスティングに POS の画面のスクリーンショットを入れる | best-practices（POS） |
| S4 | POS からサーバーへの通信は `getSessionToken()` のトークンを `Authorization` に付け、サーバー側で検証する。トークンが空のときは失敗として扱う。アプリの権限が無いスタッフではトークンが出ない | https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/standard-apis/session-api |
| S5 | Shopify 以外の POS とつなぐアプリは不可（1.1.8） | requirements 1.1.8 |

### 2.8 テーマ拡張とストアの速さ（オンラインストアに出すアプリ）

| # | 確認すること | 出典 |
|---|--------------|------|
| T1 | テーマの変更は theme app extension だけで行う（5.1.1） | requirements 5.1.1 |
| T2 | テーマエディタとストアでエラーなく表示（5.1.2） | requirements 5.1.2 |
| T3 | アプリブロック・アプリ埋め込みの設定手順を詳しく書く。ディープリンクを強くすすめる（5.1.3） | requirements 5.1.3 |
| T4 | **Lighthouse の performance スコアを 10 点より多く下げない**。重みはホーム 17%・商品ページ 40%・コレクション 43%。何回か測って平均する | best-practices（Performance） |
| T5 | 上限: Liquid 合計 100 KB（強制）・ブロック 30 個（強制）・ロケールファイル 1 つ 15 KB（強制）・スキーマから読む JS は圧縮後 10 KB まで（目安）・CSS 100 KB まで（目安） | https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration |
| T6 | オンラインストアに機能を足すなら「オンラインストアが必要」を選ぶ（4.3.1） | requirements 4.3.1 |

### 2.9 リスティング

数値は https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices より。

| 項目 | 決まり |
|------|--------|
| アプリ名 | 30 文字以内。Dev Dashboard（toml の `name`）とリスティングで同じか、共通の語を含む（4.1.1）。他のアプリ・ブランドと紛らわしくない、独自の呼び名で始める（4.1.2） |
| アイコン | 1200×1200 px、JPEG か PNG。角は自動で丸くなるので余白をとる。文字・スクショ・Shopify の商標・他社ロゴを入れない |
| アプリカードのサブタイトル | 文字数の決まりは書かれていない。機能ではなく店にとっての良さを書く。キーワードの詰め込み・数字を入れない（4.4.1） |
| 紹介文（App introduction） | 100 文字 |
| 詳細（App details） | 500 文字。機能の並べただけにしない（4.4.2） |
| 機能リスト | 1 つ 80 文字まで |
| フィーチャー画像／動画 | 動画は 2〜3 分（画面録画は 25% まで）。画像なら 1600×900 px（16:9）、代替テキストを付ける |
| スクリーンショット | 1600×900 px（16:9）、パソコン用 3〜6 枚、少なくとも 1 枚はアプリの画面。ブラウザの枠・個人情報・値段・レビュー・成果の保証を写さない。代替テキストを付ける。POS のアプリは POS の画面も入れる。1 枚ずつ違う機能・状態にする（4.4.5） |
| デモストア URL | 開発ストアの、いちばん見せたいページへ直接リンク＋説明 |
| 検索語 | 5 つまで。1 語に 1 つの意味 |
| 料金 | 「無料」「定期」「1 回払い」から選ぶ。有料プランは 14 日の無料体験をすすめる |
| プライバシーポリシー | **必須**（URL）。利用規約は任意 |
| サポート | Shopify 向けのヘルプページ。FAQ・更新履歴などは宣伝ページでなく専用ページへ |
| 言語 | アプリの画面が対応している言語だけを書く（4.3.2） |
| 禁止 | 根拠のない数字・「初の」「一番の」「唯一の」・レビューや推薦文（4.3.3〜4.3.7） |
| インストール条件 | 必要な販売チャネル（オンラインストア / POS）と国などを指定（4.3.8） |

### 2.10 審査用の資料

| # | 確認すること | 出典 |
|---|--------------|------|
| R1 | 画面録画（デモ screencast）: 初期設定から主な機能まで順に見せる。**英語の音声か英語字幕が必須**（4.5.3） | requirements 4.5.3 |
| R2 | テスト手順にログイン情報を書き、ずっと使える状態にしておく（4.5.4） | requirements 4.5.4 |
| R3 | 二段階認証・ワンタイムコードが要らないテスト用アカウント（4.5.5） | requirements 4.5.5 |

---

## 3. 新しいアプリでこの表を使う手順

1. この文書をそのアプリのリポジトリの `docs/APP_STORE_SUBMISSION.md` にコピーする。
2. 2 章はそのまま残し、4 章以降をそのアプリ用に書き換える。
3. 2 章の各行について、そのアプリのコードで「【済】【未】【T】【要確認】」を付ける（4 章の表）。
4. 特に毎回見落としやすいもの: 2.4 の W4（topic の形）、2.2 の A1（ドメイン入力のログイン画面）、2.3 の B4（App Pricing と Billing API の混在）、1 章の提出上限。

---

## 4. POS Stock の確認結果（2026-11-20 の `main` = `173c261`）

### 4.1 状態の一覧

| # | 項目 | 状態 | 根拠・メモ |
|---|------|------|-----------|
| A1 | ドメインを手で入れさせない | **【未】** | `app/routes/_index/route.tsx` がテンプレートのまま。アプリの URL を直接開くと「Shop domain」を入れるログイン欄と「A short heading about [your app]」のダミー文が出る。`auth.login/route.tsx` も同じ入力欄 |
| A2/A3 | インストール直後の OAuth とアプリ画面への移動 | 【済】（【要確認】） | toml の `[access_scopes]` で Shopify 管理のインストール。`app/shopify.server.ts` は `AppDistribution.AppStore`。Ciara 以外の開発ストアで実際に入れて確かめる（8 章） |
| A4/A5 | session token・App Bridge | 【済】 | `@shopify/shopify-app-react-router` の `authenticate.admin` と `AppProvider`（`app/routes/app.tsx`） |
| A6 | GraphQL のみ | 【済】 | Admin API は `admin.graphql`。`api.inventory-snapshot-daily.tsx` も GraphQL エンドポイントへ直接 POST |
| A8 | 期限つきオフライントークン | 【済】 | `app/shopify.server.ts` の `future.expiringOfflineAccessTokens: true` |
| A9 | 必要なスコープだけ | **【T】** | 公開 toml に `read_orders` がある。注文の webhook（`orders/updated`・`refunds/create`）は公開 toml ではコメントアウト中なので、公開版では `read_orders` を使う場面がない。4.2 の G4 を参照 |
| P5 | ドメインに Shopify / Example なし | 【済】 | `pos-stock.onrender.com` |
| B1 | Shopify の課金だけ | 【済】 | `app/routes/app.plan.tsx` は App Pricing のプラン選択ページへ `_top` で移動 |
| B2/B3 | 承認・辞退・再承認・プラン変更 | 【要確認】 | Shopify のプラン選択ページ任せ。Partner で App Pricing のプランを作った後、開発ストアで試す |
| B4 | App Pricing と Billing API の混在 | **【未】** | `app/utils/billing.ts` に `appSubscriptionCreate`（今は呼ばれていない）と `appUsageRecordCreate`（`app/routes/app.tsx` の `getShopPlan` から 11 店舗以上で呼ばれる）がある。App Pricing では従量は App Events API で送る決まりで、上限額も使えない。今の 10 店舗超の従量課金は App Pricing では動かない |
| B5 | 未契約の店をプラン選択へ | **【未】** | 公開版・本番の店で未契約のとき `plan = null`。管理画面は Pro 専用ページだけ `/app/plan` へ回すが、**POS のタイル（ロス・棚卸・仕入・発注・調整）とサーバー API（`api.inventory.apply-change.tsx`・`api.pos-stocktake-complete.tsx`・`api.log-inventory-change.tsx`）はプランを見ていない**。未契約でも POS の全機能が使える＝リスティングの料金と食い違う |
| W1 | 必須 webhook の登録 | 【済】 | 公開 toml の `compliance_topics` → `/webhooks/compliance` |
| W2 | 200 / 401 | 【済】 | `app/routes/webhooks.compliance.tsx`。HMAC が違うと `authenticate.webhook` が投げ、401 を返す |
| W3/W4 | 実際に消す | **【未】** | `webhooks.compliance.tsx` は `topicStr === "customers/redact"` / `"shop/redact"` と比べている。ライブラリの topic は `CUSTOMERS_REDACT` / `SHOP_REDACT` の形なので一致せず、**何も消さずに 200 を返す**（推測ではなく公式例の形から。開発ストアでログを見て最終確認）。さらに `shop/redact` の削除対象に `InventoryChangeEvent`（明細は cascade）と `InventoryCountDocument`（chunk は cascade）が入っていない（`prisma/schema.prisma`） |
| D1 | 保護された顧客データ | **【T】** | 公開版で注文 webhook を使わないなら「使わない」を選べる。使うなら Level 1（注文。氏名・住所などは取らない）を**提出前に**申請 |
| Q1/Q4 | テンプレートの残り | **【未】** | `app/routes/app.additional.tsx`（「Additional page」）が残っている（メニューには無いが URL で開ける）。`_index` のダミー文（A1） |
| Q1 | 診断表示 | 【済】 | `ENABLE_PLAN_DEBUG=1` のときだけ。公開 Render で未設定なことを T が確認 |
| S1/S2 | POS の操作と POS Apps | 【要確認】 | 7 つのタイル（`extensions/stock-transfer-*`）。Ciara 以外の開発ストアで全部最後まで通す |
| S4 | POS のトークン | 【済】 | `extensions/common/*.js` が `getSessionToken()`、サーバーは `authenticate.pos`（`api.log-inventory-change.tsx` は自前の検証も持つ） |
| S5 | Shopify POS だけ | 【済】 | 外部 POS との連携なし |
| 公開版の URL | 自社用の値が混ざらない | 【済】（注意あり） | 公開 toml は `pos-stock.onrender.com` だけ。`extensions/common/appUrl.js` は `APP_MODE = "public"`（`main`）。自社用で deploy するときにここを書き換える運用なので、**公開版を deploy する直前に `public` であることを必ず確かめる**（PR #37 がこの確認を自動にする案） |
| 自社用の判定 | Ciara の店名の固定 | 【済】 | 店名はコードに無い。`APP_DISTRIBUTION` と `CUSTOM_APP_STORE_IDS`（環境変数）だけ。**公開 Render でこの 2 つが空なこと**を T が確認 |
| API 版 | 期限 | 【済】（注意） | `2026-01`。Shopify は各版を少なくとも 12 か月支える約束なので、2027-01 ごろまでに上げる |
| 言語 | 画面の言語 | 【T】 | 管理画面と POS のタイル名は日本語だけ。リスティングの対応言語は「日本語」だけにする（4.3.2）。英語の画面録画は字幕で対応 |

### 4.2 提出を止める問題（直す順）

| 順 | ID | 内容 | 直す場所 | 大きさ |
|----|----|------|----------|--------|
| 1 | G1 | 必須 webhook が実際には何も消していない（topic の形の違い）＋ `shop/redact` の削除漏れ 2 表 | `app/routes/webhooks.compliance.tsx` | 小 |
| 2 | G2 | アプリ URL を直接開くと店のドメイン入力欄とダミー文が出る（2.3.1） | `app/routes/_index/route.tsx`、`app/routes/auth.login/route.tsx` | 小 |
| 3 | G3 | 未契約でも POS の全機能と POS 用 API が使える。料金の約束と食い違う | POS 用 API にプランの確認を足す（共通の 1 か所で）＋ POS のタイルで案内 | 中 |
| 4 | G4 | `read_orders` と保護された顧客データの方針が決まっていない | T が決める → 外すなら公開 toml と `DEFAULT_SCOPES`（`app/shopify.server.ts`）と公開 Render の `SCOPES` | 小（決まれば） |
| 5 | G5 | 10 店舗超の従量課金が App Pricing では動かない（`appUsageRecordCreate`） | 料金案（6 章）を決めてから。最初は従量なしで出すのが早い | 小〜中 |
| 6 | G6 | テンプレートの「Additional page」 | `app/routes/app.additional.tsx` を消す | 小 |
| 7 | G7 | 画面録画・スクショ・アイコン・プライバシーポリシー・サポート窓口が無い | 5〜7 章 / T | T |

G1〜G3 と G6 はコードの修正。**この PR では直していない**（docs だけ）。直すときは別の `claude/` ブランチで 1 つずつ PR にする。

### 4.3 開いている PR との関係

- #37（deploy のときの APP_MODE と toml の食い違いを止める）: 公開版を deploy する前に入れておくと安全。
- #7（App Store 向けの販売前監査）: 内容が古い可能性がある。この文書を正とする。
- #49・#55・#61・#63・#64 など: 審査とは別の不具合修正。審査の前に入れるかは T が決める（審査中に版を変えると、確認し直しになることがある）。

---

## 5. リスティング文案（案）

文字数は空白込みで数えた目安。Partner の入力欄で最終確認する。

### 5.1 日本語

- **アプリ名**: POS Stock（9 文字）
  - 注意: 「POS」「Stock」はどちらも一般的な語。4.1.2（独自の呼び名で始める）で指摘されたら「B3 POS Stock」などにする。toml の `name` も合わせる（4.1.1）。**T が決める**
- **サブタイトル**: 店舗間の在庫移動と棚卸を、Shopify POS からその場で記録
- **紹介文（100 文字以内）**: POSで出庫・入庫・棚卸・ロスを記録。在庫がどこからどこへ動いたかを管理画面で確かめられます。（47 文字）
- **詳細（500 文字以内）**:

```
店舗や倉庫のあいだで商品を動かすとき、POS で出庫して、届いた店舗で入庫を確定できます。バーコードを読み取るか商品を検索して明細を作るので、紙の伝票や表計算への書き写しが要りません。

POS では、出庫・入庫・ロス・棚卸・仕入・発注・在庫調整をタイルから始められます。入庫では予定数と実際の数を比べ、足りない分や多い分をそのまま記録できます。

管理画面では、入出庫・ロス・棚卸などの履歴を、出庫元・入庫先・状態で絞り込み、CSV で書き出せます。在庫の変動履歴と、日ごとの在庫高も確認できます。

在庫の移動は Shopify の在庫移管（Transfer）と出荷（Shipment）をそのまま使うため、Shopify の在庫数と食い違いません。

はじめに: インストール後、一度 Shopify 管理画面でこのアプリを開いてから、POS の「アプリ」にタイルを追加してください。
```

- **機能リスト（各 80 文字以内）**:
  1. POS のタイルから出庫・入庫・ロス・棚卸・仕入・発注を記録
  2. バーコードの読み取りと商品検索で明細をすばやく作成
  3. 入庫で予定数と実数を比べ、過不足をそのまま記録
  4. 店舗間の移動は Shopify の在庫移管と出荷をそのまま使用
  5. 履歴を出庫元・入庫先・状態で絞り込み、CSV で書き出し
  6. 在庫の変動履歴と日ごとの在庫高を管理画面で確認
- **検索語（5 つまで）**: 在庫移動 / 棚卸 / 入庫 / POS 在庫 / 店舗間移動
- **販売チャネルの条件**: POS が必要（オンラインストアは不要）
- **対応言語**: 日本語

### 5.2 English

- **App name**: POS Stock
- **Subtitle**: Move stock between stores and count it, right from Shopify POS
- **Introduction (≤100)**: Record transfers, receiving, counts and losses on POS, and track every stock move in admin.（91 文字）
- **Details (≤500)**:

```
Send stock from one store or warehouse on POS and confirm it when it arrives at the other. Scan barcodes or search products to build each list, so there is no paper slip or spreadsheet to copy.

On POS, staff start transfers, receiving, losses, stock counts, purchases, orders and adjustments from tiles. When receiving, the app compares expected and actual quantities and records any gap.

In admin, filter transfer, loss and count history by origin, destination and status, and export it to CSV.
```

- **Features (≤80 each)**:
  1. Record transfers, receiving, losses, counts, purchases and orders from POS tiles
  2. Build item lists fast with barcode scanning and product search
  3. Compare expected and received quantities and record any gap
  4. Uses Shopify inventory transfers and shipments, so stock stays in sync
  5. Filter history by origin, destination and status, and export CSV
  6. View stock change history and daily inventory value in admin
- **Search terms**: stock transfer / stocktake / receiving / POS inventory / inventory count
- 注意: 画面が日本語だけのうちは、英語リスティングの対応言語も「Japanese」にする（4.3.2）。英語の自動翻訳リスティングの対象は英語が主言語のときだけ。

---

## 6. 料金案（**T が決めるための案**。まだ決まっていない）

いまのコードの前提（`app/utils/billing.ts`・`app/routes/app.tsx`）:
- プランの判定はサブスクリプション名で行う。名前に `Pro` → Pro、`Lite` → Lite。名前に `3` / `10` があればその店舗数を上限とみなす。
- Pro だけが使える管理画面: 在庫情報・仕入・ロス・発注・棚卸・調整。
- 開発ストアと自社用（inhouse）は全部無料で使える。

**案 A（すすめる。12/3 に間に合わせやすい）: 従量なしの 2 プラン（Shopify App Pricing）**

| プラン名（この名前で判定される） | 月額 | 無料体験 | 内容 |
|---|---|---|---|
| Lite (up to 10 locations) | US$19 | 14 日 | 出庫・入庫・入出庫履歴・CSV |
| Pro (up to 10 locations) | US$59 | 14 日 | すべて（ロス・棚卸・仕入・発注・調整・在庫情報） |

- 11 店舗以上の店は、提出後に私的プラン（private plan）か上位プランで扱う。今の従量課金コードは使わない（G5）。
- 数字は既存の `docs/APP_PRICING_SETUP_GUIDE.md` の案に合わせた。
- 必要な修正: G3（POS 側のプラン確認）。

**案 B: 設計どおり 基本料＋10 店舗超の従量**（Lite $40 / Pro $120 ＋ 1 店舗 $4 / $12）
- App Pricing では従量を App Events API で送る作りに変える必要があり、上限額（cap）も使えない。12/3 には間に合わない見込み。

**案 C: 無料で出す**
- 審査はいちばん軽い。あとで有料にすると課金の流れをもう一度審査される。1 章の「10 店」の条件は有料の Shopify プランの店のインストール数なので、アプリが無料でも数える（無料体験中の店は数えない）。

---

## 7. スクリーンショット撮影リスト

共通: 1600×900 px。開発ストアに**作った架空のデータ**（店名・商品名・スタッフ名）を入れて撮る。ブラウザの枠・本物の店名・メール・値段は写さない。代替テキストを 1 枚ずつ付ける。POS は iPad を横向きで撮り、1600×900 の無地の背景に置く（文字は足しすぎない）。

| 順 | 画面 | 開き方 | 見せること | 代替テキスト（案） |
|----|------|--------|-----------|-------------------|
| 1 | POS ホームのタイル | POS → ホーム（スマートグリッド） | 出庫・入庫・ロス・棚卸などのタイルが並ぶ | POS のホーム画面に並ぶ在庫処理のタイル |
| 2 | POS 出庫の明細 | 「出庫 / 在庫処理」タイル → 出庫元・入庫先を選ぶ → 商品を 3〜5 件読み取る | 出庫元・入庫先と、数量の入った明細 | POS で出庫の明細をバーコードで作る画面 |
| 3 | POS 入庫の照合 | 「入庫 / 在庫処理」→ 入庫予定から 1 件選ぶ → 一部だけ読み取る | 予定数と実数の差（不足・超過） | 入庫で予定数と実数を比べる画面 |
| 4 | POS 棚卸 | 「棚卸 / 在庫調整」→ 棚卸 ID を開く → 数件カウント | 商品グループとカウント中の数 | POS で棚卸の数を入れる画面 |
| 5 | 管理画面 入出庫履歴 | アプリ → 入出庫履歴（`/app/history`）→ 出庫元・状態で絞り込み | 絞り込みと一覧、CSV ボタン | 入出庫履歴を出庫元と状態で絞り込んだ一覧 |
| 6 | 管理画面 在庫情報 | アプリ → 在庫情報（`/app/inventory-info`） | 在庫の変動履歴か日ごとの在庫高 | 在庫の変動履歴と在庫高の画面 |

予備: 設定（`/app/settings`）、ロス履歴（`/app/loss`）。料金プラン画面（`/app/plan`）は**値段が写るので使わない**（4.2.2）。

### 画面録画（審査用・英語字幕）の流れ（3 分ほど）

1. 開発ストアでアプリをインストール → 許可 → アプリの画面が開く
2. 設定画面でロケーションを確認
3. POS → ホームにタイルを追加 → 出庫を 1 件確定
4. 入庫先の POS で入庫を確定（一部不足を記録）
5. 管理画面の入出庫履歴で今の 2 件を確認 → CSV を書き出す
6. 料金プラン画面 → Shopify のプラン選択ページへ移る（課金の流れの確認用）

---

## 8. T が決めること・やること

| # | 内容 | いつまで |
|---|------|----------|
| T1 | **どのアプリを最初に出すか**（1 章の上限のため 1 本ずつ）。b3inc にすでに公開アプリがあるか、その店数 | すぐ |
| T2 | Partner の本人確認・登録料・緊急連絡先・API 連絡先メール（「Shopify」を含まない） | 提出前 |
| T3 | **サポート用メールアドレス**（例: support@b3-inc.com のような専用アドレス）と、サポートページの URL | 提出前 |
| T4 | **プライバシーポリシーの置き場所**（会社サイトの専用ページ、または利用者ヘルプのサイト。PR #50 の `/help/stock-transfer-pos/` と同じサイトに置くのが自然）と、本文の確認 | 提出前 |
| T5 | 料金（6 章の案 A / B / C） | G3・G5 の前 |
| T6 | `read_orders` を外すか、保護された顧客データ Level 1 を申請するか（G4）。申請は**審査中はできない** | 提出前 |
| T7 | アプリ名を「POS Stock」のままにするか | リスティング作成前 |
| T8 | 公開 Render の環境変数の確認: `APP_DISTRIBUTION` と `CUSTOM_APP_STORE_IDS` が空、`ENABLE_PLAN_DEBUG` が無い、`SCOPES` が toml と同じ | 提出前 |
| T9 | Ciara 以外の開発ストア（同じ Partner 組織のもの）で、インストール → 管理画面 → POS 全タイル → アンインストール → 再インストール を通す。審査用のログイン（二段階認証なし）をこのストアで用意 | G1〜G3 が入ったあと |
| T10 | G1〜G3・G6 を直す PR を出してよいか（main へのマージ・公開版の deploy は毎回 T の承認） | すぐ |

---

## 9. 参照（Shopify 公式）

- App Store requirements: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
- Best practices（リスティングの数値・Lighthouse・POS）: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- Submit your app for review（提出手順・上限・待ち期間）: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
- 提出上限の告知（2026-11-10）: https://shopify.dev/changelog/posts/shopify-app-store-submission-requirements-build-grow-then-expand
- Privacy law compliance（必須 webhook）: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- Webhook の topic の形（例の `switch`）: https://shopify.dev/docs/api/shopify-app-remix/latest/guide-webhooks
- Protected customer data: https://shopify.dev/docs/apps/launch/protected-customer-data
- Shopify App Pricing: https://shopify.dev/docs/apps/launch/billing/managed-pricing
- POS Session API: https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/standard-apis/session-api
- Theme app extension の上限: https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
