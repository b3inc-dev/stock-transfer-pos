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
git push origin main
```
※ 認証を聞かれたら、GitHub のパスワードまたはトークン／SSH でログイン

---

## 2. Render のデプロイ

- **main に push したら自動デプロイ**する設定なら、`git push origin main` だけでデプロイが始まります。
- 自動デプロイにしていない場合は、[Render ダッシュボード](https://dashboard.render.com) → 該当サービス（pos-stock）→ **「Manual Deploy」→「Deploy latest commit」** で手動デプロイ。

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
