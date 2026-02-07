# 出庫 確定ボタン各フローの処理内容（2026-02）

## フロー一覧と処理

| フロー | 確定する | 配送準備完了にする | 下書き保存 |
|--------|----------|--------------------|------------|
| **①新規作成** | 新規 Transfer 作成 + Shipment 確定（IN_TRANSIT） | 新規 Transfer を READY_TO_SHIP で作成 | 新規 Draft Transfer 作成 or 既存 Draft 更新 |
| **②単一シップメント編集** | `inventoryTransferSetItems` + 既存 Shipment 更新 or `inventoryShipmentCreateInTransit` で確定 | `inventoryTransferSetItems` で明細更新、Transfer は READY_TO_SHIP のまま | ❌ 非表示（READY_TO_SHIP 編集時） |
| **③複数シップメント「追加」** | `createInventoryShipmentInTransit` で既存 Transfer に新 Shipment 追加（確定） | `createInventoryShipmentDraft` で既存 Transfer に DRAFT Shipment 追加 | ❌ このフローでは非表示 |
| **④複数シップメント「編集」** | ②と同様 | ②と同様 | ②と同様 |

### ① 新規作成
- **確定する**: 在庫ゲート通過後、新規 Transfer 作成 + Shipment 作成（IN_TRANSIT）
- **配送準備完了にする**: `createTransferReadyToShipWithFallback` で READY_TO_SHIP の Transfer を新規作成（Shipment は作成しない）
- **下書き保存**: `inventoryTransferCreateDraft` または既存 `draftTransferId` があれば `inventoryTransferSetItems`

### ② 単一シップメント編集（下書き or 配送準備完了）
- **確定する**: `inventoryTransferSetItems` で明細更新後、既存 Shipment を更新 or `inventoryShipmentCreateInTransit` で確定
- **配送準備完了にする**: `inventoryTransferSetItems` で明細反映、DRAFT なら `inventoryTransferMarkAsReadyToShip`
- **下書き保存**: 編集対象が DRAFT のときのみ表示

### ③ 複数シップメント「追加」（2026-02 変更：確定・下書きの2種のみ）
- **確定する**: `createInventoryShipmentInTransit`（movementId = 既存 transferId）で新 Shipment を IN_TRANSIT で追加
- **下書き保存**: `createInventoryShipmentDraft`（movementId = 既存 transferId）で新 Shipment を DRAFT で追加
- ~~配送準備完了にする~~: 非表示（確定・下書きの2種に統一）

### ④ 複数シップメント「編集」（2026-02 変更：確定・下書きの2種のみ）
- **確定する**: ②と同様（Shipment 更新 or 新規 IN_TRANSIT）
- **下書き保存**: `inventoryTransferSetItems` で Transfer の lineItems を更新（仮想行編集時）
- ~~配送準備完了にする~~: 非表示（確定・下書きの2種に統一）

## ③で追加した DRAFT シップメントがリストに表示されない問題（2026-02 修正）

### 現象
③「配送準備完了にする」実行後、管理画面では対象 Transfer に DRAFT シップメントが保存されているが、アプリのシップメントリストに再読込しても表示されない。

### 要因候補と対応
1. **shipments(first: 10)** の取得上限：シップメントが10件超の場合に不足。→ `first: 50` に増加
2. **戻り先**: 追加後に履歴一覧へ戻るため、ユーザーが該当 Transfer を再度タップして「編集」でシップメントリストを開く。そのとき `fetchInventoryTransferDetailForHistory` が最新データを返していない可能性。→ 追加成功後にシップメントリストへ直接遷移するよう変更し、確実に再取得する
3. **キャッシュ**: API のキャッシュで古いデータが返る可能性。→ 追加成功時に `transferListVersion` を更新し、シップメントリストの再取得を促す

### 修正内容（2026-02 実装済み）
1. **shipments 取得上限の引き上げ**: `fetchInventoryTransferDetailForHistory` および `fetchTransfersForOriginAll` の `shipments(first: 10)` を `shipments(first: 50)` に変更
2. **③成功後の遷移先変更**: ③「確定する」および「配送準備完了にする」成功時に、履歴一覧へ戻らず **シップメントリストへ直接遷移** するよう変更。これにより追加した Transfer のシップメントをその場で確認可能になり、再取得で確実に表示される
