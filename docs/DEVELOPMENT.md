# Codex開発・検証・障害調査手順

運用と承認の正本は [DEPLOY.md](DEPLOY.md)、必読入口は [AGENTS.md](../AGENTS.md)。本書は手順を具体化し、既存業務仕様を変更しない。

## 開始・分離

1. `git fetch origin`、`git status --short --branch`、`git remote -v`、`git worktree list` で最新baseと未commit差分を確認する。GitHub open PR/Issue・履歴でowner/範囲/依存を確認する。
2. 同じCodex workstreamのbranch/worktree/PRがあれば再利用する。新規ならorigin/mainから作成する（名前とpathは依頼ごとに変える）:

   ```bash
   git worktree add -b codex/<topic> <isolated-path> origin/main
   ```

3. 共有mainや他tool所有checkoutを編集せず、dirty変更をstash/破棄/移動しない。分離できなければ制約を報告する。他tool所有の重複scopeには停止・handoffが必要。
4. AGENTS/PROJECT_CONTEXT/ARCHITECTURE/BUSINESS_RULES/STATE_MACHINE/SHOPIFY/DECISIONSを読み、依頼範囲とBacklogを区別する。PRへowner/base/HEAD/scopeを保存する。

## 実装前の在庫トレース

入口UI/API → SKU/barcode/variant解決 → inventoryItem → origin/destination/location → quantity/delta → activation → mutation → event/履歴/下書き保存の順に追跡する。Transfer作成、数量apply-change、履歴upsertを区別する。状態図とコードが異なる場合はコード・Git履歴で判断し、事実/仮説/変更案を分ける。

同じ操作IDでpayloadが変わる場合、二端末、連打、通信retry、timeout後の成功不明、250境界の途中失敗、Shopify成功後DB/ログ失敗を設計とテストケースに含める。成功済み操作を再実行してよいとは推測しない。

## 依存と安全な品質確認

package.json enginesとpackage-lock.jsonを確認する。専用worktreeで依存が必要なら、install lifecycle scriptsと環境を確認して `npm ci` する。本番.env/credentialsはコピーしない。既存node_modulesを再利用した場合はクリーンinstall未検証と記録する。品質確認にDB接続やmigrationは不要。

```bash
npm test
npm run lint
npm run typecheck
npm run build
npx --no-install eslint tests/inventory-safety.test.mjs
git diff --check
```

testは組み込みNode runner、既存helperのfetch/token/timerをmockする。9ケースの対象と限界は [CODEX_INVENTORY_AUDIT.md](CODEX_INVENTORY_AUDIT.md)。全体lintは既定の探索対象にmjsを含まないので、新規mjsは明示lintする。テストを追加するときは実通信へのfallbackを作らず、グローバルmockをfinallyで復元し、並列共有を避ける。

既存lint/typecheck失敗を隠さず、同じNode/依存でbaseと診断を比較して新規失敗を識別する。build成功のみで品質gate完了としない。2026-10-04 baselineはlint 3,093 errors/157 warnings、typecheck 452 error行。baseline改善は [BACKLOG.md](BACKLOG.md) の別課題。

`npm run dev`/`setup`/`docker-start`、Shopify CLI、migrationはこのmock手順に含まれない。dev store/DB/URLの隔離が未確認なら実アプリ起動を行わず、必要な接続情報の不足だけ報告する。PR #3のpreview scriptsは本branch未導入であり、存在する前提で実行しない。

## timeout・部分成功時のread-only調査

1. 再確定・数量リセット・自動再送を止める。対象shop、location、SKU/item、数量、操作時刻、操作ID、Transfer/Shipment ID、エラーと成功済み応答を収集する。secretやtokenは記録しない。
2. 既存の認証済みread-only経路でShopify Transfer/Shipmentの状態とDBイベント/履歴を照合する。取得権限や安全な接続がない場合は推測で埋めない。inventorySet/Adjust、activate、Shipment受領は照合操作ではない。
3. 結果を「確認済み成功」「確認済み失敗」「成功不明」に分け、成功したchunk/数量を記録する。現数だけで操作の成功を断定しない（売上等が並行して変動する）。
4. 作成の永続再開位置は未実装。ログ欠落だけでTransfer未作成と判断しない。pending/applyingを直接書き換えず、再開・補償案と影響をPR/Issueへ残す。
5. 本番在庫変更・キャンセル/削除・補償・rollback等が必要なら、対象と数量と差分を具体化して依頼元の明示承認まで停止する。本書は本番回復操作の包括許可ではない。

## レビュー・PR・リリース

変更scope/状態遷移/冪等性/secret漏洩を自己レビューし、別Codex agentが独立read-onlyレビューする。必要修正後に関連検証を再実行し、変更ファイルだけをstageしてfeature branchへcommit/push、同じworkstreamなら既存PRを更新する。

PR本文には在庫変更ロジックへの影響・二重実行防止・retry・timeout・partial failure・テスト結果/未検証・本番反映注意点とowner/base/HEAD/未完了を含める。既存失敗が残る場合はPRへ明示する。main merge（Render自動反映）、production deploy、Shopify本番設定、secret変更、不可逆操作は明示承認まで停止。リリース案は対象app/backend、commit、必要なmigration、検証・回復案を提示して初めて承認対象になる。

## ユーザーの指示例

「出庫のtimeout後に二重作成されないよう修正し、mock検証とPR作成まで進めて」「INV-03を調査して修正して」「このPRの指摘を修正して」でよい。期待する動作、再現手順、対象画面やlocation条件があれば添える。branch作成や通常の確認先を毎回指定する必要はない。本番反映は開発依頼から切り離して、対象操作を明示して承認する。
