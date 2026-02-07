# InboundListScreen：REFERENCE からそのままコピーされていない箇所

Modal_REFERENCE.jsx の `InboundList`（8269行〜）と InboundListScreen.jsx を比較し、**そのままコピーされていない**（書き換え・省略・別実装になっている）箇所を一覧にしました。

**2026-02 更新**: 「完全に合わせる」対応として以下を実施済み。
- 定数（CONFIRM_RECEIVE_MODAL_ID, WARNING_REASONS, DIFF_PREVIEW_LIMIT, oneLineStyle）をコンポーネント内に移動
- denyEdit_ の直後に lastScanValueRef / lastScanChangeAtRef を配置（REFERENCE 8449–8456 と同一順序）
- VariantCache の直後に mountedRef の useEffect（クリーンアップ付き）を配置、重複を削除
- clampReceiveQty_ をコンポーネント内（setAllToPlanned の前）に移動
- loadShipment を REFERENCE と同一に（toast・first なし・baseRows で over 一括・finally で setShipmentLoading(false)）
- loadMultipleShipments の first 削除、safeSet の並びを REFERENCE に合わせる
- listInitialLimit / searchList.initialLimit を (appState?.outbound?.settings ?? settings) で参照
- rowsRef / extrasRef を Array.isArray ガード付きで代入

---

## 1. モジュール構成・インポート

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| コンポーネントの置き場所 | Modal_REFERENCE.jsx 内の 1 関数 | 単体ファイル InboundListScreen.jsx | 拡張が単体のためファイル分割 |
| InboundCandidateRow / renderExtras_ 等 | REFERENCE 内で定義 | InboundUiParts.jsx から import | TDZ 対策で別ファイルに切り出し |
| toast | REFERENCE 内で SHOPIFY?.toast 等を利用 | モジュール直下で `const toast = (m) => SHOPIFY?.toast?.show?.(String(m))` | 同一挙動・定義位置のみ違う |
| clampReceiveQty_ | **コンポーネント内**（8975行付近） | **モジュール直下**（56–59行） | REFERENCE はコンポーネント内で定義 |
| CONFIRM_RECEIVE_MODAL_ID / WARNING_REASONS / DIFF_PREVIEW_LIMIT | **コンポーネント内**（8304–8314行） | **モジュール直下**（47–54行） | 定義位置のみ違う |

---

## 2. props・状態の取得元

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| 設定値（listInitialLimit 等） | `appState?.outbound?.settings?.inbound?.listInitialLimit` | **`settings?.inbound?.listInitialLimit`**（props の settings） | 単体拡張では settings を props で受け取る想定 |
| 検索件数（searchList.initialLimit） | `appState?.outbound?.settings?.searchList?.initialLimit ?? 50` | **`settings?.searchList?.initialLimit ?? 50`** | 同上 |
| locIndex | **`useLocationsIndex(appState, setAppState)`** あり | **なし** | REFERENCE はタイル内で locIndex を使用 |
| dialog | props で受け取り | **`useMemo(() => ({}), [])` で空オブジェクト** | 単体拡張で dialog を渡さない場合のフォールバック |

---

## 3. 存在しない／省略されているブロック（REFERENCE にだけあるもの）

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| allTransfersLoading / allTransfers | あり（8326–8327行） | **なし** | 単体拡張では「全 Transfer 一覧」を別 API で持たない |
| refreshAllTransfers | あり（8329–8358行） | **なし** | 同上 |
| 初回マウント時の refreshAllTransfers | `refreshPending().catch(); refreshAllTransfers().catch();`（8396–8397行） | **refreshPending() のみ**（208行） | 同上 |
| transferForShipment（useMemo） | あり（9286–9315行） | **なし** | originName 等は inbound.selected* から取得するため不要 |
| readOnly の計算 | transferForShipment を参照（9317–9343行） | **inbound と shipment のみ**で計算（151–158行） | transferForShipment がないため簡略化 |
| selectedShipmentId | `String(inbound.selectedShipmentId \|\| "").trim()` のみ | **上記に加え** `\|\| (ids.length > 0 ? String(ids[0]).trim() : "")` | 複数 ID 時は先頭をフォールバック |
| inbound 初期値 | selectedTransferStatus 等あり | **selectedOriginLocationId** あり／selectedTransferStatus なし | 必要な項目だけ揃えた差 |

---

## 4. loadShipment

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| shipmentId が空のとき | `if (!shipmentId) return toast("Shipment ID が空です");` | **`if (!shipmentId \|\| !locationGid) return;`**（toast なし） | メッセージと locationGid チェックの有無が違う |
| fetchInventoryShipmentEnriched の引数 | **`{ includeImages, signal }` のみ**（first なし） | **`{ includeImages, first: productFirst, signal }`** | Inbound は productFirst（settings）を渡している |
| baseRows の overAcceptedQty | **初回 fetch 直後に audit を取得し、baseRows の map 内で overAcceptedQty を計算**（8551–8598行） | **初回は overAcceptedQty = 0。二相目で readInboundAuditLog を呼び setRows で over を反映**（246–266, 307–318行） | ロジックは同等だが「1回で揃える」か「2回で揃える」かの違い |
| draft 適用 | `draft.rows?.find` / `nextQty = clampReceiveQty_(r, savedQty)` | `draft.rows.find` / `clampReceiveQty_(r, savedQty)` を直接 return | オプショナルと変数代入の有無のみ |

---

## 5. loadMultipleShipments

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| fetchInventoryShipmentEnriched の引数 | **`{ includeImages, signal }` のみ**（8693–8696行） | **`{ includeImages, first: productFirst, signal }`** | 同上、first の有無 |
| 空チェック | `if (!Array.isArray(shipmentIds) \|\| shipmentIds.length === 0) { toast("..."); return; }` | **`if (shipmentIds.length === 0 \|\| !locationGid) return;`**（toast なし） | メッセージと locationGid チェックの有無 |

---

## 6. loadMoreLineItems_

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| fetchInventoryShipmentEnriched の引数 | **`{ includeImages, after, signal }` のみ**（8854–8858行） | **同上**（after, signal）＋ **first は渡していない**（482–486行） | REFERENCE も first なしで一致 |
| 追加読込時の baseRows と over | REFERENCE は loadMoreLineItems_ 内で over を取得して newBaseRows に含める実装は**別箇所** | Inbound は loadMoreLineItems_ 内で overByInventoryItemId を取得し newBaseRows に overAcceptedQty を含めている（498–524行） | いずれも「追加行に over を反映」で同等 |

---

## 7. refreshPending

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| listLimit の算出 | `Number(appState?.outbound?.settings?.inbound?.listInitialLimit ?? 100)` | **`Number(settings?.inbound?.listInitialLimit ?? 100)`** | 設定の参照元が appState と settings で違う |

---

## 8. 検索（addCandidates）の useEffect

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| searchLimit | `appState?.outbound?.settings?.searchList?.initialLimit ?? 50`（8951行） | **`settings?.searchList?.initialLimit ?? 50`**（searchLimit 変数・150行） | 同上、設定の参照元 |
| 検索実行時の setAddCandidatesDisplayLimit(20) | 「新しい検索時は表示件数をリセット」で 20（8958行） | 検索開始時に 20、成功時も 20（766, 770行） | 挙動は同等 |

---

## 9. 下書き保存の useEffect の依存配列

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| 依存 | `shipment?.id`, `inbound?.selectedTransferId`, ...（9401–9413行） | **`shipment && shipment.id`** 等（esbuild で `?.` が使えないため `&&` に変更） | 意味は同じ・構文のみ合わせた |

---

## 10. その他・細かい差分

| 項目 | REFERENCE | InboundListScreen | 備考 |
|------|-----------|-------------------|------|
| ref の代入 | `rowsRef.current = Array.isArray(rows) ? rows : [];`（8413行） | **`rowsRef.current = rows;`**（160行） | 同じ結果になるが REFERENCE は配列ガードあり |
| safeSet 内の ref クリア | `lastScanValueRef.current = "";` 等 | **`if (lastScanValueRef.current !== undefined) lastScanValueRef.current = "";`** 等 | Inbound は undefined チェック付き |
| loadShipmentById | `const loadShipmentById = loadShipment;`（8646行） | 同様にあり（329行） | 一致 |
| formatShipmentLabelLocal | useCallback（8649行） | useCallback（332行） | 一致 |

---

## まとめ：そのままコピーされていない主な理由

1. **拡張の形の違い**  
   単体拡張のため、`appState` / `locIndex` / `refreshAllTransfers` / `transferForShipment` など、タイル内でしか使わないものは省略または別経路（例: `settings` props）にしている。

2. **設定の参照元**  
   REFERENCE は `appState?.outbound?.settings?....`、InboundListScreen は **props の `settings`**。意図的に「単体用」に変更。

3. **clampReceiveQty_ / 定数の定義位置**  
   REFERENCE はコンポーネント内、Inbound はモジュール直下。挙動は同じで、定義位置のみ違う。

4. **loadShipment の「空 ID」と locationGid**  
   REFERENCE は toast のみ。Inbound は **locationGid チェックを追加**し、空のときは toast を出さず return。

5. **first パラメータ**  
   REFERENCE の InboundList は `fetchInventoryShipmentEnriched` に **first を渡していない**（関数側のデフォルトに依存）。Inbound は **productFirst（settings）を明示的に渡している**。

6. **baseRows と over のタイミング**  
   REFERENCE は 1 回目の fetch 直後に audit を取って baseRows に over を含める。Inbound は「初回は 0 → 二相で setRows で over を反映」で、結果は揃うが処理の順序が違う。

7. **ビルド環境**  
   useEffect の依存配列で `?.` が使えないため、**`shipment && shipment.id`** などに書き換えている箇所がある。

これらを「そのままコピーされていない箇所」として揃えたい場合は、上記の表を元に REFERENCE に寄せるか、あるいは「単体拡張用の意図的な差」として残すかを決める形になります。
