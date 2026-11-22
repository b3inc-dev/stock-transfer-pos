# App Store 提出の材料 — POS Stock（公開版）

- 作った日: 2026-11-22（`main` = `d00078d` と、開いている PR #80・#82 のコードを見て書いた）
- 提出のチェック表（何が済んでいて何が残っているか）は PR #73 の `docs/APP_STORE_SUBMISSION.md`。この folder は「入力欄にそのまま貼る文」と「T が押すボタンの順番」をまとめたもの。
- docs だけ。アプリのコード・設定・本番・Partner の画面は何も変えていない。

## ファイル

| ファイル | 中身 | 貼る場所 |
|---|---|---|
| [ja.md](ja.md) | 日本語のリスティング文（名前・サブタイトル・紹介文・詳細・良いところ・機能・料金） | Partner Dashboard → アプリ → Distribution → App Store listing（日本語） |
| [en.md](en.md) | 英語のリスティング文（同じ項目） | 同じ（English） |
| [screenshots.md](screenshots.md) | スクリーンショットの撮影リスト（どの画面・どの状態・大きさ・代替テキスト） | 同じ（Screenshots） |
| [screencast.md](screencast.md) | 審査用の画面録画の台本（英語字幕つき） | 提出フォームの Screencast URL |
| [privacy-policy.md](privacy-policy.md) | プライバシーポリシーの案（日本語・英語） | 会社サイトなどに置き、その URL をリスティングに入れる |
| [support-faq.md](support-faq.md) | サポートページと FAQ の案（日本語・英語） | サポートページ。URL をリスティングに入れる |
| [partner-dashboard-steps.md](partner-dashboard-steps.md) | Partner Dashboard（料金プラン・メーター・Partner API client）と公開用 Render の環境変数の手順 | T が上から順に押す |

## 印の意味（どのファイルも同じ）

| 印 | 意味 |
|---|---|
| 【事実】 | コード・設定・shopify.dev で確かめた。根拠のファイルか URL を書いている |
| 【推測】 | 確かめていない。理由を書いている |
| 【T】 | T が決める・入れる値。決まるまでは `{{…}}` のままにしている |

## T が決めること（これが決まれば、残りは貼るだけ）

| # | 決めること | 今の案 | 使うファイル |
|---|---|---|---|
| 1 | ~~4 つのプランの月額と無料体験の日数~~ **決まり（2026-11-22 T）** | Lite 3 か所 $20・Lite 10 か所 $40・Pro 3 か所 $60・Pro 10 か所 $120、無料体験 Lite 7 日・Pro 14 日（DECISIONS D17）。3 か所のプランで多すぎる店は POS でも止める（#91） | ja.md / en.md / partner-dashboard-steps.md |
| 2 | サポートのメールアドレスと、サポートページ・プライバシーポリシーを置く URL | **決まり（T 2026-11-23 1:35）**: サポート https://commercore.b3-inc.com/apps/stock-transfer-pos/support/・プライバシーポリシー https://commercore.b3-inc.com/apps/stock-transfer-pos/privacy/（commercor-site PR #14）。問い合わせはフォーム https://b3-inc.com/contact だけ（メールは載せない） | privacy-policy.md / support-faq.md |
| 3 | 会社名・住所の表記（プライバシーポリシーの「運営者」） | **決まり（T 2026-11-22 22:15）**: 株式会社B3・東京都目黒区青葉台1-15-3 AK-4ビル2F | privacy-policy.md |
| 4 | ~~`read_orders` を外すか（#73 の G4）~~ **決まり（2026-11-22 T）** | 公開用の toml から外した（自社用はそのまま。DECISIONS D18）。保護された顧客データの申請はしない。公開版の在庫の履歴は売上・返品に分けない | privacy-policy.md の 2 章（2.1 の最後の文はそのまま） |
| 5 | 英語のリスティングを出すか | 画面は日本語だけ。出すなら対応言語は「日本語」のまま | en.md |
