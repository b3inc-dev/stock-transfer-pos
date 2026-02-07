# InboundList（複数Shipmentモード）実装上の懸念点

## 📋 現状の実装確認

### 現在のInboundListの構造

1. **状態管理**
   - `selectedShipmentId`: 1つのShipment ID
   - `shipment`: 1つのShipmentオブジェクト
   - `rows`: 1つのShipmentのlineItems（`shipmentLineItemId`で識別）
   - `extras`: 予定外入荷の商品リスト

2. **スキャン処理**
   - `addOrIncrementByResolved`: `rows`から該当商品を検索して数量を更新
   - 見つからない場合は `extras` に追加（予定外入荷）

3. **受領処理**
   - `inventoryShipmentReceive`: 1つのShipmentを受領
   - `rows` と `extras` から受領データを構築

---

## ⚠️ 主な懸念点

### 1. スキャン処理の複雑さ 🔴 重要

**問題**:
- 現在の `addOrIncrementByResolved` は、1つのShipmentの `rows` に対して処理している
- 複数Shipmentの場合、スキャンした商品がどのShipmentに属するか判定が必要

**具体例**:
```
Shipment 1: 商品A × 5
Shipment 2: 商品A × 3
```
商品Aをスキャンした場合、どちらのShipmentの数量を更新するか？

**解決策の選択肢**:

#### 選択肢A: 最初に見つかったShipmentに追加（シンプル）
```javascript
const addOrIncrementByResolvedMultiple = (resolved, incBy) => {
  // 全Shipmentのrowsから検索
  for (const shipmentRows of allShipmentRows) {
    const hit = shipmentRows.find(r => 
      r.inventoryItemId === resolved.inventoryItemId ||
      r.variantId === resolved.variantId
    );
    if (hit) {
      // 最初に見つかったShipmentの数量を更新
      updateQuantity(shipmentRows, hit, incBy);
      return;
    }
  }
  // 見つからない場合は予定外入荷
  addToExtras(resolved, incBy);
};
```

**メリット**:
- 実装がシンプル
- ユーザー操作が少ない

**デメリット**:
- ユーザーが意図しないShipmentに追加される可能性
- 複数Shipmentに同じ商品がある場合、どれに追加されたか分かりにくい

#### 選択肢B: ユーザーに選択させる（明確）
```javascript
const addOrIncrementByResolvedMultiple = async (resolved, incBy) => {
  // 全Shipmentのrowsから検索
  const matches = [];
  for (const [shipmentId, shipmentRows] of allShipmentRows) {
    const hit = shipmentRows.find(r => 
      r.inventoryItemId === resolved.inventoryItemId ||
      r.variantId === resolved.variantId
    );
    if (hit) {
      matches.push({ shipmentId, shipmentLabel, row: hit });
    }
  }
  
  if (matches.length === 0) {
    // 予定外入荷
    addToExtras(resolved, incBy);
    return;
  }
  
  if (matches.length === 1) {
    // 1つだけなら自動で追加
    updateQuantity(matches[0].shipmentId, matches[0].row, incBy);
    return;
  }
  
  // 複数見つかった場合はユーザーに選択させる
  const selected = await dialog.select({
    title: "どのShipmentに追加しますか？",
    options: matches.map(m => ({
      label: `${m.shipmentLabel}: ${m.row.title}（予定: ${m.row.plannedQty}）`,
      value: m.shipmentId,
    })),
  });
  
  if (selected) {
    const match = matches.find(m => m.shipmentId === selected);
    updateQuantity(match.shipmentId, match.row, incBy);
  }
};
```

**メリット**:
- ユーザーが意図したShipmentに追加できる
- 明確

**デメリット**:
- スキャン速度が落ちる（選択が必要）
- 実装が複雑

#### 選択肢C: 表示順で自動判定（バランス）
```javascript
const addOrIncrementByResolvedMultiple = (resolved, incBy) => {
  // 全Shipmentのrowsから検索（表示順で検索）
  // 最初に見つかったShipmentに追加
  // ただし、UIで「どのShipmentに追加されたか」を視覚的に表示
  for (const [shipmentId, shipmentRows] of allShipmentRows) {
    const hit = shipmentRows.find(r => 
      r.inventoryItemId === resolved.inventoryItemId ||
      r.variantId === resolved.variantId
    );
    if (hit) {
      updateQuantity(shipmentId, hit, incBy);
      // 視覚的フィードバック（該当行をハイライト）
      highlightRow(shipmentId, hit.key);
      toast(`${shipmentLabel} に追加しました`);
      return;
    }
  }
  addToExtras(resolved, incBy);
};
```

**メリット**:
- 実装が比較的シンプル
- 視覚的フィードバックで分かりやすい

**デメリット**:
- ユーザーが意図しないShipmentに追加される可能性（選択肢Aと同じ）

**推奨**: **選択肢C（表示順で自動判定 + 視覚的フィードバック）**
- 実装が比較的シンプル
- ユーザー体験も悪くない
- 必要に応じて後から選択肢Bに拡張可能

---

### 2. 数量管理の複雑さ 🔴 重要

**問題**:
- 現在の `rows` は `shipmentLineItemId` で識別されているが、これは1つのShipment前提
- 複数Shipmentの場合、各Shipmentごとに `rows` を管理する必要がある

**解決策**:

#### 選択肢A: `rows` に `shipmentId` と `shipmentLabel` を付与
```javascript
const rows = [
  {
    key: "li-1",
    shipmentLineItemId: "li-1",
    shipmentId: "shipment-1",        // 追加
    shipmentLabel: "#T0000-1",      // 追加
    inventoryItemId: "item-1",
    title: "商品A",
    plannedQty: 5,
    receiveQty: 3,
  },
  {
    key: "li-2",
    shipmentLineItemId: "li-2",
    shipmentId: "shipment-2",        // 追加
    shipmentLabel: "#T0000-2",      // 追加
    inventoryItemId: "item-1",      // 同じ商品
    title: "商品A",
    plannedQty: 3,
    receiveQty: 1,
  },
];
```

**メリット**:
- 既存の `rows` の構造を拡張するだけ
- 既存の処理（数量更新、表示など）をそのまま使える

**デメリット**:
- 同一商品が複数Shipmentにある場合、表示が分かりにくい可能性

**推奨**: **選択肢A（`rows` に `shipmentId` と `shipmentLabel` を付与）**

---

### 3. 受領処理の複雑さ 🟡 中程度

**問題**:
- 現在は `inventoryShipmentReceive` で1つのShipmentを受領
- 複数Shipmentの場合、各Shipmentごとに受領処理を実行
- エラーハンドリングが複雑（一部成功、一部失敗）

**解決策**:

```javascript
const handleReceiveMultiple = async () => {
  const results = [];
  
  // 各Shipmentごとに受領処理
  for (const shipmentId of selectedShipmentIds) {
    try {
      // 該当Shipmentのrowsとextrasを取得
      const shipmentRows = rows.filter(r => r.shipmentId === shipmentId);
      const shipmentExtras = extras.filter(e => e.shipmentId === shipmentId);
      
      // 受領データを構築
      const lineItems = buildReceiveLineItems(shipmentRows, shipmentExtras);
      
      // 受領処理
      await inventoryShipmentReceive({
        id: shipmentId,
        lineItems,
      });
      
      results.push({ shipmentId, success: true });
    } catch (e) {
      results.push({ 
        shipmentId, 
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
    // 失敗したShipmentを明確に表示
    const failedShipments = results
      .filter(r => !r.success)
      .map(r => getShipmentLabel(r.shipmentId))
      .join(", ");
    toast(`受領完了: ${successCount}件 / 失敗: ${failCount}件\n失敗: ${failedShipments}`);
  }
};
```

**懸念点**:
- トランザクション性: 一部成功、一部失敗の場合の処理
- 監査ログ: 複数Shipmentの情報をどう記録するか

**解決策**:
- 部分的な成功も許容（実務的にはこれで問題ない）
- 監査ログには各Shipmentごとに記録

---

### 4. 状態管理の複雑さ 🟡 中程度

**問題**:
- 現在は `selectedShipmentId` で1つのShipmentを管理
- 複数Shipmentの場合、`selectedShipmentIds` 配列で管理
- `rows` と `extras` にShipment情報を付与する必要がある

**解決策**:

```javascript
// appState.inbound に追加
{
  // 既存（後方互換性のため残す）
  selectedShipmentId: "",
  
  // 新規追加
  selectedShipmentIds: [], // 複数の場合
  shipmentMode: "single" | "multiple", // 処理モード
}

// InboundList内で分岐
const isMultipleMode = inbound.shipmentMode === "multiple" && 
                       Array.isArray(inbound.selectedShipmentIds) && 
                       inbound.selectedShipmentIds.length > 1;

if (isMultipleMode) {
  // 複数Shipmentモード
  const selectedShipmentIds = inbound.selectedShipmentIds;
  // 全Shipmentのデータを取得
  const allShipments = await Promise.all(
    selectedShipmentIds.map(id => fetchInventoryShipmentEnriched(id))
  );
  // rowsにshipmentIdとshipmentLabelを付与
  const rows = allShipments.flatMap((shipment, index) => {
    const label = formatShipmentLabel(transferName, index);
    return (shipment.lineItems || []).map(li => ({
      ...li,
      shipmentId: shipment.id,
      shipmentLabel: label,
    }));
  });
} else {
  // 既存の動作（1つのShipment）
}
```

**懸念点**:
- 既存のコードとの整合性
- 後方互換性の維持

**解決策**:
- `selectedShipmentId` は残す（後方互換性）
- `shipmentMode` で動作を切り替え
- 既存の処理をできるだけ再利用

---

### 5. パフォーマンス 🟡 中程度

**問題**:
- 複数ShipmentのlineItemsを大量に取得・表示する際のパフォーマンス
- スキャン処理の速度

**解決策**:
- 並列取得: `Promise.all` で複数Shipmentを並列取得
- ページネーション: 既存の `lineItemsPageInfo` を活用
- 軽量モード: `liteMode` で画像取得をスキップ

**懸念点**:
- 大量のShipment（10件以上）がある場合のパフォーマンス

**解決策**:
- 実用的には3-5件程度が想定されるため、問題ないと想定
- 必要に応じて仮想スクロールを検討

---

### 6. UI/UXの複雑さ 🟢 低

**問題**:
- 複数Shipmentを1画面で表示する際の見やすさ
- どのShipmentに属するか分かりやすく表示

**解決策**:
- 各Shipmentをタイトルで区切る（例: "配送1（#T0000-1）"）
- 視覚的に分かりやすい区切り線
- Shipmentごとに背景色を変える（オプション）

**懸念点**:
- 画面が長くなる可能性

**解決策**:
- スクロール可能にする
- 必要に応じて折りたたみ機能を追加

---

### 7. 監査ログの複雑さ 🟡 中程度

**問題**:
- 現在の監査ログは1つのShipment前提
- 複数Shipmentの場合、各Shipmentごとに記録する必要がある

**解決策**:
- 各Shipmentごとに監査ログを記録
- 既存の `writeInboundAuditLog` をそのまま使用（各Shipmentごとに呼び出し）

**懸念点**:
- 監査ログの構造を変更する必要があるか？

**解決策**:
- 既存の構造を維持（各Shipmentごとに記録）
- 必要に応じて `shipmentIds` 配列を記録

---

## 🎯 推奨される実装方針

### 1. スキャン処理
- **選択肢C（表示順で自動判定 + 視覚的フィードバック）** を採用
- 必要に応じて後から選択肢B（ユーザー選択）に拡張可能

### 2. 数量管理
- **`rows` に `shipmentId` と `shipmentLabel` を付与**
- 既存の処理をそのまま使える

### 3. 受領処理
- **各Shipmentごとに順次受領**
- 部分的な成功も許容
- 結果を明確に表示

### 4. 状態管理
- **`shipmentMode` で動作を切り替え**
- 既存の `selectedShipmentId` は残す（後方互換性）

### 5. パフォーマンス
- **並列取得を活用**
- 実用的な範囲（3-5件）では問題ないと想定

### 6. UI/UX
- **各Shipmentをタイトルで区切る**
- 視覚的に分かりやすく表示

### 7. 監査ログ
- **各Shipmentごとに記録**
- 既存の構造を維持

---

## 📝 実装時の注意点

1. **後方互換性の維持**
   - 既存の `selectedShipmentId` は残す
   - 既存の処理をできるだけ再利用

2. **段階的な実装**
   - まずは基本的な機能を実装
   - 必要に応じて拡張

3. **エラーハンドリング**
   - 部分的な成功も許容
   - エラーを明確に表示

4. **テスト**
   - 1つのShipmentの場合（既存動作）
   - 複数Shipmentの場合（新規動作）
   - エラーケース

---

## ✅ 結論

**懸念点はあるが、実装可能**

主な懸念点：
1. **スキャン処理**: 選択肢C（表示順で自動判定 + 視覚的フィードバック）で解決
2. **数量管理**: `rows` に `shipmentId` と `shipmentLabel` を付与で解決
3. **受領処理**: 各Shipmentごとに順次受領で解決

**実装の複雑さ**: 中程度
- 既存のコードを拡張する形で実装可能
- 後方互換性を維持しながら実装可能

**推奨**: 段階的に実装
1. Phase 1.4の基本的な機能を実装
2. 動作確認
3. 必要に応じて拡張（スキャン時の選択機能など）
