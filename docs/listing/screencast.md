# 審査用の画面録画の台本 — POS Stock

## 決まり【事実: App Store requirements 4.5.3 https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements】

- 初期設定から主な機能まで、順に見せる。
- **英語の音声か英語の字幕が必須**。画面が日本語なので、英語字幕を付ける（下の Subtitle をそのまま使う）。
- 長さの決まりは書かれていない。ここでは 4〜5 分にした（POS と管理画面の両方を見せるため）。
- 録るのは開発ストア（Ciara ではない店）。本物の店名・スタッフ名・メールを写さない。

## 準備

- screenshots.md の「撮る前の準備」と同じデータ。ただし**アプリは入れていない状態**から始める（インストールの流れを見せるため）。
- POS は iPad（または iPhone）の画面録画。管理画面はパソコンの画面録画。あとで 1 本につなぐ。
- 審査員用のログイン（二段階認証なし）は提出フォームの「テスト手順」に書く（4.5.4・4.5.5）。

## 台本

| # | 時間の目安 | 画面と操作 | Subtitle (English) |
|---|---|---|---|
| 1 | 0:00–0:30 | App Store のページか、Partner のインストール用リンクからインストール → 許可の画面 → 「インストール」 | Install POS Stock from the Shopify App Store and approve the permissions. |
| 2 | 0:30–1:00 | アプリのホームが開く → 「料金プラン」→ Shopify のプラン選択ページで Pro を選ぶ → アプリに戻る | After install, the app home opens. Choose a plan on Shopify's plan page. Development stores are not charged. |
| 3 | 1:00–1:30 | 「設定」でロケーションと表示を確かめる → 保存 | In Settings, check the locations and how lists are shown on POS. |
| 4 | 1:30–2:00 | POS → ホーム画面の編集 → POS Stock のタイルを足す | On POS, add the POS Stock tiles to the home screen. |
| 5 | 2:00–2:45 | 「出庫」→ 出庫元・入庫先を選ぶ → バーコードを 3 つ読む → 確定 | Create a transfer: pick the origin and destination, scan items, and confirm. The app creates a Shopify inventory transfer and shipment. |
| 6 | 2:45–3:30 | 入庫先の POS →「入庫」→ さっきの出庫を選ぶ → 1 品だけ少なく読む → 確定 | At the receiving store, open the transfer, scan what arrived, and confirm. Any shortage is recorded. |
| 7 | 3:30–4:00 | 「ロス」か「棚卸」を 1 件（Pro） | On Pro, record losses and stock counts from their own tiles. |
| 8 | 4:00–4:30 | 管理画面 →「入出庫」→ 今の 2 件を絞り込む → CSV を書き出す | In admin, filter the history and export it to CSV. |
| 9 | 4:30–4:50 | 「在庫情報」→ 在庫変動履歴 | See every stock change by location in Inventory info. |
| 10 | 4:50–5:00 | 終わり | That's POS Stock. |

## テスト手順（提出フォームに貼る英語。`{{…}}` は T が入れる）

```
1. Install the app on the test store {{TEST_STORE_DOMAIN}}. Staff login: {{TEST_LOGIN_EMAIL}} / {{TEST_LOGIN_PASSWORD}} (no two-step authentication).
2. Open the app in Shopify admin and choose any plan on the Shopify plan page (development stores are not charged).
3. In Shopify POS, sign in with the same store and add the POS Stock tiles to the home screen.
4. Outbound: tap "出庫 / 在庫処理" (Transfer), choose an origin and a destination, add items by scan or search, and confirm.
5. Inbound: on the destination location, tap "入庫 / 在庫処理" (Receive), open the transfer, and confirm.
6. In admin, open "入出庫" (History) to see both records and export CSV.
The app UI is in Japanese. The screencast has English subtitles.
```
