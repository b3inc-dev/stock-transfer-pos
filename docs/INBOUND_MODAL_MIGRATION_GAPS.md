# 入庫：Modal 時からの未反映処理の洗い出しと反映

**目的**: stock-transfer-inbound が、分割前の Modal（tile の InboundConditions / InboundList）と比べて不足していた処理を洗い出し、反映した内容を記録する。

---

## 1. 洗い出し結果（4TILE_VS_ORIGINAL_DIFF 等より）

| 項目 | Modal 時の扱い | 反映前の inbound | 対応内容 |
|------|----------------|-------------------|----------|
| **一覧の表示速度** | （同様に監査ログマージあり） | 同期で監査ログまで待ってから表示 | ✅ 二相ロード（先に API 結果を表示し、監査ログは非同期でマージ）を Modal.jsx に適用済み |
| **複数シップメントの「リスト」ボタン** | 配送数 > 1 の行に「リスト」ボタンがあり、押下でモーダル表示 | モーダルはあるが開くトリガーがなく、ボタンもなし | ✅ 配送数 > 1 の行に「リスト」ボタンを追加。`command="--show"` `commandFor={SHIPMENT_MODE_SELECTION_MODAL_ID}` でモーダルを開く。ref でクリック直後の state を補完 |
| **「まとめて表示」後の商品リスト** | 複数 Shipment を並列取得し、lineItems をマージして 1 画面で表示 | loadMultipleShipments がなく、複数 ID 時も 1 件だけ loadShipment していた | ✅ InboundListScreen に loadMultipleShipments を追加。isMultipleMode && ids.length > 1 のとき loadMultipleShipments(ids) を実行。二相で監査ログを後から反映 |
| **商品リストのフリーズ** | （1 件／複数件とも）先に明細表示してから監査ログ反映 | 初回表示前に監査ログを同期待ち | ✅ loadShipment / loadMultipleShipments を二相化（先に setRows → setShipmentLoading(false)、その後監査ログで over を反映） |

---

## 2. 今回の修正ファイルと変更内容

### extensions/stock-transfer-inbound/src/Modal.jsx

- **複数シップメント時の「リスト」ボタン**
  - 配送数 > 1 の行に `<s-button command="--show" commandFor={SHIPMENT_MODE_SELECTION_MODAL_ID}>リスト</s-button>` を追加。
  - クリックで `setPendingTransferForModal(t)` と ref への代入を行い、モーダル表示と内容の一致を確保。
- **モーダル内容の参照**
  - モーダル表示直後のレンダーで state がまだ更新されない場合に備え、`pendingTransferForModalRef.current` を併用。
- **モーダル内ボタン**
  - 「戻る」「配送ごとに選択」「まとめて表示」に `command="--hide"` `commandFor={SHIPMENT_MODE_SELECTION_MODAL_ID}` を付与し、押下でモーダルを閉じる。
  - 各ハンドラで `pendingTransferForModalRef.current = null` と `setPendingTransferForModal(null)` でクリア。

### extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx

- **loadMultipleShipments の追加**
  - `selectedShipmentIds` を並列で `fetchInventoryShipmentEnriched` し、lineItems を `shipmentId` / `shipmentLabel` 付きでマージ。
  - 監査ログの over は二相目で反映（先に setRows → setShipmentLoading(false)、その後 setRows で overAcceptedQty を更新）。
  - 下書きは transferId + shipmentIds[0] で loadInboundDraft し、複数シップメント対応の行マッチで復元。
- **useEffect の分岐**
  - `isMultipleMode && ids.length > 1` → `loadMultipleShipments(ids)`。
  - `isMultipleMode && ids.length === 0` → 一覧・エラー・pageInfo をクリア。
  - 上記以外で `selectedShipmentId` がある場合 → 従来どおり `loadShipment()`。

---

## 3. 今後の確認ポイント

- 入庫一覧で「配送数: 2」以上の行に「リスト」ボタンが表示され、押下で「処理方法を選択」モーダルが開くこと。
- 「まとめて表示」選択後、商品リストが複数シップメント分マージされて表示され、フリーズせず操作できること。
- 単一シップメント・複数シップメントとも、先に明細が表示され、その後に監査ログの超過表示が付くこと（二相ロードの動作）。
