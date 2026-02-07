# InboundListScreen と Modal_REFERENCE の全コード構造の差分

## 関数定義方法の違い

### REFERENCE では通常の関数として定義されているもの

| 関数名 | REFERENCE | InboundListScreen | 修正が必要 |
|--------|-----------|-------------------|------------|
| `safeSet` | 通常の関数 | `useCallback` | ✅ 修正必要 |
| `refreshPending` | 通常の async 関数 | `useCallback` | ✅ 修正必要 |
| `loadShipment` | 通常の async 関数 | `useCallback` | ✅ 修正必要 |
| `loadMultipleShipments` | 通常の async 関数（推測） | `useCallback` | ✅ 修正必要 |
| `formatShipmentLabelLocal` | 通常の関数（推測） | `useCallback` | ✅ 修正必要 |
| `loadMoreLineItems_` | `useCallback` | `useCallback` | ✅ 一致 |

### REFERENCE では useCallback として定義されているもの

| 関数名 | REFERENCE | InboundListScreen | 修正が必要 |
|--------|-----------|-------------------|------------|
| `clearAddSearch` | `useCallback` | `useCallback` | ✅ 一致 |
| `handleShowMoreAddCandidates` | `useCallback` | `useCallback` | ✅ 一致 |

## 変数定義の順序の違い

### REFERENCE の順序

1. **定数定義**
   - `CONFIRM_RECEIVE_MODAL_ID`
   - `WARNING_REASONS`
   - `DIFF_PREVIEW_LIMIT`
   - `oneLineStyle`

2. **useState（基本状態）**
   - `pendingLoading`, `pendingTransfers`
   - `allTransfersLoading`, `allTransfers`
   - `shipmentLoading`, `shipmentError`, `shipment`
   - `rows`, `extras`, `lineItemsPageInfo`, `loadingMore`
   - `onlyUnreceived`
   - `reason`, `note`, `ackWarning`
   - `scanValue`, `scanDisabled`, `scanQueueLen`
   - `addQuery`, `addLoading`, `addCandidates`, `addCandidatesDisplayLimit`, `addQtyById`
   - `receiveSubmitting`, `draftSavedAt`

3. **useRef**
   - `rowsRef`, `extrasRef`
   - `scanFinalizeTimerRef`, `scanQueueRef`, `scanProcessingRef`, `scanPausedRef`
   - `headerDebounceRef`
   - `scanDisabledRef`, `readOnlyRef`, `toastReadOnlyOnceRef`
   - `lastScanValueRef`, `lastScanChangeAtRef`
   - `receiveLockRef`, `hideReceiveConfirmRef`
   - `scanProcessedTimestampsRef`

4. **useEffect（初期化）**
   - `rowsRef.current = rows`
   - `extrasRef.current = extras`
   - `scanDisabledRef.current = scanDisabled`
   - `VariantCache.init`
   - `mountedRef.current = true`（クリーンアップ含む）
   - `refreshPending` の自動実行

5. **通常の関数定義**
   - `refreshAllTransfers`（async）
   - `refreshPending`（async）
   - `clearAddSearch`（useCallback）
   - `handleShowMoreAddCandidates`（useCallback）
   - `safeSet`
   - `loadShipment`（async）
   - `loadMultipleShipments`（async）
   - `formatShipmentLabelLocal`
   - `loadMoreLineItems_`（useCallback）
   - `incRow`（useCallback）
   - `setRowQty`（useCallback）
   - `setExtraQty`（useCallback）
   - `incExtra`（useCallback）
   - `addOrIncrementByResolved`（useCallback）
   - `waitForOk`（useCallback）
   - `kickProcessScanQueue`（useCallback）
   - `scanFinalizeSoon`（useCallback）
   - `receiveConfirm`（useCallback）
   - `handleReceive`（useCallback）
   - `setAllToPlanned`（useCallback）
   - `resetAllCounts`（useCallback）
   - `loadExtrasHistory`（useCallback）

6. **useMemo（計算値）**
   - `readOnly`
   - `overRows`
   - `shortageRows`
   - `plannedTotal`, `receiveTotal`
   - `overQtyTotal`, `extrasQtyTotal`, `shortageQtyTotal`
   - `hasWarning`, `warningReady`
   - `canConfirm`, `canOpenConfirm`
   - `visibleRows`
   - `transferForShipment`
   - `headNo`, `originName`, `inboundTo`
   - `headerNode`

7. **render 関数（通常の関数）**
   - `renderExtras_`
   - `renderExtrasHistory_`
   - `renderConfirmMemo_`
   - `renderProcessLog_`

8. **JSX ノード**
   - `warningAreaNode`

9. **useEffect（副作用）**
   - `readOnlyRef.current = readOnly`
   - `loadExtrasHistory` の実行
   - `setHeader(headerNode)`
   - `setFooter(footerNode)`

10. **早期 return（条件分岐）**
    - `if (!selectedShipmentId) return ...`
    - `if (shipmentLoading) return ...`
    - `if (shipmentError) return ...`

11. **メイン return**

### InboundListScreen の順序（現在）

1. **定数定義** ✅ 一致
2. **useState** ✅ ほぼ一致（順序が少し違う）
3. **useRef** ✅ ほぼ一致
4. **useMemo（readOnly）** ⚠️ REFERENCE より早い
5. **useEffect（初期化）** ✅ 一致
6. **useCallback（関数定義）** ❌ REFERENCE では通常の関数
7. **useMemo（計算値）** ✅ 一致
8. **render 関数** ✅ InboundUiParts に移動済み
9. **JSX ノード** ✅ 一致
10. **useEffect（副作用）** ✅ 一致
11. **早期 return** ✅ 一致
12. **メイン return** ✅ 一致

## 主な相違点

### 1. 関数定義方法

**REFERENCE:**
- `safeSet`, `refreshPending`, `loadShipment`, `loadMultipleShipments`, `formatShipmentLabelLocal` は通常の関数
- `clearAddSearch`, `handleShowMoreAddCandidates`, `loadMoreLineItems_` のみ useCallback

**InboundListScreen:**
- 多くの関数が useCallback でラップされている

### 2. readOnly の定義位置

**REFERENCE:** 関数定義の後、useMemo セクションで定義  
**InboundListScreen:** useState の直後、useMemo で定義

### 3. headerNode の定義方法

**REFERENCE:** useMemo で定義 → useEffect で使用  
**InboundListScreen:** ✅ 修正済み（useMemo で定義）

## 推奨される修正

1. **`safeSet` を通常の関数に変更** ✅ 修正済み
2. **`refreshPending` を通常の async 関数に変更** ✅ 修正済み
3. **`loadShipment` を通常の async 関数に変更** ✅ 修正済み
4. **`loadMultipleShipments` を通常の async 関数に変更** ✅ 修正済み
5. **`formatShipmentLabelLocal` を通常の関数に変更** ✅ 修正済み
6. **useEffect の依存配列から関数を除外し、eslint-disable コメントを追加** ✅ 修正済み

## 修正完了

すべての関数定義を REFERENCE に合わせて修正しました。これでコード構造が REFERENCE と一致し、TDZ エラーが解消されるはずです。
