# サポートページと FAQ の案 — POS Stock

- サポートページは Shopify 向けの専用ページにする（宣伝のページにしない）【事実: Best practices の Support】。置き場所は T が決める（PR #50 の `/help/stock-transfer-pos/` の利用者ヘルプと同じサイトが自然）。
- **公開する本文の正本は commercor-site の `editorial/app_policies.py`**（b3inc-dev/commercor-site PR #14、T の決定 2026-11-23 1:35「紹介サイトに置く・連絡先はフォームだけ」）。公開の URL: プライバシーポリシー https://commercore.b3-inc.com/apps/stock-transfer-pos/privacy/・サポート https://commercore.b3-inc.com/apps/stock-transfer-pos/support/。この案は根拠として残す。文を変えるときは commercor-site も同じ PR の流れで直す。
- 答えはコードで確かめたことだけ。根拠を `<!-- -->` で書いた（公開するときは消してよい）。

---

## 日本語

```
# POS Stock サポート

お問い合わせ: お問い合わせフォーム https://b3-inc.com/contact（フォームだけ）
受付: 平日 10時〜18時（日本時間）。3 営業日以内にお返事します。日本語と英語のお問い合わせを受け付けます。
お問い合わせのときは、ストアのドメイン（xxx.myshopify.com）と、困っている画面の名前を書いてください。

## はじめかた

1. Shopify 管理画面の「アプリ」から POS Stock を開きます。
2. 「料金プラン」から Shopify のプラン選択ページを開き、プランを選びます。
3. 「設定」でロケーションと表示を確かめます。
4. POS アプリでホーム画面を編集し、POS Stock のタイル（出庫・入庫など）を追加します。

## よくある質問

Q. POS にタイルが出ません。
A. POS のホーム画面の編集で、POS Stock のタイルを追加してください。追加したあとも出ないときは、POS アプリを最新にして、もう一度ログインしてください。

Q. 「料金プランの契約が必要です」と出ます。
A. プランを選ぶ前は、ホームと料金プランの画面だけが使えます。Shopify 管理画面の「アプリ」→「POS Stock」→「料金プラン」でプランを選んでください。無料体験があります。

Q. 「◯◯は Pro プランで使えます」と出ます。
A. Lite で使えるのは、設定・出庫・入庫・入出庫の履歴です。ロス・棚卸・仕入・発注・在庫調整・在庫情報は Pro で使えます。料金プランの画面から変更してください。

Q. 「契約の状態を確認できませんでした」と出ます。
A. Shopify から料金プランの情報を読めなかったときに出ます。通信の状態を確かめて、もう一度お試しください。続くときはお問い合わせください。

Q. 「プランを上げてください」と出ます。
A. 3 ロケーションのプランで、ストアのロケーションが 4 か所以上あるときに出ます。料金プランの画面で、表示された 10 ロケーションのプラン（Lite - 10ロケーション か Pro - 10ロケーション）に変更し、POS で「もう一度確認」を押してください。

Q. ロケーションが 10 か所を超えるとどうなりますか。
A. 10 ロケーションのプランでは、10 か所を超えた分が 1 か所ごとに月 US$4（Lite）／ US$12（Pro）で Shopify の請求に加わります。今の数と金額は、アプリの「料金プラン」の画面で見られます。

Q. 出庫すると Shopify の在庫はどう変わりますか。
A. 出庫は Shopify の在庫移管（Transfer）と出荷（Shipment）として作られます。入庫先で入庫を確定すると、Shopify の在庫に入ります。Shopify 管理画面の「在庫移管」でも同じものが見られます。

Q. 入庫で数が足りないときは。
A. 届いた数だけ読み取って確定してください。予定より少ない分・多い分は記録に残ります。

Q. 履歴を書き出せますか。
A. 管理画面の「入出庫」で絞り込み、CSV で書き出せます。CSV に入れる列は「設定」で選べます。

Q. 通信が切れて確定できたか分からないときは。
A. 同じ操作をもう一度送っても、在庫の調整（ロス・棚卸・入庫など）は 2 回にならない作りです。出庫は、Shopify 管理画面の「在庫移管」で作られているかを先に確かめてから、もう一度確定してください。

Q. アンインストールするとデータはどうなりますか。
A. プライバシーポリシー（https://commercore.b3-inc.com/apps/stock-transfer-pos/privacy/）の「保存する期間と削除」をご覧ください。アンインストールの 48 時間後に、アプリのデータベースからその店舗の記録を削除します。ストアの中（メタフィールド）に保存した設定・記録・毎日の在庫高は、アンインストールのあともストアに残ることがあり、アンインストールのあとはアプリから削除できません。削除を希望するときは、アンインストールの前にご連絡ください。

Q. 対応している言語は。
A. 画面は日本語です。
```

<!--
根拠:
- タイルの追加: 7 つのタイルが pos.home.tile.render（extensions/*/shopify.extension.toml）
- 止めたときの文: extensions/common/planAccess.js の buildPlanBlockMessage・PLAN_PAGE_GUIDE
- 10 か所を超えた分の表示: PR #80 の app/routes/app.plan.tsx（「10 ロケーションを超えた分」）。#80 が main に入るまで、この Q は出さない
- 2 回にならない: InventoryChangeEvent.appEventId（AGENTS.md の表）。出庫の作成にはアプリ側の冪等キーが無い（AGENTS.md「Transfer 作成に使っていない」）ので、出庫は先に確かめるよう書いた
- CSV の列: app/routes/app.history.tsx の HISTORY_CSV_COLUMN_IDS（設定の「入出庫履歴CSV出力項目設定」）
-->

---

## English

```
# POS Stock Support

Contact: our contact form https://b3-inc.com/contact (form only)
Hours: weekdays 10:00-18:00 (Japan time). We reply within 3 business days, in Japanese or English.
Please include your store domain (xxx.myshopify.com) and the name of the screen.
The app screens are in Japanese.

## Getting started

1. Open POS Stock from Apps in Shopify admin.
2. Open "料金プラン" (Plan) and choose a plan on Shopify's plan page.
3. Check locations and display options in "設定" (Settings).
4. In the POS app, edit the home screen and add the POS Stock tiles.

## FAQ

Q. The tiles do not appear on POS.
A. Edit the POS home screen and add the POS Stock tiles. If they still do not appear, update the POS app and sign in again.

Q. It says a plan is required.
A. Before you choose a plan, only the home and plan pages are available. Go to Apps > POS Stock > 料金プラン (Plan) in Shopify admin and choose a plan. A free trial is available.

Q. It says a feature is available on Pro.
A. Lite includes settings, transfers, receiving and transfer history. Losses, stock counts, purchases, orders, adjustments and inventory info need Pro.

Q. It says the plan could not be checked.
A. The app could not read your plan from Shopify. Check your connection and try again. Contact us if it continues.

Q. It asks me to upgrade my plan.
A. This appears on a 3-location plan when your store has 4 or more locations. Change to the 10-location plan shown (Lite - 10 locations or Pro - 10 locations) on the plan page, then tap "もう一度確認" (Check again) on POS.

Q. What happens if I have more than 10 locations?
A. On the 10-location plans, each location over 10 is billed at US$4/month (Lite) or US$12/month (Pro) on your Shopify bill. The plan page in the app shows the current count and amount.

Q. How does a transfer change Shopify inventory?
A. A transfer is created as a Shopify inventory transfer and shipment. When the destination confirms receiving, the stock is added there. You can see the same transfer under Inventory transfers in Shopify admin.

Q. What if fewer items arrive?
A. Scan only what arrived and confirm. The shortage or extra is recorded.

Q. Can I export history?
A. Yes. Filter history in "入出庫" (History) and export CSV. Choose the CSV columns in Settings.

Q. The connection dropped and I am not sure the action went through.
A. Sending an inventory adjustment (loss, count, receiving) again does not apply it twice. For a transfer, first check Inventory transfers in Shopify admin, then confirm again only if it is not there.

Q. What happens to my data when I uninstall?
A. See "Retention and deletion" in our privacy policy (https://commercore.b3-inc.com/apps/stock-transfer-pos/privacy/). We delete the store's records from our database 48 hours after uninstall. Settings, records and daily inventory snapshots saved in your Shopify store (metafields) may stay in the store after uninstall, and the app can no longer delete them then. If you want them deleted, contact us before you uninstall.
```
