# Modal.jsx と ModalOutbound.jsx の差分（商品リスト・履歴表示）

出庫・入庫を Modal から 2 分割したあと、商品リストが表示されない／フリーズする問題の調査用に、**商品リスト読み込み**と**履歴一覧の「未確定：1」表示**まわりの差分を整理したものです。

---

## 1. 商品リスト（OutboundHistoryDetail の loadDetail_）

### 1.1 共通している点

- どちらも `fetchInventoryTransferDetailForHistory` で詳細を取得し、`d.shipments` / `d.lineItems` は**配列**に正規化して返している（GraphQL の `nodes` を map した結果）。
- どちらも `sid` があれば `fetchInventoryShipmentEnriched`、なければ `fetchTransferLineItemsEnriched` または `d.lineItems` のフォールバックで商品リストを組み立てている。
- `fetchInventoryShipmentEnriched` の戻り値はどちらも `{ lineItems: 配列, pageInfo }` で、`lineItems` はすでに配列。

### 1.2 ModalOutbound.jsx でだけやっていること（分割後の修正）

| 項目 | Modal.jsx | ModalOutbound.jsx |
|------|-----------|-------------------|
| **sid の取得** | `d?.shipments?.[0]?.id` のみ | `d.shipments` が配列でないときは `d.shipments?.nodes` を参照し、`shipmentsList[0]?.id` で取得 |
| **ship.lineItems** | `Array.isArray(ship?.lineItems) ? ship.lineItems : []` のみ | 上記に加え `ship?.lineItems?.nodes` も配列として扱う |
| **loadDetail_ の実行タイミング** | `useEffect(() => { loadDetail_(); }, [loadDetail_]);` | `useEffect(() => { if (transferId) loadDetail_(); }, [loadDetail_, transferId]);` で **transferId がセットされたときだけ**実行 |

### 1.3 商品リストが表示されない／フリーズしうる要因（分割後にありがちなもの）

1. **transferId のタイミング**  
   詳細画面に遷移した直後、`setStateSlice` で `historySelectedTransferId` をセットしてから `nav.push(OUTBOUND_HIST_DETAIL)` している。  
   分割後は **state の更新が非同期**のため、詳細コンポーネントの初回レンダーで `outbound.historySelectedTransferId` がまだ空になりうる。  
   その結果 `transferId === ""` のまま `loadDetail_()` が走り、先頭の `if (!transferId) return` で何も取得せず終わる。  
   **対応**: `useEffect` の依存に `transferId` を入れ、**`transferId` が truthy のときだけ** `loadDetail_()` を実行するようにした（上記のとおり）。

2. **sid が空になるパス**  
   `fetchInventoryTransferDetailForHistory` は内部で `d.shipments` を配列にして返しているので、通常は `d.shipments[0]?.id` で取れる。  
   ただし、将来 API やラップ処理が変わって `d.shipments` が `{ nodes: [...] }` のまま渡る場合は、Modal.jsx の `d?.shipments?.[0]?.id` は undefined になり、sid が空になる。  
   **対応**: ModalOutbound では `shipmentsList` を「配列 or nodes」で正規化してから `shipmentsList[0]?.id` を参照するようにしている。

3. **履歴ブロックの初回読み込み**  
   OutboundConditions 側の履歴で `setHistoryTransfers(all)` としていた場合、`fetchTransfersForOriginAll` の戻り値は `{ transfers, pageInfo }` なので、**配列ではなくオブジェクト**が state に入り、一覧が空になる。  
   **対応**: `setHistoryTransfers(Array.isArray(result?.transfers) ? result.transfers : [])` に変更。

---

## 2. 履歴一覧の「（未確定：1）」表示

### 2.1 条件

- Transfer の status が `READY_TO_SHIP`
- かつ、その Transfer に紐づく shipment のうち、status が `DRAFT` のものが 1 件以上ある  
→ その数を「（未確定：N）」として表示する。

### 2.2 データの流れ

- 一覧の元データは `fetchTransfersForOriginAll` の `transfers`。
- 各要素 `t` に対して `t.shipments` を「配列 / nodes / node(単数) / edges / 単体オブジェクト」のどれかから正規化し、`unconfirmedCount = shipments.filter(s => s.status === "DRAFT").length` で未確定件数を出している。

### 2.3 配送が 1 件だけのときに「（未確定：1）」が出ない要因

- GraphQL の connection で、**1 件だけのときに `nodes` ではなく `node`（単数）で返す**実装や、キャッシュ層の変換があると、`t.shipments.nodes` は undefined になり、正規化前は `shipments` が空になる。
- その結果 `unconfirmedCount` が常に 0 になる。

**対応（ModalOutbound.jsx / OutboundHistoryScreens.jsx の両方）**:

- `fetchTransfersForOriginAll` 内の `normalizeShipmentsFromTransfer` で、  
  `t.shipments?.node`（単数オブジェクト）のときは `raw = [t.shipments.node]` とする。
- 一覧を描画するときの `shipments` 正規化でも、同じく **node (単数)** を `[t.shipments.node]` に変換する。

これで、配送が 1 件だけでも「（未確定：1）」が表示される想定です。

---

## 3. 今回の修正まとめ

| 問題 | 対応内容 |
|------|----------|
| 履歴一覧で「（未確定：1）」が出ない | shipments の正規化に **node (単数)** を追加（fetchTransfersForOriginAll・一覧表示の両方）。ModalOutbound.jsx と OutboundHistoryScreens.jsx の両方に適用。 |
| 商品リストが表示されない／固まる | ① `loadDetail_` を **transferId がセットされたときだけ**実行するよう useEffect を変更 ② OutboundConditions の履歴で `setHistoryTransfers(result?.transfers ?? [])` に修正（配列だけ渡す）。 |
| sid が取れない可能性 | 詳細の `d.shipments` を「配列 or nodes」で正規化してから `shipmentsList[0]?.id` を参照（前回対応済み）。 |

---

## 4. 分割前（Modal.jsx）で動いていた理由の整理

- 出庫と入庫が同じ Modal ツリーにいたため、**同じレンダー／state 更新の流れ**のなかで詳細に遷移しており、`historySelectedTransferId` が空のまま詳細がマウントされるケースが少なかったと考えられる。
- 分割後は Extension のマウント単位が変わり、**state 更新と画面 push のタイミング**がずれると、詳細の初回レンダーで `transferId` が空になりうる。
- その結果、`loadDetail_()` が「何もせず return」するパスだけが走り、商品リストが一度も描画されない／読み込み中のまま止まる、といった現象になりうる。

上記の「transferId がセットされたときだけ loadDetail_ を実行する」変更で、そのずれを避けるようにしています。
