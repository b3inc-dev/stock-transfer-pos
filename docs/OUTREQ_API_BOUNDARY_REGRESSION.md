# 出庫依頼 POS API transport境界の回帰

対象候補：`47b975c048ea806ee27ccac7e4217c94b8dc8203`（`codex/outbound-requests`）、main基点：`b7929da012c3527a47d9a0be95c84600476233ab`。
既存独立レビューは [#79 comment7179590757](https://github.com/b3inc-dev/stock-transfer-pos/issues/79#issuecomment-7179590757)。本変更はその同一SHAのUIレビューを再実施するものではなく、未収録のPOS API transportの安全境界を実行できる回帰にします。

```sh
node --test tests/outbound-request-api-boundary.test.mjs
```

Nodeの標準ライブラリのみ。候補の`api.js`と`appUrl.js`をそのままimportし、`shopify`、`fetch`、timerを各testで置き換えて復元します。実ネットワーク、DB、実ストア、在庫を操作しません。テストは同一プロセス内で直列実行してください。

| 確認点 | 期待結果 |
| --- | --- |
| 不正Location／出庫元とPOS店舗が不一致 | token取得前・通信前に拒否 |
| tokenなし | timer作成前・通信前に拒否 |
| 呼出元がlocationIdを偽装 | 実際のPOS店舗IDで上書き。署名token付きPOSTを1回 |
| preview／begin／save と他操作 | 90秒／25秒。成功・失敗のすべてでtimer解放 |
| timeout／通信断 | 自動再送しない。同じ依頼を再照合する案内 |
| 401／404／409／ok=false／不正JSON | 成功扱いにせず拒否、自動再送しない |
| 想定外error | 元errorを保持しtimerを解放、自動再送しない |

結果：19 pass / 0 fail / 0 skipped。Node v24.22.3。さらに一時コピーで出庫元guard削除、location上書き逆転、abort無効化、timer解放削除を各1件ずつ導入し、4/4の変異をテストが検出しました。元ファイルを復元後、Git blob SHAが候補と一致することを確認しました。変異コードはPRに含めません。機械可読の記録は [outreq-api-boundary-20261126.json](outreq-api-boundary-20261126.json)。

## 実ストア通し確認の未完ゲート

この回帰は候補URLへの送信をmockするため、候補がStagingを向いている証明にはなりません。`api.js`は`getAppUrl()`の既定URLを利用する状態を維持しています。POS-OUTREQ-ENV-001の解除には、既存のStaging設定・ログインを持つ担当が次を証拠付きで受領する必要があります。

1. 対象dev store、customアプリID／インストール、隔離したAPI URL、backend live SHA、POS拡張versionと候補SHAの対応を照合。Ciaraや公開の本番URLへ接続しない。
2. 検証DBのmigration／feature flag有効化は既存の承認範囲を確認し、必要な承認を得て実施。本PRをmainへ直接反映しない。
3. 許可された合成SKU1件・異なる有効Location2件について、出庫前の在庫・移管なしを記録。
4. 管理で2点の依頼→出庫元POSで検品／確定1回→Transfer／Shipment各1回、移動先POSの既存入庫のみへ表示を確認。
5. 移動先で2点受入→残数0、在庫・状態・履歴1回分を確認。通信切断時は同じ依頼を再照合し、新規出庫を作り直さない。
6. 差異受領1点受入／1点拒否はUI-POS-OUTREQ-001の既報不一致を合格にしない。UI001〜003は個別承認後の修正・再検証を待つ。
7. PC／iPhone管理、iPhone／iPad縦横POS、キーボード・スクロール末尾・タブ往復・保存再表示・エラー再試行、58／80mm実プリンタを実機で確認。

上記は受入手順であり実施済みではありません。Ciara-system連携は単体テストの前提にしませんが、既存の実データ・本番・配布の承認条件は維持します。独立レビュー、CI、全回帰、実機・ストア受入、migration、統合、Render／Shopify配布は本変更では未完です。
