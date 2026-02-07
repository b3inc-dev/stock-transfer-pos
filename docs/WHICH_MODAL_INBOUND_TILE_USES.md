# 入庫タイルが実際に使っているモーダル

## 結論

**「入庫 / 在庫処理」タイルをタップしたときに開くモーダルは、  
`extensions/stock-transfer-inbound/src/Modal.jsx` です。**

`extensions/stock-transfer-tile/src/ModalInbound.jsx` は**入庫タイルでは一切使われていません**。

## 根拠

| 拡張 | タイル表示 | モーダル（pos.home.modal.render） |
|------|------------|-----------------------------------|
| **stock-transfer-tile** | 「出庫 / 在庫処理」 | `ModalOutbound.jsx` のみ |
| **stock-transfer-inbound** | 「入庫 / 在庫処理」 | `Modal.jsx` |

- `stock-transfer-tile/shopify.extension.toml` の `pos.home.modal.render` は `./src/ModalOutbound.jsx` のみ指定。
- `stock-transfer-inbound/shopify.extension.toml` の `pos.home.modal.render` は `./src/Modal.jsx` を指定。
- リポジトリ内で `ModalInbound.jsx` を import しているファイルは**0件**。

そのため、入庫タイルの「一覧が遅い」「リストボタンが表示されない」「商品リストでフリーズする」などの修正は、  
**stock-transfer-inbound の Modal.jsx（および InboundListScreen.jsx / inboundApi.js）に対して行う必要があります。**

## 修正対象の正しいパス

- 一覧・コンディション: `extensions/stock-transfer-inbound/src/Modal.jsx`（InboundConditions）
- 商品リスト: `extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx`
- API: `extensions/stock-transfer-inbound/src/inboundApi.js`
