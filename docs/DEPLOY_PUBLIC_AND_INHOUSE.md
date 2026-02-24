# 公開アプリとカスタムアプリのデプロイ（2種運用）

公開アプリ（App Store 用）と自社用カスタムアプリの2つを、同じコードベースで運用するときのデプロイ手順です。

---

## 1. 何が違うか

| 項目 | 公開アプリ | 自社用カスタムアプリ |
|------|------------|----------------------|
| 設定ファイル | `shopify.app.public.toml` | `shopify.app.toml` |
| バックエンド URL | https://pos-stock.onrender.com | https://stock-transfer-pos.onrender.com |
| POS 拡張が呼ぶ API | 上記（公開用） | 上記（自社用） |

**重要**: POS 拡張（extensions）は、**ビルド時に** `extensions/common/appUrl.js` の **APP_MODE** を見て「どちらのバックエンド URL を呼ぶか」を決めます。  
そのため、**公開用にデプロイするときは APP_MODE = "public"、自社用にデプロイするときは APP_MODE = "inhouse"** になっている必要があります。

---

## 2. パートナーダッシュボードからデプロイする場合

**はい、パートナーダッシュボードからデプロイして問題ありません。**

手順は次のとおりです。

1. **デプロイする「どちらのアプリ」に合わせて APP_MODE を合わせる**
   - **公開アプリ**にデプロイする → `extensions/common/appUrl.js` の `APP_MODE` を **"public"** にし、保存する。
   - **自社用カスタムアプリ**にデプロイする → `APP_MODE` を **"inhouse"** にする。
2. 変更を **コミットしてプッシュ**する（ダッシュボードが Git 連携している場合）。
3. **パートナーダッシュボード**で、デプロイしたい方のアプリを開き、**デプロイ**（または「Git からデプロイ」など）を実行する。

ダッシュボードのデプロイは、リポジトリの**その時点のコード**で拡張をビルドするため、**プッシュした時点の APP_MODE がそのまま使われます**。  
公開アプリ用にデプロイするなら「APP_MODE = "public" の状態でプッシュ → 公開アプリのダッシュボードからデプロイ」、自社用なら「APP_MODE = "inhouse" でプッシュ → カスタムアプリのダッシュボードからデプロイ」にしてください。

---

## 3. inhouse と public の切り替え（どうすればいいか）

毎回手で `appUrl.js` を書き換えるのが手間な場合の選択肢です。

### 方法A: npm スクリプトで切り替え＋デプロイ（推奨）

リポジトリに **deploy:public** と **deploy:inhouse** の npm スクリプトを用意してあります。

- **公開アプリ用にデプロイするとき**
  ```bash
  npm run deploy:public
  ```
  → APP_MODE を "public" に書き換え → 公開用の config を有効化 → `shopify app deploy` を実行します。

- **自社用にデプロイするとき**
  ```bash
  npm run deploy:inhouse
  ```
  → APP_MODE を "inhouse" に書き換え → 自社用の config を有効化 → `shopify app deploy` を実行します。

**補足**: スクリプト内では `shopify app config use shopify.app.public.toml` / `shopify app config use shopify.app.toml` を使っています。お使いの CLI で短い名前（`config use public` など）が必要な場合は、`package.json` の `deploy:public` / `deploy:inhouse` を編集してください。

実行後、**ディスク上の appUrl.js は、いまデプロイした方のモード**に変わります。次に別の方をデプロイするときは、もう一方のスクリプトを実行すれば切り替わります。

### 方法B: 手動で appUrl.js を書き換えてからデプロイ

1. `extensions/common/appUrl.js` の **APP_MODE** を "public" または "inhouse" に変更。
2. 公開用なら `shopify app config use public`、自社用なら `shopify app config use shopify.app.toml`（または省略で自社用）。
3. `shopify app deploy` を実行。

### 方法C: ブランチで切り替える

- 公開用: 常に APP_MODE = "public" のブランチ（例: `main` や `release-public`）からデプロイ。
- 自社用: 常に APP_MODE = "inhouse" のブランチ（例: `inhouse`）からデプロイ。

パートナーダッシュボードの「デプロイ元ブランチ」を、デプロイするアプリに応じて切り替えます。

---

## 4. まとめ

| やり方 | 公開アプリ | 自社用 |
|--------|------------|--------|
| **パートナーダッシュボード** | APP_MODE=public で push → 公開アプリのダッシュボードからデプロイ | APP_MODE=inhouse で push → カスタムアプリのダッシュボードからデプロイ |
| **CLI（npm スクリプト）** | `npm run deploy:public` | `npm run deploy:inhouse` |
| **CLI（手動）** | appUrl.js で public に変更 → `shopify app config use public` → `shopify app deploy` | appUrl.js で inhouse に変更 → `shopify app config use shopify.app.toml` → `shopify app deploy` |

**どちらのアプリにデプロイするか**と、**appUrl.js の APP_MODE** が一致していれば、パートナーダッシュボードからでも CLI からでも問題ありません。

---

## 4.1 公開アプリとカスタムアプリの両方にデプロイする

同じ内容を**公開アプリ**と**カスタムアプリ**の両方に反映したいときは、次の順で行います。

### バックエンド（Render）

- 公開用・自社用で **別々の Render Web サービス** を使っている場合、どちらも同じリポジトリの同じブランチ（例: `main`）を参照しているなら、**1 回のプッシュで両方の Render が自動デプロイ**されることが多いです。
- 自動デプロイでない場合は、Render ダッシュボードで **公開用のサービス** と **自社用のサービス** の両方で「Deploy」または「Redeploy」を実行してください。
- 各サービスの環境変数はそのまま（公開用は `APP_DISTRIBUTION` 未設定または `public`、自社用は `APP_DISTRIBUTION=inhouse`）で問題ありません。

### Shopify 拡張（POS タイルなど）

CLI で両方にデプロイする場合、**公開用 → 自社用** の順で 2 回実行します。

```bash
cd /Users/develop/ShopifyApps/stock-transfer-pos

# 1. 公開アプリにデプロイ（APP_MODE=public で拡張をビルドし、公開アプリにデプロイ）
npm run deploy:public

# 2. カスタムアプリにデプロイ（APP_MODE=inhouse に切り替え、カスタムアプリにデプロイ）
npm run deploy:inhouse
```

- 実行後、ディスク上の `appUrl.js` は **inhouse** のままになります（最後に実行した `deploy:inhouse` のため）。次に公開だけデプロイするときは `npm run deploy:public` を実行すれば切り替わります。
- どちらも **同じコード** を、それぞれのアプリ用の URL 設定（public / inhouse）でビルドしてデプロイするイメージです。

### パートナーダッシュボードから両方にデプロイする場合

1. `appUrl.js` の `APP_MODE` を **"public"** に変更してコミット・プッシュする。
2. **公開アプリ**のパートナーダッシュボードを開き、デプロイを実行する。
3. `appUrl.js` の `APP_MODE` を **"inhouse"** に変更してコミット・プッシュする。
4. **カスタムアプリ**のパートナーダッシュボードを開き、デプロイを実行する。

※ 2 と 4 で「どちらのアプリのダッシュボードからデプロイするか」を間違えないようにしてください。

---

## 5. カスタムアプリのストアで全機能を解放する（CUSTOM_APP_STORE_IDS）

**同じデプロイ（公開用 URL）**で、特定のストアだけ「カスタムアプリ同様に全機能解放」したい場合は、バックエンドの環境変数 **`CUSTOM_APP_STORE_IDS`** を設定します。

| 項目 | 内容 |
|------|------|
| **設定例** | `CUSTOM_APP_STORE_IDS=my-store.myshopify.com,other.myshopify.com` |
| **形式** | ショップのドメインをカンマ区切りで列挙（スペースはトリムされる） |
| **動作** | ここに含まれるストアでアプリを開いたとき、`APP_DISTRIBUTION` が public でも **inhouse 扱い**になり、在庫情報・仕入・発注・ロス・棚卸・調整がすべて利用可能になる |

**使いどころ**: 公開アプリ用の 1 本のデプロイしか運用していないが、自社ストア（カスタムアプリとしてインストールしたストア）だけ全機能を使いたい場合に、Render 等の環境変数で上記を設定してください。  
カスタムアプリ専用のデプロイで **`APP_DISTRIBUTION=inhouse`** を設定している場合は、`CUSTOM_APP_STORE_IDS` は不要です。

### カスタムアプリなのに機能制限される場合の確認ポイント

| # | 要因 | 確認・対処 |
|---|------|------------|
| 1 | **カスタム用の Web サービスに `APP_DISTRIBUTION` が入っていない** | カスタムアプリの「アプリ URL」で開いている先の Render（など）の **環境変数** に `APP_DISTRIBUTION=inhouse` が設定されているか確認。未設定や typo だと public 扱いになり制限される。値は大文字小文字無視（`inhouse` / `INHOUSE` どちらでも可）。 |
| 2 | **カスタムアプリが公開用の URL を向いている** | パートナーでカスタムアプリの「アプリ URL」が **公開用**（例: pos-stock.onrender.com）になっていないか確認。カスタム用は **カスタム用の URL**（例: stock-transfer-pos.onrender.com）にする。 |
| 3 | **環境変数を変えたあとデプロイしていない** | Render 等で環境変数を追加・変更したら **再デプロイ**（または「Redeploy」）が必要。反映されない場合は再デプロイしてからアプリを開き直す。 |
| 4 | **1 本のデプロイで両方のストアを扱っている場合** | 公開用の 1 本しか使っていないときは、カスタム用ストアのドメイン（`○○.myshopify.com`）を **`CUSTOM_APP_STORE_IDS`** に追加する。そのデプロイの環境変数に設定し、再デプロイする。 |

### 確実な要因の特定（ENABLE_PLAN_DEBUG）

**仮説ではなく、いま動いているサーバーで何が効いているかをその場で確認する**には、そのデプロイ（カスタムアプリが実際に開いている先の Web サービス）の環境変数に **`ENABLE_PLAN_DEBUG=1`** を追加し、再デプロイしてからアプリを開き直してください。

- 管理画面を開くと、画面上部に **「プラン判定の診断」** ボックスが表示されます。
- 表示内容：
  - **shop**: いまのストアのドメイン（例: `ciarabeautiful.myshopify.com`）
  - **APP_DISTRIBUTION**: このサーバーで設定されている値（未設定なら「(未設定)」）
  - **distribution（結果）**: 実際に使われている判定（`inhouse` なら全機能解放、`public` ならプラン制限あり）
  - **CUSTOM_APP_STORE_IDS 件数**: リストに何件入っているか
  - **このストアがリストに含まれる**: はい/いいえ

**確認後は必ず `ENABLE_PLAN_DEBUG` を削除するか 0 にし、再デプロイしてください。**（本番で診断を出しっぱなしにしないため）
