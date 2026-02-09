# 公開アプリ（POS Stock）リリース要件まとめ

**作成日**: 2026年2月1日  
**前提**: カスタムアプリ側（管理画面・POS UI）は完成済み。公開アプリを App Store にリリースするまでの必要要件をまとめたものです。

---

## 📌 概要

| 項目 | 内容 |
|------|------|
| **設定ファイル** | `shopify.app.public.toml` |
| **アプリ名（例）** | POS Stock |
| **デプロイ先URL（例）** | `https://pos-stock.onrender.com` |
| **コードベース** | カスタムアプリと同一（`stock-transfer-pos`） |

---

## 🗓 推奨する進行順（この順番で進めるとスムーズです）

| 順番 | やること | 目安時間 | 備考 |
|------|---------|----------|------|
| **1** | パートナーで「公開アプリ」を新規作成し、Client ID を控える | 5分 | 既に作成済みならスキップ |
| **2** | 公開用のデプロイ先（Render 等の別サービス）を用意する | 10〜30分 | 自社用と別URLにすること |
| **3** | `shopify.app.public.toml` の `client_id`・`application_url`・`redirect_urls` を書き換える | 2分 | 2で決めたURLを入れる |
| **4** | 公開用環境の環境変数 `SHOPIFY_API_KEY`（Client ID）と `SHOPIFY_API_SECRET`（Client Secret）を設定する | 2分 | Render なら Dashboard → Environment |
| **5** | `shopify app config use public` → `shopify app deploy` でデプロイし、インストール〜動作確認 | 10分 | ここで「公開用として動く」ことを確認 |
| **6** | 本番前のコード整理（server の `console.log` 削除など） | 30分〜 | REQUIREMENTS_FINAL.md の任意項目 |
| **7** | リスティング用アセットを用意する（アイコン・スクショ・紹介文・プライバシーポリシー） | 1〜2時間 | アイコン1200×1200、スクショ1600×900 など |
| **8** | パートナーダッシュボードでリスティングを入力し、デモ動画・テスト用認証情報・緊急連絡先を登録 | 30分〜 | 審査提出の前提 |
| **9** | App Store 審査に提出する | 5分 | 提出後は Shopify の審査待ち（数日〜1週間程度のことが多い） |
| **10** | 審査結果を確認し、指摘があれば修正して再提出 | — | メールで連絡が来る |

**ポイント**
- **1〜5** が終わらないと「公開用として動くアプリ」が存在しないので、必ず先にやる。
- **7〜8** は並行して進められる（アイコンを作りながら紹介文を考える等）。
- **6** は 5 のあと、7 の前か並行でOK。審査提出前に終わっていればよい。

---

## 📋 ステップ1の詳細：公開アプリをパートナーで作成する

以下を**この順番で**行ってください。終わったら「Client ID」をメモ帳などに控えておきます。

### 1. パートナーダッシュボードを開く

1. ブラウザで次のURLを開く：
   ```
   https://partners.shopify.com/
   ```
2. ログインしていなければ、Shopify パートナー用のアカウントでログインする。

### 2. 新規アプリを作成する

1. 左メニュー（または「アプリ」タブ）から **「アプリ」** をクリックする。
2. **「アプリを作成」** または **「Create app」** をクリックする。
3. **「公開アプリを作成」** または **「Create public app」** を選ぶ。  
   （「カスタムアプリ」ではなく、**App Store に出す方＝公開アプリ** を選ぶ。）

### 3. アプリ名を入力する

1. 表示された画面で **アプリ名** を入力する（例：`POS Stock`）。  
   ※あとから変更できるので、仮の名前でもよい。
2. **「作成」** または **「Create」** をクリックする。

### 4. Client ID を控える

1. アプリが作成されると、**アプリの設定画面**（Overview や「設定」）が開く。
2. **「Client ID」** または **「API キー」** と書いてある欄を探す。
3. 表示されている**英数字の文字列**（例：`a1b2c3d4e5f6...`）を**そのままコピー**する。
4. メモ帳やこのドキュメントの下の「控え欄」に貼り付けて保存する。

---

### ✅ ステップ1 完了の目安

- パートナーに「公開アプリ」が1つある。
- そのアプリの **Client ID** をコピーして、どこかに保存してある。

**控え欄（ここに貼っておいてOK）**
```
Client ID（公開用）: 
```

ここまでできたら **ステップ2**（公開用のデプロイ先を用意する）に進みます。

---

## 📋 ステップ2の詳細：Render で公開用 Web サービスを作る

Render の「New +」→「Web Service」で**同じリポジトリ**を選び、以下のように設定します。

| 項目 | どうするか | 入力例・メモ |
|------|------------|--------------|
| **Project** | 任意。既存の「My project」のままでOK。公開用と分けたい場合はあとから「Add to project」で別プロジェクトにもできる。 | そのまま **My project** でよい |
| **Environment** | 公開用と分かる名前の**環境を新規作成**する。既存の「stock-transfer-pos-ciara」はカスタム用なので、**新規**で例: `stock-transfer-pos-public` や `pos-stock-public` を作成して選択。 | **新規作成** → 名前例: `pos-stock-public` |
| **Language** | このリポジトリは **Dockerfile** があるので **Docker** のまま。 | **Docker** |
| **Branch** | デプロイするブランチ。通常は **main** のままでよい。 | **main** |
| **Region** | カスタム用と同じリージョンにすると管理しやすい。既に Oregon に 4 サービスあるなら **Oregon** でよい。 | **Oregon (US West)** |
| **Root Directory** | このリポジトリはモノレポではないので**空のまま**。 | （未入力のまま） |
| **Instance Type** | テストなら **Free** で可。本番・安定運用なら **Starter ($7/月)** 推奨。カスタム用と同じプランでもよい。 | テスト: **Free** / 本番: **Starter** |
| **Environment Variables** | 下記の変数を**必ず**追加する（公開用の値だけを入れる）。 | 下表を参照 |

### 環境変数（公開用サービスで設定するもの）

| 変数名 | 値 | 備考 |
|--------|-----|------|
| `SHOPIFY_API_KEY` | 公開用の **Client ID**（例: `41d31838e05e4154fb75a6ccab558239`） | 必須 |
| `SHOPIFY_API_SECRET` | 公開用の **Client Secret**（例: `shpss_...`） | 必須。リポジトリに書かない |
| `SHOPIFY_APP_URL` | このサービスの URL（例: `https://pos-stock.onrender.com`）。サービス名を `pos-stock` にすると URL は `https://pos-stock.onrender.com`。 | サービス作成後、Dashboard の URL をコピーして設定。既存の pos-stock サービスを使う場合はその URL を設定。 |
| `SCOPES` | スコープをカンマ区切りで。未設定でも動く場合あり。設定する場合の例: `read_inventory,read_inventory_transfers,read_locations,read_products,write_inventory,write_inventory_shipments,write_inventory_shipments_received_items,write_inventory_transfers` | 任意（`shopify.app.public.toml` の scopes と揃えるとよい） |

**手順の流れ**
1. 上記のとおり **Environment** を新規作成（例: `pos-stock-public`）し、**Language = Docker**、**Branch = main**、**Root Directory = 空** のまま作成。
2. サービス名を **pos-stock** にすると、URL が `https://pos-stock.onrender.com` になる（公開用はこの1サービスで運用する想定）。
3. **Environment Variables** に `SHOPIFY_API_KEY`・`SHOPIFY_API_SECRET`・`SHOPIFY_APP_URL`（上記URL）を追加して保存。
4. デプロイが走り、完了したらステップ3で `shopify.app.public.toml` の `application_url` と `redirect_urls` にその URL を書く。

### サービス名・URL について（Render の仕様）

**重要**: Render では **`.onrender.com` の URL は作成時に決まり、あとから変更できません**。  
「Name」（サービス名）を変更しても、**URL は変わりません**（Render の仕様）。

**希望の URL にしたい場合の選択肢**

| 方法 | 内容 |
|------|------|
| **A. 今の URL のまま使う** | 画面上に表示されている URL（例: `https://○○○.onrender.com`）をそのまま使う。`shopify.app.public.toml` の `application_url` と `redirect_urls`、環境変数 `SHOPIFY_APP_URL` を**その URL** に合わせる。 |
| **B. 新しい URL で作り直す** | 今のサービスを**削除**し、**同じリポジトリで新規 Web サービス**を作成する。そのとき **Name** に `pos-stock` を入れると、URL が `https://pos-stock.onrender.com` になる。作成後、環境変数（`SHOPIFY_API_KEY`・`SHOPIFY_API_SECRET`・`SHOPIFY_APP_URL`）を再度設定する。 |
| **C. カスタムドメインを使う** | 自分で持っているドメイン（例: `app.example.com`）を Render の「Custom Domains」で設定する。そのドメインがアプリの URL になる。DNS 設定と Shopify 側の URL 登録が必要。 |

**まとめ**: 名前を変えただけでは URL は変わらないので、**今表示されている URL を使う（A）**か、**作り直して最初から希望の名前で作る（B）**かのどちらかになります。

---

## 1. 公開アプリ用の環境・設定（必須）

### 1.1 パートナー側で用意するもの

| 項目 | 内容 | 状態 |
|------|------|------|
| 公開アプリの作成 | パートナーダッシュボードで「新規アプリ」→ **公開アプリ** として作成 | ⬜ 要実施 |
| Client ID | 作成したアプリの Client ID を取得 | ⬜ `shopify.app.public.toml` の `client_id` に設定（現在は `YOUR_PUBLIC_APP_CLIENT_ID` のまま） |
| デプロイ先 | 自社用と**別URL**のホスティング（例: Render で別サービス） | ⬜ 例: `https://pos-stock.onrender.com` |
| 環境変数 | 公開用サービスで **`SHOPIFY_API_KEY`（Client ID）** と **`SHOPIFY_API_SECRET`（Client Secret）** を設定 | ⬜ 要実施 |

### 1.2 Client Secret について（必須）

サーバー側の OAuth や API 呼び出しに **Client Secret** も使います。`app/shopify.server.ts` で `SHOPIFY_API_SECRET` を参照しています。

| 環境変数 | 中身 | 備考 |
|----------|------|------|
| `SHOPIFY_API_KEY` | 公開用アプリの **Client ID** | 例: `41d31838e05e4154fb75a6ccab558239` |
| `SHOPIFY_API_SECRET` | 公開用アプリの **Client Secret** | パートナーで「API 認証情報」や「Client secret」から取得。**リポジトリにコミットしない** |

**Client Secret の確認場所（パートナー）**  
アプリの「設定」または「Configuration」→「API 認証情報」などに「Client secret」の表示・再生成ボタンがあります。公開用アプリ用の値をコピーし、Render の環境変数 `SHOPIFY_API_SECRET` にだけ設定してください。

### 1.3 `shopify.app.public.toml` の確認・修正

現在の内容で**必ず書き換える箇所**:

- **`client_id`**: パートナーで作成した公開アプリの Client ID（現在はプレースホルダー）
- **`application_url`**: 公開用の本番URL（例: `https://pos-stock.onrender.com`）
- **`[auth]` の `redirect_urls`**: 上記と同じURL

（Client ID / Client Secret は TOML には書かず、デプロイ先の環境変数 `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` で渡します。TOML の `client_id` は CLI やリンク用です。）

デプロイ前に以下で公開用に切り替えてデプロイ:

```bash
shopify app config use public
shopify app deploy
```

---

## 2. Shopify App Store の公式要件（リリース前に満たすもの）

公式ドキュメント: [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) / [Best practices](https://shopify.dev/docs/apps/launch/app-requirements-checklist)

### 2.1 ポリシー・セキュリティ

| 要件 | 内容 | 備考 |
|------|------|------|
| 認証 | **Session token** を使用。サードパーティCookie・ローカルストレージに依存しないこと。Chrome シークレットでも動作すること | 既存アプリが OAuth + 埋め込みで問題なければ準拠の可能性大 |
| チェックアウト | Shopify Checkout のみ使用（外部決済・マーケットプレイス禁止） | 本アプリは在庫・POS 用のため該当しない想定 |
| 事実のみ記載 | リスティング・アプリ内に虚偽の情報（偽レビュー・偽通知等）を出さない | 文言・スクショの確認 |
| 独自性 | 他に公開しているアプリと同一でないこと | カスタムアプリは「非公開」のため問題なし |

### 2.2 機能・品質

| 要件 | 内容 | 備考 |
|------|------|------|
| 重大エラーなし | 404 / 500 等でレビューが完了できない状態にしない | 本番URLで全画面の疎通確認 |
| UI | マーチャントが操作できるUIがあること | 管理画面＋POS UI で充足 |
| Shopify API | Admin API（推奨は GraphQL）を使用していること | 既存実装で使用済み |
| 埋め込み体験 | App Bridge で埋め込みアプリとして一貫した体験を提供 | 既存実装で使用済み |
| OAuth | インストール後・再インストール後とも、**最初に OAuth** が実行されること。UI 操作の前に認証完了 | 既存フローを確認 |

### 2.3 インストール・権限

| 要件 | 内容 | 備考 |
|------|------|------|
| インストール起点 | Shopify が提供する画面（App Store 等）からのみ。myshopify.com の手入力は求めない | 通常の公開アプリフローで満たす |
| 権限（スコープ） | **必要なスコープのみ** リクエスト。過剰なスコープは説明できるようにする | `shopify.app.public.toml` の `scopes` を確認 |
| ポップアップ | OAuth や課金承認など重要機能をポップアップに依存しない | 既存実装でポップアップ依存がなければOK |

### 2.4 課金（該当する場合）

| 要件 | 内容 | 備考 |
|------|------|------|
| 課金方法 | **Managed Pricing** または **Shopify Billing API** のみ。オフプラットフォーム課金は不可 | 無料アプリの場合は「Free to install」で対応 |
| プラン変更 | アップグレード・ダウングレードをマーチャントがアプリ内で行えること（再インストール不要） | 有料プランがある場合のみ要対応 |

### 2.5 パフォーマンス（ストアフロントに影響する場合）

| 要件 | 内容 | 備考 |
|------|------|------|
| Lighthouse | アプリ導入により **Lighthouse スコアが 10 点以上下がらない** こと | 主にオンラインストア用アプリ向け。POS/管理画面中心なら影響小の可能性 |

### 2.6 セキュリティ

| 要件 | 内容 | 備考 |
|------|------|------|
| TLS/SSL | 有効な証明書で HTTPS 通信 | 本番デプロイ先（Render 等）で HTTPS が有効であること |
| スコープ | 必要最小限のアクセススコープのみ | `read_inventory`, `write_inventory` 等、機能に必要な範囲か再確認 |

---

## 3. App Store リスティング（必須項目）

レビュー提出前に、パートナーダッシュボードの「配布」→「リスティングを管理」で以下を用意します。

### 3.1 ブランディング

| 項目 | 仕様 | 状態 |
|------|------|------|
| アプリ名 | 30文字以内。**ブランド名を先に**（例: 「〇〇 - POS在庫」）。TOML の `name` と一致させる | ⬜ |
| アプリアイコン | **1200 × 1200 px**、JPEG または PNG。角は四角でOK（ストア側で角丸になる）。文字・スクショ・Shopify ロゴは避ける | ⬜ |
| 一貫性 | ダッシュボードのアプリ名・アイコンとリスティングの名前・アイコンを同じにする | ⬜ |

### 3.2 リスティングコンテンツ

| 項目 | 仕様 | 状態 |
|------|------|------|
| フィーチャー画像 | 1600 × 900 px（16:9）。動画（2〜3分）または静的画像。alt テキスト必須 | ⬜ |
| デモストアURL | アプリがインストールされた開発ストアのURL。どの画面を見ればよいか説明を添える | ⬜ |
| スクリーンショット | 1600 × 900 px。**3〜6枚**（デスクトップ）。少なくとも1枚はアプリUI。ブラウザ枠・個人情報は除く。POS 対応なら POS 画面も含める | ⬜ |
| アプリ紹介文 | **100文字以内**。メリットを明確に。キーワード詰め・根拠のない数字・保証表現は避ける | ⬜ |
| アプリの詳細 | **500文字以内**。機能と独自性を説明。サポート・リンクは別欄で | ⬜ |
| 機能一覧 | 機能ごとに短く（目安 80 文字以内）。技術用語より「何ができるか」を記載 | ⬜ |
| 価格 | 「Free to install」「Recurring charge」「One-time payment」のいずれか。価格は**価格セクションのみ**に記載。画像に価格を入れない | ⬜ |
| プライバシーポリシー | **必須**。専用URLを用意する | ⬜ |
| カテゴリ・タグ | アプリの主な機能に合ったカテゴリ・タグを選択 | ⬜ |

### 3.3 レビュー提出用

| 項目 | 内容 | 状態 |
|------|------|------|
| デモ用スクリーンキャスト | オンボーディング〜主要機能の**手順が分かる動画**。英語または英語字幕。セットアップとコア機能の流れを示す | ⬜ |
| テスト用認証情報 | レビュー担当がログインして**全機能にアクセスできる**アカウント情報。提出前に有効か確認 | ⬜ |
| 緊急連絡先 | パートナーダッシュボードに**緊急開発者連絡先**を登録 | ⬜ |
| API連絡先 | ダッシュボードの API 連絡先・緊急連絡先を最新にしておく | ⬜ |

---

## 4. 本番リリース前のコード・運用チェック（推奨）

REQUIREMENTS_FINAL.md に記載の「任意」項目も、公開前に済ませておくと安全です。

| 項目 | 内容 | 状態 |
|------|------|------|
| `console.log` 整理 | server 側のデバッグ用 `console.log` を削除または本番では出さないようにする | ⬜ |
| 履歴タブのCSV案内 | 文言・配置の見直し（必要に応じて） | ⬜ |
| エラーページ | 404 / 500 時に適切なメッセージ・遷移になっているか確認 | ⬜ |
| 環境変数 | 公開用環境の `SHOPIFY_API_KEY`（Client ID）と `SHOPIFY_API_SECRET`（Client Secret）が設定されているか確認 | ⬜ |

---

## 5. 本番で必須の2つの対策（履歴が消える・管理画面を開かないとエラー）

デプロイ先（例: Render）で次の2つが起きる場合の原因と対処です。

### 5.1 デプロイすると履歴一覧が消えてしまう

**原因**

- セッションと在庫変動履歴（`InventoryChangeLog`）はどちらも **Prisma + SQLite**（`prisma/schema.prisma` の `file:dev.sqlite`）に保存されています。
- Render ではデプロイのたびにコンテナが作り直され、**ディスク上のファイルは消えます**（エフェメラル）。そのため `dev.sqlite` も毎回空の状態からになり、履歴とセッションが失われます。

**対処（リリース時に必須）**

本番では **永続的なデータベース** を使う必要があります。

| 方法 | 内容 |
|------|------|
| **A. Render PostgreSQL** | Render の「Add-ons」で PostgreSQL を追加し、発行される `DATABASE_URL` を環境変数に設定する。 |
| **B. Supabase（PostgreSQL）** | プロジェクト方針（.cursorrules）の「本番環境予定」の通り、Supabase で PostgreSQL を作成し、接続URLを `DATABASE_URL` で渡す。 |

**手順の流れ（共通イメージ）**

1. 上記のいずれかで PostgreSQL を用意し、**接続URL**（例: `postgresql://user:pass@host:5432/dbname`）を取得する。
2. 本番用環境変数に **`DATABASE_URL`** を設定する（Render の Environment など）。
3. Prisma を本番で PostgreSQL 向けに使うようにする（下記「5.3 本番DBの Prisma 設定」を参照）。
4. デプロイ時（または初回デプロイ後1回）に **マイグレーション** を実行する（例: Build Command に `npx prisma migrate deploy` を入れる、または Render の「Deploy」の前に手動実行）。

これにより、**デプロイ後も履歴とセッションが残り**、デプロイ当日の履歴一覧が消えません。

### 5.2 管理画面を開かないとエラーになる（情報が取得できない）

**原因**

- POS や Webhook から API を呼ぶとき、**オフラインアクセストークン**（バックグラウンドで Admin API を叩くためのトークン）を使います。
- このオフライントークンは、**ストアオーナーが「管理画面でアプリを開いたとき」に OAuth が完了し、そのタイミングで初めて Session テーブルに保存されます**。
- 一度も管理画面でアプリを開いていないと、`findSessionsByShop` でセッションが見つからず、`api.log-inventory-change` などが「No session found for shop」で 401 になります。

**対処（リリース時の運用と案内）**

| 対策 | 内容 |
|------|------|
| **運用で必須** | **インストール後（または初回利用前）に、必ず1回は「Shopify 管理画面でアプリを開く」** ことを、利用手順・オンボーディング・README に明記する。多くの Shopify アプリが同じ前提です。 |
| **体験の改善** | POS 側で「セッションがない」と分かったときに、「Shopify 管理画面でアプリを一度開いてから、再度お試しください」と表示すると親切です（任意）。 |
| **技術的な前提** | App Store からインストールした場合も、**「アプリを開く」リンクを最初に1回クリックすると OAuth が実行され、オフライントークンが保存されます**。つまり「管理画面を開く＝アプリを開く」を1回やってもらう必要があります。 |

リリース時は、**「初回セットアップで1回は管理画面でアプリを開く」** ことをドキュメントや画面で案内すれば、管理画面を開かなくても不備なく情報を取得できる状態を、開いた後から維持できます。

### 5.3 本番DBの Prisma 設定（永続化する場合）

履歴を消さないために本番で PostgreSQL を使う場合の設定例です。

1. **環境変数**  
   本番のみ `DATABASE_URL` を設定する（例: Render の Environment）。  
   開発環境では従来どおり SQLite を使う場合は、開発用の `.env` には `DATABASE_URL` を書かず、`file:dev.sqlite` のままにします。

2. **Prisma の切り替え方**  
   - **開発**: これまで通り `provider = "sqlite"` と `url = "file:dev.sqlite"` のままでもよい。  
   - **本番**: 同じリポジトリで本番だけ PostgreSQL にするには、**本番ビルド時だけ** `provider = "postgresql"` と `url = env("DATABASE_URL")` にする必要があります。  
   - Prisma は 1 つの `schema.prisma` で provider を 1 つしか指定できないため、**本番も開発も PostgreSQL にする**か、**本番のみ PostgreSQL 用の schema を別ファイルで用意してビルド時に差し替える**かのどちらかになります。  
   - シンプルなのは **「本番・開発ともに PostgreSQL」** にすることです。開発では Docker の PostgreSQL や Supabase の無料DBを `DATABASE_URL` で指すようにします。

3. **マイグレーション**  
   - PostgreSQL 用のマイグレーションを別途作成し、本番では `npx prisma migrate deploy` をデプロイ手順（または Build Command）に含めます。  
   - 既存の SQLite 用マイグレーションとは別に、PostgreSQL 用の初期マイグレーションを用意する必要があります。

**本番で PostgreSQL を使う場合の設定例（参考）**

- 開発は従来どおり SQLite、本番だけ PostgreSQL にする場合は、`schema.prisma` の `datasource` を環境変数で切り替えられません（provider が sqlite か postgresql か 1 つに決まるため）。そのため、**本番・開発ともに PostgreSQL** にするか、本番用に別 schema を用意する必要があります。
- **本番・開発ともに PostgreSQL** にする場合の例：
  - `prisma/schema.prisma` の `datasource` を `provider = "postgresql"` と `url = env("DATABASE_URL")` に変更する。
  - 開発用 `.env` には、ローカルや Supabase の PostgreSQL の `DATABASE_URL` を設定する。
  - 新規に `npx prisma migrate dev --name init_postgres` で PostgreSQL 用マイグレーションを作成する（既存 SQLite とは別）。
- Render の **Build Command** に `npx prisma generate && npx prisma migrate deploy` を追加し、本番では `DATABASE_URL` を設定したうえでデプロイする。

---

## 6. リリースまでの作業フロー（チェックリスト）

### Phase A: 準備（パートナー・インフラ）

1. ⬜ パートナーで「公開アプリ」を新規作成（未作成の場合）
2. ⬜ 公開用の Client ID を取得
3. ⬜ 公開用デプロイ先（例: Render の別サービス）を用意
4. ⬜ `shopify.app.public.toml` の `client_id` / `application_url` / `redirect_urls` を反映
5. ⬜ 公開用環境に `SHOPIFY_API_KEY`（Client ID）と `SHOPIFY_API_SECRET`（Client Secret）を設定
6. ⬜ `shopify app config use public` → `shopify app deploy` でデプロイし、インストール〜基本動作を確認

### Phase B: リスティング・アセット

7. ⬜ アプリアイコン 1200×1200 を用意し、ダッシュボード・リスティングに設定
8. ⬜ フィーチャー画像 or 動画（1600×900）、スクリーンショット 3〜6 枚を用意
9. ⬜ アプリ紹介文（100文字）、アプリの詳細（500文字）、機能一覧を記載
10. ⬜ 価格（無料の場合は Free to install）を設定
11. ⬜ プライバシーポリシーURLを用意し、リスティングに設定
12. ⬜ デモ用開発ストアURLと、簡単な「どこを見るか」の説明を用意

### Phase C: レビュー提出

13. ⬜ デモ用スクリーンキャスト（英語 or 英語字幕）を用意
14. ⬜ テスト用認証情報（全機能アクセス可能）を準備し、提出フォームに記載
15. ⬜ 緊急開発者連絡先をパートナーダッシュボードに登録
16. ⬜ 上記をすべて満たしたうえで、App Store 審査に提出

### Phase D: 提出後

17. ⬜ 審査結果のメール（app-submissions@shopify.com 等）を確認
18. ⬜ 指摘があれば修正し、再提出

---

## 7. 参考リンク

| 内容 | URL |
|------|-----|
| App Store 要件 | https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements |
| ベストプラクティス・チェックリスト | https://shopify.dev/docs/apps/launch/app-requirements-checklist |
| 審査提出 | https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review |
| 自社・公開の2本立て運用 | 本リポジトリ `docs/DUAL_APP_SETUP.md` |

---

## 8. 現在の `shopify.app.public.toml` の状態（要修正箇所）

- **`client_id`**: `YOUR_PUBLIC_APP_CLIENT_ID` → **公開用アプリの実際の Client ID に差し替える**
- **`application_url`**: `https://pos-stock.onrender.com` → 実際の公開用本番URLと一致させる
- **`[auth] redirect_urls`**: 上記と同じURLであることを確認

上記を反映したうえで、`shopify app config use public` と `shopify app deploy` を実行し、公開用としてデプロイ・動作確認を行ってから、リスティング作成と審査提出に進むとスムーズです。

---

## 9. 機能拡張メモ：出庫の複数シップメント対応（設計案・アドバイス）

### 9.1 イメージの整理（賛成です）

- **対象**: 履歴一覧の「未出庫」タブのうち、**ステータスが「配送準備完了」（READY_TO_SHIP）の Transfer だけ**を対象にする。
- **UI**: 入庫の複数シップメント時と同様、**右側に「編集」ボタン**を出し、タップでモーダルを表示。
- **モーダルでの選択肢**:
  1. **このシップメントを確定** … 既存のシップメントを「出庫した」扱いにし、Transfer を「処理中」に進める。
  2. **シップメントを追加** … 同じ Transfer に新しいシップメント（商品リスト）を追加。追加後は新規出庫と同様の商品リスト画面で明細を入力し、そのシップメントを確定（必要なら「このシップメントを確定」と同様の操作で出庫済みにできる）。

この流れで、**配送準備完了のものだけ**追加シップメント可能にし、入庫の複数シップメントと対になる動きにできるので、そのイメージで問題ないと思います。

### 9.2 利用する API（Shopify 公式）

- **このシップメントを確定**  
  - `inventoryShipmentMarkInTransit(id: シップメントID)`  
  - 既存のシップメントを「出庫済み（IN_TRANSIT）」にし、Transfer 全体が **IN_PROGRESS / IN_TRANSIT** に進みます。
- **シップメントを追加**  
  - `inventoryShipmentCreate(input: { movementId: TransferのID, lineItems: [...] })`  
  - 同じ Transfer に **DRAFT の新シップメント**を追加します。  
  - 入力は `InventoryShipmentCreateInput`（`movementId`・`lineItems` 必須。`trackingInput` 等は任意）。

追加したシップメントを「出庫した」扱いにする場合は、そのシップメントに対して同じく `inventoryShipmentMarkInTransit` を呼べば、Transfer は引き続き処理中として扱われます。

### 9.3 未確定・新規作成が「処理中」に進むタイミング（アドバイス）

- **Transfer が「処理中」（IN_PROGRESS / IN_TRANSIT）になる条件**  
  - **「いずれか 1 つ以上のシップメントが“出庫済み”（Mark In Transit）になったとき」**と整理するのが分かりやすいです。
- **未確定（OutboundList の下書き）**  
  - まだ Transfer は存在しません。  
  - 「確定」モーダルで  
    - **「配送準備完了にする」** → Transfer を **READY_TO_SHIP** で 1 つ作成（＝未出庫のまま）。  
    - **「出庫を作成（進行中）」**（配送番号ありで確定） → Transfer 作成 ＋ そのシップメントを **In Transit** で作成するため、**この時点で処理中に進行**します。
- **新規作成（条件 → 商品リスト → 確定）**  
  - 上と同じです。  
  - 「配送準備完了にする」→ READY_TO_SHIP のまま（未出庫）。  
  - 「出庫を作成（進行中）」→ 処理中に進行。
- **履歴の「配送準備完了」の行**  
  - 「編集」→「このシップメントを確定」で `inventoryShipmentMarkInTransit` を実行した時点で、その Transfer が処理中に進みます。  
  - 「シップメントを追加」で増やしたシップメントも、同様に Mark In Transit した時点で「出庫済み」になり、Transfer は処理中として扱われます。

まとめると、

| 操作 | Transfer の状態 |
|------|------------------|
| 新規で「配送準備完了にする」 | READY_TO_SHIP（未出庫） |
| 新規で「出庫を作成（進行中）」 | 作成直後から処理中（IN_PROGRESS 等） |
| 履歴の READY_TO_SHIP で「このシップメントを確定」 | その時点で処理中に進行 |
| 履歴の READY_TO_SHIP で「シップメントを追加」 | 追加後も READY_TO_SHIP。追加シップメントを Mark In Transit すると処理中 |

「未確定」と「新規作成」のどちらも、**「配送準備完了」を選ぶ限りは READY_TO_SHIP のまま**で、**「出庫を作成（進行中）」または履歴から「このシップメントを確定」を実行したタイミングで処理中に進める**、とルールを揃えておくと実装も運用も分かりやすいです。

---

### 9.4 シップメントリストの必要性とモーダル内容

**シップメントリストは必要です。**

- 1 Transfer に複数シップメントが紐づく場合、「どのシップメントを確定するか」「どのシップメントを編集するか」を選べる一覧があると分かりやすいです。
- 想定する表示タイミング:
  - **履歴の「編集」を押したあと** … READY_TO_SHIP の Transfer を開いたとき、シップメントが **2 つ以上**なら「シップメント一覧」を表示する。
  - 一覧の各行: シップメント名・明細サマリー・「このシップメントを確定」など。末尾に「シップメントを追加」を配置。

**確定ボタン押下後のモーダル内容（方針）**

- **新規作成の「確定」**（OutboundList の確定ボタン）  
  - 現状どおり「出庫を確定しますか？」モーダル（配送準備完了にする / 出庫を作成（進行中））のままでよい。  
  - ここで作られる Transfer は通常シップメント 1 つなので、モーダルを分岐させる必要はありません。
- **履歴の READY_TO_SHIP の「編集」を押したあと**  
  - **シップメントが 1 つのとき**  
    - モーダルは 2 択でよい:「このシップメントを確定」「シップメントを追加」。
  - **シップメントが 2 つ以上のとき**  
    - **モーダル内容を変更**し、**シップメント一覧**を表示する。  
    - 各シップメントに「このシップメントを確定」、一覧の下に「シップメントを追加」。  
  - いったん「このシップメントを確定」を実行したあとも、同じ Transfer に未確定のシップメントが残っていれば、**詳細画面に戻してシップメント一覧を再表示**する形にすると、続けて他のシップメントを確定したり追加したりしやすいです。

まとめ: 「確定ボタン」は新規作成用と履歴用で文脈が違うので、**履歴の「編集」先では、複数シップメント保有時だけモーダル内容を「シップメント一覧＋各確定・追加」に変える**形でよいです。

---

### 9.5 Modal.jsx の容量を増やさない実装方針（慎重に進める）

`Modal.jsx` はすでに 14,000 行超あるため、**この機能のコンポーネントは Modal.jsx に足さず、別ファイルに切り出す**ことを推奨します。

| 方針 | 内容 |
|------|------|
| **新規コンポーネントは別ファイル** | 出庫の「READY_TO_SHIP 編集」用の UI（シップメント一覧・選択モーダル・シップメント追加用の商品リスト）は、`Modal.jsx` とは別のファイル（例: `OutboundShipmentList.jsx` / `OutboundReadyToShipModal.jsx` など）に実装する。 |
| **Modal.jsx の変更は最小限に** | 履歴一覧に「編集」ボタンを足す、`Extension` のルーティングで新しい画面を 1 つ足す、など**接続だけ**を Modal.jsx に書く。中身の JSX とロジックは上記ファイル側に集約する。 |
| **既存パターンに合わせる** | `screens/` に `Screens.jsx` を分割しているように、**出庫複数シップメント用も 1 ファイル、または「一覧用」「モーダル用」で 2 ファイルに分離**し、`Modal.jsx` からは `import` して 1 行で使う形にする。 |
| **段階的に実装** | まず「編集」押下で開くモーダル（シップメント 1 つのときの 2 択）だけ別ファイルで実装し、動作を確認してから「シップメント一覧」を追加する、など小さく進めると安全です。 |

こうしておくと、**シップメントリストとモーダル内容変更を追加しても、Modal.jsx の行数はほとんど増やさずに済みます**。
