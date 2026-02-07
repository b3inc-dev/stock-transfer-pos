# InboundList（InboundListScreen）の TDZ 対策一覧

**目的**: 「Cannot access 'Ot' before initialization」等の Temporal Dead Zone (TDZ) エラーを防ぐため、InboundListScreen で行った修正を漏れなく説明する。

---

## 1. TDZ が起きる理由（おさらい）

- **minify** で変数名が短く圧縮される（jt, Jt, Ot など）。
- コンポーネント内の **const / let** は「定義の行」より**前**で参照されると **TDZ** になり、「Cannot access 'Xx' before initialization」が出る。
- ソース上は「定義の後に参照」していても、**minifier が宣言順を変える**と、実行時に「参照が先・代入が後」になることがある。
- 特に **useMemo / useCallback の依存配列**で別の const を参照していると、minify 後の順序でその const がまだ代入前になる可能性がある。

---

## 2. 実施した修正（漏れなく）

### 2.1 モジュールレベルへ移動した関数（コンポーネント外で定義）

これらは **コンポーネント内の const として残さず**、ファイル先頭付近の**モジュールレベル**で定義し、必要な値は**引数**で渡す。

| モジュールレベル関数 | 元の定義 | 参照されていた箇所 | 修正理由 |
|----------------------|----------|--------------------|----------|
| **denyEdit_** | コンポーネント内の通常関数 | setRowQty_ / incRow_ / setAllToPlanned_ 等 | minify で jt になりうる。参照元が多く宣言順で TDZ になり得るためモジュールレベルに移した。 |
| **clampReceiveQty_** | コンポーネント内の const | loadShipment / setRowQty_ / incRow_ / setAllToPlanned_ / resetAllCounts_ | 同上。 |
| **safeSet** | コンポーネント内の通常関数 | loadShipment / loadMultipleShipments | 同上。 |
| **formatShipmentLabelLocal** | コンポーネント内の useCallback | loadMultipleShipments | 同上。モジュールレベルに移し useCallback は廃止。 |
| **incRow_** | コンポーネント内の const | addOrIncrementByResolved | minify で Jt になりうる。addOrIncrementByResolved が先に評価されると TDZ のためモジュールレベルに移した。 |
| **setRowQty_** | 同上 | renderInboundShipmentItems_（JSX） | 同上。JSX では `(key, qty) => setRowQty_(readOnlyRef, ...)` のようにインラインで渡す。 |
| **setExtraQty_** | 同上 | renderExtras_（JSX） | 同上。 |
| **incExtra_** | 同上 | addOrIncrementByResolved | 同上。 |
| **setAllToPlanned_** | コンポーネント内の useCallback | headerNode（useMemo 内の onClick） | headerNode の依存や JSX で参照され、宣言順で jt/Jt になりうるためモジュールレベルに移した。 |
| **resetAllCounts_** | 同上 | headerNode（useMemo 内の onClick） | 同上。 |
| **clearAddSearch_** | コンポーネント内の useCallback | headerNode（useMemo 内の onClick と依存配列） | **Ot の主因候補**。headerNode の依存配列で参照され、minify で宣言順が逆になると TDZ になるためモジュールレベルに移した。 |
| **handleShowMoreAddCandidates_** | 同上 | 検索結果「さらに表示」ボタン（JSX） | 同上。JSX で参照される useCallback が Ot になりうるためモジュールレベルに移した。 |
| **loadExtrasHistory_** | 同上 | useEffect の依存配列 `[..., loadExtrasHistory]` | **Ot の主因候補**。useEffect の依存評価が useCallback の代入より先に並べ替えられると TDZ になるためモジュールレベルに移した。依存配列からは外し、useEffect 内で `loadExtrasHistory_(...)` を直接呼ぶ形に変更。 |

### 2.2 headerNode の依存配列から「同一コンポーネント内の const」を外した

**問題**: `headerNode` の useMemo の依存配列に **headNo, originName, inboundTo** が入っていた。これらは同じコンポーネント内の const（および useMemo の戻り値）なので、minify で宣言順が入れ替わると、**headerNode の依存配列を評価する時点で headNo / originName / inboundTo がまだ未代入**（Ot 等）になり TDZ になる可能性がある。

**修正**:

- **headNo, originName, inboundTo** を headerNode の**外**で定義せず、**headerNode の useMemo の中**で算出するようにした。
- 依存配列からは **headNo, originName, inboundTo を削除**し、**inbound** のみにした（`inbound` は getStateSlice の戻り値で、コンポーネント冒頭で代入されるため宣言順の影響を受けにくい）。
- これにより「同一コンポーネント内の const を useMemo の依存に含める」箇所をなくし、**Ot が依存配列経由で参照される前に未代入になる**事象を防いだ。

**変更後の依存配列**:

- 変更前: `[setHeader, addQuery, addLoading, addCandidates, headNo, originName, inboundTo, liteMode, onToggleLiteMode, shipment && shipment.id, shipment && shipment.tracking, readOnly]`
- 変更後: `[setHeader, addQuery, addLoading, addCandidates, inbound, liteMode, onToggleLiteMode, shipment && shipment.id, shipment && shipment.tracking, readOnly]`

### 2.3 dialog の宣言順（Ot の主因）

**問題**: **waitForOk**（useCallback）の依存配列に **`[dialog]`** が入っているが、**dialog**（useMemo）は **waitForOk より約 250 行後**で定義されていた。React はフックを上から順に実行するため、waitForOk を登録する時点で依存配列の `dialog` を参照するが、その時点ではまだ `dialog` は未代入（minify で **Ot** になると "Cannot access 'Ot' before initialization" になる）。

**修正**: **dialog** の宣言を **waitForOk より前**（ref 同期と VariantCache.init の useEffect の直後、約 293 行目）に移動した。これで waitForOk が評価される時点で dialog は既に代入済みとなり、TDZ が発生しない。

**headerNode 内で行っている算出**:

- `originName = String(inbound?.selectedOriginName || "").trim() || "-"`
- `destName = String(inbound?.selectedDestinationName || "").trim() || "-"`
- `transferName = String(inbound?.selectedTransferName || "").trim() || "入庫"`
- `headNo` = transferName の末尾数字から `#数字` を生成（従来の useMemo と同じロジック）
- `inboundTo = destName || "-"`

---

## 3. 呼び出し側の変更（漏れなく）

| 箇所 | 変更内容 |
|------|----------|
| ヘッダー「全入庫」ボタン | `onClick={setAllToPlanned}` → `onClick={() => setAllToPlanned_(readOnlyRef, toastReadOnlyOnceRef, toast, rowsRef, setRows)}` |
| ヘッダー「リセット」ボタン | `onClick={resetAllCounts}` → `onClick={() => resetAllCounts_(readOnlyRef, toastReadOnlyOnceRef, toast, setRows, setExtras, setReason, setNote, setAckWarning)}` |
| ヘッダー検索クリア「✕」ボタン | `onClick={clearAddSearch}` → `onClick={() => clearAddSearch_(setAddQuery, setAddCandidates, setAddCandidatesDisplayLimit, setAddQtyById)}` |
| 検索結果「さらに表示」ボタン | `onClick={handleShowMoreAddCandidates}` → `onClick={() => handleShowMoreAddCandidates_(setAddCandidatesDisplayLimit)}`（onPress も同様） |
| 予定外履歴取得の useEffect | 依存を `[shipment?.id, locationGid, loadExtrasHistory]` から `[shipment?.id, locationGid]` に変更。effect 内で `loadExtrasHistory_(shipmentId, locationGid, setExtrasHistory, setExtrasHistoryLoading, setConfirmMemo, readInboundAuditLog)` を直接呼ぶ。 |
| 商品行の数量変更 | `setRowQty` → `(key, qty) => setRowQty_(readOnlyRef, toastReadOnlyOnceRef, toast, rowsRef, setRows, key, qty)` をインラインで渡す。 |
| 予定外行の数量変更 | `setExtraQty` → `(key, value) => setExtraQty_(readOnlyRef, toastReadOnlyOnceRef, toast, extrasRef, setExtras, key, value)` をインラインで渡す。 |

---

## 4. まとめ：何を修正したか

1. **dialog の宣言を waitForOk より前に移動した（Ot の主因）**  
   waitForOk の依存配列に [dialog] がある一方、dialog が waitForOk より後で定義されていたため、minify で dialog→Ot になったときに「Ot を初期化前に参照」して TDZ になっていた。dialog を waitForOk より前（ref 同期・VariantCache.init の直後）に移動して解消した。

2. **コンポーネント内で定義していた関数をモジュールレベルに移した**  
   denyEdit_, clampReceiveQty_, safeSet, formatShipmentLabelLocal, incRow_, setRowQty_, setExtraQty_, incExtra_, setAllToPlanned_, resetAllCounts_, clearAddSearch_, handleShowMoreAddCandidates_, loadExtrasHistory_ の 13 個。これにより minify で jt / Jt / Ot 等になっても、**コンポーネント内に「参照が先・代入が後」になる const を残さない**ようにした。

3. **headerNode の useMemo の依存から「同一コンポーネント内の const」を外した**  
   headNo, originName, inboundTo を依存配列から削除し、これらは headerNode 内で inbound から算出するようにした。これにより **Ot が依存配列経由で参照される時点で未代入**になるパターンをなくした。

4. **依存配列で参照していた useCallback をやめた**  
   loadExtrasHistory を useEffect の依存から外し、effect 内でモジュールレベルの loadExtrasHistory_ を直接呼ぶ形にした。clearAddSearch は headerNode の依存から外し、インラインで clearAddSearch_ を呼ぶ形にした。

以上の対応で、**InboundList（InboundListScreen）で TDZ が発生しないように**漏れなく修正している。

---

## 5. 他に考えられる要因（現時点で低リスク）

以下は、**現状のコード順では「参照より先に定義されている」ため通常は TDZ にならない**が、minify の挙動次第で理論上リスクがゼロではない要素。同じようなエラーが再発した場合に優先して確認するとよい。

| 要素 | 種類 | 説明 |
|------|------|------|
| **receiveConfirm** | useCallback | 確定処理。依存に canConfirm, shipment, rows, extras, overRows, shortageRows, note, reason, transferId, locationGid, inbound, onAfterReceive, onBack, isMultipleMode。参照している refreshPending / loadShipmentById / loadMultipleShipments はすべて receiveConfirm より前に定義済み。 |
| **handleReceive** | useCallback | 確定ボタン用。依存に hasWarning, warningReady, receiveConfirm, onBack。receiveConfirm は直前に定義済み。 |
| **loadMoreLineItems_** | useCallback | 追加読み込み。依存に loadingMore, lineItemsPageInfo, selectedShipmentId, locationGid, showImages, liteMode。いずれも state や上位の派生で、loadMoreLineItems_ より前に存在。 |
| **loadShipment** | async 関数 | 単一シップメント読み込み。useEffect の依存には含めず [isMultipleMode, idsKey, selectedShipmentId] のみ。effect 内で loadShipment(selectedShipmentId, …) を呼ぶ。loadShipment はその useEffect より前に定義済み。 |
| **loadMultipleShipments** | useCallback | 複数シップメント読み込み。依存は [showImages, liteMode, locationGid]。内部で使う safeSet / formatShipmentLabelLocal はモジュールレベル。同上の useEffect で呼ばれ、useEffect より前に定義済み。 |
| **refreshPending** | 通常の async 関数 | useCallback で包んでいない。useEffect（locationGid）と receiveConfirm から参照。どちらも refreshPending より後で定義されているため、現状の実行順では問題にならない。 |
| **setFooter の useEffect** | useEffect | 依存配列に receiveConfirm は含めていない。フッターの「確定」は command/commandFor でモーダルを開くだけなので、この effect のクロージャが receiveConfirm を参照しているわけではない。 |

**結論**: 上記はいずれも「参照しているもの」が自分より前に定義されているため、**現時点では追加の TDZ 対策は不要**と判断している。今後も同様の "Cannot access 'Xx' before initialization" が出た場合は、minify 後の宣言順を疑い、該当する const/useCallback をモジュールレベルへ移すか、宣言順を依存関係に合わせて前に寄せることを検討するとよい。

---

## 6. 関連ドキュメント

- 実装の完全性チェック: `INBOUND_LIST_SCREEN_COMPLETE_CHECK.md`（「0. Minify 時の TDZ エラー対策」）
- REFERENCE との差分: `INBOUND_REFERENCE_VS_CURRENT_DIFF.md`
