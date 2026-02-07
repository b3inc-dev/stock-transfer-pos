# アプリ URL 設定ガイド

## 概要

POS 拡張がアプリの API（`/api/log-inventory-change` など）を呼ぶ際のベース URL を、**1箇所の設定ファイル**で管理します。

## 設定ファイル

`extensions/common/appUrl.js`

## 使い方

### 1. 公開アプリ用（デフォルト）

`APP_MODE = "public"` のままにしておくと、本番環境では `https://pos-stock-public.onrender.com` が使用されます。

### 2. 自社用カスタムアプリに切り替え

`appUrl.js` の `APP_MODE` を `"inhouse"` に変更：

```js
const APP_MODE = "inhouse"; // "public" から変更
```

これで本番環境では `https://stock-transfer-pos.onrender.com` が使用されます。

### 3. 開発環境（トンネル利用時）

Cloudflare トンネルなどを使う場合、`DEV_APP_URL` をトンネル URL に変更：

```js
const DEV_APP_URL = "https://warranties-studios-artificial-virtually.trycloudflare.com";
```

## 各拡張での使用例

```js
// 動的インポート（必要に応じて）
const { getAppUrl } = await import("../../../common/appUrl.js");

// 開発環境用
const appUrl = getAppUrl(true);

// 本番環境用（本番ビルド時）
const appUrl = getAppUrl();
```

## ビルド時の注意

- **開発ビルド**: `getAppUrl(true)` を使用（`DEV_APP_URL`）
- **本番ビルド**: `getAppUrl()` を使用（`PROD_APP_URL`、`APP_MODE` に応じて自動選択）

本番ビルド時は、各拡張のコードで `getAppUrl(true)` を `getAppUrl()` に変更するか、ビルドスクリプトで置換してください。

## 設定値の確認

現在の設定を確認するには：

```js
import { APP_MODE, PROD_URL, DEV_URL } from "./common/appUrl.js";
console.log(`Mode: ${APP_MODE}, Prod: ${PROD_URL}, Dev: ${DEV_URL}`);
```
