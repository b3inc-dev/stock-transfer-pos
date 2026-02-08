# Render PostgreSQL 実装タスク（将来の Supabase Pro 移行を想定）

**作成日**: 2026年2月8日  
**前提**: Render PostgreSQL（Basic-256mb $6/月）で本番を運用し、将来 Supabase Pro（$25/月）へ移行することを想定した実装とする。

---

## タスク チェックリスト（概要）

| Phase | タスク | 内容 |
|-------|--------|------|
| **A** | A1 | schema.prisma を `provider = "postgresql"` に変更 |
| **A** | A2 | SQLite 用 migrations を退避し、PostgreSQL 用 `init_postgres` を新規作成 |
| **A** | A3 | .env.example に DATABASE_URL 例を追加、開発環境方針を記載 |
| **B** | B1 | Render で PostgreSQL（Basic-256mb）を**新規作成**（「Add-ons」ではなく「+ New → Postgres」） |
| **B** | B2 | 環境変数に DATABASE_URL を設定 |
| **B** | B3 | Build Command に `prisma generate && prisma migrate deploy` を追加 |
| **B** | B4 | デプロイして履歴・ログインが残ることを確認 |
| **C** | C1 | 将来 Supabase に切り替える手順をドキュメント化 |
| **C** | C2 | README 等に本番 PostgreSQL 前提を追記 |

---

## Render PostgreSQL Basic-256mb で耐えられるアカウント数・期間の目安

**前提**: 保存するのは **Session** と **InventoryChangeLog** のみ。1 ショップ = 1 アプリインストール（アカウント）として考える。

### 制限（Render 公式）

| 項目 | Basic-256mb の目安 |
|------|---------------------|
| **接続数** | **最大 100 接続**（8GB 未満 RAM のインスタンスは 100）。複数リクエストが同時に来ても、アプリが接続をプールして使えば実質あまる。 |
| **ストレージ** | 初期 **1 GB** から（有料プラン）。追加は $0.30/GB/月。必要なら 5 GB 単位で増量可能。 |
| **メモリ** | 256 MB RAM。小規模なクエリ（Session 参照・在庫変動の挿入・期間検索）なら十分。 |

### データ量のざっくり目安

- **Session**: 1 ショップあたりオフライン＋オンラインで数行。1 行 1〜3 KB 程度 → **100 ショップでも 1 MB 未満**。
- **InventoryChangeLog**: 1 行あたり **約 0.5 KB**（インデックス含めても 1 KB 以下）。増えるのはほぼこのテーブルだけ。

| ショップ数（目安） | 在庫変動 1 ショップあたり | 1 年あたりのログ行数（概算） | 1 年で必要な容量（概算） | 1 GB で持つ期間の目安 |
|--------------------|---------------------------|------------------------------|----------------------------|-------------------------|
| 50 ショップ        | 300 件/月                 | 約 18 万行                   | 約 90〜180 MB              | **5 年以上**           |
| 100 ショップ       | 500 件/月                 | 約 60 万行                   | 約 300〜600 MB             | **1.5〜2 年**           |
| 200 ショップ       | 500 件/月                 | 約 120 万行                  | 約 600 MB〜1.2 GB          | **約 1 年**（1 GB でギリ） |
| 500 ショップ       | 500 件/月                 | 約 300 万行                  | 約 1.5〜3 GB               | **数ヶ月で 1 GB 超過** → ストレージ増量 or 古いログ削除 |

※ 在庫変動の「1 ショップあたり 300〜500 件/月」は、入出庫・ロス・棚卸・売上などがそこそこある想定の目安です。実際はショップごとに差があります。

### 結論（目安）

- **50〜100 ショップ程度**で、変動が月 300〜500 件/ショップなら、**1 GB のまま 1.5〜2 年は十分もつ**想定。
- **200 ショップ超**や、**1 ショップあたりの変動がとても多い**場合は、**1 年以内に 1 GB を超える**可能性が高い。そのときは  
  - ストレージを 5 GB 等に増やす（$0.30/GB/月）、  
  - または「○ヶ月より古い在庫変動履歴は削除する」運用にすると、Basic-256mb のまま長く使える。
- **接続数 100** は、同一瞬間のリクエスト数が極端に多くなければ、**数百ショップ規模でも問題になりにくい**。心配なら Render の PgBouncer（接続プール）を利用する。

**注意**: 上記はあくまで目安です。実運用では Render ダッシュボードでストレージ使用量を定期的に確認し、必要になったらストレージ増量や古いログの整理を検討してください。

---

## 1. ゴール（完了の定義）

次の状態が満たされたら「完了」とします。

| # | ゴール | 確認方法 |
|---|--------|----------|
| G1 | 本番（Render）で **Render PostgreSQL** に Session と InventoryChangeLog が保存され、デプロイ後もデータが消えない | デプロイ後に在庫変動履歴一覧が残っていること・再ログインできること |
| G2 | アプリコードは **PostgreSQL の接続先に依存しない**（接続は `DATABASE_URL` のみ）。Render 固有・Supabase 固有の API は使わない | コードレビュー・接続まわりで `DATABASE_URL` 以外の環境変数に依存していないこと |
| G3 | 将来 **Supabase Pro に切り替えるときは、DATABASE_URL の差し替えとマイグレーション実行だけで済む** | 手順書どおりに Supabase 用 URL に切り替えて動作することを確認できること |
| G4 | 開発環境でも PostgreSQL で動作確認できる（オプション: ローカルは SQLite のままでも可。その場合は本番用 schema の扱いを手順化） | 開発時に `DATABASE_URL` を設定して `prisma migrate dev` 等が通ること |

---

## 2. 方針（将来 Supabase を見据えた実装）

- **接続**: 常に **環境変数 `DATABASE_URL`** のみで接続する。接続文字列の形式は PostgreSQL 標準（`postgresql://...`）のため、Render でも Supabase でも同じ。
- **Prisma**: `provider = "postgresql"` と `url = env("DATABASE_URL")` に統一。Supabase 専用の Prisma プラグインや Render 専用のコードは入れない。
- **マイグレーション**: PostgreSQL 用マイグレーションを 1 セット用意し、Render でも Supabase でも **同じマイグレーション** を `prisma migrate deploy` で適用する。
- **データ移行**: 将来 Render → Supabase に切り替えるときは、必要なら pg_dump / pg_restore や Prisma 経由のスクリプトでデータを移行する。アプリのロジック変更は不要とする。

---

## 3. タスク一覧（実施順）

### Phase A: Prisma を PostgreSQL 対応にする

| ID | タスク | 詳細 | 成果物・確認 |
|----|--------|------|--------------|
| A1 | **schema.prisma を PostgreSQL に変更** | `datasource` を `provider = "postgresql"` と `url = env("DATABASE_URL")` に変更する。Session / InventoryChangeLog のモデル定義はそのまま（Prisma が SQLite と PostgreSQL で型を吸収）。 | `prisma/schema.prisma` の変更 |
| A2 | **PostgreSQL 用マイグレーションを新規作成** | Prisma は 1 つの schema で 1 種類の provider しか使えないため、**schema を postgresql にしたら、マイグレーション履歴も PostgreSQL 用だけ**にする。手順: (1) A1 で schema を `provider = "postgresql"` に変更済みとする。(2) 既存の `prisma/migrations` は SQLite 用のため、**退避**（例: `prisma/migrations_sqlite_backup` にリネーム）する。(3) PostgreSQL が使える環境（Render の Postgres を先に作成して URL を取る、またはローカル Docker / Supabase 無料など）で `DATABASE_URL` を設定し、`npx prisma migrate dev --name init_postgres` を実行する。これで Session と InventoryChangeLog を一度に作る **PostgreSQL 用の初期マイグレーション**が生成される。(4) 生成された `prisma/migrations/YYYYMMDDHHMMSS_init_postgres/migration.sql` をリポジトリにコミットする。 | `prisma/migrations/` に PostgreSQL 用の初期マイグレーション 1 本ができる。既存 SQLite 用は退避済み。 |
| A3 | **開発環境の .env 方針を決める** | 開発も **同じ PostgreSQL** を使う場合: `.env.example` に `DATABASE_URL=` の例（`postgresql://...`）を記載し、開発用にローカル Postgres または Supabase Free / Render Postgres の URL を設定する。開発時に `npx prisma migrate dev` や `npm run dev` が通るようにする。 | `.env.example` の更新、必要なら README や本ドキュメントの「開発環境」に追記 |

**注意**: 一度 schema を PostgreSQL に統一すると、**開発環境でも `DATABASE_URL` で PostgreSQL を指す必要**があります。開発用に「ローカルで Docker の PostgreSQL を立てる」「Supabase Free のプロジェクトを 1 つ作る（1 週間でポーズする点に注意）」「Render の Postgres Free（30 日限定）を使う」のいずれかが現実的です。SQLite と PostgreSQL を切り替えて使う場合は、schema を 2 ファイル用意してビルド時に差し替える構成になるため、まずは「本番・開発とも PostgreSQL」で揃えることを推奨します。

### Phase B: Render で PostgreSQL を用意し、本番で使う

| ID | タスク | 詳細 | 成果物・確認 |
|----|--------|------|--------------|
| B1 | **Render で PostgreSQL を新規作成** | Render ダッシュボードで **「+ New」→「Postgres」** をクリック（**Add-ons ではない**。Postgres は別リソースとして作成する）。名前・リージョン（Web サービスと同じにすると Internal URL で接続可）、**Instance type: Basic-256mb（$6/月）**、Storage 1 GB などを設定して **Create Database**。詳細は下記「B1 の詳細」参照。 | Dashboard に Postgres が 1 件できる。Status が Available になったら使える。 |
| B2 | **DATABASE_URL を環境変数に設定** | 作成した Postgres の **Connect** メニュー（または Info タブ）から **Internal URL** をコピーし、**Web サービス**の **Environment** に **`DATABASE_URL`** として**手動で追加**する。 | 本番環境で `DATABASE_URL` が参照できること |
| B3 | **Build Command にマイグレーションを追加** | Render の **Build Command** に、`npx prisma generate && npx prisma migrate deploy` を含める。既存のビルドコマンドがある場合は、その前にこれらを実行する形にする。 | デプロイ時にマイグレーションが実行され、本番 DB にテーブルができる |
| B4 | **デプロイと動作確認** | デプロイ後、管理画面にログインし、POS や在庫変動を行う。再度デプロイし、**在庫変動履歴が残っていること**と**ログインができること**を確認する。 | G1 の達成確認 |

**B1 の詳細（Render で Postgres を作る手順）**

Render では **「Add-ons」ではなく、PostgreSQL を別のデータベースとして作成**します。

1. **ダッシュボードを開く**: [dashboard.render.com](https://dashboard.render.com) にログインする。
2. **「+ New」をクリック**: 画面上部またはダッシュボードの **「+ New」** ボタンをクリックする。
3. **「Postgres」を選ぶ**: メニューから **「Postgres」** を選択する。（Web Service ではなく、データベース用の Postgres）
4. **作成フォームを入力**（入力例）:
   | 項目 | 入力例・推奨 |
   |------|----------------|
   | **Name** | 例: `stock-transfer-db`（画面上部。あとから変更可） |
   | **Database (Optional)** | 空欄でOK（自動生成）。指定するなら例: `pos_stock` |
   | **User (Optional)** | 空欄でOK（自動生成） |
   | **Region** | **pos-stock（Web サービス）が動いているリージョンと同じ**を選ぶ。Oregon に5つ・Singapore に1つある場合は、pos-stock がどちらかで合わせる。同じにすると Internal URL で接続でき、レイテンシが小さい。 |
   | **PostgreSQL Version** | **18** のままでよい |
   | **Datadog API Key / Region** | 使わなければ空欄でOK |
   | **Instance type** | **Basic** の **Basic-256mb**（$6/月）を選択 |
   | **Storage** | 初期は **1 GB** で十分（あとから増やせる）。料金は約 $0.30/月。15 GB にすると約 $4.50/月になるので、コストを抑えるなら 1 GB。 |
   | **Storage Autoscaling** | Disabled でOK（必要ならあとで有効化） |
   | **High Availability** | Disabled（Pro 以上で利用可能） |
5. **「Create Database」をクリック**する。
6. 作成後、Status が **Available** になるまで待つ。数分かかることがある。
7. **接続 URL をコピー**: Postgres の画面で **「Connect」** メニュー（右上）または **「Info」** タブを開き、**Internal URL**（`postgresql://...`）をコピーする。Web サービスと別リージョンの場合は **External URL** を使う。

公式ドキュメント: [Create and Connect to Render Postgres](https://render.com/docs/postgresql-creating-connecting)

**既存の pos-stock をマイプロジェクトに移す方法（Project Optional で選択したい場合）**

Postgres 作成時に「プロジェクト」で pos-stock と同じプロジェクトを選びたい場合は、先に pos-stock をプロジェクトに入れておきます。

1. **プロジェクトを作る（まだない場合）**
   - ダッシュボードで **「New」→「Project」** をクリック。
   - プロジェクト名（例: `pos-stock-app`）と、最初の環境名（例: `Production`）を入力して **「Create a project」** をクリック。

2. **pos-stock をそのプロジェクトに移す**
   - **方法A（1つだけ移す）**: ダッシュボードのサービス一覧で **pos-stock** の行の **「•••」（3点メニュー）** をクリック → **「Move」** を選択 → 移したい **プロジェクト** と **環境**（例: Production）を選んで確定。
   - **方法B（空のプロジェクトから誘導）**: 上で作ったプロジェクトのページを開く → 環境（例: Production）が空なら **「Move existing services」** のようなボタンが出るので、そこから pos-stock を選んで移動。

3. **確認**
   - 左サイドやダッシュボード上部の **「マイプロジェクト」** 一覧にそのプロジェクトが表示され、クリックすると pos-stock が見えればOK。あとで Postgres を作るときに **Project (Optional)** でこのプロジェクトを選べる。

公式: [Projects and Environments](https://render.com/docs/projects)（Add services to an environment / Move）

### Phase C: ドキュメントと将来移行の準備

| ID | タスク | 詳細 | 成果物・確認 |
|----|--------|------|--------------|
| C1 | **「将来 Supabase に切り替える手順」を書く** | 次の内容を短い手順書にまとめる: (1) Supabase で新規 PostgreSQL プロジェクトを作成し、接続 URL を取得する。(2) （必要なら）Render の DB からデータをエクスポートし、Supabase にインポートする。(3) Render の環境変数 `DATABASE_URL` を Supabase の接続 URL に更新する。(4) 再デプロイする（または `prisma migrate deploy` を Supabase に対して実行する）。アプリコードの変更は不要である旨を明記する。 | 例: `docs/MIGRATION_RENDER_TO_SUPABASE.md` または本ドキュメント内の「4. 将来 Supabase Pro に移行するとき」に記載 |
| C2 | **README または REQUIREMENTS に DB 前提を追記** | 本番では PostgreSQL（Render または Supabase）を前提とする旨と、`DATABASE_URL` の設定が必須である旨を README や REQUIREMENTS_FINAL.md に 1 行ずつでもよいので追記する。 | 新規開発者が読んで分かる状態 |

---

## 4. 将来 Supabase Pro に移行するとき（手順イメージ）

以下の手順は、**今回の実装が完了した後**に、Supabase に切り替えるときのイメージです。実装タスクには含めず、参照用として記載します。

1. **Supabase でプロジェクト作成**  
   Supabase ダッシュボードで新規プロジェクトを作成し、**Database → Connection string** から接続 URL（`postgresql://postgres.[ref]:[password]@...`）をコピーする。

2. **マイグレーションの適用**  
   ローカルなどで `DATABASE_URL` を Supabase の URL に設定し、`npx prisma migrate deploy` を実行する。これで Supabase 側に Session / InventoryChangeLog のテーブルが作成される。

3. **（オプション）既存データの移行**  
   Render の PostgreSQL にすでにデータがある場合: `pg_dump` で Render からエクスポートし、Supabase に `psql` や Supabase の SQL Editor で流し込む。または、アプリ側で「再ログイン」「在庫変動は新規から」として、データ移行を省略する。

4. **本番の DATABASE_URL を差し替え**  
   Render の Web サービスの Environment で、`DATABASE_URL` を **Supabase の接続 URL** に更新する。

5. **再デプロイ**  
   保存されている環境変数で再デプロイする（または手動でデプロイ）。アプリはそのまま Supabase の PostgreSQL に接続する。

6. **Render PostgreSQL Add-on の解約**  
   動作確認が終わったら、Render の PostgreSQL Add-on を削除し、料金を止める。

---

## 5. タスクの依存関係と「PostgreSQL を先に作成する」推奨

**Render で PostgreSQL は「Add-ons」ではなく、先に「+ New → Postgres」で別リソースとして作成してよいです。むしろ推奨します。**

- **理由**: A2（PostgreSQL 用マイグレーションの新規作成）では、`npx prisma migrate dev --name init_postgres` を実行するために **PostgreSQL の DATABASE_URL が必須**です。先に Postgres を作成しておくと、発行された **Internal URL** をコピーしてローカルの `.env` に `DATABASE_URL` として設定し、そのまま A1 → A2 を進められます。
- **メリット**: 本番で使う **同じ Render Postgres** 上でマイグレーションを生成するため、本番デプロイ時の互換性を気にしなくて済みます。

**推奨する進行順（PostgreSQL を先に作成）**

1. **B1 を先にやる**: Render ダッシュボードで **PostgreSQL を新規作成**する（手順は下記「B1 の詳細」参照）。**「Add-ons」は使わない**。Postgres は **「+ New」→「Postgres」** で別リソースとして作成する。
2. **URL を控える**: 作成後、Postgres の画面で **Connect** メニュー（または **Info** タブ）から **Internal URL** をコピーする。Web サービスと**同じリージョン**にした場合は Internal URL を使う（レイテンシが小さい）。いったんメモ帳などに貼っておく。
3. **ローカル .env に設定**: 手元の `.env` に `DATABASE_URL="（コピーしたURL）"` を追加する（本番ではあとで B2 で Web サービスの Environment に設定する）。
4. **A1**: `schema.prisma` を `provider = "postgresql"` と `url = env("DATABASE_URL")` に変更する。
5. **A2**: 既存の SQLite 用 `migrations` を退避し、`npx prisma migrate dev --name init_postgres` を実行する。生成された `prisma/migrations/.../migration.sql` をコミットする。
6. **A3**: `.env.example` に `DATABASE_URL` の例を追記する。
7. **B2**: Render の **Web サービス**の **Environment** に、上記と同じ接続 URL を **`DATABASE_URL`** として**手動で追加**する（Postgres は別サービスなので、自動では入らない）。
8. **B3**: Build Command に `npx prisma generate && npx prisma migrate deploy` を追加する。
9. **B4**: デプロイして、履歴が残ること・ログインできることを確認する。
10. **C1, C2**: ドキュメント整備。

### タスクの依存関係（簡易）

```
B1（Postgres を「+ New → Postgres」で作成）→ URL 取得
       ↓
A1 → A2（URL を .env に設定済みなら実行可能）→ A3
       ↓
B2 → B3 → B4
       ↓
C1 → C2
```

- B2 は B1 のあと。Postgres は Web サービスとは別リソースなので、**Web サービスの Environment に `DATABASE_URL` を手動で追加**する必要がある。
- B3 は A1・A2 がリポジトリに反映されていることが前提。B4 は B1〜B3 のあと。
- C1・C2 は Phase B のあとでよい（並行しても可）。

---

## 6. 参照

- **全体設計・DB選定**: `docs/ARCHITECTURE_EXTERNAL_DB.md`
- **本番で必須の2つの対策**: `RELEASE_REQUIREMENTS_PUBLIC_APP.md` セクション 5
- **要件書のデータベース設計**: `REQUIREMENTS_FINAL.md` セクション 4
