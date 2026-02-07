# 在庫変動履歴：開発ストアでのアクティビティ振り分け検証ガイド

**作成日**: 2026年2月7日  
**対象**: 開発ストアで売上・返品・POSアプリ処理がすべて「管理」になってしまう問題の整理と、振り分け実装の確認方法

---

## 1. なぜ開発ストアだと「管理」ばかりになるか

在庫変動の**種別（アクティビティ）**は、次の3系統で記録されています。

| 種別 | 記録元 | 条件 |
|------|--------|------|
| **売上** (order_sales) | Webhook `orders/updated` | 注文の履行（fulfillment）が発生したとき |
| **返品** (refund) | Webhook `refunds/create` | 返品で在庫に戻すとき |
| **ロス・仕入・入出庫・棚卸** 等 | POS からの **api/log-inventory-change** | 各アプリが確定処理のあとで API を呼ぶとき |
| **管理** (admin_webhook) | Webhook `inventory_levels/update` | 上記のいずれでも「既に記録済み」と判定できなかったとき |

開発ストアで「全部『管理』になる」主な要因は次の2つです。

### 1.1 Webhook の URL が開発サーバーに届いていない

- Webhook の送信先は、**アプリの「アプリ URL」**（`application_url`）＋ パス（例: `/webhooks/orders/updated`）です。
- `shopify app dev` では **トンネル URL** がアプリ URLとして使われます（`automatically_update_urls_on_dev = true` のとき）。
- トンネル URL が変わると（ngrok の再起動・無料枠の切替など）、**Shopify 側に登録されている Webhook の URL は古いまま**になることがあります。
- その結果、**orders/updated・refunds/create・inventory_levels/update が開発サーバーに届かず**、売上・返品は記録されず、在庫変動は「別経路」だけになります。

### 1.2 POS 拡張が「開発サーバー」ではなく本番 URL を呼んでいる

- POS 拡張は **`getAppUrl()`** でベース URL を決め、`${appUrl}/api/log-inventory-change` を呼びます。
- 現在の実装では **`getAppUrl()` は本番 URL（PROD_APP_URL）を返し**、`getAppUrl(true)` でない限り開発 URL は使いません。
- 開発ストアで POS を動かしているとき、**api/log-inventory-change が本番サーバーに飛ぶ**と、  
  - 開発ストアのセッションが本番に無ければ 401 等で失敗する  
  - 本番 DB にだけログが書き込まれ、開発環境の「在庫変動履歴」には出てこない  
- そのうえ、開発側に届くのは **inventory_levels/update** だけ（かつトンネルが有効なとき）で、この Webhook は「既に誰かが記録していない」場合に **admin_webhook（管理）** として保存するため、**結果として「管理」ばかり**になります。

まとめると、

- **売上・返品** → Webhook が開発サーバーに届いていない → 記録されない or 別環境に記録される  
- **POS の処理** → api が本番 URL に飛んでいる → 開発 DB に残らない  
- **在庫変動** → inventory_levels/update だけ届く → 「既存の正しい種別」がないので **「管理」で保存される**

という流れで、開発ストアでは「管理」ばかりになります。

---

## 2. 開発環境でもアクティビティ振り分けを確認する方法

### 2.1 Webhook を開発サーバーに届ける

1. **トンネル URL を固定する（推奨）**  
   - 有料の ngrok などで固定ドメインを使う  
   - または Cloudflare Tunnel などで同じ URL を使い続ける  
   - `shopify.app.toml` の `application_url` がその URL になるようにし、`shopify app dev` で一度起動して Webhook を登録し直す  

2. **トンネルを起動し直したら、アプリの URL を更新する**  
   - `shopify app dev` を再実行すると、多くの場合は新しいトンネル URL がアプリに設定される  
   - ダッシュボードで「アプリの URL」が今のトンネルと一致しているか確認する  
   - 必要なら「アプリをインストールし直す」か「設定で URL を更新」して、Webhook が新しい URL に向くようにする  

3. **Webhook が届いているかログで確認する**  
   - `webhooks.orders.updated` / `webhooks.refunds.create` / `webhooks.inventory_levels.update` の先頭にある  
     `console.log('[orders/updated] ...')` 等が、開発サーバーのターミナルに出力されるか確認する  
   - 届いていれば「売上」「返品」はそれぞれ order_sales / refund で記録される  

### 2.2 POS から開発サーバーの api を叩く

1. **開発時だけ DEV_APP_URL をトンネル URL にする**  
   - `extensions/common/appUrl.js` の **`DEV_APP_URL`** を、いま使っているトンネル URL に変更する  
     - 例: `const DEV_APP_URL = "https://xxxx.ngrok-free.app";`  

2. **POS 拡張で開発時は getAppUrl(true) を使う**  
   - 現在は多くの箇所で `getAppUrl()` のみを使っているため、本番 URL が使われます  
   - 開発ビルド時だけ `getAppUrl(true)` を呼ぶようにすると、`DEV_APP_URL`（上記で設定したトンネル URL）が使われ、**api/log-inventory-change が開発サーバーに届きます**  
   - 例: 環境変数やビルドフラグで「開発」のときだけ `getAppUrl(true)` に切り替える  

3. **動作確認**  
   - 開発ストアで POS からロス・仕入・入出庫・棚卸のいずれかを実行する  
   - 開発サーバーのログに `[api/log-inventory-change]` の出力が出るか確認する  
   - 管理画面の在庫変動履歴で、該当処理が「管理」ではなく「ロス」「仕入」「入出庫」「棚卸」などになっているか確認する  

### 2.3 振り分けロジックだけを確認する（Webhook なし）

- **api/log-inventory-change** は、正しい `activity` を渡せばそのまま DB に保存されます  
- 開発サーバーで **curl や Postman** から、  
  - 認証ヘッダー（セッショントークンなど）を付けて  
  - `POST /api/log-inventory-change` に `activity: "order_sales"` や `"refund"`, `"loss_entry"` などを含めて送る  
- 在庫変動履歴画面で、保存されたレコードの「アクティビティ」が渡した値どおりになっているか確認すれば、**振り分けの「保存部分」**は問題ないと判断できます  

---

## 3. 現在のコードでアクティビティ振り分けが正しく動いているかの確認

### 3.1 設計の整理

- **売上**: `orders/updated` が履行を検知し、`logInventoryChange(..., activity: "order_sales")` で保存している。  
- **返品**: `refunds/create` が返品行を検知し、`logInventoryChange(..., activity: "refund")` で保存している。  
- **POS**: 各拡張（ロス・仕入・入出庫・棚卸など）が確定処理後に `POST /api/log-inventory-change` を呼び、`activity` に loss_entry / purchase_entry / inbound_transfer / outbound_transfer / inventory_count などを渡している。  
- **inventory_levels/update**:  
  - 同じ変動がすでに「売上・返品・ロス・仕入・入出庫・棚卸」のいずれかで記録されていれば、**保存しない**（二重の「管理」を防ぐ）。  
  - 誰にも記録されていなければ、**admin_webhook（管理）** として保存する。  

この設計どおりに実装されていれば、**本番のように「Webhook が届く」「POS が本番 URL を叩く」環境では、振り分けは正しく動きます。**

### 3.2 コード上の確認ポイント

| 確認項目 | ファイル | 内容 |
|----------|----------|------|
| 売上で order_sales を保存しているか | `webhooks.orders.updated.tsx` | 履行ごとに `logInventoryChange(..., activity: "order_sales")` を呼んでいるか |
| 返品で refund を保存しているか | `webhooks.refunds.create.tsx` | 返品行ごとに `logInventoryChange(..., activity: "refund")` を呼んでいるか |
| POS が activity を渡しているか | 各拡張（loss / purchase / inbound / outbound / stocktake 等） | 確定後に `POST /api/log-inventory-change` に `activity` を渡しているか |
| api が activity をそのまま保存しているか | `api.log-inventory-change.tsx` | 受信した `activity` で DB に保存（または既存 admin_webhook を上書き）しているか |
| inventory_levels/update で二重「管理」を防いでいるか | `webhooks.inventory_levels.update.tsx` | `knownActivities` に order_sales, refund, loss_entry 等を含め、既存ログがあれば保存スキップしているか |

これらが満たされていれば、**「振り分けの実装」は問題ありません。**  
開発ストアで「全部『管理』になる」のは、主に **Webhook の送信先 URL** と **POS が叩く api の URL（getAppUrl）** の環境差によるものです。

### 3.3 開発環境で「振り分けができているか」を一言で確認するには

1. **Webhook が開発サーバーに届くようにする**（トンネル固定 or URL 更新）  
2. **POS から開発サーバーに api を叩かせる**（`DEV_APP_URL` をトンネルにし、必要なら `getAppUrl(true)` を開発時だけ使用）  
3. 開発ストアで **売上・返品・POS のいずれかを1件ずつ**発生させ、在庫変動履歴で「売上」「返品」「ロス」等、期待どおりのラベルが出るか見る  

これで「開発環境でもアクティビティ振り分けができているか」を確認できます。

---

## 4. まとめ

- **開発ストアで全て「管理」になる主因**  
  - Webhook の URL が開発サーバー（現トンネル）と一致していない  
  - POS が本番 URL の api を叩いており、開発側 DB にログが残っていない  

- **振り分けの実装**  
  - 売上 → orders/updated、返品 → refunds/create、POS → api/log-inventory-change、それ以外 → inventory_levels/update で「管理」またはスキップ、という設計はコード上満たされています。  

- **開発環境で確認するには**  
  - Webhook が届くように URL を揃える  
  - 開発時は `DEV_APP_URL` をトンネルにし、必要なら `getAppUrl(true)` で api を開発サーバー向けにする  
  - 上記のうえで、売上・返品・POS を少しずつ試して在庫変動履歴の表示を確認する  

必要なら、`getAppUrl(true)` を開発ビルド時だけ使う切り替え方法（環境変数やビルドフラグ）も別ドキュメントで整理できます。

---

## 5. 開発ストアで「今」ステータス振り分けができているか確認する手順（推奨）

**前提**: アプリのURLを本番（Render）に切り替え済み（`shopify app deploy` 済み）。開発ストアからアプリを開くと **本番URL**（例: https://stock-transfer-pos.onrender.com）で開く状態。

この状態なら、Webhook も POS の API も本番サーバーに向くため、**開発ストアで振り分けが正しく動いているか**をそのまま確認できます。

### 5.1 確認の流れ

1. **開発ストアでアプリを開く**（本番URLで開いていることを確認）
2. **在庫変動を起こす操作**を、種類ごとに1件ずつ行う（下表）
3. **管理画面 → 在庫情報 → タブ「在庫変動履歴」** を開く
4. **期間**で今日を含む範囲を指定し、**アクティビティ種別**で該当を選んで、それぞれの操作が**期待どおりのラベル**で出ているか確認する

### 5.2 操作と確認したい表示（一覧）

| やりたい確認 | 開発ストアでの操作 | 在庫変動履歴で見るラベル |
|--------------|--------------------|---------------------------|
| 売上 | 注文を作成 → **履行（Fulfill）** する | **売上** |
| 返品 | 注文の返品を作成し、**在庫に戻す**（Restock） | **返品** |
| ロス | POS「ロス」タイルで商品を追加 → **確定** | **ロス** |
| 仕入 | POS「仕入」タイルで商品を追加 → **確定** | **仕入** |
| 入庫 | POS「入庫」タイルで入庫処理を **確定** | **入庫** |
| 出庫 | POS「出庫」タイルで出庫処理を **確定** | **出庫** |
| 棚卸 | POS「棚卸」タイルで棚卸を **完了** | **棚卸** |
| 管理 | 管理画面の「商品」→ 在庫数量を**手動で変更** | **管理** |

### 5.3 確認のポイント

- **売上**: テスト注文で「履行」まで行う（部分履行でも可）。履歴に **「売上」** が 1 件以上出ればOK。
- **返品**: 返品作成時に「在庫に戻す」を選ぶ。履歴に **「返品」** が 1 件以上出ればOK。
- **POS 系（ロス・仕入・入庫・出庫・棚卸）**: 各タイルで**確定（または完了）**まで実行。履歴にそれぞれ **ロス・仕入・入庫・出庫・棚卸** と出ればOK。
- **管理**: 商品編集画面で在庫数を変更して保存。履歴に **「管理」** が出ればOK。

### 5.4 うまくいかないとき

- **全部「管理」になる**  
  → アプリがまだトンネルURLのままの可能性があります。`shopify app deploy` を実行して本番URLに切り替え、開発ストアからアプリを開き直してください（`docs/DEV_TO_PRODUCTION_SWITCH.md` 参照）。
- **売上・返品だけ「管理」**  
  → Webhook（orders/updated, refunds/create）が本番サーバーに届いていない可能性。パートナーダッシュボードで Webhook の送信先URLが本番と一致しているか確認してください。
- **POS の処理だけ「管理」**  
  → POS が本番の `/api/log-inventory-change` を叩けていない可能性。POS 拡張の `getAppUrl()` が本番URLを返しているか、ネットワーク・CORS のエラーがないか確認してください。

---

## 6. 開発用：DEV_APP_URL をトンネルにする手順（POS を開発サーバー向けにする）

1. `shopify app dev` で開発サーバーを起動し、表示された **トンネル URL**（例: `https://xxxx.ngrok-free.app`）をコピーする。
2. **`extensions/common/appUrl.js`** を開き、`DEV_APP_URL` をそのトンネル URL に変更する。
   ```js
   const DEV_APP_URL = "https://xxxx.ngrok-free.app";  // 実際のトンネル URL に置き換え
   ```
3. POS 拡張で開発時に `getAppUrl(true)` を使うようにする（現在は `getAppUrl()` のみのため本番 URL が使われている）。  
   開発時だけ切り替える例：
   ```js
   // 開発時は true を渡す（DEV_APP_URL を使う）。本番ビルドでは false または省略。
   const isDev = typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
   const appUrl = getAppUrl(!!isDev);
   ```
   ※ POS 拡張はブラウザ/シミュレータで動くため、上記の `process.env` はビルド時に埋め込む必要があります。簡単な方法は、開発時だけ `getAppUrl(true)` に書き換えてビルドし、本番デプロイ前に `getAppUrl()` に戻すことです。
4. トンネル URL が変わったら、手順 1〜2 をやり直し、必要に応じて拡張を再ビルドする。
