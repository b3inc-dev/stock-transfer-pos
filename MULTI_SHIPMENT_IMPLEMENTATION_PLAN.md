# InboundList（複数Shipmentモード）実装方針

## 📋 実装方針の比較

### 選択肢A: 既存のInboundListを拡張 ✅ 推奨

**アプローチ**:
- 既存の `InboundList` コンポーネント内で `shipmentMode` による条件分岐を追加
- 複数Shipmentモードの場合、既存のロジックを拡張して使用

**メリット**:
1. **コードの重複を避けられる**: 既存のロジック（スキャン処理、数量管理、受領処理など）を再利用
2. **一貫性**: 同じコンポーネント内で動作が統一される
3. **メンテナンス性**: 修正が1箇所で済む
4. **後方互換性**: 既存の動作を壊さない（`shipmentMode` で分岐）

**デメリット**:
1. **コンポーネントが大きくなる**: 既に2000行以上あるため、さらに複雑になる可能性
2. **条件分岐が増える**: `shipmentMode` による分岐が各所に必要

**実装イメージ**:
```javascript
function InboundList({ ... }) {
  const inbound = getStateSlice(appState, "inbound", {
    selectedShipmentId: "",
    selectedShipmentIds: [],      // 新規追加
    shipmentMode: "single",       // 新規追加: "single" | "multiple"
    // ...
  });
  
  const isMultipleMode = inbound.shipmentMode === "multiple" && 
                         Array.isArray(inbound.selectedShipmentIds) && 
                         inbound.selectedShipmentIds.length > 1;
  
  // データ取得の分岐
  useEffect(() => {
    if (isMultipleMode) {
      // 複数Shipmentモード: 全Shipmentを並列取得
      const loadMultipleShipments = async () => {
        const shipments = await Promise.all(
          inbound.selectedShipmentIds.map(id => 
            fetchInventoryShipmentEnriched(id, { includeImages: showImages && !liteMode })
          )
        );
        // rowsにshipmentIdとshipmentLabelを付与
        const allRows = shipments.flatMap((shipment, index) => {
          const label = formatShipmentLabel(inbound.selectedTransferName, index);
          return (shipment.lineItems || []).map(li => ({
            ...li,
            shipmentId: shipment.id,
            shipmentLabel: label,
          }));
        });
        setRows(allRows);
      };
      loadMultipleShipments();
    } else {
      // 既存の動作（1つのShipment）
      if (!selectedShipmentId) return;
      loadShipment(selectedShipmentId);
    }
  }, [isMultipleMode, selectedShipmentId, inbound.selectedShipmentIds, ...]);
  
  // スキャン処理の拡張
  const addOrIncrementByResolved = useCallback((resolved, delta = 1, opts = {}) => {
    if (isMultipleMode) {
      // 複数Shipmentモード: 表示順で検索
      const curRows = rowsRef.current || [];
      const hitRow = curRows.find((r) => 
        r.inventoryItemId === resolved.inventoryItemId
      );
      if (hitRow) {
        incRow(hitRow.key, delta);
        // 視覚的フィードバック
        toast(`${hitRow.shipmentLabel} に追加しました`);
        return;
      }
      // 予定外入荷処理（既存と同じ）
      // ...
    } else {
      // 既存の動作（1つのShipment）
      // ...
    }
  }, [isMultipleMode, ...]);
  
  // 受領処理の拡張
  const receiveConfirm = useCallback(async ({ finalize = true } = {}) => {
    if (isMultipleMode) {
      // 複数Shipmentモード: 各Shipmentごとに受領
      const results = [];
      for (const shipmentId of inbound.selectedShipmentIds) {
        try {
          const shipmentRows = rows.filter(r => r.shipmentId === shipmentId);
          const shipmentExtras = extras.filter(e => e.shipmentId === shipmentId);
          const lineItems = buildReceiveLineItems(shipmentRows, shipmentExtras);
          await inventoryShipmentReceive({ id: shipmentId, lineItems });
          results.push({ shipmentId, success: true });
        } catch (e) {
          results.push({ shipmentId, success: false, error: e.message });
        }
      }
      // 結果表示
      // ...
    } else {
      // 既存の動作（1つのShipment）
      // ...
    }
  }, [isMultipleMode, ...]);
  
  // 表示の分岐
  return (
    <s-box padding="base">
      {isMultipleMode ? (
        // 複数Shipmentモード: 各Shipmentをタイトルで区切って表示
        <s-stack gap="base">
          {groupRowsByShipment(rows).map((group, index) => (
            <s-box key={group.shipmentId}>
              <s-text emphasis="bold">{group.shipmentLabel}</s-text>
              <s-divider />
              {group.rows.map(row => (
                <InboundRow key={row.key} row={row} ... />
              ))}
            </s-box>
          ))}
        </s-stack>
      ) : (
        // 既存の表示（1つのShipment）
        // ...
      )}
    </s-box>
  );
}
```

---

### 選択肢B: 別コンポーネントを作成

**アプローチ**:
- `InboundListMultiple` のような別コンポーネントを作成
- 既存の `InboundList` はそのまま維持

**メリット**:
1. **既存コードを壊さない**: 既存の `InboundList` に影響しない
2. **シンプルな実装**: 複数Shipmentモード専用のシンプルな実装
3. **テストが容易**: 独立したコンポーネントとしてテスト可能

**デメリット**:
1. **コードの重複**: 既存のロジック（スキャン処理、数量管理、受領処理など）をコピーする必要がある
2. **メンテナンス性**: 修正が2箇所に必要（既存と新規）
3. **一貫性**: 2つのコンポーネントで動作が異なる可能性

**実装イメージ**:
```javascript
// 既存のInboundList（変更なし）
function InboundList({ ... }) {
  // 既存の実装
}

// 新規: 複数Shipmentモード専用
function InboundListMultiple({ ... }) {
  // 複数Shipmentモード専用の実装
  // 既存のInboundListのロジックをコピーして拡張
}

// ルーティング
if (screen === SCREENS.INBOUND_LIST) {
  const isMultipleMode = inbound.shipmentMode === "multiple" && 
                         Array.isArray(inbound.selectedShipmentIds) && 
                         inbound.selectedShipmentIds.length > 1;
  
  body = isMultipleMode ? (
    <InboundListMultiple ... />
  ) : (
    <InboundList ... />
  );
}
```

---

## 🎯 推奨: 選択肢A（既存のInboundListを拡張）

### 理由

1. **コードの重複を避けられる**
   - 既存のロジック（スキャン処理、数量管理、受領処理など）を再利用
   - メンテナンス性が高い

2. **一貫性**
   - 同じコンポーネント内で動作が統一される
   - ユーザー体験が一貫する

3. **後方互換性**
   - 既存の動作を壊さない（`shipmentMode` で分岐）
   - 既存の `selectedShipmentId` は残す

4. **実装の複雑さ**
   - 条件分岐は必要だが、既存のロジックをそのまま使える
   - 別コンポーネントを作るよりシンプル

### 実装のポイント

1. **早期リターンで分岐を明確に**
   ```javascript
   const isMultipleMode = ...;
   
   // 複数Shipmentモードの場合
   if (isMultipleMode) {
     // 複数Shipmentモード専用の処理
     return <MultipleModeView ... />;
   }
   
   // 既存の動作（1つのShipment）
   // ...
   ```

2. **共通ロジックの抽出**
   ```javascript
   // 共通の数量更新ロジック
   const incRow = (key, delta) => {
     // 既存のロジック（複数Shipmentモードでも使用）
   };
   
   // 共通のスキャン処理（拡張）
   const addOrIncrementByResolved = useCallback((resolved, delta = 1, opts = {}) => {
     if (isMultipleMode) {
       // 複数Shipmentモード用の拡張
     } else {
       // 既存の動作
     }
   }, [isMultipleMode, ...]);
   ```

3. **状態管理の拡張**
   ```javascript
   const inbound = getStateSlice(appState, "inbound", {
     // 既存（後方互換性のため残す）
     selectedShipmentId: "",
     
     // 新規追加
     selectedShipmentIds: [],
     shipmentMode: "single", // "single" | "multiple"
   });
   ```

4. **表示の分岐**
   ```javascript
   // 複数Shipmentモード: 各Shipmentをタイトルで区切って表示
   const groupRowsByShipment = (rows) => {
     const groups = new Map();
     rows.forEach(row => {
       const shipmentId = row.shipmentId;
       if (!groups.has(shipmentId)) {
         groups.set(shipmentId, {
           shipmentId,
           shipmentLabel: row.shipmentLabel,
           rows: [],
         });
       }
       groups.get(shipmentId).rows.push(row);
     });
     return Array.from(groups.values());
   };
   ```

---

## 📝 実装ステップ

### Step 1: 状態管理の拡張
- [ ] `appState.inbound` に `selectedShipmentIds` と `shipmentMode` を追加
- [ ] 既存の `selectedShipmentId` は残す（後方互換性）

### Step 2: データ取得の拡張
- [ ] `isMultipleMode` の判定ロジックを追加
- [ ] 複数Shipmentモードの場合、全Shipmentを並列取得
- [ ] `rows` に `shipmentId` と `shipmentLabel` を付与

### Step 3: スキャン処理の拡張
- [ ] `addOrIncrementByResolved` を拡張
- [ ] 複数Shipmentモードの場合、表示順で検索
- [ ] 視覚的フィードバックを追加

### Step 4: 受領処理の拡張
- [ ] `receiveConfirm` を拡張
- [ ] 複数Shipmentモードの場合、各Shipmentごとに受領
- [ ] エラーハンドリングと結果表示

### Step 5: 表示の拡張
- [ ] `groupRowsByShipment` 関数を追加
- [ ] 複数Shipmentモードの場合、各Shipmentをタイトルで区切って表示
- [ ] 既存の表示はそのまま維持

### Step 6: テスト
- [ ] 1つのShipmentの場合（既存動作）
- [ ] 複数Shipmentの場合（新規動作）
- [ ] エラーケース

---

## ✅ 結論

**推奨: 選択肢A（既存のInboundListを拡張）**

- コードの重複を避けられる
- 既存のロジックを再利用できる
- メンテナンス性が高い
- 後方互換性を維持できる

**実装の複雑さ**: 中程度
- 条件分岐は必要だが、既存のロジックをそのまま使える
- 段階的に実装することで、リスクを最小化できる
