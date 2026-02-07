# 入庫商品リスト（InboundListScreen）と Modal_REFERENCE.jsx の差分

## 概要

このドキュメントは、`extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx` と `extensions/stock-transfer-tile/src/Modal_REFERENCE.jsx` の `InboundList` 関数の差分を明確にまとめたものです。

---

## 1. `loadShipment` 関数の差分

### Modal_REFERENCE.jsx (8509-8644行目)

**特徴:**
- `async` 関数（`useCallback` でラップされていない）
- `AbortController` の `signal` パラメータを受け取る
- `safeSet` 関数を使用して state 更新を安全に実行
- **同期処理**: 監査ログを事前に取得して `overAcceptedQty` を計算してから `baseRows` を作成
- `alreadyRejectedQty` フィールドを含む

**処理フロー:**
1. `safeSet` で初期化（state クリア、`setShipmentLoading(true)`）
2. `fetchInventoryShipmentEnriched` で shipment を取得
3. **監査ログを取得** (`readInboundAuditLog`, `buildInboundOverItemIndex_`)
4. `baseRows` を作成（この時点で `overAcceptedQty` と `alreadyRejectedQty` を含む）
5. 下書きを読み込んで `baseRows` を更新
6. `safeSet` で `setRows(baseRows)` を実行
7. `finally` で `setShipmentLoading(false)`

**コード例:**
```javascript
const loadShipment = async (id, { signal } = {}) => {
  // ...
  safeSet(() => {
    setShipmentLoading(true);
    // ...
  }, signal);
  
  try {
    const shipmentResult = await fetchInventoryShipmentEnriched(shipmentId, {
      includeImages: showImages && !liteMode,
      signal,
    });
    
    // 監査ログを事前に取得
    let overByInventoryItemId = new Map();
    try {
      const audit = await readInboundAuditLog();
      overByInventoryItemId = buildInboundOverItemIndex_(audit, {
        locationId: locationGid,
        shipmentId: s?.id,
      });
    } catch (_) {
      overByInventoryItemId = new Map();
    }
    
    // baseRows を作成（overAcceptedQty を含む）
    const baseRows = (s.lineItems ?? []).map((li) => {
      const alreadyRejectedQty = Math.max(0, Number(li.rejectedQuantity ?? 0));
      const overAcceptedQty = Math.max(0, Math.floor(Number(inventoryItemId ? overByInventoryItemId.get(String(inventoryItemId)) || 0 : 0)));
      return {
        // ...
        alreadyRejectedQty,
        overAcceptedQty,
        // ...
      };
    });
    
    // 下書きを読み込んで baseRows を更新
    // ...
    
    safeSet(() => {
      setRows(baseRows);
      // ...
    }, signal);
  } catch (e) {
    if (signal?.aborted) return;
    safeSet(() => setShipmentError(toUserMessage(e)), signal);
  } finally {
    safeSet(() => setShipmentLoading(false), signal);
  }
};
```

### InboundListScreen.jsx (172-261行目)

**特徴:**
- `useCallback` でラップされた関数
- `AbortController` を使用していない
- `safeSet` を使用していない
- **二相ロード**: 先に `baseRows` を表示し、その後非同期で `overAcceptedQty` を更新
- `alreadyRejectedQty` フィールドを含まない

**処理フロー:**
1. 初期化（state クリア、`setShipmentLoading(true)`）
2. `fetchInventoryShipmentEnriched` で shipment を取得
3. `baseRows` を作成（`overAcceptedQty = 0` で初期化）
4. 下書きを読み込んで `baseRows` を更新
5. `setRows(baseRows)` を実行
6. `setShipmentLoading(false)` を実行
7. **非同期で監査ログを取得**して `overAcceptedQty` を更新

**コード例:**
```javascript
const loadShipment = useCallback(async () => {
  // ...
  setShipmentLoading(true);
  // ...
  try {
    const shipmentResult = await fetchInventoryShipmentEnriched(selectedShipmentId, {
      includeImages: showImages && !liteMode,
      first: productFirst,
    });
    
    // baseRows を作成（overAcceptedQty = 0）
    const baseRows = (s.lineItems ?? []).map((li) => {
      const overAcceptedQty = 0; // 初期値
      return {
        // ...
        overAcceptedQty,
        // alreadyRejectedQty なし
        // ...
      };
    });
    
    // 下書きを読み込んで baseRows を更新
    // ...
    
    setRows(baseRows);
    setShipment(s);
    setShipmentLoading(false);
    
    // 非同期で監査ログを取得して更新
    try {
      const audit = await readInboundAuditLog();
      const overByInventoryItemId = buildInboundOverItemIndex_(audit, {
        locationId: locationGid,
        shipmentId: s?.id,
      });
      setRows((prev) => prev.map((r) => {
        const overAcceptedQty = Math.max(0, Math.floor(Number(r.inventoryItemId ? overByInventoryItemId.get(String(r.inventoryItemId)) || 0 : 0)));
        return { ...r, overAcceptedQty };
      }));
    } catch (_) {}
  } catch (e) {
    setShipmentError(toUserMessage(e));
    setShipmentLoading(false);
  }
}, [selectedShipmentId, locationGid, transferId, showImages, liteMode, productFirst]);
```

---

## 2. `loadMultipleShipments` 関数の差分

### Modal_REFERENCE.jsx (8657-8801行目)

**特徴:**
- `useCallback` でラップされた関数
- `AbortController` の `signal` パラメータを受け取る
- `safeSet` 関数を使用
- **同期処理**: 監査ログを事前に取得して `overAcceptedQty` を計算
- `alreadyRejectedQty` フィールドを含む

**処理フロー:**
1. `safeSet` で初期化
2. `Promise.all` で全 shipment を並列取得
3. **監査ログを取得**して `overByInventoryItemId` を作成
4. `allRows` を作成（この時点で `overAcceptedQty` と `alreadyRejectedQty` を含む）
5. 下書きを読み込んで `allRows` を更新
6. `safeSet` で `setRows(allRows)` を実行

**コード例:**
```javascript
const loadMultipleShipments = useCallback(async (shipmentIds, { signal } = {}) => {
  safeSet(() => {
    setShipmentLoading(true);
    // ...
  }, signal);
  
  try {
    const shipmentResults = await Promise.all(
      shipmentIds.map(id => 
        fetchInventoryShipmentEnriched(id, {
          includeImages: showImages && !liteMode,
          signal,
        })
      )
    );
    
    // 監査ログを事前に取得
    let overByInventoryItemId = new Map();
    try {
      const audit = await readInboundAuditLog();
      shipmentIds.forEach(shipmentId => {
        const itemOver = buildInboundOverItemIndex_(audit, {
          locationId: locationGid,
          shipmentId,
        });
        itemOver.forEach((value, key) => {
          overByInventoryItemId.set(key, (overByInventoryItemId.get(key) || 0) + value);
        });
      });
    } catch (_) {
      overByInventoryItemId = new Map();
    }
    
    // allRows を作成（overAcceptedQty を含む）
    const allRows = shipmentResults.flatMap((s, index) => {
      return (s.lineItems ?? []).map((li) => {
        const alreadyRejectedQty = Math.max(0, Number(li.rejectedQuantity ?? 0));
        const overAcceptedQty = Math.max(0, Math.floor(Number(inventoryItemId ? overByInventoryItemId.get(String(inventoryItemId)) || 0 : 0)));
        return {
          // ...
          alreadyRejectedQty,
          overAcceptedQty,
          // ...
        };
      });
    });
    
    safeSet(() => {
      setRows(allRows);
      // ...
    }, signal);
  } catch (e) {
    if (signal?.aborted) return;
    safeSet(() => setShipmentError(toUserMessage(e)), signal);
  } finally {
    safeSet(() => setShipmentLoading(false), signal);
  }
}, [showImages, liteMode, locationGid, inbound?.selectedTransferName, formatShipmentLabelLocal]);
```

### InboundListScreen.jsx (270-371行目)

**特徴:**
- `useCallback` でラップされた関数
- `AbortController` を使用していない
- `safeSet` を使用していない
- **二相ロード**: 先に `allRows` を表示し、その後非同期で `overAcceptedQty` を更新
- `alreadyRejectedQty` フィールドを含まない

**処理フロー:**
1. 初期化
2. `Promise.all` で全 shipment を並列取得
3. `allRows` を作成（`overAcceptedQty = 0` で初期化）
4. 下書きを読み込んで `allRows` を更新
5. `setRows(allRows)` を実行
6. `setShipmentLoading(false)` を実行
7. **非同期で監査ログを取得**して `overAcceptedQty` を更新

**コード例:**
```javascript
const loadMultipleShipments = useCallback(async (shipmentIds) => {
  // ...
  setShipmentLoading(true);
  // ...
  try {
    const results = await Promise.all(
      shipmentIds.map((id) =>
        fetchInventoryShipmentEnriched(id, {
          includeImages: showImages && !liteMode,
          first: productFirst,
        })
      )
    );
    
    // allRows を作成（overAcceptedQty = 0）
    const allRows = results.flatMap((s, index) => {
      return (s.lineItems ?? []).map((li) => {
        const overAcceptedQty = 0; // 初期値
        return {
          // ...
          overAcceptedQty,
          // alreadyRejectedQty なし
          // ...
        };
      });
    });
    
    // 下書きを読み込んで allRows を更新
    // ...
    
    setRows(allRows);
    setShipment(results[0] || null);
    setShipmentLoading(false);
    
    // 非同期で監査ログを取得して更新
    try {
      const audit = await readInboundAuditLog();
      let overByInventoryItemId = new Map();
      shipmentIds.forEach((sid) => {
        const itemOver = buildInboundOverItemIndex_(audit, { locationId: locationGid, shipmentId: sid });
        itemOver.forEach((value, key) => {
          overByInventoryItemId.set(key, (overByInventoryItemId.get(key) || 0) + value);
        });
      });
      setRows((prev) => prev.map((r) => {
        const overAcceptedQty = Math.max(0, Math.floor(Number(r.inventoryItemId ? overByInventoryItemId.get(String(r.inventoryItemId)) || 0 : 0)));
        return { ...r, overAcceptedQty };
      }));
    } catch (_) {}
  } catch (e) {
    setShipmentError(toUserMessage(e));
    setShipmentLoading(false);
  }
}, [locationGid, transferId, inbound?.selectedTransferName, showImages, liteMode, productFirst, formatShipmentLabelLocal]);
```

---

## 3. `loadMoreLineItems_` 関数の差分

### Modal_REFERENCE.jsx (8848-8931行目)

**特徴:**
- `AbortController` を使用
- `alreadyRejectedQty` フィールドを含む
- 監査ログを事前に取得して `overAcceptedQty` を計算

**コード例:**
```javascript
const loadMoreLineItems_ = useCallback(async () => {
  // ...
  setLoadingMore(true);
  const ac = new AbortController();
  try {
    const shipmentResult = await fetchInventoryShipmentEnriched(selectedShipmentId, {
      includeImages: showImages && !liteMode,
      after: lineItemsPageInfo.endCursor,
      signal: ac.signal,
    });
    
    // 監査ログを事前に取得
    let overByInventoryItemId = new Map();
    try {
      if (locationGid) {
        const audit = await readInboundAuditLog();
        overByInventoryItemId = buildInboundOverItemIndex_(audit, {
          locationId: locationGid,
          shipmentId: newShip?.id || selectedShipmentId,
        });
      }
    } catch (_) {
      overByInventoryItemId = new Map();
    }
    
    // 新しい行を作成（overAcceptedQty と alreadyRejectedQty を含む）
    const newBaseRows = newLineItems.map((li) => {
      const alreadyRejectedQty = Math.max(0, Number(li.rejectedQuantity ?? 0));
      const overAcceptedQty = Math.max(0, Math.floor(Number(inventoryItemId ? overByInventoryItemId.get(String(inventoryItemId)) || 0 : 0)));
      return {
        // ...
        alreadyRejectedQty,
        overAcceptedQty,
        // ...
      };
    });
    
    // 既存のrowsに追加
    // ...
  } catch (e) {
    toast(`追加読み込みエラー: ${toUserMessage(e)}`);
  } finally {
    setLoadingMore(false);
  }
}, [loadingMore, lineItemsPageInfo, selectedShipmentId, showImages, liteMode, locationGid]);
```

### InboundListScreen.jsx (373-418行目)

**特徴:**
- `AbortController` を使用していない
- `alreadyRejectedQty` フィールドを含まない
- 監査ログを事前に取得して `overAcceptedQty` を計算（この点は同じ）

**コード例:**
```javascript
const loadMoreLineItems_ = useCallback(async () => {
  // ...
  setLoadingMore(true);
  try {
    const result = await fetchInventoryShipmentEnriched(selectedShipmentId, {
      includeImages: showImages && !liteMode,
      after: lineItemsPageInfo.endCursor,
    });
    
    // 監査ログを事前に取得
    let overByInventoryItemId = new Map();
    try {
      const audit = await readInboundAuditLog();
      overByInventoryItemId = buildInboundOverItemIndex_(audit, { locationId: locationGid, shipmentId: newShip?.id || selectedShipmentId });
    } catch (_) {}
    
    // 新しい行を作成（overAcceptedQty を含むが、alreadyRejectedQty なし）
    const newBaseRows = newLineItems.map((li) => {
      const overAcceptedQty = Math.max(0, Math.floor(Number(li.inventoryItemId ? overByInventoryItemId.get(String(li.inventoryItemId)) || 0 : 0)));
      return {
        // ...
        overAcceptedQty,
        // alreadyRejectedQty なし
        // ...
      };
    });
    
    // 既存のrowsに追加
    // ...
  } catch (e) {
    toast(`追加読み込みエラー: ${toUserMessage(e)}`);
  } finally {
    setLoadingMore(false);
  }
}, [loadingMore, lineItemsPageInfo, selectedShipmentId, locationGid, showImages, liteMode]);
```

---

## 4. `useEffect` での呼び出し方法の差分

### Modal_REFERENCE.jsx (8803-8845行目)

**特徴:**
- `AbortController` を使用してクリーンアップを実装
- `loadShipment` と `loadMultipleShipments` に `signal` を渡す

**コード例:**
```javascript
useEffect(() => {
  if (isMultipleMode) {
    const selectedShipmentIds = Array.isArray(inbound.selectedShipmentIds) 
      ? inbound.selectedShipmentIds 
      : [];
    
    if (selectedShipmentIds.length === 0) {
      // クリア処理
      return;
    }

    const ac = new AbortController();
    (async () => {
      await loadMultipleShipments(selectedShipmentIds, { signal: ac.signal });
    })();

    return () => ac.abort();
  }

  if (!selectedShipmentId) {
    // クリア処理
    return;
  }

  const ac = new AbortController();
  (async () => {
    await loadShipment(selectedShipmentId, { signal: ac.signal });
  })();

  return () => ac.abort();
}, [isMultipleMode, selectedShipmentId, inbound.selectedShipmentIds, showImages, liteMode, loadMultipleShipments]);
```

### InboundListScreen.jsx (420-443行目)

**特徴:**
- `AbortController` を使用していない
- `loadShipment` と `loadMultipleShipments` を直接呼び出す

**コード例:**
```javascript
useEffect(() => {
  if (isMultipleMode) {
    if (ids.length === 0) {
      // クリア処理
      return;
    }
    if (ids.length > 1) {
      loadMultipleShipments(ids);
      return;
    }
  }
  if (!selectedShipmentId) {
    // クリア処理
    return;
  }
  loadShipment();
}, [isMultipleMode, ids, selectedShipmentId, loadShipment, loadMultipleShipments]);
```

---

## 5. `safeSet` 関数の有無

### Modal_REFERENCE.jsx (8503-8507行目)

**定義:**
```javascript
const safeSet = (fn, signal) => {
  if (!mountedRef.current) return;
  if (signal?.aborted) return;
  fn?.();
};
```

**用途:**
- アンマウント済みやキャンセル済みの場合に state 更新をスキップ
- `AbortController` と組み合わせて使用

### InboundListScreen.jsx

**定義:**
- `safeSet` 関数は存在しない

---

## 6. `alreadyRejectedQty` フィールドの有無

### Modal_REFERENCE.jsx

**含まれる箇所:**
- `loadShipment`: `baseRows` 作成時に `alreadyRejectedQty` を含む（8570行目）
- `loadMultipleShipments`: `allRows` 作成時に `alreadyRejectedQty` を含む（8735行目）
- `loadMoreLineItems_`: `newBaseRows` 作成時に `alreadyRejectedQty` を含む（8882行目）

**値の取得:**
```javascript
const alreadyRejectedQty = Math.max(0, Number(li.rejectedQuantity ?? 0));
```

### InboundListScreen.jsx

**含まれる箇所:**
- `loadShipment`: `alreadyRejectedQty` を含まない
- `loadMultipleShipments`: `alreadyRejectedQty` を含まない
- `loadMoreLineItems_`: `alreadyRejectedQty` を含まない
- **ただし**: `alreadyRejectedQty` を使用している箇所が1箇所ある（695行目: `const alreadyRejected = Math.max(0, Number(r.alreadyRejectedQty || 0));`）

---

## 7. `overAcceptedQty` の計算タイミング

### Modal_REFERENCE.jsx

**タイミング:**
- **同期処理**: `baseRows` / `allRows` / `newBaseRows` を作成する前に監査ログを取得して `overAcceptedQty` を計算

**メリット:**
- 初回表示時から正確な `overAcceptedQty` が表示される

**デメリット:**
- 監査ログ取得が完了するまで UI がブロックされる可能性がある

### InboundListScreen.jsx

**タイミング:**
- **二相ロード**: 先に `baseRows` / `allRows` を表示し、その後非同期で `overAcceptedQty` を更新

**メリット:**
- UI の応答性が向上（先にリストが表示される）

**デメリット:**
- 初回表示時は `overAcceptedQty = 0` で表示され、後から更新される（一瞬の不一致）

---

## 8. `first` パラメータの有無

### Modal_REFERENCE.jsx

**`loadShipment`:**
- `first` パラメータを渡していない（全件取得）

**`loadMultipleShipments`:**
- `first` パラメータを渡していない（全件取得）

### InboundListScreen.jsx

**`loadShipment`:**
- `first: productFirst` を渡している（設定値に基づく件数制限）

**`loadMultipleShipments`:**
- `first: productFirst` を渡している（設定値に基づく件数制限）

---

## まとめ表

| 項目 | Modal_REFERENCE.jsx | InboundListScreen.jsx |
|------|---------------------|----------------------|
| `loadShipment` の関数形式 | `async` 関数 | `useCallback` でラップ |
| `AbortController` の使用 | ✅ 使用 | ❌ 未使用 |
| `safeSet` の使用 | ✅ 使用 | ❌ 未使用 |
| `overAcceptedQty` の計算タイミング | 同期処理（事前計算） | 二相ロード（後から更新） |
| `alreadyRejectedQty` フィールド | ✅ 含む | ❌ 含まない（ただし使用箇所あり） |
| `loadMultipleShipments` の `signal` パラメータ | ✅ 受け取る | ❌ 受け取らない |
| `first` パラメータ | ❌ 渡さない（全件取得） | ✅ 渡す（`productFirst`） |
| `useEffect` でのクリーンアップ | ✅ `AbortController` で実装 | ❌ 未実装 |

---

## 修正済み項目（二相ロードは維持）

1. **`alreadyRejectedQty` フィールド** ✅
   - `loadShipment`, `loadMultipleShipments`, `loadMoreLineItems_` の全てで `alreadyRejectedQty` を含めるように修正済み

2. **`AbortController` の導入** ✅
   - `loadShipment(id, { signal })`, `loadMultipleShipments(shipmentIds, { signal })` で `signal` を受け取る形に変更
   - `useEffect` で `AbortController` を生成し、クリーンアップで `ac.abort()` を実行
   - `loadMoreLineItems_` 内で `AbortController` を生成し、`fetchInventoryShipmentEnriched` に `signal` を渡すように変更

3. **`safeSet` 関数の追加** ✅
   - `safeSet(fn, signal)` を定義し、`mountedRef.current` と `signal?.aborted` をチェックして state 更新をスキップするように実装済み

4. **`overAcceptedQty` の計算タイミング**
   - **二相ロードを維持**（先に一覧表示し、非同期で監査ログ over を反映）。UI 応答性を優先。

5. **`first` パラメータの扱い**
   - 現状のまま `productFirst` を渡す実装を維持（件数制限あり）。Modal_REFERENCE は全件取得だが、パフォーマンスのため制限を維持。
