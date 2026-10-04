# BUSINESS_RULES — 在庫移管・出庫入庫

コード（主に `ModalOutbound.jsx` / inbound）と既存 docs から抽出した業務ルール。

## 1. 出庫の基本ルール

| ルール | 内容 |
|--------|------|
| 出庫元 | **現在の POS ロケーション**（ユーザーが任意の origin を選ぶモデルではない） |
| 宛先 | 1 ロケーション。店舗グループ設定でフィルタされる場合あり |
| 明細上限（API） | **1 Transfer あたり lineItems 配列最大 250**（`SHOPIFY_ADMIN_LINE_ITEMS_ARRAY_MAX`） |
| 下書き UI 上限 | 下書き保存は概ね **300 行**まで（ストレージ安全側） |
| 在庫追跡 | 確定前に origin / destination で `inventoryActivate`（失敗時は確定中断） |
| レベル待ち | activate 後、欠損 InventoryLevel の解消をポーリング（新規確定で最大約 30s） |

## 2. 確定ボタンの意味

詳細行列: [`OUTBOUND_CONFIRM_FLOWS.md`](./OUTBOUND_CONFIRM_FLOWS.md)

| 操作 | 新規作成時の結果 |
|------|------------------|
| **確定する** | Transfer READY → Shipment IN_TRANSIT（Transfer は概ね IN_PROGRESS） |
| **配送準備完了にする** | Transfer READY_TO_SHIP（**Shipment は作らない**） |
| **下書き保存** | Transfer DRAFT |

編集 / Shipment 追加モードではボタンの組み合わせが変わる（READY 編集時は下書き非表示など）。

## 3. 250 超の分割ルール（重要）

Shopify 制約: Transfer に無い SKU を同一 movement の別 Shipment に載せると数量エラーになる。

| モード | 250 超の挙動 |
|--------|----------------|
| 新規 **確定（IN_TRANSIT）** | **Transfer を複数作成**し、各 Transfer に 1 Shipment |
| 新規 **READY_TO_SHIP** | **Transfer を複数**（各 READY） |
| 新規 **下書き** | **DRAFT Transfer を複数**（Draft では Shipment 追加不可） |
| 既存 Transfer へ **Shipment 追加** | 同一 `movementId` で Shipment 分割（Transfer 上に SKU/数量が載っていることが前提） |

分割メモ例: `POS出庫 分割 i/n（API上限250明細/Transfer）`

## 4. Transfer / Shipment ステータス語彙

| Transfer | 意味（アプリ表示） |
|----------|-------------------|
| DRAFT | 下書き |
| READY_TO_SHIP | 配送準備完了 |
| IN_PROGRESS | 処理中（発送〜受領中） |
| TRANSFERRED | 入庫済み |
| CANCELED | キャンセル |
| OTHER | その他 |

| Shipment | 意味 |
|----------|------|
| DRAFT | 下書き |
| IN_TRANSIT | 進行中 |
| PARTIALLY_RECEIVED | 部分受領 |
| RECEIVED | 入庫済み |
| OTHER | その他 |

**Shipment に READY_TO_SHIP は存在しない。**\
「配送準備完了」は **Transfer のステータス / Transfer lineItems** を指す。詳細: [`OUTBOUND_TRANSFER_VS_SHIPMENT_STATUS.md`](./OUTBOUND_TRANSFER_VS_SHIPMENT_STATUS.md)

## 5. 入庫ルール

| ルール | 内容 |
|--------|------|
| 対象 | 宛先ロケーションの Transfer / その Shipment |
| 受領単位 | **Shipment** |
| 数量 | 既受領分との **差分（delta）** のみ送る |
| 部分受領 | 可能。再実行時は差分計算で二重加算を抑制 |
| 不足 finalize | REJECTED 等 + 必要に応じて出庫元へ在庫戻し（apply-change）。Transfer note で二重戻し防止を試みる |
| 過剰 | 宛先で adjust（apply-change） |
| 完了 | Shopify 側で Transfer → TRANSFERRED（全受領時） |

## 6. 履歴・アクティビティ

| activity | いつ |
|----------|------|
| `outbound_transfer` | 出庫確定成功後（origin ロケ、delta 負） |
| `inbound_transfer` | 入庫受領・補正時 |
| `loss_entry` / `adjustment` / `inventory_count` 等 | 各タイル |

出庫ログの `appEventId` は **作成済み Transfer ID 由来**（`buildStableAppEventId("outbound_create", …)`）。\
→ **ログ再送の冪等には効くが、Transfer 二重作成防止には使えない。**

**推測**: 250 分割で複数 Transfer になった場合、履歴 `sourceId` は先頭 Transfer のみになり、後続 Transfer が履歴上薄くなる可能性がある（コード上、成功後ログが first `movementId` 基準）。

## 7. キャンセル・削除

- DRAFT / READY_TO_SHIP: キャンセルや削除 UI あり（READY は削除不可などステータス依存）
- IN_TRANSIT 以降: 編集制約が強まる（履歴からの操作はステータスゲートあり）

## 8. 在庫ゲート（確定前）

UI 上のゲート例（負在庫・宛先未設定・不足など）。ゲート通過後も Shopify `userErrors` で失敗し得る。

## 9. 課金・プラン（周辺）

公開アプリは Lite/Pro・ロケーション数に応じた従量などあり（移管状態機械とは独立）。プラン詳細は `docs/PUBLIC_APP_*` / `APP_PRICING_*` を参照。
