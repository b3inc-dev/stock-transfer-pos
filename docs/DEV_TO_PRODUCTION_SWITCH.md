# 開発環境から本番環境への切り替え（管理画面をPCを閉じても開けるようにする）

**作成日**: 2026年2月7日

---

## 1. なぜPCを閉じると管理画面が開かなくなるか

- `shopify app dev` を実行すると、**トンネルURL**（ngrok など）が発行され、Shopify 側の「アプリのURL」が**そのトンネルURL**に更新されます（`automatically_update_urls_on_dev = true` のため）。
- 開発ストアで「アプリを開く」と、Shopify は**登録されているアプリURL**（＝トンネルURL）にリダイレクトします。
- **PCを閉じる**とトンネルが止まり、そのURLは応答しなくなります。
- そのため、**管理画面（アプリ）を開こうとしても「つながらない」**状態になります。

---

## 2. 本番環境に切り替える＝「アプリのURL」を本番サーバーに戻す

「本番環境にする」＝**Shopify に登録されているアプリのURLを、本番サーバー（例: Render）のURLに戻す**ことです。

一度戻せば、**PCを閉じていても**、開発ストアからアプリを開くと**本番サーバー（Render）**が表示されます。開発ストアのままでも、本番で動いているアプリを確認できます。

---

## 3. 手順（自社用アプリ：stock-transfer-pos.onrender.com の場合）

### 前提

- **Render** に自社用アプリをデプロイ済みで、**https://stock-transfer-pos.onrender.com** で動いていること。
- Render の環境変数に **`SHOPIFY_APP_URL`** が **`https://stock-transfer-pos.onrender.com`** になっていること。

### ステップ 1: 使うアプリ設定を確認

自社用アプリなら **`shopify.app.toml`** を使います。

```bash
# 自社用アプリの設定を使う（通常はこれがデフォルト）
shopify app config use shopify.app.toml
# または単に
shopify app config use
```

中身で **`application_url`** が本番URLになっているか確認します。

```toml
# shopify.app.toml
application_url = "https://stock-transfer-pos.onrender.com"
```

### ステップ 2: 本番へデプロイ（アプリURLを本番に更新）

次のコマンドで、**コードのデプロイ**と**Shopify 側のアプリURLの更新**を行います。

```bash
shopify app deploy
```

- このとき、**現在の config**（通常は `shopify.app.toml`）の **`application_url`** が Shopify に送られ、**アプリのURLが本番（Render）に切り替わります**。
- デプロイが終わったら、**開発ストアで「アプリを開く」**と、本番URL（Render）の管理画面が開くようになります。

### ステップ 3: 動作確認

1. **PCで `shopify app dev` は起動しない**状態で、ブラウザから開発ストアの管理画面を開く。
2. アプリ（例: POS Stock）をクリックする。
3. **https://stock-transfer-pos.onrender.com/...** が開き、管理画面が表示されればOKです。PCを閉じても、同じ手順で開けます。

---

## 4. 開発ストアでも本番で確認できるか

**できます。**

- アプリのURLを本番（Render）に切り替えたあと、**インストールされているストアはそのまま**使えます。
- 開発ストアも「アプリをインストール済み」であれば、**本番URLのアプリ**が開きます。
- つまり、**開発ストアで、本番（Render）で動いているアプリの挙動を確認する**ことができます。データは開発ストアのままです。

---

## 5. 注意点

### 再度ローカル開発するとき

- 次に **`shopify app dev`** を実行すると、また**トンネルURL**がアプリのURLとして登録されます。
- その間は、アプリを開くと**トンネル（ローカル）**に飛び、PCを閉じると開けなくなります。
- **開発が終わったら、もう一度 `shopify app deploy` を実行**すると、また本番URLに戻り、PCを閉じても管理画面が開くようになります。

### 公開用アプリ（pos-stock.onrender.com）の場合

- 公開用は **`shopify.app.public.toml`** を使います。
- 切り替え: `shopify app config use public` のあと `shopify app deploy` を実行します。
- 本番URLは `shopify.app.public.toml` の `application_url`（例: `https://pos-stock.onrender.com`）になります。

---

## 6. まとめ

| やりたいこと | やること |
|--------------|----------|
| PCを閉じても管理画面を開けるようにする | 本番（Render）を起きた状態にしておき、**`shopify app deploy`** を実行してアプリURLを本番に戻す。**deploy 後もトンネルURLに飛ぶ場合は「7. パートナーダッシュボードでアプリURLを手動で本番に戻す」を実行。** |
| 開発ストアで本番のアプリを試す | 上記のあと、開発ストアからアプリを開く。本番URLで開くので、開発ストアのデータのまま本番アプリを確認できる。 |
| またローカルで開発する | `shopify app dev` を実行。終わったら再度 `shopify app deploy` または手動でアプリURLを本番に戻す。 |

**コマンドの目安**

```bash
# 自社用アプリ（POS Stock - Ciara）を本番URLにする場合
shopify app config use shopify.app.toml
shopify app deploy

# 公開用アプリ（POS Stock）を本番URLにする場合
shopify app config use public
shopify app deploy
```

デプロイ後、開発ストアからアプリを開いて、本番URLで表示されることを確認してください。

---

## 開発ストアで「どのアプリ」を開いているかで deploy 先が違う

サイドバーに **「POS Stock - Ciara」** と **「POS Stock」** の2つがある場合、**別々のアプリ**です。

| サイドバーに表示される名前 | 使う toml | 本番URL |
|----------------------------|-----------|---------|
| **POS Stock - Ciara** | `shopify.app.toml` | https://stock-transfer-pos.onrender.com |
| **POS Stock** | `shopify.app.public.toml`（public） | https://pos-stock.onrender.com |

**「POS Stock」を開いたときにトンネルエラーになる**場合は、**公開用アプリ**のアクティブなバージョンがまだトンネルURLのままです。次のように **公開用の deploy** を実行してください。

```bash
shopify app config use public
shopify app deploy
```

**「POS Stock - Ciara」を開いたときにエラーになる**場合は、自社用の deploy です。

```bash
shopify app config use shopify.app.toml
shopify app deploy
```

deploy は **いま開いている（エラーになっている）アプリ**に対応する config で行う必要があります。

---

## 7. deploy しても「Cloudflare Tunnel error」「トンネルURLに飛ぶ」場合（要因と対処）

### 7.1 症状

- `shopify app deploy` を実行したのに、管理画面を開くと **Cloudflare Tunnel error (Error 1033)** や、**trycloudflare.com のURL**（例: `titled-monitoring-lighting-packets.trycloudflare.com`）に飛んでしまう。
- そのため、**`shopify app dev` でトンネルを繋いでいないと管理画面が開けない**状態になる。

### 7.2 要因

- **`shopify app dev`** を実行すると、Shopify に登録されている**アプリのURL**が**トンネルURL**（Cloudflare Tunnel や ngrok のURL）に**上書き**されます。
- その後 **`shopify app deploy`** を実行しても、**アプリのURLが toml の `application_url`（本番URL）に戻らない**ことがあります（CLI の挙動やキャッシュの影響など）。
- その結果、Shopify 側に保存されているアプリのURLが**トンネルURLのまま**になっており、アプリを開くたびにそのURLへリダイレクトされます。トンネルは `shopify app dev` を止めると消えるため、**Error 1033** や「解決できない」という表示になります。

### 7.3 公式の仕様：URLは「バージョン」に含まれる（ダッシュボードに単独の編集欄はない）

Shopify の公式ドキュメントでは、次のように説明されています。

- **アプリのURL（application_url）** は **`shopify.app.toml`** で定義します。
- **本番ストアに反映するには**、設定変更後に **`shopify app deploy`** を実行します。  
  （開発ストア向けは `shopify app dev` 実行時に toml の内容が自動で反映されます。）
- **Dev Dashboard では「設定 > App URL」のような単独の編集欄はありません。**  
  URL は **各アプリ「バージョン」のスナップショットの一部**として保存されています。  
  そのため、**バージョン詳細**（Versions → 対象バージョンをクリック）に **App URL** や **Redirect URLs** が表示されます。
- URL を変えたい場合は、**「新しいバージョンを作成・リリースする」**必要があります。  
  つまり **toml の `application_url` を本番URLにしたうえで `shopify app deploy` を実行**し、できた新しいバージョンをリリースすると、そのバージョンの URL が使われます。

参照: [App configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration) / [Deploy app versions](https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions)

### 7.4 対処：本番URLのバージョンを作成・リリースする

**手順（推奨）**

1. **`shopify app dev` を止める**（トンネルを止め、CLI がトンネルURLを使わないようにする）。
2. 使うアプリの **toml** を確認・編集する。
   - 自社用: **`shopify.app.toml`** の `application_url = "https://stock-transfer-pos.onrender.com"`
   - 公開用: **`shopify.app.public.toml`** の `application_url = "https://pos-stock.onrender.com"`
3. その toml を使って **deploy** する。
   ```bash
   # 自社用の場合（通常はこれがデフォルト）
   shopify app config use shopify.app.toml
   shopify app deploy
   # 公開用の場合
   shopify app config use public
   shopify app deploy
   ```
4. deploy が成功すると **新しいバージョン** が作成され、そのバージョンに toml の **App URL** が含まれます。通常はそのままリリースされるので、**アクティブなバージョン** が本番URLになります。
5. **Dev Dashboard → Apps → 対象アプリ → Versions** で、いま **Active** のバージョンを開き、**App URL** と **Redirect URLs** が本番URLになっているか確認する。
6. 開発ストアからアプリを開き直し、アドレスバーが本番URL（onrender.com）になっていればOKです。

**まだトンネルURLのバージョンが Active のままの場合**

- 上記のとおり **toml を本番URLにしたうえで、再度 `shopify app deploy`** を実行してください。  
  新しいバージョンが作成・リリースされ、そのバージョンの URL が使われます。
- もし **過去に本番URLで deploy したバージョン** が残っていれば、Dev Dashboard の **Versions** でそのバージョンを選び **Release** して「そのバージョンをアクティブにする」方法でも、本番URLに戻せます。

### 7.5 パートナーで「インストール数が0」の場合（要因になり得る）

- パートナーダッシュボードの「アプリ配信」で、**「POS Stock」のインストール数が 0** と出ることがあります。
- **要因として考えられること**
  - 開発ストアに「POS Stock」が表示されていても、そのインストールが **開発時のトンネル経由**（`shopify app dev` で入れた状態）のままで、**本番の「インストール」としてカウントされていない**場合があります。
  - その場合、ストア側に残っている**インストール情報**が、古いトンネルURLや古いバージョンに紐づいたままになっている可能性があります。
- **やること**
  1. まず **7.4** のとおり、**本番URLのバージョン**が Dev Dashboard で **Active** になっているか確認する。
  2. 本番URLのバージョンが Active なのにまだトンネルに飛ぶ場合は、**開発ストアで一度「POS Stock」をアンインストールし、あらためて本番URLのアプリとしてインストールし直す**と、正しいURLで開くようになることがあります。
  3. 公開用アプリを開発ストアにインストールし直す方法: **Dev Dashboard → 対象アプリ（POS Stock）→ 開発ストア用のインストールリンク** や、アプリの **Test your app** などから、そのストアに再インストールする。

インストール数が0だからといって「アプリが開けない」直接の原因ではありませんが、**「トンネル時代のインストールのまま」** になっている可能性はあり、その場合は**再インストール**で解消することがあります。

### 7.6 deploy を実行したのに「まだ変わらない」ときの確認リスト

1. **`shopify app dev` を完全に止めているか**  
   別のターミナルで動いていないかも確認する。

2. **deploy したアプリと、開いているアプリが同じか**  
   - サイドバーで **「POS Stock」** を開いてエラー → **公開用**で deploy（`shopify app config use public` → `shopify app deploy`）。
   - **「POS Stock - Ciara」** を開いてエラー → **自社用**で deploy（`shopify.app.toml` で deploy）。

3. **Dev Dashboard で Active バージョンの URL を確認**  
   - **Dev Dashboard → Apps → POS Stock（または該当アプリ）→ Versions** を開く。
   - **Active** になっているバージョンをクリックし、**App URL** が **https://pos-stock.onrender.com**（公開用）や **https://stock-transfer-pos.onrender.com**（自社用）になっているか確認する。
   - まだ **trycloudflare.com** や **ngrok** のURLになっている場合は、**本番URLが書かれた toml で再度 `shopify app deploy`** を実行し、新バージョンができたらそのバージョンが Active になるか確認する。

4. **開発ストアでアンインストール → 再インストール**  
   - 上記まで正しいのにまだトンネルに飛ぶ場合は、その開発ストアで一度アプリをアンインストールし、**本番URLのアプリ**として再度インストールする（7.5 参照）。

5. **ブラウザのキャッシュ**  
   - 別タブで開き直す、または **スーパーリロード**（Ctrl+Shift+R / Cmd+Shift+R）してからアプリを開き直す。

### 7.8 再インストール後に「Not Found」になる場合（要因と対処）

**症状**

- Dev Dashboard から「POS Stock」を開発ストアにインストールし直したら、トンネルエラーは解消したが、今度は画面に **「Not Found」** だけが表示される。

**要因**

- 「Not Found」は **React Router** が「どのルートにもマッチしなかった」ときに返すメッセージです。つまり、**リクエストされたURLのパス**が、アプリ側のルート（`/` や `/app` など）と一致していない可能性があります。
- 想定される原因:
  1. **Shopify 側に登録されている App URL にパスが含まれている**  
     Dev Dashboard や過去のバージョンで、App URL が `https://pos-stock.onrender.com/embed` や `https://pos-stock.onrender.com/app` のように**パス付き**になっていると、管理画面の iframe はそのURLを開きます。アプリはルート（`/`）で `/app` へリダイレクトするため、`/embed` など未定義のパスだとルートにマッチせず **Not Found** になります。
  2. **本番デプロイ（Render）の環境変数の違い**  
     pos-stock サービス（公開用URLを提供）の **SHOPIFY_API_KEY** が公開用アプリの client_id と一致していない、または **SHOPIFY_APP_URL** が `https://pos-stock.onrender.com` になっていない場合、認証やリダイレクトがずれて別パスに飛んだ結果、Not Found になることがあります。
  3. **リダイレクトURLの不一致**  
     パートナー／Dev Dashboard の「リダイレクトURL」に、利用しているパス（例: ルートや `/auth/callback`）が含まれていないと、認証後に想定外のURLに飛び、Not Found になることがあります。

**対処（確認の順番）**

1. **実際にリクエストされているURLを確認する**  
   - 管理画面で「POS Stock」を開いた状態で、iframe の中身のURLを確認します（アプリ画面で右クリック → 「フレームで開く」や、開発者ツールの Network タブでドキュメントの Request URL を確認）。  
   - パスが `/` や `/app` ではなく、`/embed` や `/app/embed` などになっていれば、**Dev Dashboard → 対象アプリ → Versions → Active バージョン** の **App URL** を **パスなし** の `https://pos-stock.onrender.com` に修正し、必要なら toml の `application_url` を同じにしたうえで **再度 `shopify app deploy`** してください。

2. **App URL をルートに統一する**  
   - **shopify.app.public.toml** の `application_url` は **パスなし** にします。  
     `application_url = "https://pos-stock.onrender.com"`  
   - 変更後は `shopify app config use public` → `shopify app deploy` を実行し、Dev Dashboard の Active バージョンの App URL がルートになっているか確認します。

3. **Render の環境変数を確認する**  
   - pos-stock サービス（公開用URLを提供）で、**SHOPIFY_API_KEY**（公開用アプリの client_id）、**SHOPIFY_APP_URL**（`https://pos-stock.onrender.com`）、**SHOPIFY_API_SECRET** などが正しく設定されているか確認します。

4. **スプラットルートによるフォールバック**  
   - アプリ側で、**どのルートにもマッチしないパス**でかつ **`?shop=` または `?host=` が付いているリクエスト**は、自動で `/app` にリダイレクトするようにしています（`app/routes/$.tsx`）。  
   - これにより、古いバージョンでパス付きのURLが登録されていた場合でも、Not Found にならずアプリが開くようになります。デプロイ後は再度アプリを開き直して確認してください。

**「iframe の実際のURL」の確認のしかた（任意）**

- ここで言う「iframe の実際のURL」は、**あなたのアプリ（POS Stock）の画面を表示している iframe が読み込んでいる URL** のことです。Dev Dashboard の「App URL」と同じになる想定ですが、実際にブラウザがどのURLにリクエストしているか確認したいときに使います。
- **Network タブ**で見る場合: 一覧に並んでいるリクエストのうち、**あなたのアプリのドメイン**（`pos-stock.onrender.com`）**へのリクエスト**を探します。`admin.shopify.com` や `location-stock-indicator` など、Shopify 管理画面のAPI用のリクエストは**対象ではありません**。フィルターに `onrender.com` や `pos-stock` を入れると見つけやすいです。そのリクエストの「Request URL」が iframe の実際のURLです（404 になっている場合は、そのURLのパスが原因の可能性があります）。
- **Elements タブ**で見る場合: 「Not Found」と出ているあたりを右クリック → 「検証」で、HTML 内の `<iframe>` を探し、その **`src` 属性**の値が iframe の実際のURLです。

**ルート（/）＋ shop 付きなのに 404 になる場合**

- iframe のリクエストが **`https://pos-stock.onrender.com/?shop=...&embedded=1&...`** のように **パスは `/` でクエリに `shop` もある**のに 404 になる場合は、**リクエストが Render 上の Node アプリまで届いていない**可能性が高いです（アプリ側のルートでは `/` に `shop` があれば `/app` にリダイレクトするため、通常は 404 を返しません）。
- **確認すること:**
  1. **Render ダッシュボード**で、pos-stock サービス（公開用URLを提供）が **Running** か、直近のデプロイが成功しているか。
  2. **ブラウザで直接** `https://pos-stock.onrender.com/` を開いたとき、何が表示されるか（「Not Found」だけ / ログインフォーム / 別のエラー）。同じ 404 なら、Render 上のアプリが動いていないか、別のサービスが応答している可能性があります。
  3. **Build & Deploy** の **Start Command** が、このアプリの Node サーバーを起動するコマンドになっているか（例: `npm run start` や `react-router-serve ./build/server/index.js`。Docker の場合は `npm run docker-start`）。
  4. **Logs** で、起動時エラーやリクエストが届いていない理由が出ていないか確認する。

**公開用は同じ「pos-stock」サービス（pos-stock.onrender.com）を使う場合**

- 公開用アプリの本番URLに **https://pos-stock.onrender.com** を使う場合は、**既存の「pos-stock」サービスをそのまま**使います。2つ目のサービスは不要です。
- **shopify.app.public.toml** の `application_url` と `redirect_urls` を `https://pos-stock.onrender.com` にし、**公開用アプリ**用の環境変数（`SHOPIFY_API_KEY` が公開用の client_id、`SHOPIFY_APP_URL` = `https://pos-stock.onrender.com`）を、そのサービスで使うか、デプロイ時に切り替えられるようにしておきます。自社用と公開用で**別サービスに分けたい**場合だけ、2つ目の Web サービスを新規作成し、そちらのサービス名で別URL（例: そのサービス名.onrender.com）を取得します。

### 7.9 今後の注意（トンネルURLの上書き）

- **`shopify app dev`** を再度実行すると、またアプリのURLがトンネルURLに上書きされます。
- 開発が終わって「PCを閉じても開ける」状態に戻したいときは、  
  - もう一度 **パートナーダッシュボードでアプリURLを本番に戻す**か、  
  - **`shopify app deploy`** を実行したうえで、まだトンネルURLのままなら同様に手動で本番URLに戻してください。
