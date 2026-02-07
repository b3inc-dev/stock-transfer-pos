# InboundListScreen と Modal_REFERENCE のコード構造の差分

## 重要な違い（TDZ エラーの原因になり得る）

### 1. `headerNode` の定義方法

**REFERENCE (10254行目):**
```javascript
const headerNode = useMemo(() => {
  if (!setHeader) return null;
  const q = String(addQuery || "");
  const showResults = q.trim().length >= 1;
  return (
    <s-box padding="small">
      {/* ... */}
    </s-box>
  );
}, [setHeader, addQuery, addLoading, addCandidates, headNo, originName, inboundTo, ...]);

useEffect(() => {
  if (!setHeader) return;
  setHeader(headerNode);
  return () => setHeader(null);
}, [setHeader, headerNode]);
```

**InboundListScreen (1020-1134行目):**
```javascript
useEffect(() => {
  if (!setHeader) return;
  const q = String(addQuery || "");
  const showResults = q.trim().length >= 1;
  const headerNode = (
    <s-box padding="small">
      {/* ... */}
    </s-box>
  );
  setHeader(headerNode);
  return () => setHeader?.(null);
}, [setHeader, addQuery, addLoading, addCandidates, headNo, originName, inboundTo, ...]);
```

**違い:** REFERENCE では `headerNode` を `useMemo` で定義してから `useEffect` で使用しているが、InboundListScreen では `useEffect` 内で直接定義している。

### 2. `refreshPending` の定義方法

**REFERENCE (8361行目):**
```javascript
const refreshPending = async () => {
  // ...
};
```

**InboundListScreen (162行目):**
```javascript
const refreshPending = useCallback(async () => {
  // ...
}, [locationGid, ...]);
```

**違い:** REFERENCE では通常の async 関数だが、InboundListScreen では `useCallback` でラップされている。

### 3. `readOnly` の依存配列

**REFERENCE (9317-9343行目):**
```javascript
const readOnly = useMemo(() => {
  // ...
}, [
  shipment?.status,
  inbound?.selectedReadOnly,
  inbound?.selectedTransferTotalQuantity,
  inbound?.selectedTransferReceivedQuantity,
  transferForShipment?.totalQuantity,
  transferForShipment?.receivedQuantity,
]);
```

**InboundListScreen (140-147行目):**
```javascript
const readOnly = useMemo(() => {
  // ...
}, [shipment?.status, inbound?.selectedReadOnly, inbound?.selectedTransferTotalQuantity, inbound?.selectedTransferReceivedQuantity]);
```

**違い:** REFERENCE では `transferForShipment` の値も依存配列に含まれている。

### 4. `headNo`, `originName`, `inboundTo` の計算ロジック

**REFERENCE (9438-9466行目):**
```javascript
const headNo = useMemo(() => {
  const raw = String(
    transferForShipment?.name || inbound?.selectedTransferName || ""
  ).trim();
  const m = raw.match(/T\d+/i);
  if (m) return `#${String(m[0]).toUpperCase()}`;
  if (raw) return raw.startsWith("#") ? raw : `#${raw}`;
  const s = String(shipment?.id || selectedShipmentId || "").trim();
  return s ? `#${s.slice(-8)}` : "—";
}, [transferForShipment?.name, inbound?.selectedTransferName, shipment?.id, selectedShipmentId]);

const originName = useMemo(() => {
  const n = String(
    transferForShipment?.originName || inbound?.selectedOriginName || ""
  ).trim();
  return n || "—";
}, [transferForShipment?.originName, inbound?.selectedOriginName]);

const inboundTo = useMemo(() => {
  const n = String(
    transferForShipment?.destinationName || inbound?.selectedDestinationName || ""
  ).trim();
  if (n) return n;
  const fallback = getLocationName_(locationGid, locIndex.byId);
  return fallback || "—";
}, [transferForShipment?.destinationName, inbound?.selectedDestinationName, locationGid, locIndex.byId]);
```

**InboundListScreen (1008-1018行目):**
```javascript
const headNo = useMemo(() => {
  const name = String(transferName || "").trim();
  if (!name) return "入庫";
  const match = name.match(/(\d+)$/);
  return match ? `#${match[1]}` : name;
}, [transferName]);

const inboundTo = useMemo(() => {
  const n = String(destName || "").trim();
  return n || "-";
}, [destName]);
```

**違い:** REFERENCE では `transferForShipment` を優先的に使用し、より詳細なフォールバックロジックがある。

### 5. `warningReady` の定義

**REFERENCE (9418行目):**
```javascript
const warningReady = !hasWarning ? true : !!ackWarning;
```

**InboundListScreen (615行目):**
```javascript
const warningReady = !hasWarning || !!ackWarning;
```

**違い:** ロジックは同じだが、REFERENCE の方が明示的。

### 6. `canOpenConfirm` の定義

**REFERENCE (9421行目):**
```javascript
const canOpenConfirm = canConfirm;
```

**InboundListScreen (1144行目):**
```javascript
const canOpenConfirm = canConfirm && !receiveSubmitting;
```

**違い:** InboundListScreen では `!receiveSubmitting` の条件が追加されている。

## 推奨される修正

1. **`headerNode` を `useMemo` で定義**: REFERENCE に合わせて、`headerNode` を `useMemo` で定義し、`useEffect` で使用する。
2. **`refreshPending` を通常の関数に**: REFERENCE に合わせて、`useCallback` を削除（ただし、依存配列が必要な場合は残す）。
3. **`readOnly` の依存配列を拡張**: `transferForShipment` の値も含める（ただし、InboundListScreen に `transferForShipment` がない場合は現状のままで良い）。
4. **`headNo`, `originName`, `inboundTo` のロジックを統一**: REFERENCE のロジックに合わせる（ただし、`transferForShipment` がない場合は現状のままで良い）。
