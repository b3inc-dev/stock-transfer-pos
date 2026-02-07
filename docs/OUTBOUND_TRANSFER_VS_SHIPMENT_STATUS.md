# Transfer と Shipment のステータスと表示の関係（2026-02）

## 1. 公式 API の定義

### Transfer ステータス（InventoryTransferStatus）

| ステータス | 説明 | アプリ表示 |
|------------|------|------------|
| DRAFT | 作成済みだが未確定 | 下書き |
| READY_TO_SHIP | 作成済みだが未発送 | 配送準備完了 |
| IN_PROGRESS | 発送中または受領済み | 処理中 |
| TRANSFERRED | 宛先で完全受領済み | 入庫済み |
| CANCELED | キャンセル済み | キャンセル |
| OTHER | その他 | その他 |

### Shipment ステータス（InventoryShipmentStatus）

| ステータス | 説明 | アプリ表示 |
|------------|------|------------|
| DRAFT | 作成済みだが未発送 | 下書き |
| IN_TRANSIT | 輸送中 | 進行中 |
| PARTIALLY_RECEIVED | 一部受領済み | （部分受領） |
| RECEIVED | 完全受領済み | 入庫済み |
| OTHER | その他 | その他 |

**重要**: Shipment には **READY_TO_SHIP というステータスは存在しない**。

---

## 2. Transfer の「配送準備完了」と Shipment の違い

### 結論

| 項目 | Transfer | Shipment |
|------|----------|----------|
| 「配送準備完了」相当 | **READY_TO_SHIP** あり | **なし**（READY_TO_SHIP は存在しない） |
| データの持ち方 | Transfer の `lineItems` | Shipment の `lineItems` |
| Shipment ID | なし（Shipment レコードが存在しない） | あり（gid://shopify/InventoryShipment/...） |

### 管理画面の表示モデル

1. **「発送準備完了」セクション**
   - Transfer が READY_TO_SHIP のとき、**Transfer の lineItems** を表示
   - **Shipment レコードは存在しない**（Shipment ID なし）
   - `inventoryTransferCreateAsReadyToShip` で Transfer のみ作成し、Shipment は作らない

2. **「下書き」セクション**
   - `inventoryShipmentCreate` で追加した **DRAFT Shipment** を表示
   - Shipment ID あり（#T0127-1 など）

3. **その他（進行中・入庫済み）**
   - `inventoryShipmentCreateInTransit` などで作成された **IN_TRANSIT / RECEIVED** の Shipment

---

## 3. #T0127 のようなケースの構造

```
Transfer #T0127 (status: READY_TO_SHIP)
├── lineItems（Transfer に直接紐づく）: 3点
│   → 管理画面の「発送準備完了」ブロック（Shipment ID なし）
│
└── shipments（API で取得できる Shipment レコード）
    └── #T0127-1 (status: DRAFT): 2点
        → 管理画面の「下書き」ブロック
```

- **総数 5 点** = Transfer の lineItems 3点 + Shipment の lineItems 2点
- アプリの「配送数: 1」= Shipment レコードが 1 件だけカウントされている
- Transfer の lineItems は Shipment ではないため、現在のロジックでは表示されない

---

## 4. 総数が 5 点になる理由

- Transfer の `totalQuantity` は、**Transfer の lineItems と Shipment の lineItems を合わせた総数**
- 一覧の「0/5」などの表示は、この `totalQuantity` を使っている
- 一方、シップメントリストは **Shipment レコードのみ** を表示しており、Transfer の lineItems を表示していない
- そのため、「総数 5 点」と「シップメントリストに表示されない 3 点」が同時に起きる

---

## 5. 実装方針の整理

### 現状

| 操作 | 確定する | 配送準備完了にする | 備考 |
|------|----------|--------------------|------|
| ③追加 | `inventoryShipmentCreateInTransit`（IN_TRANSIT Shipment 追加） | `inventoryShipmentCreate`（DRAFT Shipment 追加） | API 上は確定 or 下書きのみ |
| ②④編集（Shipment 編集） | Shipment 更新 or 新規 IN_TRANSIT | `inventoryTransferSetItems`（Transfer の lineItems 更新） | 編集対象による |
| ②④編集（Transfer の lineItems 編集） | - | `inventoryTransferSetItems` | Shipment は作らない |

### シンプル化の選択肢

- ③「追加」: API 的には **確定（IN_TRANSIT）** か **下書き（DRAFT）** のどちらかしか作れない
- ②④「編集」: 既存の「配送準備完了にする」は `inventoryTransferSetItems` で Transfer の lineItems を更新するもので、仕様上必要
- **結論**: 「配送準備完了にする」を外すと、Transfer の lineItems だけを更新したいケースを表現できなくなるため、削除すると不整合が増える

---

## 6. 管理画面と同一表示にするための対応

### 必要な対応

1. **Transfer の lineItems を仮想行として表示**
   - Transfer が READY_TO_SHIP かつ lineItems があるとき
   - シップメントリストの**先頭**に、`__transfer__${transferId}` のような仮想行を追加
   - ラベル例: 「発送準備完了」または「#T0127（Transfer）」

2. **表示順序**
   - 1 行目: 仮想行（Transfer の lineItems＝「発送準備完了」）
   - 2 行目以降: Shipment レコード（下書き、進行中、入庫済み など）

3. **総数**
   - 現状どおり Transfer の `totalQuantity` を使用すれば、管理画面と同じ 5 点表示になる

### 仮想行をタップしたときの挙動（既存実装で対応済み）

- 仮想行をタップ → `historySelectedShipmentId = "__transfer__${transferId}"` を設定
- 詳細・編集は、`loadDetail_` で `detail.lineItems`（Transfer の lineItems）を表示
- 編集ボタンで OutboundList を開く際、`openEditAndOpen_` の `isVirtual` 分岐で **Transfer の lineItems を lines に変換**
- 確定時は `inventoryTransferSetItems` で Transfer の lineItems を更新（Shipment は触らない）
- **アプリから仮想行の lineItems を編集・保存できる**（既存の `__transfer__` 仮想行ロジックで対応済み）
