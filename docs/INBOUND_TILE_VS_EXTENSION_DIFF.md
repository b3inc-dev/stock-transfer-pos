# 入庫：tile Modal（4分割前）と入庫拡張の差分と完全再現対応

**参照元コード**: `extensions/stock-transfer-tile/src/Modal.jsx` 内  
- **InboundConditions** 約2720行〜  
- **InboundList** 約3532行〜  

**現行入庫拡張**: `extensions/stock-transfer-inbound/`（Modal.jsx, InboundShipmentSelection.jsx, InboundListScreen.jsx, inboundApi.js）

---

## 1. 実施した完全再現対応（今回）

### 1.1 設定（metafield）の読み込み

- **tile**: `bootstrap()` で metafield（settings_v1）を取得し `outbound.settings` に格納。InboundConditions / InboundList は `appState?.outbound?.settings?.inbound?.listInitialLimit` 等を参照。
- **入庫拡張（修正前）**: 設定を metafield から読んでおらず、`appState.outbound.settings` は常に未設定 → 常にデフォルト値。
- **対応**:  
  - `inboundApi.js` に **fetchSettings()** を追加（metafield 取得、tile/loss と同じ namespace/key）。  
  - `Modal.jsx` でマウント時に **fetchSettings()** を実行し、**settings** を state で保持。  
  - InboundConditions / InboundShipmentSelection / InboundListScreen に **settings** を渡し、**履歴一覧リスト（listInitialLimit）・商品リスト（productList.initialLimit）・検索リスト（searchList.initialLimit）** を管理画面の設定どおりに使用。

### 1.2 入庫コンディション（InboundConditions）

- **tile**: `transfersPageInfo`（hasNextPage, endCursor）、`loadMoreTransfers_`、「さらに読み込み」用 UI、`appState?.outbound?.settings?.inbound?.listInitialLimit` で初回・追加読み込み件数を指定。
- **入庫拡張（修正前）**: ページネーションなし。listInitialLimit は設定未読のためデフォルト 100。
- **対応**:  
  - **transfersPageInfo** / **loadingMore** / **loadMoreTransfers_** を追加。  
  - ヘッダーに「未読み込み一覧リストがあります。（過去分）」＋「読込」ボタンを追加（tile と同様）。  
  - **listInitialLimit** を **settings?.inbound?.listInitialLimit** から算出（未設定時は 100）。  
  - refresh 時も **setTransfersPageInfo** を更新。

### 1.3 シップメント選択（InboundShipmentSelection）

- **tile**: 該当画面はモーダル内の「シップメントごとに選択」で遷移。transfer はコンディションで選択したものを state で保持。  
- **入庫拡張**: 再取得時に `fetchTransfersForDestinationAll` の件数に **settings?.inbound?.listInitialLimit** を使用するよう変更。

### 1.4 入庫リスト（InboundListScreen）

- **tile InboundList**: `appState?.outbound?.settings?.productList?.initialLimit` を lineItems 取得の `first` に使用。`searchList.initialLimit` を検索結果の件数に使用。
- **入庫拡張（修正前）**: fetchInventoryShipmentEnriched の `first` は未指定（API デフォルト 250）。設定未読。
- **対応**:  
  - **settings?.productList?.initialLimit** を参照し、**fetchInventoryShipmentEnriched(..., { first: productFirst })** に渡す。  
  - 検索リストは現状 InboundListScreen に検索 UI がないため、検索を追加する場合は **settings?.searchList?.initialLimit** を使用する想定。

---

## 2. 差分一覧（tile 元コード vs 入庫拡張）

| 項目 | tile Modal（元） | 入庫拡張（修正前） | 修正後 |
|------|------------------|--------------------|--------|
| 設定の取得 | bootstrap で metafield 取得 → outbound.settings | なし | fetchSettings() で取得 → settings state |
| 履歴一覧リスト件数 | settings.inbound.listInitialLimit | 未使用（常に100） | settings.inbound.listInitialLimit を使用 |
| コンディション「さらに読み込み」 | transfersPageInfo + loadMoreTransfers_ + UI | なし | 追加済み |
| シップメント選択の再取得件数 | （コンディションと同様） | 固定値 | settings.inbound.listInitialLimit を使用 |
| 商品リスト件数（lineItems first） | settings.productList.initialLimit | 未使用（API デフォルト） | settings.productList.initialLimit を使用 |
| 検索リスト件数 | settings.searchList.initialLimit | 検索 UI なし | 検索追加時に searchList.initialLimit を参照予定 |

---

## 3. 残差（完全一致ではない部分）

- **InboundList の機能規模**: tile の InboundList は、複数シップメント一括表示・予定外入荷（extras）・スキャンキュー・確定時の超過/不足処理・検索（searchVariants）・lineItems の追加読み込み（loadMoreLineItems_）・dialog など多機能。入庫拡張の InboundListScreen は「1 シップメント・明細・入庫数編集・確定・下書き」の最小構成。完全に同一にするには、tile の InboundList を移植するか、上記機能を順次追加する必要がある。
- **検索リスト**: InboundListScreen に検索 UI を追加する場合、searchList.initialLimit を参照する実装を追加する。

---

## 4. 変更ファイルまとめ

- **inboundApi.js**: fetchSettings() 追加、DEFAULT_SETTINGS / SETTINGS_NS / SETTINGS_KEY 定義。
- **Modal.jsx**: settings state、useEffect で fetchSettings、InboundConditions / InboundShipmentSelection / InboundListScreen に settings を渡す。InboundConditions に listInitialLimit・transfersPageInfo・loadMoreTransfers_・「さらに読み込み」UI を追加。
- **InboundShipmentSelection.jsx**: settings プロップ受け取り、再取得時の listLimit に settings?.inbound?.listInitialLimit を使用。
- **InboundListScreen.jsx**: settings プロップ受け取り、fetchInventoryShipmentEnriched に first: productFirst（settings?.productList?.initialLimit）を渡す。
