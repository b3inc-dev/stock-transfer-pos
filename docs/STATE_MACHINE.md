# STATE_MACHINE — 在庫移管の状態遷移と再実行安全性

本ドキュメントは **1 件の出庫確定（在庫移管作成）** と関連する入庫・apply-change の状態遷移を正本として整理する。\
実装: `extensions/stock-transfer-tile/src/ModalOutbound.jsx` ほか。

---

## 1. 状態の単位（現行設計）

```mermaid
stateDiagram-v2
  [*] --> UI_Idle
  UI_Idle --> UI_Locked: 確定タップ / submitLockRef
  UI_Locked --> Activating: inventoryActivate origin+dest
  Activating --> WaitingLevels: waitForMissingInventoryLevels
  WaitingLevels --> CreatingTransfer: levels OK
  CreatingTransfer --> CreatingShipment: Transfer READY
  CreatingShipment --> Logging: Shipment IN_TRANSIT
  Logging --> UI_Complete: log + clear draft
  Activating --> UI_Failed: activate/timeout/userErrors
  WaitingLevels --> UI_Failed: timeout/remaining
  CreatingTransfer --> UI_Failed: GraphQL timeout/userErrors
  CreatingShipment --> UI_Failed: mid-flight failure
  Logging --> UI_Complete_ShopifyOnly: log失敗でもTransfer残存
  UI_Failed --> UI_Idle: unlock (finally)
  UI_Complete --> [*]
  UI_Complete_ShopifyOnly --> [*]
```

| レイヤ | 状態の持ち方 | 永続性 |
|--------|--------------|--------|
| UI | `submitLockRef`, `submitting` | セッションのみ |
| Shopify Transfer | DRAFT / READY_TO_SHIP / IN_PROGRESS / TRANSFERRED / CANCELED | 永続（正） |
| Shopify Shipment | DRAFT / IN_TRANSIT / PARTIALLY_RECEIVED / RECEIVED | 永続（正） |
| Draft 明細 | `SHOPIFY.storage` | 成功後削除。失敗時は残る場合あり |
| 作成チェックポイント | `SHOPIFY.storage` (`outboundCreateCheckpoint.js`) | チャンク進捗・attemptId。成功後削除 |
| 履歴 | `InventoryChangeLog` | 永続・idempotent |
| apply-change | `InventoryChangeEvent` | 永続・idempotent（**Transfer 作成では未使用**） |

**結論**: 「未処理→処理中→完了」の **Prisma job は無い**。正は Shopify Transfer/Shipment。再実行安全は **UI ロック + クライアントチェックポイント + note の attempt マーカー**で補う（D1/D3）。

---

## 2. Happy path（新規「確定する」、明細 ≤250）

```mermaid
sequenceDiagram
  participant U as POS User
  participant M as ModalOutbound
  participant S as Shopify GraphQL
  participant A as App API (log)

  U->>M: 確定する
  M->>M: submitLockRef=true
  M->>S: inventoryActivate (origin, dest)
  M->>S: poll InventoryLevel (≤30s)
  M->>S: inventoryTransferCreateAsReadyToShip<br/>(fallback: Create Draft → MarkReady)
  Note over S: Transfer = READY_TO_SHIP
  M->>S: inventoryShipmentCreate (DRAFT)
  M->>S: optional SetTracking
  M->>S: inventoryShipmentMarkInTransit
  Note over S: Shipment=IN_TRANSIT / Transfer≈IN_PROGRESS
  M->>A: logInventoryChangeToApi (outbound_transfer)
  M->>M: clear drafts, unlock
```

完了判定（クライアント）:

1. 各 mutation が `userErrors` なし
2. toast 成功
3. 下書きクリア
4. （ベストエフォート）履歴ログ成功

---

## 3. 250 超パス（複数 Transfer）

```text
activate / wait
→ for i in 1..n:
     create Transfer READY (chunk i)
     create Shipment IN_TRANSIT on that Transfer
→ 代表 transfer = 先頭
→ log（sourceId/appEventId は先頭 Transfer 基準）
→ clear / unlock
```

**チェックポイントあり（E3）:** 各チャンク成功後に `nextChunkIndex` / `created[]` を永続化。i=2 で失敗しても i=1 は Shopify に残るが、**同一指紋で再確定すると i=2 から再開**する（先頭チャンクの二重作成を避ける）。

---

## 4. Timeout → retry → resume → 完了（E3 以降）

サーバー側ワーカーは無い。クライアントが attempt マーカー付き note と storage チェックポイントで再開する。

```mermaid
flowchart TD
  A[処理中] -->|adminGraphql 20s abort| B[例外 / unlock / CP 保持]
  A -->|level wait 30s| B
  B --> C{同一指紋の CP があるか}
  C -->|ある| D[再確定 → pending チャンクを note 照会]
  C -->|なし / 指紋不一致| E[新規 attempt でフル作成]
  D --> F{Transfer が Shopify に存在}
  F -->|あり| G[Shipment 補完後 nextChunk から再開]
  F -->|なし| H[当該チャンクを作成して続行]
  G --> I[残りチャンク完了 → CP クリア]
  H --> I
  E --> I
```

| 事象 | コード上の挙動 | Resume の意味 |
|------|----------------|---------------|
| 二重タップ | lock 中は toast「処理中です…」で no-op | — |
| activate / level timeout | throw → alert → unlock | 最初から再実行（CP 未書込なら新規） |
| GraphQL 20s timeout（Transfer create） | CP の `pendingChunkIndex` を保持。再確定時に note `[pos-cp:…]` で成功確認 | **成功確認 → 再開** |
| 複数 Transfer 途中失敗 | 先行分は残存 + CP に created 記録 | **同一内容の再確定で続きから** |
| ログのみ失敗 | Transfer 残存、UI はクリア方向 | ログ再送は appEventId で比較的安全 |

---

## 5. Shopify Transfer / Shipment 状態（正）

```mermaid
stateDiagram-v2
  [*] --> DRAFT: Create Draft / 下書き保存
  [*] --> READY_TO_SHIP: CreateAsReadyToShip
  DRAFT --> READY_TO_SHIP: MarkAsReadyToShip
  READY_TO_SHIP --> IN_PROGRESS: Shipment MarkInTransit
  IN_PROGRESS --> TRANSFERRED: 全Shipment受領完了(Shopify)
  DRAFT --> CANCELED: Cancel
  READY_TO_SHIP --> CANCELED: Cancel

  state Shipment {
    [*] --> S_DRAFT: shipmentCreate
    S_DRAFT --> S_IN_TRANSIT: MarkInTransit
    S_IN_TRANSIT --> S_PARTIAL: Receive partial
    S_IN_TRANSIT --> S_RECEIVED: Receive full
    S_PARTIAL --> S_RECEIVED: Receive remaining
  }
```

入庫側の完了: Shipment 受領進捗 → Transfer `TRANSFERRED`。UI は fully received で readOnly。

---

## 6. apply-change 状態機械（調整系・入庫補正）

Transfer 作成とは **別系統**。

```text
pending → applying → completed
                   ↘ partial_failed / failed
```

- 同一 `appEventId` が `completed` → 即 OK 返却（冪等）
- `pending` / `applying` → 202（処理中）
- サーバー GraphQL は 429/503 を `withGraphQLRetry`（最大 3 回、指数バックオフ）

---

## 7. 再実行安全性マトリクス（最重要）

| シナリオ | リスク | 現行の防御 | 残ギャップ |
|----------|--------|------------|------------|
| 二重タップ | 二重 Transfer | `submitLockRef` | ロックはメモリのみ |
| API 成功後・状態保存（ログ）失敗 | 履歴欠落。在庫は Transfer 済み | log の idempotency | Transfer ロールバックなし |
| timeout 直前に Shopify のみ成功 | ユーザー再実行で二重 | note attempt マーカー照会 + CP | **中**（端末ローカル CP。他端末は未カバー） |
| retry 重複（出庫作成） | 二重 Transfer | 同一指紋 CP 再開 / 作成前照会 | **中**（指紋不一致の編集後再確定は新規 attempt） |
| 完了済ロケーションの再実行 | 出庫は「ロケ完了フラグ」モデルではない | — | 該当 job なし。再確定は新規作成扱い |
| 部分成功（250 分割） | 先頭チャンクのみ成功 | CP `nextChunkIndex` + created[] | **中**（成功分はスキップして再開） |
| 途中停止（アプリクラッシュ） | 上に同じ | CP + 下書きが残れば再開容易 | Shopify 側の掃除は手動（孤児 Transfer） |
| 同時実行（2 端末） | 二重 | 端末ローカル lock / CP のみ | **高**（分散ロックなし） |
| trigger 重複 | Cron は snapshot のみ | 移管トリガーはユーザー操作 | Cron による移管二重はなし |
| 入庫受領の再実行 | 二重受領・二重調整 | delta vs alreadyAccepted + 安定 appEventId + note マーカー | 比較的低い |
| apply-change 再送 | 二重 set | `appEventId` unique | 設計意図どおり |

### Idempotency の境界

```text
[防御あり]
  InventoryChangeLog.idempotencyKey
  InventoryChangeEvent.appEventId
  Webhook 系 idempotencyKey
  入庫 receive の差分計算

[弱い / 端末ローカル]
  inventoryTransferCreate*（Shopify 側 idempotency key なし。アプリは CP + note マーカー）
  inventoryShipmentCreate* / MarkInTransit（Transfer 回復後の Shipment 補完あり）
  出庫 UI ロック（永続・分散なし）
```

---

## 8. 処理対象の抽出・完了判定

| フェーズ | 抽出 | 完了 |
|----------|------|------|
| 出庫新規 | UI `lines` → `lineItems` | mutation 成功 + UI クリア |
| 出庫 250 分割 | `chunkLineItemsWithMeta` | 全チャンクループ成功（途中失敗時は未定義完了） |
| 入庫一覧 | destination の `inventoryTransfers` | Transfer/Shipment ステータス |
| 入庫受領 | shipment lineItems − alreadyAccepted | receive mutation + 必要なら finalize |
| 日次 snapshot | Bulk Operation | bulk completed（移管とは無関係） |

---

## 9. Error handling の層

| 層 | 扱い |
|----|------|
| GraphQL `userErrors` | `assertNoUserErrors` で throw |
| POS network/timeout | Promise.race / Abort → catch → toast/alert |
| Server 429/503 | `withGraphQLRetry`（POS クライアントには無い） |
| apply-change 部分適用 | `partial_failed` + rollback 試行（set quantities サーバー） |
| finally | **必ず** `submitLockRef=false` |

userErrors（ビジネス）はリトライしても同じ結果になりやすい。network / 429 はリトライ候補だが、**出庫作成を盲リトライすると二重発行**になる。

---

## 10. 「ロケーション単位処理」について

調査結果:

- 出庫は **origin 1 + destination 1** のペア処理。activate/wait はロケ単位
- **複数ロケーションをキュー処理する移管ジョブはコード上存在しない**
- 「完了済ロケーションをスキップして再開」型の状態フラグも **出庫作成には無い**
- 類似パターンは棚卸のグループ完了・apply-change の lineStatus 側に存在する

過去に「ロケーション単位・timeout・途中再実行」の修正が入っている可能性が高い領域は **棚卸 / snapshot / Webhook**。移管作成にそのジョブモデルを投影しないこと。

---

## 11. 棚卸確定の状態分離（COMPLETE_RETRY 正本）

実装: `InventoryCountList.jsx` + `api.pos-stocktake-complete` + `api.inventory.apply-change` + Admin `pos_metafield_retry`。  
詳細 UI: [`STOCKTAKE_COMPLETE_RETRY_DESIGN.md`](./STOCKTAKE_COMPLETE_RETRY_DESIGN.md)、画面方針: [`STOCKTAKE_UX_CANON.md`](./STOCKTAKE_UX_CANON.md)。

### 現行確定順（正本）

差異あり:

```text
確定タップ
→ submitLockRef
→ apply-change（履歴先行 upsert → setQuantities → 履歴 quantityAfter 確定）  // 冪等: appEventId
→ pos-stocktake-complete（metafield read/merge/write、サーバー自動リトライ）
→ 成功: toast / clear draft / unlock
→ metafield 失敗かつ setQuantities 済み: needMetafieldRetry（編集不可・メタのみ再試行）
```

差異なし: metafield 更新のみ（setQuantities なし）。

| 状態 | 意味 | 再試行でやってよいこと |
|------|------|------------------------|
| `quantitiesApplied` | apply-change 成功 | **再 setQuantities 禁止**（同一 appEventId） |
| `needMetafieldRetry` | メタ未反映 | POS `retryOnly` / Admin `pos_metafield_retry`（metafield のみ） |
| `completed` | メタ反映済み | なし |

二重 setQuantities 防止: `quantitiesAppliedRef` + `InventoryChangeEvent.appEventId` 冪等。  
Admin 再試行は `pending_complete_v1` からメタのみ適用（在庫 API を叩かない）。

### 差異あり apply-change: activate 伝播と setQuantities 失敗（2026-10-09）

- activate 成功後に短い settle + `inventoryLevel` 再確認。**確かな missing だけ再 ensure**。verify uncertain / lag では set 前にハード失敗しない（set + not-stocked 1 回再試行へ）。
- setQuantities が **厳格な** `not stocked at the location` 等で失敗し `partiallyApplied` でないときだけ、再 activate→settle→set を **1 回**。
- POS 向け `error` は `formatInventoryApiError` で空/Unknown 固定を避け、`errorCode`（`activate_failed` / `not_stocked` / `set_quantities_failed` / `partial_failed`）を付与。
- post-success / outer-catch は #22（旧 #20/#21）を維持。

### 同時売上/返品と絶対値 set（#19 CAS）

- 差異あり apply-change（`inventory_count` / `adjustment`）は **activate 成功後**、チャンク直前に available を再読取し `changeFromQuantity` CAS する（`casFromLiveSnapshot`）。
- 目標値と live が一致する行は set を skip（skip 行は rollback 対象に入れない）。
- CAS stale は 1 回再スナップショット後、なお不一致なら明確なエラーで失敗（`partiallyApplied` 時は再 set しない）。
- 後続チャンク失敗時のロールバックも **再読取 CAS**: 書いた数量と live が一致する行だけ戻し、同時変動行は null 上書きしない。
- stale 検出は `userErrors.message` 部分一致 + 可能なら `code`（実ストア形は検証ノート参照。ロケール変更で壊れ得る）。
- **製品決定（R1・inherent）**: カウント中〜確定タップ**前**の売上/返品は、棚卸「実数絶対値」セマンティクス上、確定時に上書きし得る。CAS は確定 API 実行中の緩和のみ。販売凍結や確定前ライブ差分確認 UI は製品変更（本 PR では inherent として文書化）。
- **#13**: `inventory_count` / `adjustment` の post-activate CAS を再 null 化しない（#19 が概念上先）。
- **残存**: TOCTOU・`partial_failed` 手動復旧・API 2026-01 のまま・ライブ stale 形未証明。
