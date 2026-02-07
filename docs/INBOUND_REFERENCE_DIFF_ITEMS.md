# 入庫（InboundList）: REFERENCE との差分一覧（項目・要因）

**目的**: 現在の入庫実装（InboundListScreen / inboundApi / Modal 等）と Modal_REFERENCE.jsx の入庫部分との**処理・UI・表示項目**の差を、項目ごとに「事象」と「要因」でまとめる。

---

## 1. 既知の事象と要因（修正済み）

### 1.1 商品画像が表示されない 【修正済み】

| 項目 | 内容 |
|------|------|
| **事象** | 入庫リスト・予定外入荷・検索候補などで商品画像が表示されない。 |
| **要因** | **inboundApi.js** の `fetchInventoryShipmentEnriched` が **`includeImages` を無視**しており、常に画像なし用の GraphQL クエリ（`qNoImg`）のみを使用している。そのため `lineItems` の各要素の **`imageUrl` が常に `""`** になっている（167行目付近）。 |
| **REFERENCE** | stock-transfer-tile の `ModalOutbound.jsx` 内 `fetchInventoryShipmentEnriched` では、`includeImages === true` のときに `variant { image { url } product { featuredImage { url } } }` を取得するクエリ（`qImg`）を使い、`imageUrl` を設定している。`false` のときのみ `qNoImg` にフォールバック。 |
| **修正方針** | inboundApi.js の `fetchInventoryShipmentEnriched` に、REFERENCE（tile）と同様の分岐を追加する。`includeImages` が true のときは画像付きクエリを実行し、`lineItems` に `imageUrl`（`variant.image?.url ?? product.featuredImage?.url ?? ""`）を詰める。 |
| **修正内容** | `inboundApi.js` に `includeImages === true` 用のクエリ（`qImg`）を追加。`variant { image { url } product { featuredImage { url } } }` を取得し、`lineItems` の `imageUrl` を設定。失敗時は従来の `qNoImg` にフォールバック。 |

---

### 1.2 InboundList に配送情報が表示されない（または出にくい） 【修正済み】

| 項目 | 内容 |
|------|------|
| **事象** | 入庫リスト画面のヘッダーに「配送業者」「配送番号」「予定日」が表示されない、または出にくい。 |
| **要因（データ）** | **API 側**: inboundApi.js の `fetchInventoryShipmentEnriched` は **tracking を取得・返却している**（`tracking { trackingNumber company trackingUrl arrivesAt }` をクエリし、`return { ... tracking: s.tracking ?? null }`）。Shopify の Shipment に tracking が未設定の場合は API が `null` を返すため、その場合は表示されない（仕様どおり）。 |
| **要因（UI）** | **REFERENCE**: ヘッダーでは「配送業者:」「配送番号:」「予定日:」の **3行を常に表示**し、値は `shipment?.tracking?.company` 等で、空なら空文字。**現行**: `shipment?.tracking ? (<>3行</>) : null` のため、**tracking オブジェクトが無いときはブロックごと非表示**になる。そのため、API が tracking を返していても、オブジェクトが空だったり型の違いで「無い」と判定されると表示されない。REFERENCE に合わせて「ラベルは常に表示・値は空でよい」にすると、データがあれば表示され、無くても項目は出る。 |
| **修正方針** | InboundListScreen.jsx の headerNode 内で、配送業者・配送番号・予定日の **3行を REFERENCE と同様に常に表示**する（`shipment?.tracking` の有無でブロックを出し分けしない）。値は `String(shipment?.tracking?.company ?? "").trim()` 等のまま、空なら空文字で表示。 |
| **修正内容** | `InboundListScreen.jsx` の headerNode で、`shipment?.tracking ? (<>3行</>) : null` をやめ、**常に3行の s-text**（配送業者 / 配送番号 / 予定日）を表示するように変更。値は `shipment?.tracking?.company` 等で、無い場合は空文字。 |

---

## 2. その他の REFERENCE との差（確認済み・差なし or 意図的）

以下は既に REFERENCE と揃えている、または意図的な差のみ。

| 項目 | REFERENCE | 現行 | 備考 |
|------|-----------|------|------|
| ヘッダー #T0000 / 出庫元 / 入庫先 | transferForShipment 優先で useMemo 算出 | **修正済み:** headNo / headerOriginName / headerInboundTo を transferForShipment 優先の useMemo で算出し、refresh 後に最新表示。 |
| ヘッダー 軽量・全入庫・リセット | あり | あり | 同一。モジュールレベル関数をインラインで呼ぶ形。 |
| ヘッダー 検索・検索結果表示 | 「検索結果：N件」 | 「検索結果：N件」 | 文言統一済み。 |
| 商品リスト 行の予定/入庫/増減 | あり | あり | setRowQty_ / incRow_ で REFERENCE と同等。キー比較も `key` / `shipmentLineItemId` 両方で一致済み。 |
| 商品リスト 画像 | variant image / featuredImage | **常に imageUrl が ""** | 上記 1.1 の要因で未実装。inboundApi 修正で解消予定。 |
| 予定外入荷・履歴・確定時メモ | あり | あり | renderExtras_ / renderExtrasHistory_ / renderConfirmMemo_ で同一。 |
| 複数シップメント グループ表示 | shipmentLabel でグループ | 同一 | formatShipmentLabelLocal でラベル付与済み。 |
| フッター 戻る・予定/入庫・確定 | あり | あり | 同一（Condition のフッターボタン・ステータスバッチは意図的変更のため除く）。 |
| 確定モーダル・一部入庫 | あり | あり | receiveConfirm / handleReceive で同等。 |
| スキャン・検索候補・在庫表示 | あり | あり | kickProcessScanQueue / searchVariants / ensureInbCandidateStock 等で同等。 |

---

## 3. 確定処理・一部入庫処理の REFERENCE との差 【修正済み】

以下は **receiveConfirm** 内のロジックの差。通常・予定外・超過不足・複数シップメントのいずれにも影響する。**いずれも REFERENCE と同じ処理に実装済み。**

### 3.1 複数シップメント確定処理 【修正済み】

| 項目 | REFERENCE | 現行 | 要因 |
|------|-----------|------|------|
| **受領送信** | **シップメントごと**に `byShipment` で行をグループ化し、各 `sid` に対して `receiveShipmentWithFallbackV2({ shipmentId: sid, items: plannedItems })` を呼ぶ。不足(rejected)も `rejectedByShip` でシップメントごとに送る。capped fallback もシップメントごと。 | **全行を先頭1シップメント**に送っている。`plannedItems` を `rows` 全体から作り、`receiveShipmentWithFallbackV2({ shipmentId: shipment.id, items: plannedItems })` で **shipment.id（先頭1件）のみ**に送信。2つ目以降のシップメントの明細が無視され、かつ他シップメントの lineItemId を先頭シップメントに送ってエラーになる可能性が高い。 | 現行は **isMultipleMode の分岐がなく**、単一と同じ処理のまま。 |

**修正内容:** receiveConfirm 内で isMultipleMode のとき、rowByLineId / byShipment / plannedByShip / rejectedByShip を組み立て、各 shipmentId に対して receiveShipmentWithFallbackV2 を呼ぶ。不足は rejectedByShip でシップメントごとに送信し、出庫元への返却は rawRejected をマージして rejectedDeltas で一度に adjust。capped 時の overflowMap も extraDeltas とマージして extraDeltasMerged に。

### 3.2 予定外入荷（extras）の出庫元在庫マイナス 【修正済み】

| 項目 | REFERENCE | 現行 | 要因 |
|------|-----------|------|------|
| **予定外の在庫** | 入庫先にプラスしたあと、**出庫元の在庫をマイナス**（`originDeltas = extraDeltasMerged` を `delta: -delta` で `adjustInventoryAtLocationWithFallback`）。 | **入庫先へのプラスのみ**。出庫元マイナスをしていない。 | 予定外は「入庫先にだけ足す」実装のまま。REFERENCE は入庫先＋出庫元の両方を更新。 |

**修正内容:** extraDeltasMerged を入庫先にプラスしたあと、`inbound?.selectedOriginLocationId` がある場合に `originDeltas = extraDeltasMerged.map(d => ({ ...d, delta: -d.delta }))` で出庫元に `adjustInventoryAtLocationWithFallback` を実行。

### 3.3 単一シップメント時の capped 超過分の extraDeltasMerged 【修正済み】

| 項目 | REFERENCE | 現行 | 要因 |
|------|-----------|------|------|
| **quantity エラー時** | plannedItems 送信でエラーになったとき、cappedItems を送ったあと、**超過分（overflow）を overflowMap に集計**し、extraDeltas とマージして **extraDeltasMerged** にする。その後の「予定外の入庫先プラス・出庫元マイナス」では **extraDeltasMerged** を使用（超過分も予定外として在庫調整）。 | cappedItems を送る**だけ**。overflow を extraDeltas にマージしていない。超過分が予定外として在庫調整されない。 | extraDeltasMerged の概念がなく、常に extraDeltas のみ使用。 |

**修正内容:** 単一シップメントで quantity エラー時に overflowMap を計算し、cappedItems 送信後 extraDeltas とマージして extraDeltasMerged を設定。その後の「予定外の入庫先プラス・出庫元マイナス」で extraDeltasMerged を使用。

### 3.4 確定後の「在庫調整履歴」メモ追記 【修正済み】

| 項目 | REFERENCE | 現行 | 要因 |
|------|-----------|------|------|
| **管理画面メモ** | 確定処理後に、rejectedDeltas（出庫元へ戻した分）と extraDeltasMerged（入庫先プラス・出庫元マイナス）の内容を **inventoryAdjustments** として `buildInboundNoteLine_({ ..., inventoryAdjustments })` に渡し、**appendInventoryTransferNote_** で「在庫調整履歴」を追記。 | このブロックがない。 | 確定後のメモに在庫調整の内訳を残していない。 |

**修正内容:** 確定処理・在庫調整のあと、`transferId && (rejectedDeltas.length > 0 || extraDeltasMerged.length > 0)` のときに adjustments（拒否→出庫元、予定外→入庫先プラス・出庫元マイナス）を組み立て、`buildInboundNoteLine_({ ..., inventoryAdjustments: adjustments })` で `appendInventoryTransferNote_` を1回呼ぶ。

### 3.5 その他 【修正済み】

| 項目 | REFERENCE | 現行 | 備考 |
|------|-----------|------|------|
| **readOnly / 二重送信** | 冒頭で `if (readOnly)` で toast して return false。`receiveLockRef.current` で二重実行を防止。finally で `receiveLockRef.current = false`。 | readOnly は canConfirm に含まれ、receiveLockRef なしだった。 | **修正済み:** receiveLockRef を追加し、冒頭で readOnly と receiveLockRef をチェック。finally で receiveLockRef.current = false。 |
| **onAfterReceive** | **複数シップメントのときは onAfterReceive を呼ばない**（「まとめて表示の時は既存の動作を維持」）。 | **isMultipleMode でも** onAfterReceive を呼んでいた。 | **修正済み:** `if (!isMultipleMode && finalize && typeof onAfterReceive === "function")` で呼ぶように変更。readOnly 冒頭チェックと receiveLockRef による二重送信防止も追加。 |

---

## 4. 修正後の確認ポイント（画像・配送）

1. **商品画像**  
   - 入庫リストの行で `showImages === true`（軽量OFF）のときに画像が表示されること。  
   - 予定外入荷・検索候補は既に searchVariants / resolveVariantByCode の `includeImages` で画像を取得しているため、**Shipment 明細のみ** inboundApi の `fetchInventoryShipmentEnriched` 修正で解消する。

2. **配送情報**  
   - ヘッダーに「配送業者:」「配送番号:」「予定日:」が常に 3 行表示されること。  
   - API が tracking を返している場合は値が表示され、未設定の場合は空でよい。

---

## 5. その他の漏れ・要確認（REFERENCE との徹底比較）

入庫アプリの要件を満たすために、REFERENCE と比較して**漏れ・要確認**と思われる項目を洗い出した一覧。

### 5.1 要対応（確定処理・状態に影響） 【修正済み】

| # | 項目 | REFERENCE | 現行 | 要因・修正方針 |
|---|------|-----------|------|----------------|
| 1 | **InboundShipmentSelection で selectedOriginLocationId** | シップメント選択画面から InboundList へ遷移する際、REFERENCE は **transferForShipment** を InboundList 内で pendingTransfers から逆引きして originLocationId を取得。state には保存しない。 | 現行は **inbound.selectedOriginLocationId** を receiveConfirm で参照。InboundConditions では set しているが、**シップメント選択画面で1つ選んで InboundList へ**のときは onSelectShipment で selectedOriginLocationId を set していなかった。 | **修正済み:** InboundShipmentSelection の `onSelectShipment` 内で `selectedOriginLocationId: String(transfer?.originLocationId ?? "")` を追加。 |
| 2 | **確定前メモの overForLog に sku** | REFERENCE の overForLog は `sku: String(x?.sku \|\| "").trim()` を含む。buildInboundNoteLine_ は over の sku があれば「(SKU: xxx): +N」と出力。 | 現行の overRows は sku なし、overForLog も sku を渡していなかった。 | **修正済み:** overRows に `sku: r.sku` を追加し、overForLog に `sku: String(x?.sku ?? "").trim()` を追加。 |

### 5.2 要確認・検討 【REFERENCE に合わせて修正済み】

| # | 項目 | REFERENCE | 現行 | 備考 |
|---|------|-----------|------|------|
| 3 | **InboundList の「戻る」の遷移先** | 確定後に **Transfer が完了（全シップメント RECEIVED/TRANSFERRED）なら INBOUND_COND へ**遷移し inbound 状態をクリア。**未完了なら INBOUND_SHIPMENT_SELECTION へ**遷移し、selectedShipmentId / selectedShipmentIds / shipmentMode のみクリア。「戻る」は nav.pop()。 | **修正済み:** Modal.jsx で **onAfterReceiveInboundList(transferId)** を実装。確定成功後に onAfterReceive(transferId) で fetchTransfersForDestinationAll から Transfer を取得し、全シップメント完了なら INBOUND_COND＋inbound クリア、未完了なら INBOUND_SHIPMENT_SELECTION＋シップメントのみクリア。onBack は goBack（pop）のまま。 |
| 4 | **transferForShipment 相当の算出** | REFERENCE は InboundList 内で **pendingTransfers + allTransfers** から「現在の shipment を含む Transfer」を **transferForShipment** として useMemo で算出。readOnly や originLocationId、**ヘッダー表示（#T0000/出庫元/入庫先）** も transferForShipment から取得。 | **修正済み:** InboundListScreen で **transferForShipment** を useMemo で算出。readOnly / transferId / originLocationId を transferForShipment 優先で使用。**ヘッダー**の headNo / headerOriginName / headerInboundTo も transferForShipment 優先の useMemo で算出し、refresh 後に最新表示。 |
| 5 | **一覧取得の listLimit の参照元** | REFERENCE は **appState?.outbound?.settings?.inbound?.listInitialLimit** を参照。 | **修正済み:** **appState?.outbound?.settings?.inbound?.listInitialLimit ?? settings?.inbound?.listInitialLimit ?? 100** に統一（Modal InboundConditions / InboundListScreen refreshPending / InboundShipmentSelection / onAfterReceiveInboundList）。入庫専用では outbound が無い場合は settings にフォールバック。 |
| 6 | **appendInventoryTransferNote_ の processLogCallback** | REFERENCE は確定前メモ追記時に **processLogCallback: addProcessLog** を渡し、デバッグ用ログを残せる。 | **修正済み:** 確定前メモ追記時に **processLogCallback: addProcessLog**（空関数）を渡すように変更。機能差はなくデバッグ用。 |

### 5.3 意図的・仕様差の可能性

| # | 項目 | REFERENCE | 現行 | 備考 |
|---|------|-----------|------|------|
| 7 | **入庫へのエントリ** | メニュー画面（出庫/入庫ボタン）→「入庫」→ INBOUND_COND。 | 入庫専用アプリはモーダルを開くと**最初から INBOUND_COND**。メニューは不要の可能性。 | 意図的とみなしてよい。 |
| 8 | **InboundConditions のヘッダー** | REFERENCE は「未入庫 N件」「入庫済み N件」のタブ＋「未読み込み一覧リストがあります」＋読込ボタン。 | 現行も同様のタブ＋読込ボタンを実装済み。 | 差なし。 |
| 9 | **ヘッダー入庫先名のフォールバック** | Transfer の destinationName が無いとき **getLocationName_(locationGid, locIndex.byId)** で現在ロケ名を表示。 | 現行は **"-"** で表示。 | 表示上の差のみ。必要なら InboundListScreen で useLocationsIndex + getLocationName_ を追加可能。 |

---

## 6. モーダル関連の REFERENCE との差

入庫アプリで使うモーダル類と REFERENCE の比較。**入庫確定の警告「確認しました」は現行の内容を維持**（ユーザー要望）。

### 6.1 入庫確定の警告エリア（予定外/超過/不足時） 【意図的に現行維持】

| 項目 | REFERENCE | 現行（維持） |
|------|-----------|--------------|
| **見出し** | 「予定差異があります（予定外/超過/不足）」 | 「予定外/超過/不足があります。理由とメモを入力し、「確認しました」を押してください。」 |
| **理由** | 入力欄なし | **理由（予定超過/予定外入荷/破損/その他）** の s-text-field あり |
| **メモ** | label「メモ（任意）」、placeholder「例: 発注数誤り...」 | placeholder「メモ」の s-text-field |
| **確認ボタン** | トグル「内容を確認しました（必須）」/「OK」、補足「※ チェックがONでないと「確定」できません」 | **「確認しました」/「確認済み」**（押下で setAckWarning(true) の一方向）。理由・メモとセットで運用。 |

**方針:** 上記の**現行の警告エリア（理由＋メモ＋「確認しました」ボタン）をそのまま活かす**。REFERENCE のトグル／「内容を確認しました（必須）」には合わせない。

### 6.2 入庫確定モーダル（CONFIRM_RECEIVE_MODAL_ID） 【内容は REFERENCE と同等】

| 項目 | REFERENCE | 現行 |
|------|-----------|------|
| **heading** | 「入庫を確定しますか？」 | 同一 |
| **本文** | 予定/入庫・予定外/超過/不足のサマリー、不足(N件)+行、予定外(N件)+行、超過(N件)+行、hasWarning 時は warningAreaNode、戻る | 同一構成。DIFF_PREVIEW_LIMIT=1、不足/予定外/超過の key は shipmentLineItemId または key。 |
| **ボタン** | 戻る、一部入庫（一時保存）、確定する。一部入庫/確定するは onClick と **onPress** の両方。 | 同一。**onPress を追加済み**（REFERENCE 互換）。 |
| **閉じ方** | 成功時に hideReceiveConfirmRef.current?.click?.() で「戻る」をクリック | 成功時に document.querySelector(`#${CONFIRM_RECEIVE_MODAL_ID}`)?.hide?.() で閉じる（機能的に同等）。 |

### 6.3 処理方法を選択モーダル（SHIPMENT_MODE_SELECTION） 【内容は REFERENCE と同等】

| 項目 | REFERENCE | 現行 |
|------|-----------|------|
| **heading** | 「処理方法を選択」 | 同一 |
| **本文** | Transfer/出庫元/宛先/シップメント数、説明2行（シップメントごとに選択／まとめて表示）、戻る | 同一。現行は pendingTransferForModal \|\| pendingTransferForModalRef.current で表示を安定化。 |
| **アクション** | シップメントごとに選択（secondary-actions）、まとめて表示（primary-action） | 同一。command="--hide" commandFor=... でモーダルを閉じつつ遷移。 |

### 6.4 その他モーダル

| モーダル | 備考 |
|----------|------|
| **行の数量変更**（renderInboundShipmentItems_ 内） | InboundUiParts.jsx の StockyRowShell／qty 用 s-modal。REFERENCE 互換。 |
| **予定外の数量指定**（数量を指定して追加） | InboundUiParts.jsx の InboundCandidateRow 内 s-modal。REFERENCE 互換。 |
| **スキャンエラー等の alert** | waitForOk → dialog.alert。REFERENCE と同様。 |

---

## 7. その他・確認しておくべき要素（漏れの最終確認）

REFERENCE と照合したうえで、追加で確認・対応した項目。

| # | 項目 | REFERENCE | 現行 | 備考 |
|---|------|-----------|------|------|
| 1 | **監査ログ（appendInboundAuditLog）の extras** | 確定後に**実際に反映した予定外**（**extraDeltasMerged**）から extrasForLog を組み立てて渡す。capped 超過分も含まれる。 | 確定前の **extras**（画面 state）から extrasForLog を組み立てて渡していた。 | **修正済み:** appendInboundAuditLog に渡す extras を **extraDeltasMerged** から組み立てるように変更（extrasMap で title/sku 等を補完）。 |
| 2 | **ヘッダー内の検索結果表示文言** | 「**検索リスト 候補：** N件」。 | ヘッダー内は「**検索結果：** N件」、本文ブロックは「検索リスト 候補： N件」。 | 表示上の差のみ。REFERENCE に揃えるならヘッダーも「検索リスト 候補：」に統一可能。 |
| 3 | **allTransfers / refreshAllTransfers** | InboundList で **refreshPending** と **refreshAllTransfers** の両方を実行し、transferForShipment を **pendingTransfers + allTransfers** から算出。 | **pendingTransfers のみ**で transferForShipment を算出（allTransfers は未使用）。 | 確定後は onAfterReceive で遷移するため InboundList に留まらない。戻る時は pending で十分。意図的な省略で問題なし。 |

---

## 8. 参照

- **REFERENCE**: `extensions/stock-transfer-tile/src/Modal_REFERENCE.jsx`（入庫リスト: 8269 行～、ヘッダー 10254～、fetchInventoryShipmentEnriched は tile では同ファイル内にないため `ModalOutbound.jsx` 9280 行～を参照）
- **画像付き Shipment 取得（tile）**: `ModalOutbound.jsx` の `fetchInventoryShipmentEnriched`（includeImages 時は `qImg` で `variant { image { url } product { featuredImage { url } } }` を取得）
- **現在の入庫 API**: `extensions/stock-transfer-inbound/src/inboundApi.js` の `fetchInventoryShipmentEnriched`
- **現在の入庫画面**: `extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx`（ヘッダーは headerNode の useMemo 内）
