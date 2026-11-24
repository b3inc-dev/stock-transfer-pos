# 取置（Issue #59）— 要件・状態遷移・検証

2026-11-25。Codex。ユーザーの実装依頼で着手。管理画面は UI_RULES v1.1 の共通部品、POS はロス画面を基準とする。

## 初回仕様

自店舗の在庫追跡バリエーションを最大250明細、正の整数で確保する。複数明細は1回の inventoryMoveQuantities で動かす。顧客はPOSカートで選択、ゲストは氏名・電話必須。標準日数は全店共通（初期7日、1〜365）。登録時の店舗現地日付にN日を足した日を期限として固定する。現地日付はサーバーに設定した店舗のIANAタイムゾーンを保存する。日付の変わり目から要対応とする（営業時間マスタがないため開店時の通知はPOS起動時）。期限だけでは解除しない。

不通は要対応のまま、来店予定は未来の次回確認日まで要対応から外す。一覧は自店舗・要対応/取置中/終了、番号・氏名検索、電話マスク。詳細の連絡先は署名済みPOSトークンのショップとsubがRESERVATION_POS_ACCESSで店舗・連絡先参照を許可されている場合のみ表示する。pinned staff の申告を権限判定に使わない。担当の記録は署名済みsub。既存顧客の氏名・電話はShopifyから取得し、DBには顧客IDと取置用の補完電話だけを保存する。ゲスト連絡先は専用DBのみに保存し、終了後に管理画面で匿名化可能。通知・在庫履歴・注文・印刷に氏名/電話を入れない。

レシートの暫定値: 発行しないが既定、対面でのみ選択、お客様控え1枚、固定HTML、店舗・番号・登録日・期限・明細・担当ID。氏名・電話・金額なし。保存と印刷を分離し何度でも再印刷する。2026-07 の新拡張だけ shopify.printing を使う。

## 在庫と状態

`reserving → held → checkout → completing → sold`、`held → cancelling → cancelled`。
Shopifyの結果不明時は同じpending状態で「確認中」、明確な拒否は直前状態へ戻す（登録拒否はfailed）。DBに操作ID・完全な入力・開始時刻を送信前に永続化。同じ操作の再送は同じ @idempotent key と同じ入力。DB version CASで販売と解除を排他。23時間以上たった結果不明操作は自動再送せず、管理者の照合が必要。既存Transfer/apply-change/履歴の冪等性と混同しない。

確保 available→reserved、キャンセル reserved→available。同一店舗の両状態を読んでchangeFromQuantityでCASする。最後の1点の並行確保は片方を拒否。250超を暗黙に分割しない。

会計に入る前に確保を解除しない。空で顧客が一致するカートだけに、取置番号とランダムな会計キー、商品を渡す。空カートへ会計キーを書いてからサーバーの会計状態を確定するため、その応答が失われても同じキーで再開できる。確かな拒否時だけ、同じ空カートのキーを取り除く。サーバー応答待ちでカートが切り替わった場合は顧客・商品を変更する前に停止する。同じ会計キーのカートは数量を照合して不足分だけ補い、別人・別取置のカートは停止。会計中断でもreservedは維持。決済済みPOS注文の店舗・顧客・全対象バリエーション数量・取置番号/会計キー・キャンセル/返品/明細ページ終端をサーバーで照合してからreserved→availableを1回行う。注文の通常減算と合わせて A5/R0/O5→A3/R2/O5→（POS販売）A1/R2/O3→A3/R0/O3。**この順番・棚卸との競合は実機合格必須**。拡張はPOSの在庫不足販売を強制できないため、スタッフが警告を確認する。

会計へ渡した後のキャンセルは初回は安全側に止める。会計キーが付いたカートから何度でも再開できる。カートが消えた場合に新しいカートを自動作成すると未着注文と二重会計になるため止め、注文番号で照合する。会計失敗後に新カートへ戻す操作は、実機で注文不在の確定方法を確認するまで解放しない（初回受入の未完了項目）。

## 配備境界

RESERVATIONS_ENABLED=1 を明示した開発環境だけで新API/管理画面を有効にする。既定では入口も隠す。POS拡張は配備しない限り追加されない。顧客/注文読み取りscope追加の承認と保護顧客データの利用設定が必要。本番DBへmigrationを実行しない。公開プランは既存Pro機能と同じ門番に従う（取置を追加）。権限は任意scopeで申請し、既存の必須scopeを増やさない。

## 検証

自動: 日付/DST、入力、電話マスク、期限/来店予定、注文全数/店舗/決済/返品の不一致、DB CAS、timeout成功後の再送、23h停止、印刷PII除外、カート混入/再開。

開発ストア + POS Lite + POS 11.11以上: 2端末最後の1点、複数明細拒否の原子性、通信断/DB保存失敗、別端末更新、日付跨ぎ/復帰、顧客scopeと権限、通常販売と棚卸/移管、会計中断/決済後再送、mPOP/mC-Print3印字。main merge・本番migration・releaseは人間承認後のみ。

## 公式仕様

- https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/inventoryMoveQuantities
- https://shopify.dev/docs/apps/build/inventory-management-apps/manage-quantities-states
- https://shopify.dev/docs/api/pos-ui-extensions/2026-07/target-apis/contextual-apis/cart-api
- https://shopify.dev/docs/api/pos-ui-extensions/2026-07/target-apis/standard-apis/session-api
- https://shopify.dev/docs/api/pos-ui-extensions/2026-07/target-apis/platform-apis/printing-api

## 開発環境の有効化・権限設定

本番では実行しない。開発用DBへmigrationを適用したあと、次を開発サーバーにだけ設定する。

```dotenv
RESERVATIONS_ENABLED=1
# ショップ → 署名済みトークンsub（ログインユーザー） → 店舗と連絡先参照権限
RESERVATION_POS_ACCESS={"example.myshopify.com":{"123":{"locations":["gid://shopify/Location/456"],"contact":true}}}
# 店舗の現地日付は端末設定に依存させない。IANA名を店舗ごとに固定する。
RESERVATION_LOCATION_TIMEZONES={"example.myshopify.com":{"gid://shopify/Location/456":"Asia/Tokyo"}}
```

上記IDは非secretの例。実トークンを設定・ログへ書かない。権限のないアカウント・店舗はAPIで403となる。連絡先権限は**ログインアカウント単位**であり、POSのPINだけを入れたスタッフ単位の権限ではない。PIN交代で連絡先を分離する運用は未対応。権限を持つログインアカウントを共有しないこと。担当欄は署名済みユーザーと、POSから申告された数値staffMemberIdを併記する（後者は署名済みの本人証明ではない）。

管理画面の「取置」から、ストア管理者が任意scope（read_orders/read_customers）を許可する。公開アプリは保護顧客データ承認後にのみ配備する。既存の必須scopeは変更しない。許可前にPOSで在庫操作を行わない。

顧客データ開示Webhookは専用DBに依頼IDと顧客IDだけを耐久受付する。管理画面に未処理依頼を表示し、通常のブラウザPOSTでJSONをダウンロードする。配送成功を判定できないため、開示依頼は再ダウンロードできるまま残す。顧客データ画面とダウンロードは、機能無効化・Pro解約・ロケーションプラン不一致後も認証済み管理者から利用できる。ストア担当者が本人確認と提供を行う。customers/redactは取置の連絡先・顧客IDを匿名化し、在庫と状態は維持。shop/redactは公開用・未再インストールの従来条件に従って取置・イベント・設定・開示依頼を削除する。

## 残る実機・リリース条件（未合格）

- Shopify CLIのconfig検証・開発ストアでのdev/buildは、接続先アプリ/ストアを人間が確定してから実行する。既存tomlの本番URLを開発で更新しない。
- POS Lite実機の通常注文で、reservedを維持したまま販売した際のavailable/on_handとfulfillmentの反映順を確認する。未履行・返品・店舗違い・数量違いは自動解除しない。
- 会計カートが消失した後の新カート再作成・解除は未対応（注文の遅延反映との区別が必要）。そのまま同じカートを開き直した中断は再開できる。ここを含むIssueの全受入条件はまだ完了ではない。
- PINのみでスタッフを切り替える運用の本人証明/詳細連絡先の権限分離は未対応。署名済みログインアカウントごとのサーバー権限を使う。
- 店舗スタッフによる在庫不足警告の続行・他アプリによるreservedの手動変更は、UIロックやDB CASだけでは禁止できない。現物の取分けと実機検証が必要。

## 品質確認（2026-11-25、ローカル）

- 専用worktreeに `npm ci --ignore-scripts`、Prisma Client生成、Prisma schema validate。DB接続・migration実行なし。
- 対象60テスト成功（在庫・通信断・競合・カート切替・期限・店舗/権限分離・開示/削除・既存の拡張Preactバンドル）。全体は404成功/5失敗/1TODO。失敗はmainにもある在庫Webhook履歴の3件とCLIテストの2件（/varと/private/varのパス差）。mainでは公開scopeテストにも同じパス差の失敗があり、このPRの同テストはrealpathで解消。
- build成功。lintはmainと同じ3167 errors/150 warnings、typecheckはmainと同じ458 diagnostics（パス/位置を正規化して追加0）。新規のアプリ・POSファイルの対象lintは成功。
- Shopify公式検証: Admin GraphQL 2026-01は成功（Customer.phoneの非推奨警告あり）。POSのタイル/モーダル2026-07、管理画面/期限設定/顧客データ画面のUI検証は成功。
- 独立レビューで通信断直後の会計再開・カート混入・入力修正・下書き復元・開示ダウンロード・店舗制限・プラン解約後の開示対応の指摘を修正。最後の同一キー/旧versionでの会計再送修正を再確認済み。実機確認を代替しない。

UI_RULES §15: 共通AdminBlock/BackAction/SaveBar/StateBadge/StatusBanner/ConfirmActionを使用。期限設定は独立編集画面でSaveBarは1つ。表はHistory-table + data-label、数値/期限/IDは共通クラス。POSは標準padding=baseで端を統一。処理中は操作ロック。保存と印刷を分離。ブラウザ・スマホ・POS実機の視覚確認と、2回目の保存/未保存移動/印刷機の操作確認は未実施。
