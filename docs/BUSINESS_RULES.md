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
再実行用マーカー（E3）: note 末尾に `[pos-cp:<attemptId>#i/n]` を付与。同一内容の再確定はチェックポイントから再開。

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

### 在庫履歴の差分と通知の順番（inventory_levels/update）

Shopify は Webhook の届く順番を約束していない。差分（delta）は届いた順ではなく、**通知の時刻（`updated_at`）の順**で決める。

| ルール | 内容 |
|--------|------|
| ひとつ前の行 | その通知の時刻 **より前** の行だけから選ぶ（同じ商品・ロケーション、数値 ID と GID の両方）。いちばん近い行の数量が null なら数量のある行まで遡る |
| 古い通知があとから届いた | その行を書いたあと（または数量を決めたあと）、**すぐ後ろの 1 行** の差分を「後ろの行の数量 − いま書いた数量」で計算し直す |
| 計算し直す行 | 差分を在庫数の差から出している **管理（`admin_webhook`）の行だけ**。売上・返品・ロス・入出庫・棚卸などの行の差分は業務の数なので変えない。数量が null の行も変えない |
| 変えないもの | Shopify の在庫数（履歴の数だけの補正）。同じ通知の再送は従来どおり idempotencyKey で何もしない |

実装: `app/utils/inventory-history-order.ts`。例: 10 → A(8) → B(7) が B, A の順に届いても A=−2・B=−1。

**推測（未確認）**: アプリの操作で書く行の時刻はサーバーの時刻、Webhook の行の時刻は Shopify の `updated_at`。時計のずれが数秒あると、ごく近い 2 つの変動で前後を取り違える可能性は残る。

## 7. キャンセル・削除

- DRAFT / READY_TO_SHIP: キャンセルや削除 UI あり（READY は削除不可などステータス依存）
- IN_TRANSIT 以降: 編集制約が強まる（履歴からの操作はステータスゲートあり）

## 8. 在庫ゲート（確定前）

UI 上のゲート例（負在庫・宛先未設定・不足など）。ゲート通過後も Shopify `userErrors` で失敗し得る。

## 9. 課金・プラン（周辺）

公開アプリは Lite/Pro・ロケーション数に応じた従量などあり（移管状態機械とは独立）。プラン詳細は `docs/PUBLIC_APP_*` / `APP_PRICING_*` を参照。

- 公開用で使える機能（`extensions/common/planAccess.js`。DECISIONS D14）:

| プラン | 使える機能 |
|---|---|
| 未契約 | なし（ホームと料金プランだけ開ける。POS のタイルは理由と案内を出して止まる） |
| Lite | 設定・入出庫（管理画面の履歴、POS の出庫・入庫） |
| Pro | すべて（在庫情報・仕入・ロス・発注・棚卸・調整も） |

- 開発ストアも契約が要る（テスト課金で請求なし）。自社用（inhouse）は契約なしで全機能。
- 料金（2026-11-22 T 決定・DECISIONS D17）: Lite - 3ロケーション $20・Lite - 10ロケーション $40・Pro - 3ロケーション $60・Pro - 10ロケーション $120（月額 USD）。無料体験 Lite 7 日・Pro 14 日。10 ロケーションのプランは 11 か所目から 1 か所 Lite $4 / Pro $12（D15）。
- 3 ロケーションのプランで 4 か所以上ある店: 管理画面はホームと料金プランだけ、POS はタイルを開くときに「プランを上げてください」と要るプランを出して止める。確定の途中（apply-change・履歴の記録・棚卸の完了）では止めない。10 ロケーションのプランは 11 か所以上でも止めない（従量）。
- 契約を読めなかったときは「確認できませんでした」と出し、新しく在庫を動かす処理は止める。
