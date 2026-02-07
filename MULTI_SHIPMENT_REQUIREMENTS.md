# 複数Shipment対応 詳細要件書

## 📋 現状分析

### 現在の実装状況

1. **Transfer取得時のShipment情報**
   - `fetchInventoryTransferDetailForHistory`: `shipments(first: 10) { nodes { id status } }` で取得
   - `fetchTransfersForDestinationAll`: shipments配列を取得（形式は様々）
   - 現在は `id` と `status` のみ取得

2. **Shipment選択ロジック**
   - `pickShipmentIdFromTransfer`: 最初の未受領Shipmentを自動選択
   - 入庫処理: `onTapTransfer` で自動的に1つのShipmentを選択
   - 出庫履歴: `getShipmentIdFromTransferForHistory` で最初のShipmentを取得

3. **問題点**
   - 複数Shipmentがある場合、どのShipmentを処理しているか不明確
   - ユーザーがShipmentを選択できない
   - 複数Shipmentを同時に処理できない

---

## 🎯 要件定義

### Phase 1: 複数Shipmentの読み込み・表示 ✅ 最優先

#### 1.1 入庫一覧での表示

**実装箇所**: `InboundConditions` コンポーネント

**要件**:
- Transfer一覧で、Shipmentが2つ以上ある場合に「シップメント数: N」を表示
- Shipmentが1つの場合は表示しない（既存動作を維持）

**実装詳細**:
```javascript
// Transfer一覧の各項目に追加
const shipmentCount = transfer.shipments?.length || 0;
if (shipmentCount > 1) {
  // "シップメント数: 3" を表示
  <s-text tone="subdued" size="small">
    シップメント数: {shipmentCount}
  </s-text>
}
```

**データ取得**:
- `fetchTransfersForDestinationAll` で既に `shipments` 配列を取得している
- 追加のGraphQLクエリは不要

---

#### 1.2 Shipment選択モーダル（新規追加）✅ 重要

**実装箇所**: `InboundConditions` → `onTapTransfer` の処理を拡張

**要件**:
- Transfer選択後、Shipmentが2つ以上ある場合のみ表示
- Shipmentが1つの場合は自動スキップ（既存の `onTapTransfer` を実行）

**画面構成**:
```
┌─────────────────────────┐
│ Shipment処理方法を選択   │
├─────────────────────────┤
│ Transfer: #T0000        │
│ 出庫元: 店舗A           │
│ 宛先: 店舗B             │
│ シップメント数: 3        │
├─────────────────────────┤
│ [ ] シップメントごとに選択│
│     1つのShipmentを選択  │
│     して処理します      │
│                         │
│ [ ] まとめて表示        │
│     全Shipmentを1画面で │
│     表示して処理します  │
├─────────────────────────┤
│ [戻る]                  │
└─────────────────────────┘
```

**選択肢の説明**:
1. **シップメントごとに選択**
   - Shipment選択画面へ遷移
   - 1つのShipmentを選択して `InboundList` へ
   - 既存の動作に近い（1つのShipmentのみ処理）

2. **まとめて表示**
   - 全Shipmentを1画面で表示
   - 各Shipmentをタイトルで区切る
   - まとめてスキャン・カウント処理が可能
   - `InboundList` を複数Shipmentモードで表示

**実装詳細**:
```javascript
const onTapTransfer = (t) => {
  const shipments = Array.isArray(t?.shipments) ? t.shipments : [];
  const shipmentCount = shipments.length;
  
  if (shipmentCount === 0) {
    toast("Shipmentが見つかりません");
    return;
  }
  
  if (shipmentCount === 1) {
    // 既存の動作（自動スキップ）
    const shipmentId = pickShipmentIdFromTransfer(t);
    if (!shipmentId) return;
    // ... 既存の処理
    onNext?.();
    return;
  }
  
  // 2つ以上の場合：選択モーダルを表示
  setStateSlice(setAppState, "inbound", {
    selectedTransferId: String(t?.id || ""),
    selectedTransferName: String(t?.name || ""),
    selectedOriginName: String(t?.originName || ""),
    selectedDestinationName: String(t?.destinationName || ""),
    // 一時的に保存（モーダルで使用）
    pendingTransfer: t,
  });
  
  // モーダルを表示
  showShipmentModeSelectionModal();
};
```

---

#### 1.3 Shipment選択画面（シップメントごとに選択の場合）

**実装箇所**: 新規コンポーネント `InboundShipmentSelection`

**要件**:
- 選択モーダルで「シップメントごとに選択」を選択した場合に表示
- 各Shipmentの情報を表示して、1つを選択

**画面構成**:
```
┌─────────────────────────┐
│ Shipment選択            │
├─────────────────────────┤
│ Transfer: #T0000        │
│ 出庫元: 店舗A           │
│ 宛先: 店舗B             │
├─────────────────────────┤
│ [選択] 配送1 (#T0000-1)  │
│     ステータス: IN_TRANSIT
│     追跡番号: 123456    │
│     数量: 10件          │
│                         │
│ [選択] 配送2 (#T0000-2)  │
│     ステータス: IN_TRANSIT
│     追跡番号: 789012    │
│     数量: 5件           │
│                         │
│ [選択] 配送3 (#T0000-3)  │
│     ステータス: RECEIVED
│     数量: 3件           │
├─────────────────────────┤
│ [戻る]                  │
└─────────────────────────┘
```

**表示項目（各Shipment）**:
- 選択ボタン（タップで選択）
- Shipmentラベル（例: "配送1 (#T0000-1)"）
- ステータス（IN_TRANSIT, RECEIVED等）
- 追跡情報（あれば）: 配送会社、追跡番号
- 数量サマリー: 明細数、合計数量

**データ取得**:
- 各Shipmentの詳細情報を取得する必要がある
- GraphQLクエリ: `inventoryShipment` で各Shipmentの詳細を取得
- または、`fetchTransfersForDestinationAll` でより詳細な情報を取得

**画面遷移**:
- Shipmentを選択 → `InboundList` へ（1つのShipment IDを渡す）

---

#### 1.4 まとめて表示モード（InboundList拡張）

**実装箇所**: `InboundList` コンポーネントを拡張

**要件**:
- 選択モーダルで「まとめて表示」を選択した場合に表示
- 全Shipmentを1画面内に表示
- 各Shipmentをタイトルで区切る（例: "配送1（#T0000-1）"）
- 各Shipmentの明細を個別に表示
- まとめてスキャン・カウント処理が可能

**画面構成**:
```
┌─────────────────────────┐
│ 入庫明細（3件のShipment）│
├─────────────────────────┤
│ 配送1（#T0000-1）       │
│ ステータス: IN_TRANSIT  │
│ 追跡: ヤマト 123456     │
│ ─────────────────────   │
│ 商品A × 5              │
│ 商品B × 3              │
│                         │
│ 配送2（#T0000-2）       │
│ ステータス: RECEIVED    │
│ ─────────────────────   │
│ 商品C × 2              │
│                         │
│ 配送3（#T0000-3）       │
│ ステータス: IN_TRANSIT  │
│ 追跡: 佐川 789012       │
│ ─────────────────────   │
│ 商品D × 1              │
│                         │
│ [確定する]              │
└─────────────────────────┘
```

**実装詳細**:
- `InboundList` に `selectedShipmentIds` 配列を追加（複数Shipment対応）
- `selectedShipmentId` が1つの場合: 既存の動作（後方互換性）
- `selectedShipmentIds` が複数の場合: まとめて表示モード

**データ取得**:
```javascript
// 複数Shipmentの場合
const shipmentDetails = await Promise.all(
  selectedShipmentIds.map(id => 
    fetchInventoryShipmentEnriched(id, { includeImages: false })
  )
);

// 各ShipmentのlineItemsを統合
const allLineItems = shipmentDetails.flatMap((shipment, index) => {
  const label = formatShipmentLabel(transferName, index);
  return (shipment.lineItems || []).map(li => ({
    ...li,
    shipmentLabel: label, // どのShipmentか識別用
    shipmentId: shipment.id,
  }));
});
```

**スキャン・カウント処理**:
- 既存のスキャン処理を拡張
- スキャンした商品がどのShipmentに属するか判定
- 同一商品が複数Shipmentにある場合、Shipmentごとに数量を管理

**受領処理**:
- 選択した全Shipmentを同時に受領
- 各Shipmentごとに `inventoryShipmentReceive` を実行
- 成功/失敗を記録して表示

---

#### 1.5 履歴詳細での全Shipment表示

**実装箇所**: `OutboundHistoryDetail` コンポーネント

**要件**:
- 1画面内に全Shipmentを表示
- 各Shipmentをタイトルで区切る（例: "配送1（#T0000-1）"）
- 各Shipmentの明細を個別に表示

**画面構成**:
```
┌─────────────────────────┐
│ 出庫履歴詳細            │
├─────────────────────────┤
│ Transfer: #T0000        │
│ ステータス: IN_PROGRESS │
├─────────────────────────┤
│ 配送1（#T0000-1）       │
│ ステータス: IN_TRANSIT  │
│ 追跡: ヤマト 123456     │
│ ─────────────────────   │
│ 商品A × 5              │
│ 商品B × 3              │
│                         │
│ 配送2（#T0000-2）       │
│ ステータス: RECEIVED    │
│ ─────────────────────   │
│ 商品C × 2              │
│                         │
│ 配送3（#T0000-3）       │
│ ステータス: IN_TRANSIT  │
│ 追跡: 佐川 789012       │
│ ─────────────────────   │
│ 商品D × 1              │
└─────────────────────────┘
```

**実装詳細**:
- `fetchInventoryTransferDetailForHistory` で取得した `shipments` 配列をループ
- 各Shipmentごとに `fetchInventoryShipmentEnriched` で詳細を取得
- 各ShipmentのlineItemsを表示

**データ取得**:
```javascript
// 各Shipmentの詳細を並列取得
const shipmentDetails = await Promise.all(
  shipments.map(s => fetchInventoryShipmentEnriched(s.id, { includeImages: false }))
);
```

---

### Phase 2: 出庫処理での複数Shipment作成 ⚠️ 将来対応

#### 2.1 「配送分割」オプションの追加

**実装箇所**: 出庫確定モーダル（`CONFIRM_TRANSFER_MODAL_ID`）

**要件**:
- チェックボックス「配送を分割する」を追加
- デフォルトはOFF（既存動作を維持）
- ONにした場合、分割方法選択画面を表示

**UI配置**:
- 確定モーダル内の上部（宛先・明細情報の下）に配置

---

#### 2.2 分割方法の選択

**分割方法**:
1. **手動分割**（最優先実装）
   - 明細をドラッグ&ドロップで振り分け
   - または、各明細に「配送1」「配送2」などのラベルを付与
   - POS環境を考慮して、タッチ操作に最適化

2. **数量分割**（将来対応）
   - 同一商品を複数Shipmentに分割
   - 例: 商品A 100個 → 配送1: 50個、配送2: 50個

3. **配送先ごと**（将来対応）
   - 複数宛先がある場合（現状は1宛先のみ）

4. **配送方法ごと**（将来対応）
   - 配送会社が異なる場合（現状は1配送会社のみ）

---

#### 2.3 各Shipmentへのtracking情報設定

**要件**:
- 分割後、各Shipmentごとにtracking情報を個別設定
- 一括設定オプションも提供（全Shipmentに同じ情報を適用）

**実装**:
- 分割確認画面で、各Shipmentごとにtracking情報入力欄を表示
- または、分割後に個別に設定画面を表示

---

### Phase 3: 入庫処理での複数Shipment処理（まとめて表示モードで実現）✅ 実装済み

**注意**: Phase 1.4の「まとめて表示モード」で既に実現されるため、Phase 3は独立したフェーズではなく、Phase 1.4の一部として実装されます。

---

## 🔧 実装詳細

### 1. Shipment命名規則

```javascript
/**
 * Transfer名からShipmentラベルを生成
 * @param {string} transferName - Transfer名（例: "T0000"）
 * @param {number} index - Shipmentのインデックス（0始まり）
 * @returns {string} Shipmentラベル（例: "#T0000-1"）
 */
function formatShipmentLabel(transferName, index) {
  const base = transferName || "T0000";
  // Transfer名から末尾の数字部分を抽出（必要に応じて）
  // 例: "T0000" → "T0000"
  // 例: "Transfer #12345" → "12345"
  const match = base.match(/(\d+)$/);
  const numPart = match ? match[1] : base;
  return `#${numPart}-${index + 1}`;
}
```

### 2. Shipment詳細情報の取得

**GraphQLクエリ**:
```graphql
query ShipmentDetail($id: ID!) {
  inventoryShipment(id: $id) {
    id
    status
    tracking {
      company
      trackingNumber
      trackingUrl
      arrivesAt
    }
    lineItems(first: 250) {
      nodes {
        id
        quantity
        inventoryItem {
          id
          sku
        }
      }
    }
  }
}
```

**実装関数**:
```javascript
async function fetchShipmentDetail(shipmentId, opts = {}) {
  const includeImages = opts?.includeImages !== false;
  // 既存の fetchInventoryShipmentEnriched を拡張
}
```

### 3. InboundListの拡張（複数Shipment対応）

**状態管理の拡張**:
```javascript
// appState.inbound に追加
{
  // 既存（後方互換性のため残す）
  selectedShipmentId: "", // 1つの場合
  
  // 新規追加
  selectedShipmentIds: [], // 複数の場合（まとめて表示モード）
  shipmentMode: "single" | "multiple", // "single" | "multiple"
}
```

**InboundListの分岐処理**:
```javascript
function InboundList({ ... }) {
  const inbound = getStateSlice(appState, "inbound", {
    selectedShipmentId: "",
    selectedShipmentIds: [],
    shipmentMode: "single",
    // ... その他
  });
  
  const isMultipleMode = inbound.shipmentMode === "multiple" && 
                         Array.isArray(inbound.selectedShipmentIds) && 
                         inbound.selectedShipmentIds.length > 1;
  
  if (isMultipleMode) {
    // まとめて表示モード
    return <InboundListMultiple shipments={inbound.selectedShipmentIds} />;
  } else {
    // 既存の動作（1つのShipment）
    return <InboundListSingle shipmentId={inbound.selectedShipmentId} />;
  }
}
```

### 4. スキャン処理の拡張（まとめて表示モード）

**問題**: スキャンした商品がどのShipmentに属するか判定が必要

**解決策**:
1. **ShipmentごとにlineItemsを保持**
   - 各ShipmentのlineItemsを別々に管理
   - スキャン時に、どのShipmentのlineItemかを判定

2. **統合表示時の識別**
   - 各lineItemに `shipmentLabel` と `shipmentId` を付与
   - 表示時にShipmentごとにグループ化

**実装例**:
```javascript
// スキャン処理
const handleScan = (barcode) => {
  // 全ShipmentのlineItemsから該当商品を検索
  for (const shipment of shipmentDetails) {
    const lineItem = shipment.lineItems.find(li => 
      li.barcode === barcode || li.sku === barcode
    );
    if (lineItem) {
      // 該当Shipmentの数量を更新
      updateQuantity(shipment.id, lineItem.id, 1);
      return;
    }
  }
  // 見つからない場合は予定外入荷として処理
  handleUnplannedItem(barcode);
};
```

### 5. 受領処理の拡張（まとめて表示モード）

**実装**:
```javascript
const handleReceive = async () => {
  const results = [];
  
  for (const shipment of shipmentDetails) {
    try {
      const lineItems = buildReceiveLineItems(shipment.id);
      await inventoryShipmentReceive({
        id: shipment.id,
        lineItems,
      });
      results.push({ shipmentId: shipment.id, success: true });
    } catch (e) {
      results.push({ 
        shipmentId: shipment.id, 
        success: false, 
        error: e.message 
      });
    }
  }
  
  // 結果を表示
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  
  if (failCount === 0) {
    toast(`全${results.length}件のShipmentを受領しました`);
  } else {
    toast(`受領完了: ${successCount}件 / 失敗: ${failCount}件`);
  }
};
```

### 6. ステータス管理

**TransferステータスとShipmentステータスの関係**:
- Transferステータス: 全Shipmentの状態を反映
  - 全Shipmentが `RECEIVED` → Transferは `TRANSFERRED` に近い状態
  - 一部Shipmentが `IN_TRANSIT` → Transferは `IN_PROGRESS`
- Shipmentステータス: 個別に管理
  - 各Shipmentは独立してステータス遷移

### 7. エラーハンドリング

**複数Shipment受領時のエラー処理**:
```javascript
const results = [];
for (const shipmentId of selectedShipmentIds) {
  try {
    await inventoryShipmentReceive({ id: shipmentId, lineItems });
    results.push({ shipmentId, success: true });
  } catch (e) {
    results.push({ shipmentId, success: false, error: e.message });
  }
}

// 結果を表示
const successCount = results.filter(r => r.success).length;
const failCount = results.filter(r => !r.success).length;
```

---

## 📝 実装チェックリスト

### Phase 1: 複数Shipmentの読み込み・表示

#### 1.1 入庫一覧での表示
- [ ] `InboundConditions` でShipment数を表示
- [ ] Shipmentが2つ以上の場合のみ表示
- [ ] 後方互換性の確認（Shipmentが1つの場合）

#### 1.2 Shipment選択モーダル
- [ ] 新規モーダル `ShipmentModeSelectionModal` を作成
- [ ] Transfer選択後の分岐処理（Shipment数で判定）
- [ ] 「シップメントごとに選択」と「まとめて表示」の選択肢
- [ ] Shipmentが1つの場合は自動スキップ

#### 1.3 Shipment選択画面（シップメントごとに選択の場合）
- [ ] 新規コンポーネント `InboundShipmentSelection` を作成
- [ ] Shipment詳細情報の取得（GraphQLクエリ）
- [ ] Shipmentラベルの生成（`formatShipmentLabel`）
- [ ] 各Shipmentの情報表示（ステータス、追跡情報、数量）
- [ ] 「選択」ボタンで選択したShipment IDを `InboundList` に渡す

#### 1.4 まとめて表示モード（InboundList拡張）
- [ ] `InboundList` に `selectedShipmentIds` と `shipmentMode` を追加
- [ ] 複数Shipmentモードの分岐処理
- [ ] 全Shipmentの詳細情報を並列取得
- [ ] 各Shipmentをタイトルで区切って表示
- [ ] 各ShipmentのlineItemsを個別に表示
- [ ] スキャン処理の拡張（どのShipmentに属するか判定）
- [ ] カウント処理の拡張
- [ ] 一括受領処理の実装
- [ ] 受領結果の表示（成功/失敗を明確に）
- [ ] 監査ログへの複数Shipment情報記録

#### 1.5 履歴詳細での全Shipment表示
- [ ] `OutboundHistoryDetail` で全Shipmentを取得
- [ ] 各Shipmentの詳細情報を並列取得
- [ ] 各Shipmentをタイトルで区切って表示
- [ ] 各ShipmentのlineItemsを個別に表示
- [ ] Shipmentラベルの表示（#T0000-1形式）

---

### Phase 2: 出庫処理での複数Shipment作成（将来対応）

- [ ] 「配送分割」チェックボックスの追加
- [ ] 分割方法選択画面の実装
- [ ] 手動分割UIの実装
- [ ] 分割後の各Shipment作成処理
- [ ] 各Shipmentへのtracking情報設定
- [ ] 分割結果の確認画面

---

## 🎯 実装順序

### ステップ1: Phase 1.1（入庫一覧での表示）✅ 最優先
- **期間**: 1日
- **理由**: 最も簡単で、ユーザーに複数Shipmentの存在を認識させる

### ステップ2: Phase 1.2（Shipment選択モーダル）✅ 最優先
- **期間**: 1-2日
- **理由**: 複数Shipment対応の入り口となる

### ステップ3: Phase 1.3（Shipment選択画面）✅ 最優先
- **期間**: 2-3日
- **理由**: シップメントごとに選択する場合の処理

### ステップ4: Phase 1.4（まとめて表示モード）✅ 最優先
- **期間**: 1-2週間
- **理由**: 実務でよく使われる機能、最も複雑

### ステップ5: Phase 1.5（履歴詳細での全Shipment表示）✅ 最優先
- **期間**: 2-3日
- **理由**: 出庫側でも複数Shipmentを確認できるようにする

### ステップ6: Phase 2（出庫処理での複数Shipment作成）⚠️ 将来対応
- **期間**: 3-4週間
- **理由**: UI設計が複雑、需要が低い可能性

---

## 💡 設計上の考慮事項

### 1. 後方互換性
- Shipmentが1つの場合は既存の動作を維持
- 既存の `selectedShipmentId` は残す（後方互換性のため）
- 既存の `pickShipmentIdFromTransfer` は残す（フォールバック用）

### 2. パフォーマンス
- 複数ShipmentのlineItems取得は並列処理
- 軽量モード（liteMode）でも動作するように
- 大量のShipmentがある場合はページネーション検討

### 3. エラーハンドリング
- Shipment詳細取得時のエラーは個別に処理
- 一部Shipmentの取得失敗があっても、取得できた分は表示
- 受領処理の部分失敗も許容

### 4. UI/UX
- POS環境を考慮したシンプルなUI
- タッチ操作に最適化
- 視覚的に分かりやすい表示
- 選択モーダルで処理方法を明確に提示

### 5. 設計の複雑さを最小限に
- **選択モーダルで処理方法を明確に分岐**: ユーザーが選択するため、処理が明確
- **InboundListを拡張**: 既存のコンポーネントを再利用
- **状態管理を明確に**: `shipmentMode` で動作を切り替え
- **後方互換性を保つ**: 既存の動作を壊さない

---

## 📊 データ構造

### Transferオブジェクト（拡張後）
```typescript
type Transfer = {
  id: string;
  name: string;
  status: string;
  shipments: Shipment[]; // 複数Shipment対応
  // ... その他
};

type Shipment = {
  id: string;
  status: string;
  tracking?: {
    company?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    arrivesAt?: string;
  };
  lineItems?: ShipmentLineItem[];
  // 表示用
  label?: string; // "#T0000-1"
  totalQuantity?: number;
  itemCount?: number;
};
```

### appState.inbound（拡張後）
```typescript
type InboundState = {
  // 既存（後方互換性のため残す）
  selectedShipmentId: string;
  
  // 新規追加
  selectedShipmentIds: string[]; // 複数の場合
  shipmentMode: "single" | "multiple"; // 処理モード
  
  // その他（既存）
  selectedTransferId: string;
  selectedTransferName: string;
  // ...
};
```

---

## 🔗 関連ファイル

- `Modal.jsx`: メイン実装ファイル
  - `InboundConditions`: 入庫一覧
  - `InboundList`: 入庫明細（拡張必要）
  - `OutboundHistoryDetail`: 出庫履歴詳細
- GraphQLクエリ関数:
  - `fetchTransfersForDestinationAll`: 入庫予定一覧取得
  - `fetchInventoryTransferDetailForHistory`: 履歴詳細取得
  - `fetchInventoryShipmentEnriched`: Shipment詳細取得（拡張必要）

---

## ✅ 完了条件

### Phase 1完了の定義
- [ ] 入庫一覧でShipment数が表示される
- [ ] Shipmentが2つ以上ある場合、選択モーダルが表示される
- [ ] 「シップメントごとに選択」でShipment選択画面が表示される
- [ ] 「まとめて表示」で全Shipmentが1画面で表示される
- [ ] まとめて表示モードでスキャン・カウント処理ができる
- [ ] まとめて表示モードで一括受領処理ができる
- [ ] Shipmentが1つの場合、既存の動作が維持される
- [ ] 履歴詳細で全Shipmentが表示される
- [ ] 全ての動作が正常に機能する

---

## 🎯 設計の複雑さについて

### 懸念点
- 選択モーダルが追加される
- `InboundList` が複数Shipment対応で複雑になる
- スキャン処理でどのShipmentに属するか判定が必要

### 解決策
1. **選択モーダルで処理を明確に分岐**
   - ユーザーが処理方法を選択するため、処理が明確
   - コードの分岐も明確になる

2. **InboundListの拡張を最小限に**
   - `shipmentMode` で動作を切り替え
   - 既存の処理を再利用
   - 複数Shipmentモードは別関数として分離

3. **段階的な実装**
   - Phase 1.1 → 1.2 → 1.3 → 1.4 → 1.5 の順で実装
   - 各ステップで動作確認

4. **後方互換性の維持**
   - 既存の動作を壊さない
   - 既存の状態管理を残す

**結論**: 設計はやや複雑になりますが、選択モーダルで処理を明確に分岐することで、実装と保守がしやすくなります。段階的な実装でリスクを最小化できます。

---

この要件書に基づいて、段階的に複数Shipment対応を実装していきます。
