# プライバシーポリシーの案 — POS Stock（公開版）

- この案の中身は、`main`（`d00078d`）のコードと PR #80/#82 に合わせた。**コードが変わったら、この文も直す**（特に `prisma/schema.prisma`・`app/utils/compliance-webhook.ts`・`shopify.app.public.toml` の scopes と webhooks）。
- 1 章は「なぜこう書いたか」の根拠（公開しない）。2 章（日本語）と 3 章（English）が公開する本文。
- `{{…}}` は T が入れる【T】。

---

## 1. 根拠（公開しない）

### 1.1 アプリの DB（公開用 Render の PostgreSQL）に入るもの【事実: `prisma/schema.prisma`】

| テーブル | 中身 | 入る時 | 消える時 |
|---|---|---|---|
| `Session` | 店のドメイン、アクセストークン・リフレッシュトークン、スコープ、期限。スタッフの氏名・メールの欄もあるが、このアプリはオフラインのトークンだけを使う（`shopify.app.public.toml` の `direct_api_mode = "offline"`）ので、【推測】ふつうは空 | インストール時 | `app/uninstalled`（`webhooks.app.uninstalled.tsx`）と `shop/redact` |
| `InventoryChangeLog` | 在庫の変動の履歴: 日時、在庫アイテム・バリエーションの ID、SKU、ロケーションの ID と名前、種類（出庫・入庫・ロス・棚卸など）、変動数、変動後の数、元の ID（移管 ID など）、メモ | POS・管理画面の操作、`inventory_levels/update` の webhook | `shop/redact` |
| `InventoryChangeEvent` / `…Line` | 1 回の操作の記録（再送しても 2 回にならないため）と行ごとの結果 | POS・管理画面の操作 | `shop/redact`（明細は一緒に消える） |
| `InventoryCountDocument` / `…Chunk` | 棚卸のデータ（名前・状態・ロケーション・数えた数） | 棚卸 | `shop/redact`（明細は一緒に消える） |
| `OrderPendingLocation` / `RefundPendingLocation` | 注文 ID・返金 ID と商品・ロケーション・数 | **公開版では入らない**: 入れるのは `orders/updated`・`refunds/create` の webhook で、公開用 toml ではコメントアウトしている | `customers/redact`（その注文の行）・`shop/redact` |
| `AppUsageReport`（PR #80 で増える） | 請求期間・プラン・ロケーション数・送った単位・送った結果 | 料金プランの確認のとき（公開用だけ） | **今は消さない**（D15 の残り「shop/redact で消すかは未決」）【T】 |

顧客の氏名・メール・電話・住所、支払いの情報は、どのテーブルにも無い【事実】。

### 1.2 店の Shopify の中（アプリのメタフィールド）に入るもの【事実】

- 設定・ロス・仕入・発注・調整・棚卸の記録・商品グループ・入庫の照合の記録などを、`currentAppInstallation` に付くメタフィールドに JSON で入れる（例: `extensions/stock-transfer-loss/src/screens/loss/lossApi.js` の `ownerId = currentAppInstallation.id`）。
- この記録には、記録の担当者として選んだ・入れた**スタッフ名**が入る（`staffName`。ロス・仕入・発注・調整）。
- 【推測】アプリに付くメタフィールドは、Shopify がアプリのアンインストールで消す。Shopify の説明で確かめてから公開する。

### 1.3 POS の端末に入るもの【事実: AGENTS.md「POS 下書き・UI 状態 → `SHOPIFY.storage` / localStorage」】

- 作りかけの明細（下書き）と画面の状態。

### 1.4 必須 webhook の動き【事実: `app/utils/compliance-webhook.ts`】

| topic | 動き |
|---|---|
| `customers/data_request` | 顧客ごとのデータを持っていないので、渡すものはない（記録だけして 200） |
| `customers/redact` | `orders_to_redact` の注文の行を `OrderPendingLocation`・`RefundPendingLocation` から消す |
| `shop/redact` | アンインストールの 48 時間後に届く。その店の行を `InventoryChangeEvent`・`InventoryCountDocument`・`InventoryChangeLog`・`OrderPendingLocation`・`RefundPendingLocation`・`Session` から消す。48 時間のうちに入れ直した店と、自社用（inhouse）のサーバーでは消さない |

### 1.5 決まっていない・合っていないこと

- `AppUsageReport` を `shop/redact` で消すか（個人情報は無い）【T】。請求の記録として残すなら、本文の「請求の記録」の行のとおりに書く。
- `read_orders` のスコープ（#73 の G4）。公開版では注文のデータを使っていないので、外すなら本文 2.1 の最後の文はそのまま。残すなら「注文は読む権限があるが保存しない」と書き足す【T】。
- サーバーの場所（Render の地域）とログの保存日数【T】。

---

## 2. 本文（日本語）

```
# POS Stock プライバシーポリシー

最終更新日: {{UPDATED_DATE}}

{{COMPANY_NAME}}（以下「当社」）は、Shopify アプリ「POS Stock」（以下「本アプリ」）を提供しています。このポリシーは、本アプリをインストールした店舗（以下「店舗」）のデータを、本アプリがどう扱うかを説明します。

## 1. 集める情報

本アプリは、店舗が本アプリを使うために必要な次の情報だけを、Shopify の API から受け取り、または店舗の操作によって保存します。

- 店舗の情報: ストアのドメイン、Shopify から発行されるアクセストークン
- 在庫の情報: 商品・バリエーション・SKU、ロケーションの名前と ID、在庫数とその変動（出庫・入庫・ロス・棚卸・仕入・発注・在庫調整）、在庫移管と出荷の ID、操作した日時、店舗が入力したメモ
- スタッフの情報: 記録の担当者として店舗が選んだ・入力したスタッフの名前
- 料金の情報: 契約しているプランとロケーション数（使用量の請求のため）

本アプリは、お客様（店舗で買い物をする人）の氏名・メールアドレス・電話番号・住所、支払いの情報を集めません。

## 2. 使う目的

- POS と管理画面で、在庫の移動・入庫・ロス・棚卸などを記録し、表示するため
- 同じ操作が 2 回記録されないようにするため
- 契約しているプランを確かめ、ロケーション数による使用量を Shopify に報告するため
- 不具合を調べ、サポートの問い合わせに答えるため

集めた情報を、広告や、本アプリの提供と関係のない目的には使いません。販売もしません。

## 3. 保存する場所と、渡す先

- 本アプリのサーバーとデータベース（ホスティング: Render。地域: {{SERVER_REGION}}）
- 店舗の Shopify ストアの中（本アプリ用のメタフィールド）
- POS の端末の中（作りかけの明細）

情報を渡すのは、本アプリを動かすための Shopify（API と請求）とホスティングの会社だけです。法令で求められたときを除き、ほかの第三者には渡しません。通信は HTTPS で暗号化しています。

## 4. 保存する期間と削除

- 本アプリをインストールしている間は、在庫の記録を保存します。
- 本アプリをアンインストールすると、すぐにアクセストークンを削除します。
- アンインストールの 48 時間後に Shopify から届く削除の依頼（shop/redact）を受けて、その店舗の在庫の記録をデータベースから削除します。その前にもう一度インストールした場合は削除しません。
- Shopify からお客様のデータの削除の依頼（customers/redact）が届いたときは、その注文につながるデータを削除します。データの開示の依頼（customers/data_request）には、お客様ごとのデータを持っていないことを店舗に答えます。
- {{USAGE_RECORD_RETENTION}}
- サーバーのログは {{LOG_RETENTION_DAYS}} 日で消えます。

店舗は、{{SUPPORT_EMAIL}} に連絡して、アンインストールの前でもデータの削除を求められます。

## 5. 店舗の権利

店舗は、本アプリが保存している自分の店舗のデータについて、確認・訂正・削除を求められます。お客様からの求めは、店舗を通じて、または Shopify の手続き（上の 4 章）で受けます。

## 6. 変更

このポリシーを変えるときは、このページで知らせ、最終更新日を変えます。

## 7. 問い合わせ

{{COMPANY_NAME}}
{{COMPANY_ADDRESS}}
メール: {{SUPPORT_EMAIL}}
```

`{{USAGE_RECORD_RETENTION}}` に入れる文（1.5 で T が決める）:
- 消すなら: 「使用量の報告の記録も、同じときに削除します。」
- 残すなら: 「使用量の報告の記録（プラン・ロケーション数・請求期間。個人の情報は含みません）は、請求の確認のため {{N}} か月保存します。」

---

## 3. Policy text (English)

```
# POS Stock Privacy Policy

Last updated: {{UPDATED_DATE}}

{{COMPANY_NAME}} ("we") provides the Shopify app "POS Stock" (the "App"). This policy explains how the App handles data of the stores that install it ("merchants").

## 1. Information we collect

The App receives from the Shopify API, or saves when a merchant uses it, only the information needed to run the App:

- Store information: the store's myshopify domain and the access token issued by Shopify
- Inventory information: products, variants and SKUs; location names and IDs; inventory quantities and changes (transfers, receiving, losses, stock counts, purchases, orders and adjustments); inventory transfer and shipment IDs; dates and times; notes entered by the merchant
- Staff information: staff names that the merchant selects or enters as the person in charge of a record
- Billing information: the merchant's plan and number of locations (for usage charges)

The App does not collect the names, email addresses, phone numbers or addresses of the merchant's customers, or any payment information.

## 2. How we use it

- To record and show stock transfers, receiving, losses, counts and other inventory changes on POS and in Shopify admin
- To prevent the same action from being recorded twice
- To check the merchant's plan and report location-based usage to Shopify
- To investigate problems and answer support requests

We do not use this information for advertising or for any purpose unrelated to the App, and we do not sell it.

## 3. Where it is stored and who receives it

- The App's servers and database (hosted on Render, region: {{SERVER_REGION}})
- The merchant's Shopify store (metafields owned by the App)
- The POS device (unfinished lists)

We share information only with Shopify (API and billing) and our hosting provider, as needed to run the App, unless the law requires otherwise. All traffic is encrypted with HTTPS.

## 4. Retention and deletion

- We keep inventory records while the App is installed.
- When the App is uninstalled, we delete the access token right away.
- When Shopify sends the shop/redact request 48 hours after uninstall, we delete the store's inventory records from our database. If the App is installed again before that, we do not delete them.
- When Shopify sends a customers/redact request, we delete data linked to the listed orders. For a customers/data_request, we tell the merchant that we hold no data per customer.
- {{USAGE_RECORD_RETENTION_EN}}
- Server logs are deleted after {{LOG_RETENTION_DAYS}} days.

Merchants can ask us to delete their data at any time by writing to {{SUPPORT_EMAIL}}.

## 5. Merchant rights

Merchants can ask us to show, correct or delete the data we hold about their store. Requests from customers are handled through the merchant or through Shopify's process described above.

## 6. Changes

If we change this policy, we will post the new version on this page and update the date above.

## 7. Contact

{{COMPANY_NAME}}
{{COMPANY_ADDRESS}}
Email: {{SUPPORT_EMAIL}}
```

`{{USAGE_RECORD_RETENTION_EN}}`:
- Delete: "Usage report records are deleted at the same time."
- Keep: "Usage report records (plan, number of locations and billing period; no personal data) are kept for {{N}} months to check billing."
