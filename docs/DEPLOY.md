> Agent運用: 以下の本番手順は参照用です。専用branchからPRを作り、main反映は承認済みPRのmergeで行います。本番手動deploy・Shopify release・本番env変更は明示承認後のみ。今回の初期設定では実行しません。

# プッシュとデプロイ手順

本番（Render）への反映と、必要に応じた Shopify 拡張のデプロイ手順です。

---

## 1. 変更をコミットしてプッシュ（GitHub）

ターミナルで以下を実行。GitHub 認証が必要なため、**ご自身の環境**で実行してください。

```bash
cd /Users/develop/ShopifyApps/stock-transfer-pos
```

```bash
git status
```
※ どのファイルが変更されているか確認

```bash
git add <変更したいファイル>
```
例: `git add app/routes/api.log-inventory-change.tsx`（.DS_Store は add しない）

```bash
git commit -m "ここに変更内容の短い説明"
```

```bash
git push origin <feature-branch>
# PRを作成。main反映は承認済みPRのmergeで行う
```
※ 認証を聞かれたら、GitHub のパスワードまたはトークン／SSH でログイン

---

## 2. Render のデプロイ

- 公開用 `pos-stock` はGitHub main監視・On Commit auto-deployを2026-10-04に確認済み。承認済みmain mergeでbackend production deployが始まります。Ciara用 `pos-stock-ciara` の実設定は未確認（末尾の再監査参照）。
- 明示承認後に手動deployする場合のみ、[Render ダッシュボード](https://dashboard.render.com) → 該当サービス（pos-stock）→ **「Manual Deploy」→「Deploy latest commit」** で手動デプロイ。

**確認:** Render の **Logs** で `==> Your service is live` などが出れば完了。

---

## 3. Shopify 拡張のデプロイ（必要なときだけ）

**サーバー側（app/routes など）の変更だけ**なら不要。  
**拡張のコード**（extensions 内の JS/設定）を変えたときだけ実行します。

```bash
cd /Users/develop/ShopifyApps/stock-transfer-pos
shopify app deploy
```

※ 本番アプリにデプロイする場合は、`shopify.app.public.toml` を指定するなど、プロジェクトの設定に合わせて実行してください。

---

## 環境変数の確認（Render）

- **SHOPIFY_API_KEY** ＝ Partner Dashboard のアプリ「設定」の **Client ID**
- **SHOPIFY_API_SECRET** ＝ 同じく **Secret**

POS が使うアプリと Render で動かしているアプリが同じになるよう、上記が一致していることを確認してください。変更した場合は Render で保存し、必要に応じて再デプロイします。


## Cursor・Codex・Claude Code 共通開発運用

GitHub のコード・Issue・PR を正本とし、共通指示は `AGENTS.md` と本書に保存する。ツールの個人メモだけで仕様を確定しない。

業務・状態遷移の正本は [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[BUSINESS_RULES.md](BUSINESS_RULES.md)、[STATE_MACHINE.md](STATE_MACHINE.md)、[SHOPIFY.md](SHOPIFY.md)、[DECISIONS.md](DECISIONS.md)。開発運用・owner・引き継ぎ・リリース承認の正本は本書。古い個別手順のmain直pushや無承認deployは実行せず、本書の停止条件に従う。DECISIONSの推奨優先順位はBacklogとして扱い、依頼なしに実装へ着手しない。

- 1 logical workstream = 1 owner agent/tool = 1 branch/worktree/PR。同じworkstreamを3ツールが同時編集しない。
- 開始前にGitHub Issue/PRでownerを確認し、担当未確定なら確定してから編集する。別workstreamも変更範囲の重複を確認する。
- mainへのdirect commit/push・force pushは禁止。GitHub正本から専用branch/worktreeを作り、変更ファイルだけをstageする。他者の未コミット変更・Theme Editor由来commitを保持する。
- Backlogは候補一覧であり実行指示ではない。依頼された範囲以外へ勝手に着手しない。
- 調査→設計→実装→品質確認→独立レビュー→Readyの順。仕様競合は編集前に報告する。既存のSMALL/MEDIUM/HIGH RISK分類・DoD・自動merge条件がある場合は維持し、出典不明なら推測で補わない。
- HIGH RISKはReadyで停止し、人間の明示承認後のみmergeする。今回の初期設定ではproduction releaseを伴うmergeも承認待ち。本番手動deploy/publish/rollbackは行わない。
- secrets/token/本番credentialsをrepo・Issue・PR・ログへ保存しない。.env.exampleは必要な変数名と非secretの例のみ。既存接続を置換せず、MCP追加は必要性・権限・credential保存先を先に確認する。

### 3ツール間の引き継ぎ

前ownerは編集・自動処理を止め、commitと作業状態をIssue/PRへ記録して所有権を解放する。次ownerは記録・HEAD・未コミット差分を確認して引き継ぎを明記してから編集する。ownerが不明なら同時着手しない。

Issue本文またはPR本文/コメントに以下を記録する（secretを含めない）:

```text
Workstream:
Owner tool / agent: Cursor | Codex | Claude Code / 担当名
State: Investigating | Working | Ready | Handing off | Done
Branch / worktree:
Base / HEAD commit:
Scope / files:
Risk / 既存分類の根拠:
Quality: コマンド・結果・未実行理由
Independent review:
Unfinished / blockers:
Next action:
Release impact / approval:
Handoff: 前owner停止確認・次owner受領
```

### ツールの読込・権限確認

- Cursor: repo rootのAGENTS.mdと`.cursor/rules/shared-agent-entry.mdc`から共通docsを読む。既存のscoped rule・User/Team Rulesも確認する。
- Codex: repo rootから起動してAGENTS.mdを読む。`.codex/config.toml`は`approval_policy = "on-request"`・`sandbox_mode = "workspace-write"`を指定。信頼済みprojectのみproject configを読込む。管理設定・起動引数・ユーザー設定が上書きする可能性を確認する。
- Claude Code: CLAUDE.mdの`@AGENTS.md` importを使う。既存CLAUDE.md・個人設定・MCP接続を保持する。`/context`のMemory filesと`/memory`で読込先を確認する。
- 全ツールでFull Access・承認全面省略へ変更しない。docsは行動指示であり、GitHub保護や各ツールの実権限の代わりではない。
- 新規セッションで「読込済み指示ファイル、owner、PR base、本番操作の停止条件を挙げて。編集・外部操作はしない」と依頼し、回答と実際のファイルを照合する。別ツールを検証する際もownerを変更しない。

読込仕様の参照: [Cursor Rules](https://cursor.com/docs/rules)、[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Claude Code memory/imports](https://code.claude.com/docs/en/memory)。

### Shopify App のリリース境界と品質

OAuth・scopes・webhooks・App Proxy・billing・inventory/order mutation・本番env変更はHIGH RISK。手動production deployは明示承認時のみ。旧手順のmain直pushは使わず、PR経由に読み替える。`shopify app deploy`によるShopify設定/拡張のreleaseと、hosted backendのdeployは別経路。開発時も本番アプリのURLを更新しないようapp/config/storeの接続先を確認する。

Renderの下記確認済みサービスはmainを監視しOn Commit auto-deploy。main merge = backend production releaseとして扱い、今回は人間承認までmergeしない。Shopify app config/extension releaseは別経路で、Render deployだけではShopify版のreleaseを意味しない。

品質ゲートはpackage.jsonに存在するlint/typecheck/buildを実行し、存在しないtestコマンドを捏造しない。開発用credentialsが必要な検証は未実行理由をPRに残す。本番DBへのmigrationや接続を品質確認に使わない。

外部API変更時は既存helperのretry上限/backoff・429/GraphQL throttle・error/userErrors処理を確認する。mutationはタイムアウト後の成功不明状態を含めidempotencyと再送を確認し、read用retryをそのまま適用しない。全経路の網羅性・rate limit・secret/log redactionが未確認なら注意点として残し、初期設定ではrefactorしない。

### repoから確認した運用証拠（2026-10-04）

`shopify.app.toml`/`shopify.app.public.toml`と既存deploy docsは自社用/公開用を分離する。`package.json`のdeployはShopify releaseであり、Render backend deployを直接実行する証拠ではない。公開用Renderサービスのmain/On Commitを実確認。Ciara用の設定は下記未確認。`app/utils/graphql-with-retry.ts`はHTTP429/503に最大3retry（1/2/4秒）を実装するが、このhelperのGraphQL throttle/network例外/Retry-After対応は未整備。`app/utils/admin-webhook-retry.ts`は2.5秒×12回の再検索。`app/routes/api.log-inventory-change.tsx`等のappEventIdとDB unique/upsertで重複防止する。全mutationの網羅性は未確認。

### 初期設定監査（2026-10-04、本番コード/deploy設定変更なし）

main protectionなし（API404 Branch not protected）、rulesetなし。GitHub Actions workflowなし、GitHub auto-merge機能は無効。ツールによる既存merge運用とこのAPI設定は別物として扱う。提案はmainのPR必須・force push/削除禁止・必須人間review 0・bypassなし。存在しないCI checkをrequiredに追加しない。保護設定適用は差分を提示して人間承認後のみ。

品質: build成功。lint失敗: 3,093 errors / 157 warnings、typecheck失敗。 実行Nodeは24.11.1、既存ローカルnode_modulesを再利用したためNode20での完全再現は未確認。アプリコードの差分はなし。既存gateエラーは初期設定PRでrefactorせず別課題とする。

ツール: Cursor desktop CLI 3.23.12、Codex CLI 0.160.0、Claude Code 2.1.246、Shopify CLI 3.88.1。Codexはread-only実セッションで共通指示と参照docsを読み、owner/PR/停止条件/引き継ぎを確認。Cursorの実Agent読込は未確認（cursor-agentは未検出）、Claude Codeは未ログインで実セッション未確認。rootから起動して上記の無編集確認promptを実行し、Claudeは/contextのMemory files、Cursorは適用ルールを照合する。

既存権限/接続: Codexユーザー設定にapproval/sandboxの明示キーはなく、このPRはrepo側だけsafe defaultを追加。repo設定はon-request/workspace-writeを維持するが、再監査時のこのCodex desktop sessionは起動側のdanger-full-access/approval neverで上書きされている。repo設定だけでは実効権限を保証できないため、通常開発ではdesktopの承認・sandbox表示を確認して開始する。今回こちらからFull Accessへ変更した事実はない。Cursor CLIはapprovalMode=allowlistだがsandbox.mode=disabled（既存ユーザー設定を保持、要確認）。Claudeユーザー設定はallow 28件・defaultMode明示なし。Edit(**)、git push、npx prisma、gcloud buildsの広いallowがある。production禁止はdocs上の指示でありpermission denyではない。未ログインのため実効モードとimportは未確認。個人権限は変更していない。Codex/ Cursorの既存MCP、App repoのShopify MCPは保持し、新規MCP・credentialsを追加しない。個人認証/接続情報はコピーしていない。

承認後の更新: 2026-10-04にユーザー承認を受けmain ruleset `main-pr-required-no-force-push` をactiveで適用し、有効ルールをGETで再確認済み。PR必須、force push/削除禁止、required approvals=0、追加承認/Code Owner/last push approvalは無効、bypassなし。required checksは追加せず、既存auto-merge設定は変更していない。

独立レビュー: 別Agentによる読み取りレビューで旧deploy手順の矛盾を修正し、重大な追加指摘なし。実行できないツール/外部設定と既存品質エラーは上記・PRで未確認/未完了として残す。

### 外部設定・品質再監査（2026-10-04）

Render `pos-stock`（srv-d5vcsr7pm1nc73cfph90）は `b3inc-dev/stock-transfer-pos` / main / On Commit、Docker service、context `.`、Dockerfile path `./Dockerfile`、Root Directory/Build Filters未指定、Docker Command overrideとpreDeploy空。DockerfileはNode20、CMD `npm run docker-start`。Ciara用 `pos-stock-ciara`（srv-d5d4n2be5dus7394um90）の実Source/Branch/Auto-Deployは未確認。Dashboard→サービス→Settingsで確認する。`shopify.app.toml`はstock-transfer-pos.onrender.com、公開用tomlはpos-stock.onrender.comを指定しており、稼働Ciaraアプリの実URL/redirectとサービスURLの対応はShopify Dev Dashboardのアプリ設定で照合が必要。設定を書き換えず未確認として残す。

GitHub main `c3cfefff` とPRを同じNode24/依存/envで比較し、lint 3,093 errors/157 warnings、typecheck 452 error行が同一（lintの絶対path・列幅を正規化）。今回差分による新規失敗なし。正式Green baselineは未成立。

## PR Preview Workflow

本番 deploy / Shopify deploy / Render / DB migrate を行わず、**PR の内容だけ**をローカルで確認するための手順です。Preview 専用 worktree（既定: リポジトリの兄弟ディレクトリ `../ciara-system-preview`）を使い、本体の作業ディレクトリや branch は切り替えません。ブラウザの確認 URL は常に同じです。

**Preview URL:** `http://127.0.0.1:3001`（通常の `npm run dev` は 3000。競合させない）

コマンドはすべて **本体側の checkout**（`preview:*` スクリプトがある dir。通常は main 作業 dir）で実行します。`cd ../ciara-system-preview` してから `preview:*` を回す必要はありません（Preview 内実行は拒否します）。

### 初回だけ（Preview worktree 準備）

```bash
npm run preview:setup
npm run preview:pr -- <PR番号>
npm run preview:dev
```

- 既に `../ciara-system-preview` があれば再利用し、二重作成しません。
- パスを変えたい場合は `PREVIEW_WORKTREE_PATH=/absolute/path` を付けて実行。
- Preview worktree が dirty（未コミット変更）のときは破棄せず停止します。`git reset --hard` / `git clean -fd` / force push は使いません。
- `preview:setup` / `preview:pr` は必要時のみ Preview 内で `npm ci` します（本体の `node_modules` は触りません）。

### 以後（PR を切り替えて確認）

```bash
npm run preview:pr -- <PR番号>
npm run preview:dev
```

例（PR #27）:

```bash
npm run preview:pr -- 27
npm run preview:dev
```

ブラウザで `http://127.0.0.1:3001` を開いて確認します。

### 起動経路・依存関係・Prisma / env

- `preview:dev` は **`shopify app dev` を使いません**。`shopify.web.toml` の `prisma migrate deploy` を踏まないよう、`prisma generate`（DB変更なし）+ `react-router dev`（`PORT=3001`）だけを Preview worktree で起動します。
- `package.json` / `package-lock.json` が `origin/main` から変わっている場合は明示し、ロック／マニフェストのハッシュが変わっていれば Preview 内だけで `npm ci` します。
- Prisma schema / migration の差分は**警告のみ**です。`db push` / `migrate deploy` / `migrate apply` / production DB / production sync は**絶対に自動実行しません**。
- `.env` / secrets は自動コピーしません。Preview でアプリ動作確認が必要なら、本体側と同様の**ローカル用** `.env` を Preview worktree に手動配置してください（本番 credentials を書かない）。
- 通常の `npm run dev`（3000）と同時起動は可能ですが、Shopify CLI のトンネル／`FRONTEND_PORT` とは別プロセスです。混同しないでください。
- PR 取得は `gh` を優先し、だめなら `refs/pull/<PR>/head` に fallback します。存在しない PR は明確にエラー終了します。

### 確認後 → 本番反映ワークフローへ

プレビューで問題なければ、人間向けの合図として次を使い、既存の production release workflow（本書前半の PR merge 承認 → Render / 必要時 Shopify deploy）へ進めてください。**この Preview 手順自体は merge / 本番操作を行いません。**

```text
プレビュー確認済み。問題ないので本番反映まで進めて。
```

### 禁止事項（Preview スクリプト・運用）

- PR の自動 merge
- production deploy / Shopify deploy / Render 操作 / rollback
- `git reset --hard` / `git clean -fd` / force push
- 本番 DB 操作・secrets 変更
- Preview 起動経路での `prisma migrate deploy` / `db push`

### 依頼ごとに自動で行う作業分離

ユーザーは変更内容を通常の言葉で依頼するだけでよい。Cursor・Codex・Claude Codeの担当toolは、編集前に次を自律実行し、branch/worktreeの作成・再利用について毎回の確認を求めない。

1. 実作業path・GitHub remote・branch・dirty状態・既存worktreeを確認し、GitHub Issue/PRの進行中workstream/owner/範囲/依存と照合する。依頼が読み取りだけならworktree作成は不要。
2. 同じworkstreamを自分が継続中なら専用branch/worktree/PRを再利用する。他toolがownerなら編集せず、停止とhandoffを確認する。新しい独立workstreamならGitHubの最新base（Themeはstaging、他repoはmain）から専用branch＋isolated worktreeを作る。Codex新規branchはcodex/を既定とし、各toolの既存命名規約を保持する。
3. 原checkoutの未commit変更を勝手に移動・stash・破棄しない。作業pathが専用worktree、branchが保護base以外、ownerが自分であることを確かめてから編集する。base追従は現在のworkstreamと競合を確認し、他者の履歴を書き換えない。
4. owner tool/agent・branch/worktree・base/HEAD・scope・quality・未完了・次actionをIssue/PRへ記録し、関連品質確認と必要な独立reviewまで進める。依頼外Backlogへ着手しない。merge/releaseは既存の分類・DoD・承認条件に従う。本依頼のproduction merge停止は継続する。

実行環境がworktree作成を許可しない場合は共有mainへ編集せず、具体的な制約と最小限の対応を報告する。これは各toolの読込後の行動規則であり、GUIでworktree作成を強制する仕組みや権限の全面省略ではない。PR未mergeの間はこのbranchの規則を読めるセッションで利用し、共有baseへの反映後は新規セッションで読込を確認する。
