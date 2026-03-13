# 入庫アプリタイルで商品が (unknown) になる問題の対応

## 現象

- **管理画面（PC）・在庫移管リスト**では商品名が正しく表示される。
- **POS の入庫画面（アプリタイル／拡張）**では、同じ伝票の一部の行が「(unknown)」のまま表示される。
- これが原因で、確定時に「配送先ロケーションにアイテムの在庫がありません」などの在庫有効化エラーにつながる可能性がある。

## 要因（コード上の原因）

1. **Shipment の lineItems で `inventoryItem` や `variant` が null になる場合**
   - `fetchInventoryShipmentEnriched` は `inventoryShipment(id).lineItems.nodes` を取得し、各 node の `inventoryItem.variant` から `product.title` / `variant.title` を組み立てている。
   - Shopify API の都合や、取得タイミング・API バージョンなどで、一部の lineItem で `inventoryItem` や `inventoryItem.variant` が null になることがある。
   - その場合、`productTitle` / `variantTitle` が空になり、フォールバックが `li.inventoryItem?.id` のみで、さらに `inventoryItem` 自体が null だと `"(unknown)"` になっていた。

2. **タイトル解決の欠如**
   - `inventoryItemId` はあるが `variant` が null（例: 削除済みバリアント参照）のケースで、別クエリで `nodes(ids: [inventoryItemId])` から InventoryItem.variant を取得してタイトルを補完する処理がなかった。

3. **lineItem.id をフォールバックに使っていなかった**
   - 少なくとも明細行の識別子（lineItem.id）を表示に使っていなかったため、`inventoryItem` が null のとき即「(unknown)」になっていた。

4. **下書き復元**
   - 下書き復元時は「API の baseRows の title のみ」を使っており、draft.rows の title では上書きしていない。  
     ただし、**初回表示の baseRows が API から (unknown) で返ってきている**と、復元後も (unknown) のままになる。  
     そのため、根本対策は「API 取得時・表示用組み立て時に (unknown) を出さない／補完する」こと。

## 対応内容（再発防止）

### 1. fetchInventoryShipmentEnriched（inbound 拡張・inboundApi.js）

- **title のフォールバックに `li.id` を追加**  
  `variantTitle || productTitle || v?.sku || li.inventoryItem?.id || li.id || "(unknown)"` とし、  
  `inventoryItem` が null でも lineItem の id があれば (unknown) にせず表示する。
- **resolveMissingLineItemTitles_** を追加  
  - `title === "(unknown)"` または未設定で、かつ `inventoryItemId` がある lineItem を対象に、  
    `nodes(ids: [inventoryItemId])` で InventoryItem の `variant { product { title } title }` を取得。
  - 取得できたタイトルで該当 lineItem の `title`（必要なら `productTitle` / `variantTitle`）を上書き。
  - 画像あり・画像なしの両方のクエリパスの戻り値に対して、return 前にこの解決処理を 1 回ずつ実行。

### 2. タイル拡張（stock-transfer-tile・ModalOutbound.jsx）

- 上記と同様の **resolveMissingLineItemTitlesTile_** を定義し、  
  - 画像ありクエリ
  - 画像なしクエリ（qNoImg）
  - 最小クエリ（qMin）  
  の 3 パスすべてで、lineItems を返す前に実行。
- 各パスで **title のフォールバックに `li.id` を追加**（qMin は `li.inventoryItem?.id || li.id || "(unknown)"`）。

### 3. 下書き復元（InboundListScreen.jsx）

- 単一シップメントの下書き復元で「表示用の title/sku は必ず API の baseRows を採用する」旨をコメントで明示。
- 複数シップメントではもともと API の `li` から `title` を組み立てているため、同様に「API 由来の title を優先」している。

### 4. 複数シップメント時の行タイトル

- `allRows` 組み立て時のフォールバックに `li.id` を追加し、  
  `title: li.title || li.sku || li.inventoryItemId || li.id || "(unknown)"` に統一。

## 結果

- API で `inventoryItem` / `variant` が null でも、`inventoryItemId` があれば nodes でタイトル解決を試みるため、(unknown) になる件数を削減できる。
- 解決できなくても、lineItem.id を表示に使うため、完全な (unknown) を減らせる。
- 下書き復元時も「常に API の baseRows の title を使う」ことをコードで明示し、古い下書きの title で上書きしないようにした。
- これにより、商品リストが正しく表示され、在庫有効化・確定処理で必要な inventoryItemId と表示の対応が取りやすくなり、在庫有効化エラーの一因を抑えられる。
