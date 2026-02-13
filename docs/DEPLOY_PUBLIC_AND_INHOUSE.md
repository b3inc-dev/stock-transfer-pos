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
