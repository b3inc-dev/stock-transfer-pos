# Codex継続開発のための在庫処理監査

2026-10-04、GitHub main `3e4aeb9c4c81f63fefdb58310452e7e9b667bd78` を対象にコード・docs・履歴を調査。運用の正本は [DEPLOY.md](DEPLOY.md)、状態遷移の正本は [STATE_MACHINE.md](STATE_MACHINE.md)。本書は調査時点の記録であり、安全性修正を実装したものではない。

## 現状構成とGitHub

React Router/React/TypeScriptの埋め込みAdminアプリ、POS Extension 7種（出庫・入庫・ロス・調整・棚卸・発注・仕入）、Prisma/PostgreSQL。Transfer/Shipmentの正はShopify、イベント・履歴はDB、POS下書きはstorage/localStorage。各ExtensionとApp設定はAPI 2026-01。GAS、在庫移管の永続job queue、mainのGitHub Actionsは存在しない。Render Cronは日次スナップショットで、移管再開jobではない。

初期設定PR #2はmainへmerge済み。調査時のopen PR #3はCursor所有のpreview workflow（`cursor/pr-preview-workflow-2c86`）。引き継ぎなしに編集しない。本workstreamはCodex所有の独立branch。#3とpackage.json/docs/DEPLOY.mdにファイル重複があるため、merge時にscriptsと運用指示の両方を保持する。本PRからmain mergeは行わない。

## location / SKU / inventoryItem / quantity

Shopify更新のキーはinventoryItem GIDとlocation GID。SKU/barcodeからvariant/inventoryItemを解決し、SKUはログ等の補助情報として送る。出庫はorigin→destinationの2点でactivate/InventoryLevel待ちを行う。locations取得は一部first:250のみでpaginationがない。ModalOutboundのmanual/session origin優先順位は画面間で異なるため、変更時に実際の確定経路まで追跡する。

| 入口 | Shopify更新までの経路 | 数量と安全性 |
|---|---|---|
| `extensions/stock-transfer-tile/src/ModalOutbound.jsx` | 確定ロック→明細解決→origin/destination activate・level待ち→Transfer作成→Shipment作成/mark→履歴API | qtyを非負数として送信。250超は複数Transfer。キーや永続chunkチェックポイントなし |
| `extensions/stock-transfer-inbound/` | alreadyAcceptedとの差分→Shipment受領。超過/予期しない商品等はcommon apply-change | 差分受領と安定appEventIdを利用。ただし複数端末の古い状態を排他する保証はない |
| ロス/仕入/調整POS | common applyInventoryChange→`api.inventory.apply-change.tsx`→`inventory-set-quantities-server.ts`→inventorySetQuantities | ロスは負delta、仕入は正delta、調整は実数。deltaは現数から絶対値へ変換。操作IDの生成時点に注意 |
| Admin仕入 `app/routes/app.purchase.tsx` | pending読取→inventoryAdjustQuantities→metafield状態更新 | mutation成功後の状態保存失敗/同時要求でdelta重複の余地 |
| Admin棚卸 `app/routes/app.inventory-count.tsx` | 独自250分割→inventorySetQuantities | common event処理とは別経路。全経路を同じ冪等設計と扱わない |

参照: [出庫](../extensions/stock-transfer-tile/src/ModalOutbound.jsx)、[apply-change](../app/routes/api.inventory.apply-change.tsx)、[数量helper](../app/utils/inventory-set-quantities-server.ts)、[Prisma](../prisma/schema.prisma)。

## 再実行・timeout・partial success

- 出庫のsubmitLockRefはセッション内の二重タップ防止。Transfer作成でアプリ側idempotency keyは使っていない。250分割途中の失敗後は先頭から再作成され得る。成功Transferを保存した永続再開位置はない。
- POS adminGraphqlは約20秒timeout。timeoutはShopify側の成功取消を保証しない。API成功後に履歴APIが失敗してもTransferを戻さない。複数Transferの履歴は先頭Transfer中心で、全成功IDを復元するチェックポイントではない。
- common apply-changeの通信retryは最大3attempt。401はtoken再取得、429/5xx/networkは待機して同じappEventId/bodyを再送。クライアントにtimeout/AbortControllerはない。202 applyingは自動再開しない。
- DB InventoryChangeEventのappEventId uniqueと既存イベント照会により同じイベントを抑止する。ただしshop複合キーではなく、同じIDでpayloadが変わった場合の照合もない。pending/applyingのまま停止したイベントを復旧する永続workerはない。イベントとline作成は単一transactionではない。
- Shopify成功→event completed→履歴upsertの順。履歴保存だけ失敗するとcompletedに残り、再送で履歴修復する保証はない。例外後にpending/applyingが残る経路がある。
- server helperは絶対値setとメモリ内の事前数量による補償を使う。changeFromQuantity:nullでCASを行わず、同時売上との競合や成功不明のchunkへの補償が課題。GraphQLトップレベルerror/欠落responseを成功・数量0と扱い得る経路もある。partial_failed時のline全件failedは実際の適用済みsubsetを正確に表さない。
- common調整のchunk IDは順番/総chunk数に依存。同じ内容・並びなら再送キーは同じだが、内容変更との結合はない。ロス/仕入の手動再確定は新IDになり得る。棚卸はmetafield完了の後で在庫applyを行う経路があり、状態だけ完了する失敗を確認する。
- webhookの再検索は要求内の短期retryで、永続background queueではない。Transfer作成、apply-change、履歴upsertの冪等性は別の仕組み。

Shopify APIに機能が存在することとアプリが使用していることは区別する。API 2026-01の対応mutationには任意の@idempotentがあるが、現行Transfer作成/set経路で使用していない。API更新時は公式schemaを再確認する。参照: [2026-01 inventoryTransferCreate](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/inventoryTransferCreate)、[inventorySetQuantities](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/inventorySetQuantities)。

## deployと安全な検証

mainを監視するRender backendとShopify app deployによる拡張/config releaseは別経路。main mergeもproduction反映として停止する。Docker起動はprisma migrate deployを伴い、web devにもmigrationがある。Shopify devはURL更新設定がある。deploy:public/inhouseはAPP_MODE変更とdeploy --forceを行う。これらをテストとして起動しない。

`npm test` は `tests/inventory-safety.test.mjs` のNode runner。全fetch/token/timerをmock化し、SKU/location/item/delta保持、401/429/503/network retry上限、同一キー再送、202停止、250分割partial failureと再実行、location別キー、timeout機構不在を確認する。通信先URLが本番既定でも実fetchへ到達しない。

このテストはサーバーDBの排他・Shopify mutationの冪等性・実際のtimeout後再開・補償の正しさを保証しない。重複要求が2回送られる現状を確認し、サーバー抑止をmockで捏造しない。mockで安全性が成立したという理由で本番検証を省略可能とは判断しない。

## 不足しているもの（未実装Backlog）

1. Transfer作成の永続operation ID、作成済みTransfer/Shipment/chunkのチェックポイント、成功不明時の照合・再開手順。
2. shop+操作ID+payload対応の冪等設計、pending/applying復旧、event/line保存と履歴修復、正確なpartial適用記録。
3. Shopify/DB adapter mockによるserver retry・timeout・同時実行・補償の検証、SKU解決/複数location/250境界を含むfixture。
4. green lint/typecheck baselineとCI。既存大量失敗の解消は別scope。CIのrequired checksは存在確認後に設計する。
5. 本番credentialsを使わない開発store/DB、appURL/migrationの隔離確認、preview PR #3との整合。スマホで起動したセッションも実効sandbox/approvalと専用checkoutを確認する。
6. 古い調査docsの有効期限・正本リンク、障害時に再確定せず照合するrunbookとrelease/rollback手順。billing未実装など過去TODOは現行実装・履歴で再確認する。

これらは候補であり、本PRでは在庫ロジックを修正しない。次の機能依頼時は影響する課題をscopeに含め、調査からレビュー・PRまでCodexが進める。

## このPRの品質結果

Node 24.11.1、既存ローカルnode_modulesを専用worktreeから再利用。npm test 9/9成功、build成功、追加testファイルのESLint成功、diff --check成功。全体lintは3,093 errors/157 warnings、typecheckは452 error行で失敗。typecheck出力は既存mainコードbaselineと完全一致。在庫アプリコードは変更していない。クリーンinstall/Node20/実DB/実Shopifyの検証は行っていない。自己レビューと別Codex agentによる独立読み取りレビューに重大指摘なし。
