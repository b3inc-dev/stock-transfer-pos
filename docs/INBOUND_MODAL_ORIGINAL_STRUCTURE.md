# Modal 時の入庫実装：履歴一覧と商品リストの構造

**目的**: 分割前の Modal.jsx にあった InboundConditions と InboundList の実装内容を整理し、現在の stock-transfer-inbound との差分を明確にする。

**※ 実コード準拠の正確な仕様（行番号・UI文言・処理の違い）は `INBOUND_MODAL_UI_ELEMENTS.md` を参照すること。**  
同ドキュメントは復元した `extensions/stock-transfer-tile/src/Modal_REFERENCE.jsx` に基づいており、以前の要約で誤りがあった箇所（DIFF_PREVIEW_LIMIT=1、フッター構成、ヘッダー要素、文言など）を修正している。

---

## 1. 履歴一覧（InboundConditions）の構造

### 1.1 データ取得

**Modal 時の実装**（Modal_REFERENCE.jsx 7473〜7513）:
- **1本のクエリ**: `fetchTransfersForDestinationAll(locationGid, { first: listInitialLimit })` で全件取得
- **画面側でフィルタ**: `viewMode === "pending"` なら `!isCompleted(t)`、`viewMode === "received"` なら `isCompleted(t)` でフィルタ
- **監査ログマージ**: 取得した transfers に対して **同期的に** `readInboundAuditLog()` → `buildInboundOverIndex_` / `buildInboundExtrasIndex_` / `buildInboundRejectedIndex_` → `mergeInboundOverIntoTransfers_` を実行してから `setTransfers(patched)`（二相ロードではない）

**現在の stock-transfer-inbound**:
- ✅ 同じ構造（1本のクエリ + 画面側フィルタ + 監査ログマージ）
- ✅ 二相ロード（先に API 結果を表示、監査ログは非同期でマージ）を実装済み（体感速度改善のため）

---

## 2. 商品リスト（InboundList）の構造

### 2.1 Modal 時の実装（重要な要素）

#### A. **pendingTransfers と allTransfers の2つのリストを保持**

```javascript
// InboundList コンポーネント内
const [pendingLoading, setPendingLoading] = useState(false);
const [pendingTransfers, setPendingTransfers] = useState([]);
const [allTransfersLoading, setAllTransfersLoading] = useState(false);
const [allTransfers, setAllTransfers] = useState([]);

const refreshPending = async () => {
  // fetchPendingTransfersForDestination で未入庫分を取得
  // 監査ログマージ処理
  setPendingTransfers(list);
};

const refreshAllTransfers = async () => {
  // fetchTransfersForDestinationAll で全件取得
  // 監査ログマージ処理
  setAllTransfers(list);
};

useEffect(() => {
  if (!locationGid) return;
  refreshPending().catch(() => {});
  refreshAllTransfers().catch(() => {});
}, [locationGid]);
```

**目的**:
- `transferForShipment` の逆引きに使用（後述）
- `!selectedShipmentId` 時のフォールバックUIで pendingTransfers を表示

#### B. **transferForShipment の逆引き**

```javascript
const transferForShipment = useMemo(() => {
  const sidRaw = String(shipment?.id || selectedShipmentId || "").trim();
  if (!sidRaw) return null;

  const sidNorm = normalizeId_(sidRaw);
  const p = Array.isArray(pendingTransfers) ? pendingTransfers : [];
  const a = Array.isArray(allTransfers) ? allTransfers : [];

  // pendingTransfers と allTransfers をマージ（重複除去）
  const merged = [];
  const seen = new Set();
  [...p, ...a].forEach((t) => {
    const id = String(t?.id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    merged.push(t);
  });

  // shipmentId を含む Transfer を探す
  return merged.find((t) => {
    const ships = Array.isArray(t.shipments) ? t.shipments : [];
    return ships.some((s) => {
      const idRaw = String(s?.id || "").trim();
      if (!idRaw) return false;
      return idRaw === sidRaw || normalizeId_(idRaw) === sidNorm;
    });
  }) || null;
}, [pendingTransfers, allTransfers, shipment?.id, selectedShipmentId]);
```

**目的**:
- `readOnly` の計算で `transferForShipment?.totalQuantity` / `transferForShipment?.receivedQuantityDisplay` を優先的に使用
- Transfer の完了状態を正確に判定

#### C. **readOnly の計算（transferForShipment を優先）**

```javascript
const readOnly = useMemo(() => {
  // 1) shipment 自体が RECEIVED なら確定で読み取り専用
  if (String(shipment?.status || "").toUpperCase() === "RECEIVED") return true;

  // 2) 遷移元で readOnly を持ってきている場合
  if (!!inbound?.selectedReadOnly) return true;

  // 3) transfer の total/received で完了判定（transferForShipment を優先）
  const total = Number(
    transferForShipment?.totalQuantity ?? 
    inbound?.selectedTransferTotalQuantity ?? 
    0
  );
  const received = Number(
    transferForShipment?.receivedQuantityDisplay ??
    transferForShipment?.receivedQuantity ??
    inbound?.selectedTransferReceivedQuantity ??
    0
  );

  if (total > 0 && received >= total) return true;

  return false;
}, [
  shipment?.status,
  inbound?.selectedReadOnly,
  inbound?.selectedTransferTotalQuantity,
  inbound?.selectedTransferReceivedQuantity,
  transferForShipment?.totalQuantity,
  transferForShipment?.receivedQuantity,
  transferForShipment?.receivedQuantityDisplay,
]);
```

#### D. **!selectedShipmentId 時のフォールバックUI**

```javascript
if (!selectedShipmentId) {
  return (
    <s-box padding="base">
      <s-stack gap="base">
        <s-text emphasis="bold">入庫予定一覧</s-text>
        <s-button kind="secondary" onClick={refreshPending}>
          入庫予定一覧を更新
        </s-button>
        {pendingTransfers.length > 0 ? (
          <s-stack gap="base">
            <s-text emphasis="bold">入庫予定（Transfer）</s-text>
            {pendingTransfers.slice(0, 8).map((t) => (
              <s-text key={t.id} tone="subdued" size="small">
                ・{t.name ? `${t.name} / ` : ""}{String(t.id).slice(-12)}（{t.status ?? "-"}）
              </s-text>
            ))}
            {pendingTransfers.length > 8 ? (
              <s-text tone="subdued" size="small">
                …他 {pendingTransfers.length - 8} 件
              </s-text>
            ) : null}
          </s-stack>
        ) : null}
      </s-stack>
    </s-box>
  );
}
```

**目的**:
- Shipment が選択されていない状態でも、入庫予定の Transfer 一覧を表示
- 「入庫予定一覧を更新」ボタンで手動更新可能

#### E. **loadShipment（first パラメータなし）**

```javascript
const loadShipment = async (id, { signal } = {}) => {
  // ...
  const shipmentResult = await fetchInventoryShipmentEnriched(shipmentId, {
    includeImages: showImages && !liteMode,
    // first パラメータなし = 全件取得
    signal,
  });
  // ...
};
```

**目的**:
- 初回読み込み時に全件取得（ページネーションは `loadMoreLineItems_` で対応）

---

### 2.2 現在の stock-transfer-inbound の実装

#### 欠けている要素

| 要素 | Modal 時 | 現在の inbound | 影響 |
|------|----------|----------------|------|
| **pendingTransfers / allTransfers** | ✅ 保持 | ❌ なし | transferForShipment の逆引きができない、フォールバックUIが表示できない |
| **transferForShipment** | ✅ 逆引きロジックあり | ❌ なし | readOnly の計算が inbound.selectedXXX のみに依存 |
| **!selectedShipmentId フォールバック** | ✅ 入庫予定一覧を表示 | ❌ シンプルなメッセージのみ | Shipment 未選択時に予定一覧が見えない |
| **loadShipment の first** | ❌ なし（全件取得） | ✅ `first: productFirst` | 初回読み込みが制限される（ページネーションが必要） |

---

## 3. まとめ：Modal 時と現在の差分

### 履歴一覧（InboundConditions）

| 項目 | Modal 時 | 現在の inbound | 状態 |
|------|----------|----------------|------|
| クエリ数 | 1本（fetchTransfersForDestinationAll） | 1本（同じ） | ✅ 一致 |
| フィルタ | 画面側（pending/received） | 画面側（同じ） | ✅ 一致 |
| 監査ログマージ | 同期 | 二相（先表示→後マージ） | ✅ 改善済み |

### 商品リスト（InboundList）

| 項目 | Modal 時 | 現在の inbound | 状態 |
|------|----------|----------------|------|
| **pendingTransfers / allTransfers** | ✅ 保持 | ❌ なし | ❌ **欠落** |
| **transferForShipment 逆引き** | ✅ あり | ❌ なし | ❌ **欠落** |
| **readOnly 計算** | transferForShipment 優先 | inbound.selectedXXX のみ | ❌ **不完全** |
| **!selectedShipmentId フォールバック** | 入庫予定一覧表示 | シンプルメッセージ | ❌ **不完全** |
| **loadShipment の first** | なし（全件） | `first: productFirst` | ⚠️ **変更あり** |
| **複数シップメント対応** | ✅ loadMultipleShipments | ✅ loadMultipleShipments | ✅ 実装済み |

---

## 4. 修正が必要な項目

### 優先度：高

1. **pendingTransfers / allTransfers の保持**
   - InboundListScreen 内で `refreshPending()` / `refreshAllTransfers()` を実装
   - `useEffect` で locationGid 変更時に両方を呼び出す

2. **transferForShipment の逆引き**
   - pendingTransfers / allTransfers から shipmentId で Transfer を探すロジックを追加
   - `readOnly` の計算で `transferForShipment` を優先的に使用

3. **!selectedShipmentId 時のフォールバックUI**
   - 「入庫予定一覧を更新」ボタン
   - pendingTransfers のリスト表示（最大8件）

### 優先度：中

4. **loadShipment の first パラメータ**
   - Modal 時は全件取得だったが、現在は `first: productFirst` で制限
   - パフォーマンスとのバランスを考慮して決定

---

## 5. 参考：Modal 時の InboundList の行番号

- **InboundConditions**: 約2720行付近
- **InboundList**: 約3532行付近
- **fetchPendingTransfersForDestination**: 約11957行付近
- **fetchTransfersForDestinationAll**: 約12021行付近

（※ これらのファイルは削除済みのため、会話履歴やドキュメントから再現する必要があります）
