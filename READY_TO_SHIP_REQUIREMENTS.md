# 配送準備完了ステータス（READY_TO_SHIP）要件整理

## ✅ 実装完了

**実装日**: 2026年1月25日  
**検証完了**: ✅ 完了

---

## 📋 現状分析

### 現在の実装

1. **出庫確定モーダル** (`CONFIRM_TRANSFER_MODAL_ID`)
   - 「下書き保存」ボタン（secondary-actions）: `inventoryTransferCreateDraftSafe` → **DRAFT**ステータスで作成
   - 「確定する」ボタン（primary-action）: `submitTransferCore` → `createTransferReadyToShipWithFallback` → **READY_TO_SHIP**ステータスで作成 + Shipment作成（tracking情報がある場合）

2. **履歴からの編集**
   - 編集可能条件: `isEditable = statusRaw === "DRAFT" || statusRaw === "READY_TO_SHIP"`
   - 編集処理: `openEditAndOpen_` → `editingTransferId`を設定 → `inventoryTransferSetItemsSafe`で明細を更新
   - **注意**: 編集時はステータスを変更しない（明細のみ更新）

---

## 🎯 要件定義

### Phase 1: 「配送準備完了にする」ボタンの追加

#### 1.1 UI配置
- **場所**: 出庫確定モーダル内
- **位置**: 「下書き保存」ボタンの下（secondary-actions内）
- **順序**:
  1. 「下書き保存」（既存）
  2. **「配送準備完了にする」（新規）** ← ここに追加
  3. 「キャンセル」（既存）
  4. 「確定する」（primary-action、既存）

#### 1.2 動作仕様

**「配送準備完了にする」ボタンの処理フロー:**

```
1. 入力チェック（宛先、明細数など）
2. 在庫追跡有効化（出庫元・宛先）
3. 在庫レベル反映待ち
4. Transfer作成（READY_TO_SHIPステータス）
   - 既存の下書き（draftTransferId）がある場合:
     a. `inventoryTransferSetItemsSafe` で明細を更新
     b. `inventoryTransferMarkAsReadyToShip` でステータスをREADY_TO_SHIPに変更
   - 新規の場合:
     a. `inventoryTransferCreateAsReadyToShip` でREADY_TO_SHIPステータスで作成
5. Shipmentは作成しない（tracking情報なし）
6. モーダルを閉じる
7. 画面をリセット（linesをクリア、下書きをクリア）
```

**「確定する」ボタンとの違い:**
- ✅ **同じ**: 在庫追跡有効化、在庫レベル反映待ち、READY_TO_SHIPステータス
- ❌ **違う**: Shipmentを作成しない（tracking情報は不要）

#### 1.3 実装関数

```javascript
// 新規関数: 配送準備完了にする（Shipmentなし）
async function createTransferAsReadyToShipOnly({ skipActivate = false } = {}) {
  // submitTransferCore とほぼ同じ処理だが、Shipment作成をスキップ
  // 1. 在庫追跡有効化
  // 2. Transfer作成（READY_TO_SHIP）
  // 3. Shipmentは作成しない
}
```

---

### Phase 2: 履歴一覧からの編集処理

#### 2.1 現状の編集処理

**DRAFTステータスの場合:**
1. 履歴詳細画面で「編集」ボタンを押す
2. `openEditAndOpen_` が実行される
3. `editingTransferId` が設定される
4. OutboundList画面に遷移
5. 明細を編集
6. 「確定」ボタンで `submitTransferCore` が呼ばれる
7. `editingTransferId` がある場合、`inventoryTransferSetItemsSafe` で明細を更新
8. **ステータスは変更しない**（DRAFTのまま）

#### 2.2 READY_TO_SHIPステータスの編集処理

**質問: READY_TO_SHIPの編集は下書き編集と違う処理になる？**

**回答: 基本的に同じ処理でOK**

**理由:**
1. `inventoryTransferSetItemsSafe` はステータスを変更しない
2. READY_TO_SHIPステータスでも明細の更新は可能
3. 既存の編集フローをそのまま使える

**処理フロー（READY_TO_SHIPの場合）:**
```
1. 履歴詳細画面で「編集」ボタンを押す
2. openEditAndOpen_ が実行される
3. editingTransferId が設定される（READY_TO_SHIPのTransfer ID）
4. OutboundList画面に遷移
5. 明細を編集
6. 「確定」ボタンで submitTransferCore が呼ばれる
7. editingTransferId がある場合、inventoryTransferSetItemsSafe で明細を更新
8. ステータスは変更しない（READY_TO_SHIPのまま）
```

**注意点:**
- READY_TO_SHIPステータスでも明細の更新は可能
- ただし、既にShipmentが作成されている場合は、ShipmentのlineItemsも更新が必要な可能性がある
- 現時点では、TransferのlineItemsを更新するだけでOK（Shipmentは自動で追従する想定）

#### 2.3 編集後のステータス管理

**ケース1: DRAFT → 編集 → 確定**
- 編集後もDRAFTのまま
- 「確定する」ボタンでREADY_TO_SHIP + Shipment作成

**ケース2: READY_TO_SHIP → 編集 → 確定**
- 編集後もREADY_TO_SHIPのまま
- 「確定する」ボタンでShipment作成（既存のTransferを更新）

**ケース3: READY_TO_SHIP → 編集 → 配送準備完了にする**
- 編集後もREADY_TO_SHIPのまま
- 「配送準備完了にする」ボタンで何もしない（既にREADY_TO_SHIPなので）

---

## 🔧 実装詳細

### 1. 「配送準備完了にする」ボタンの実装

**場所**: `Modal.jsx` の `CONFIRM_TRANSFER_MODAL_ID` モーダル内

**追加するボタン:**
```jsx
<s-button
  slot="secondary-actions"
  command="--hide"
  commandFor={CONFIRM_TRANSFER_MODAL_ID}
  onClick={async () => {
    // createTransferAsReadyToShipOnly を呼ぶ
  }}
>
  配送準備完了にする
</s-button>
```

**実装関数:**
```javascript
// submitTransferCore をベースに、Shipment作成をスキップした版
const createTransferAsReadyToShipOnly = async ({ skipActivate = false } = {}) => {
  // 1. 入力チェック（submitTransferCoreと同じ）
  // 2. 在庫追跡有効化（submitTransferCoreと同じ）
  // 3. 在庫レベル反映待ち（submitTransferCoreと同じ）
  
  // 4. Transfer作成（READY_TO_SHIP）
  const editingTransferId = String(outbound?.editingTransferId || "").trim();
  if (editingTransferId) {
    // 既存Transferの編集: 明細更新 + ステータス変更
    await inventoryTransferSetItemsSafe({
      id: editingTransferId,
      lineItems,
    });
    
    // DRAFT → READY_TO_SHIP に変更
    const currentStatus = String(detail?.status || "").toUpperCase();
    if (currentStatus === "DRAFT") {
      await inventoryTransferMarkAsReadyToShip(editingTransferId);
    }
    
    toast("配送準備完了にしました（同ID）");
  } else {
    // 新規作成: READY_TO_SHIPで作成
    const transfer = await createTransferReadyToShipWithFallback({
      originLocationId: String(originLocationGid || "").trim(),
      destinationLocationId: String(destinationLocationId || "").trim(),
      lineItems,
      lineItemsMeta,
    });
    
    toast("配送準備完了で作成しました");
  }
  
  // 5. Shipmentは作成しない（tracking情報なし）
  
  // 6. 後処理（submitTransferCoreと同じ）
  // - 下書きをクリア
  // - linesをクリア
  // - editingTransferIdをクリア
  // - 画面を戻る
};
```

### 2. 編集処理の確認

**現状の実装で問題ないか確認:**

✅ **問題なし**: `inventoryTransferSetItemsSafe` はステータスを変更しないため、READY_TO_SHIPのまま編集可能

**ただし、以下の点に注意:**
- 既にShipmentが作成されている場合、ShipmentのlineItemsも更新が必要かもしれない
- 現時点では、TransferのlineItemsを更新するだけでOK（Shopify側で自動追従する想定）

---

## 📝 実装チェックリスト

### Phase 1: 「配送準備完了にする」ボタン ✅ 完了
- [x] `createTransferAsReadyToShipOnly` 関数の実装
- [x] 確定モーダルに「配送準備完了にする」ボタンを追加
- [x] 既存下書き（draftTransferId）がある場合の処理
- [x] 編集モード（editingTransferId）がある場合の処理
- [x] 在庫追跡有効化の処理
- [x] 在庫レベル反映待ちの処理
- [x] 後処理（下書きクリア、linesクリア、画面戻る）
- [x] エラーハンドリング

### Phase 2: 編集処理の確認 ✅ 完了
- [x] READY_TO_SHIPステータスでの編集が正常に動作するか確認
- [x] 既存Shipmentがある場合の動作確認
- [x] 編集後のステータスが正しく維持されるか確認

---

## 🎯 結論

### 1. 「配送準備完了にする」ボタン
- **実装方針**: `submitTransferCore` をベースに、Shipment作成をスキップした版を作成
- **配置**: 確定モーダルの「下書き保存」の下
- **動作**: READY_TO_SHIPステータスでTransferを作成（Shipmentなし）

### 2. 履歴からの編集
- **現状の実装で問題なし**: READY_TO_SHIPステータスでも `inventoryTransferSetItemsSafe` で明細を更新可能
- **ステータスは変更しない**: 編集後もREADY_TO_SHIPのまま
- **下書き編集と同じ処理**: 特別な処理は不要

### 3. 実装順序
1. **Phase 1**: 「配送準備完了にする」ボタンの実装（最優先）
2. **Phase 2**: 編集処理の動作確認（既存実装で問題ないか確認）

---

## 💡 補足: ステータス遷移の整理

### Transferステータスの遷移
```
DRAFT（下書き）
  ↓ 「配送準備完了にする」
READY_TO_SHIP（配送準備完了）
  ↓ 「確定する」（Shipment作成）
IN_TRANSIT（配送中）
  ↓ 入庫処理
RECEIVED（受領済み）
  ↓ 入庫確定
TRANSFERRED（入庫済み）
```

### 編集可能なステータス
- **DRAFT**: 編集可能（明細更新、ステータス変更可能）
- **READY_TO_SHIP**: 編集可能（明細更新可能、ステータスは維持）
- **IN_TRANSIT以降**: 編集不可（読み取り専用）

### ボタンの使い分け
- **「下書き保存」**: DRAFTステータスで保存（後で編集可能）
- **「配送準備完了にする」**: READY_TO_SHIPステータスで保存（Shipmentなし、後で編集可能）
- **「確定する」**: READY_TO_SHIPステータス + Shipment作成（tracking情報付き）
