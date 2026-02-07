# InboundListScreen と Modal_REFERENCE（InboundList）徹底比較

## 比較日・対象

- **REFERENCE**: `extensions/stock-transfer-tile/src/Modal_REFERENCE.jsx` の `InboundList` 関数（約8271行〜）
- **InboundListScreen**: `extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx`

## 1. 定数・スタイル

| 項目 | REFERENCE | InboundListScreen | 一致 |
|------|-----------|-------------------|------|
| CONFIRM_RECEIVE_MODAL_ID | コンポーネント内 | モジュール直下 | ✅ 機能的に同じ |
| WARNING_REASONS | コンポーネント内 | モジュール直下 | ✅ 機能的に同じ |
| DIFF_PREVIEW_LIMIT | コンポーネント内 | モジュール直下 | ✅ 機能的に同じ |
| oneLineStyle | コンポーネント内・useState の前 | return 直前（1301行） | ❌ 定義位置が違う → 前方に移動で一致 |

## 2. 関数定義（種類）

| 関数名 | REFERENCE | InboundListScreen | 一致 |
|--------|-----------|-------------------|------|
| safeSet | 通常の関数 | 通常の関数 | ✅ |
| refreshPending | 通常の async | 通常の async | ✅ |
| loadShipment | 通常の async | 通常の async | ✅ |
| loadShipmentById | loadShipment のエイリアス | なし（loadShipment を直接使用） | ❌ エイリアス追加で一致 |
| formatShipmentLabelLocal | **useCallback** | 通常の関数 | ❌ useCallback に変更で一致 |
| loadMultipleShipments | useCallback | useCallback | ✅ |
| clearAddSearch | useCallback | useCallback | ✅ |
| handleShowMoreAddCandidates | useCallback | useCallback | ✅ |
| loadMoreLineItems_ | useCallback | useCallback | ✅ |
| setRowQty / incRow / setExtraQty / incExtra | **通常の関数**（REFERENCE 8999–9039行） | **通常の関数**（REFERENCE に合わせて修正済み） | ✅ 一致。同一構成にすることで jt（denyEdit_）の TDZ も防止。 |

## 3. REFERENCE にのみ存在するもの（意図的な差）

| 項目 | 説明 |
|------|------|
| allTransfersLoading / allTransfers / refreshAllTransfers | REFERENCE はタイル内で「全 Transfer 一覧」を別 API で取得。InboundListScreen は単体拡張で親から渡された inbound state のみ使用するため不要。 |
| transferForShipment（useMemo） | REFERENCE は pendingTransfers + allTransfers から現在 shipment の属する Transfer を逆引き。Inbound は originName/destName/transferName を inbound.selected* から取得するため不要。 |
| denyEdit_ + toastReadOnlyOnceRef | REFERENCE は readOnly 時に編集操作をすると「この入庫は入庫済みのため変更できません」と toast を一度だけ表示。Inbound は readOnlyRef.current で return するだけで toast なし。→ **UX 一致のため追加推奨** |

## 4. state・ref の初期値

| 項目 | REFERENCE | InboundListScreen | 一致 |
|------|-----------|-------------------|------|
| addCandidatesDisplayLimit 初期値 | 50 | 20 | ❌ 50 に変更で一致 |
| clearAddSearch 時のリセット値 | 20 | 20（setAddCandidatesDisplayLimit(20)） | ✅ |

## 5. 計算値・JSX ノード（useMemo の有無）

| 項目 | REFERENCE | InboundListScreen | 一致 |
|------|-----------|-------------------|------|
| overRows / shortageRows | 通常の配列計算 | 通常の配列計算 | ✅ |
| plannedTotal / receiveTotal | 通常の計算 | 通常の計算 | ✅ |
| hasWarning / warningReady / canConfirm / canOpenConfirm | 通常の計算 | 通常の計算 | ✅ |
| visibleRows | useMemo | useMemo | ✅ |
| warningAreaNode | 通常の JSX 代入 | 通常の JSX 代入 | ✅ |

## 6. 結論：漏れと対応

- **合わせるべき差分（修正する）**
  1. **formatShipmentLabelLocal** を useCallback に変更（REFERENCE 8649行と一致）
  2. **oneLineStyle** をコンポーネント前方（state の前）に移動（REFERENCE 8317行付近と定義順序一致）
  3. **denyEdit_** と **toastReadOnlyOnceRef** を追加し、readOnly 時の編集で toast を表示（REFERENCE 8449行付近）
  4. **addCandidatesDisplayLimit** の初期値を 50 に変更（REFERENCE 8481行）
  5. **loadShipmentById = loadShipment** を追加（REFERENCE 8646行。receiveConfirm 内では loadShipment のままでも可）

- **意図的な差（修正しない）**
  - allTransfers / refreshAllTransfers / transferForShipment：単体拡張では不要。
  - CONFIRM_RECEIVE_MODAL_ID 等の定義位置（モジュール直下）：参照順序上問題なし。

## 7. 「漏れがない」と言い切れる根拠（上記修正後）

- 上記 1〜5 を反映したうえで、
  - 関数の「種類」（通常 vs useCallback）は REFERENCE の InboundList と一致する。
  - 計算値・JSX ノードは useMemo を使う／使わないが REFERENCE と一致する。
  - 定数・oneLineStyle の定義位置が REFERENCE と揃う。
  - readOnly 時の UX（denyEdit_ + toastReadOnlyOnceRef）が REFERENCE と揃う。
  - incRow / setRowQty / setExtraQty / incExtra / addOrIncrementByResolved / setAllToPlanned / resetAllCounts で readOnly 時に denyEdit_() を呼ぶ。
- 単体拡張に起因する差（allTransfers / transferForShipment の不在）は仕様上の意図的な差であり、「漏れ」ではない。

以上を満たせば、**REFERENCE と比較したうえで漏れはない**と判断できる。

---

## 8. 実施した修正（反映済み）

| # | 内容 |
|---|------|
| 1 | formatShipmentLabelLocal を useCallback に変更 |
| 2 | oneLineStyle をコンポーネント前方（state の前）に移動し、return 直前の重複定義を削除 |
| 3 | toastReadOnlyOnceRef を追加。denyEdit_ を定義し、readOnly 解除時に toastReadOnlyOnceRef をリセットする useEffect を追加 |
| 4 | incRow / setRowQty / setExtraQty / incExtra / addOrIncrementByResolved / setAllToPlanned / resetAllCounts で readOnly 時に denyEdit_() を呼ぶよう変更 |
| 5 | addCandidatesDisplayLimit の初期値を 50 に変更 |
| 6 | loadShipmentById = loadShipment を追加。receiveConfirm 内の再読込で loadShipmentById(shipment.id) を使用 |
