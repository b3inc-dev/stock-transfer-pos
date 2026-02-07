# 入庫：tile Modal 全行確認による未移行処理の徹底一覧

**対象**: `extensions/stock-transfer-tile/src/Modal.jsx` 内の入庫関連コード（4分割前の元実装）  
**比較先**: `extensions/stock-transfer-inbound/` 拡張

**2025年対応**: 未移行だった処理の多くを入庫拡張に実装済み（inboundApi: appendInventoryTransferNote_, resolveVariantByCode, VariantCache, ensureInventoryActivatedAtLocation / InboundListScreen: extras, over/shortage, 下書き拡張, 検索UI, スキャンキュー, loadMoreLineItems, 確定モーダル, 理由・メモ・一部入庫, 予定外履歴・確定時メモ表示）。複数シップメント一括表示のみ未実装（単一シップメント表示のまま）。

---

## 1. Modal.jsx 入庫関連の行範囲と役割

| 行範囲 | 名前・役割 |
|--------|------------|
| 257 | `SCAN_QUEUE_KEY`（スキャンキュー用ストレージキー） |
| 416– | スキャナー subscribe（tile 全体で共有、入庫でも利用） |
| 577–606 | ルート描画で InboundConditions / InboundShipmentSelection / InboundList に `readInboundAuditLog` 等を渡す |
| 977–1033 | `buildInboundNoteLine_`（確定時メモ・監査ログ用テキスト生成） |
| 2720–3273 | **InboundConditions**（入庫コンディション画面） |
| 3275–3530 | **InboundShipmentSelection**（シップメント選択画面） |
| 3532–6398 | **InboundList**（入庫リスト・明細・確定・予定外・スキャン等） |
| 6401–6489 | **InboundAddedLineRow**（1行表示コンポーネント） |
| 6520– | `searchVariants`（バリアント検索、入庫の「追加」で使用） |
| 7914–8055 | 下書きキー定数・`loadInboundDraft` / `saveInboundDraft` / `clearInboundDraft` |
| 8057–8226 | 監査ログ・超過/予定外インデックス・`mergeInboundOverIntoTransfers_` |
| 8227– | `appendInboundAuditLog` |
| 8531– | `resolveVariantByCode`（スキャン/コードからバリアント解決） |
| 8622–8666 | `renderInboundShipmentItems_`（複数シップメント時の行描画） |

---

## 2. 入庫拡張に「既に移行済み」のもの

- **設定（metafield）**: `fetchSettings()` で取得し、`listInitialLimit` / `productList.initialLimit` / `searchList.initialLimit` を参照。
- **入庫コンディション**: 履歴一覧のページネーション（`transfersPageInfo` / `loadMoreTransfers_` / 「さらに読み込み」）、`listInitialLimit` 適用。
- **シップメント選択**: 再取得時の `listInitialLimit`、選択した transfer の保持（`selectedTransferForSelection` 相当の最適化）。
- **入庫リスト（最小構成）**: 1シップメントの明細表示・数量編集・確定・下書き復元、`productList.initialLimit` 適用。
- **API/ヘルパー**:  
  `loadInboundDraft`, `saveInboundDraft`, `clearInboundDraft`,  
  `readInboundAuditLog`, `buildInboundOverIndex_`, `buildInboundExtrasIndex_`,  
  `buildInboundOverItemIndex_`, `buildInboundRejectedIndex_`,  
  `mergeInboundOverIntoTransfers_`, `appendInboundAuditLog`, `buildInboundNoteLine_`,  
  `adjustInventoryAtLocationWithFallback`, `searchVariants`（API のみ存在）。

---

## 3. 未移行の処理（tile Modal にのみ存在）

### 3.1 InboundList 本体の機能

| 機能 | Modal.jsx の行・内容 | 入庫拡張の状態 |
|------|----------------------|----------------|
| **複数シップメント一括表示** | 3562–3564 `isMultipleMode`、3796–3800 `loadMultipleShipments`、6199–6236 複数シップメントをグループ化して `renderInboundShipmentItems_` で表示 | 未実装（1シップメントのみ） |
| **予定外入荷（extras）** | 3662–3667 `extras` state、3688–3689、4242–4258 `setExtraQty` / `incExtra`、4453–4481 `overRows`/`extrasQtyTotal`、5626–5676 `renderExtras_`、6289–6324 確定モーダル内の予定外/超過/不足プレビュー | 未実装（extras の追加・編集・表示なし） |
| **予定外入荷の履歴表示** | 5679–5734 `extrasHistory` / `loadExtrasHistory`、5742–5814 `renderExtrasHistory_` | 未実装 |
| **確定時メモ（前回メモの表示）** | 5680–5681 `confirmMemo`、5708–5711、5812–5823 `renderConfirmMemo_` | 未実装 |
| **スキャンキュー（バーコード等）** | 257 `SCAN_QUEUE_KEY`、3681–3697 スキャン用 state/ref、4321–4414 `kickProcessScanQueue` / `scanFinalizeSoon`、4347–4384 キュー処理と `resolveVariantByCode` 呼び出し、4416–4447 ストレージからのキュー取り出し interval | 未実装（`resolveVariantByCode` も未移行） |
| **商品スキャンで追加** | 4363 `resolveVariantByCode(code, …)`、4260–4269 `addOrIncrementByResolved`（extras または既存行に加算） | 未実装（`resolveVariantByCode` が入庫拡張にない） |
| **検索による予定外追加 UI** | 3720–3724 `addQuery` / `debouncedAddQuery` / `addCandidates` / `addCandidatesDisplayLimit`、4155–4191 `searchVariants` で検索、4231–4258 `addOrIncrementByResolved`、5890–6152 `InboundCandidateRow` と「追加」候補リスト表示 | 未実装（searchVariants は API のみで UI なし） |
| **Line Items の追加読み込み** | 3665–3666 `lineItemsPageInfo` / `loadingMore`、4073–4149 `loadMoreLineItems_`、6181–6197 「未読み込み商品リストがあります」＋「読込」ボタン | 未実装（初回 first のみ、ページネーションなし） |
| **超過/不足の計算と確定処理** | 4453–4481 `overRows` / `shortageRows` / `overQtyTotal` / `extrasQtyTotal` / `shortageQtyTotal`、4690–4792 確定前の `buildInboundNoteLine_`＋`appendInventoryTransferNote_`、4793–5166 確定時の超過・不足・予定外の在庫調整と `appendInboundAuditLog`、5223–5315 出庫元/入庫先の `adjustInventoryAtLocationWithFallback` と transfer メモ追記（`buildInboundNoteLine_`＋`appendInventoryTransferNote_`） | 未実装（超過/不足/予定外の計算・在庫調整・メモ追記なし。入庫拡張は「予定通り受け入れ」のみ） |
| **確定前の「理由・メモ・警告確認」** | 3726–3728 `reason` / `note` / `ackWarning`、3568–3573 `WARNING_REASONS`、4530–4546 `hasWarning` / `warningReady`、5392–5410 `warningAreaNode`（理由選択・メモ・同意チェック）、6246–6336 確定モーダル（予定外/超過/不足のプレビュー、理由・メモ、戻る／一部入庫／確定する） | 未実装（理由・メモ・警告確認 UI なし） |
| **「一部入庫（一時保存）」** | 6359–6371 `finalize: false` で `receiveConfirm` を実行するボタン | 未実装（入庫拡張は「確定」のみで一部入庫フローなし） |
| **readOnly 判定の詳細** | 4526–4548 `selectedReadOnly` / `selectedTransferTotalQuantity` / `selectedTransferReceivedQuantity` / `receivedQuantityDisplay` を考慮した readOnly | 入庫拡張は `shipment.status === 'RECEIVED'` と `inbound.selectedReadOnly` のみで、transfer の受取済み表示量は未使用 |
| **下書きに reason/note/onlyUnreceived** | 4570–4579 payload に `onlyUnreceived`, `reason`, `note` を含めて保存 | 入庫拡張の下書きは rows 中心で、reason/note/onlyUnreceived は未使用 |
| **処理ログ表示** | 5395–5396 `setProcessLog`、5826–5835 `renderProcessLog_` | 未実装 |

### 3.2 共通・ユーティリティ

| 機能 | Modal.jsx の行・内容 | 入庫拡張の状態 |
|------|----------------------|----------------|
| **管理画面メモへの追記** | `appendInventoryTransferNote_`（4763–4776、5311–5314）：確定前・確定後に transfer の note へ `buildInboundNoteLine_` で生成した行を追記 | 未実装（入庫拡張に `appendInventoryTransferNote_` が存在しない） |
| **resolveVariantByCode** | 8531– スキャンコード正規化とバリアント取得 | 未実装（入庫拡張に同名関数なし。`searchVariants` のみあり） |
| **normalizeScanCode_** | `resolveVariantByCode` 内で使用 | 未移行 |
| **renderInboundShipmentItems_** | 8622–8666 行リストを `InboundAddedLineRow` で描画 | 入庫拡張はシンプルなリスト表示で、このコンポーネント構成は未使用 |
| **InboundAddedLineRow** | 6401–6489（行・数量・SKU・予定/入庫、QtyControlCompact_3Buttons、onRemove） | 入庫拡張は s-text-field 等の簡易行で、この行コンポーネントは未使用 |

### 3.3 InboundConditions / InboundShipmentSelection の細部

- **InboundConditions**: 設定・ページネーション・「さらに読み込み」は移行済み。tile 固有の `appState.outbound.settings` 参照は、拡張では `settings` prop で代替済み。
- **InboundShipmentSelection**: 再取得件数と選択 transfer の保持は対応済み。`selectedTransferForSelection` のような「コンディションで選んだ transfer を渡す」最適化は拡張でも同様の考え方で実装済み。

---

## 4. まとめ：未移行の処理一覧（実装の有無で整理）

1. **複数シップメントの一括表示・操作**（`isMultipleMode`、`loadMultipleShipments`、グループ表示）
2. **予定外入荷（extras）**の追加・編集・表示・確定時の扱い
3. **予定外入荷の履歴表示**（`extrasHistory` / `loadExtrasHistory` / `renderExtrasHistory_`）
4. **確定時メモの前回表示**（`confirmMemo` / `renderConfirmMemo_`）
5. **スキャンキュー**（ストレージキュー、interval、`kickProcessScanQueue`、`scanFinalizeSoon`）
6. **resolveVariantByCode**（スキャン/コード→バリアント解決）および **商品スキャンで行・extras に追加**
7. **検索 UI による予定外追加**（`addQuery` / `addCandidates` / `InboundCandidateRow`、`searchVariants` の画面利用）
8. **Line Items の追加読み込み**（`loadMoreLineItems_`、`lineItemsPageInfo.hasNextPage`、読込ボタン）
9. **超過・不足の計算と確定時の在庫調整**（`overRows` / `shortageRows`、出庫元/入庫先の `adjustInventoryAtLocationWithFallback`、rejected/extra の delta 計算）
10. **確定時の監査ログ・メモ**（`appendInboundAuditLog` は API あり。確定フローでの「理由・over/extras の整形・メモ追記」の一連の流れは InboundListScreen に未実装）
11. **管理画面 transfer メモへの追記**（`appendInventoryTransferNote_`、`buildInboundNoteLine_` の内容を note に追記）
12. **確定前の理由・メモ・警告確認 UI**（WARNING_REASONS、reason/note/ackWarning、確定モーダル内の警告エリア）
13. **「一部入庫（一時保存）」**（`receiveConfirm({ finalize: false })`）
14. **readOnly の詳細判定**（transfer の total/received 表示量に基づく readOnly）
15. **下書きの reason / note / onlyUnreceived** の保存・復元
16. **処理ログ表示**（`setProcessLog` / `renderProcessLog_`）
17. **renderInboundShipmentItems_ / InboundAddedLineRow** による行表示（拡張は別の簡易行で実装）

これらは「4分割前の Modal に入庫として存在していたが、現状の入庫拡張にはまだ入っていない処理」として整理したものです。必要に応じて優先度をつけて順次、入庫拡張へ移植できます。
