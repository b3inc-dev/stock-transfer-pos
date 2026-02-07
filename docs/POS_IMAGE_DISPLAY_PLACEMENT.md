# POS：画像表示ON/OFFの設置箇所一覧

出庫・入庫・ロス・棚卸の各拡張で、「画像表示」（liteMode の ON/OFF）を切り替えるUIがどの画面のどの箇所に設置されているかをまとめたドキュメントです。

**共通仕様**
- 設定は `stock_transfer_pos_ui_prefs_v1`（localStorage）の `liteMode` で保持され、各拡張の Modal で `prefs.liteMode` として管理。
- コンディション・商品リスト・履歴など、同一拡張内では同じ `liteMode` / `onToggleLiteMode` を渡して連動。

---

## 出庫（stock-transfer-tile / ModalOutbound.jsx）

| 画面 | 設置箇所 | 内容 | コンポーネント／行付近 |
|------|----------|------|-------------------------|
| **コンディション**（出庫ID一覧） | フッター **左** | ボタン「画像表示:OFF」／「画像表示:ON」 | `OutboundConditions` / FixedFooterNavBar `leftLabel` |
| **履歴一覧**（未出庫・出庫済み一覧） | フッター **中央** | ボタン「画像表示:OFF」／「画像表示:ON」 | `OutboundHistoryConditions` / FixedFooterNavBar `middleLabel` |
| **配送リスト**（シップメント選択） | フッター 中央 | 「再読込」のみ（画像表示ボタンなし） | `OutboundShipmentSelection` |
| **商品リスト**（出庫リスト） | ヘッダー **右** | ボタン「画像表示」（在庫更新・複製の左） | `OutboundList` / setHeader 内 s-button |
| **履歴詳細**（商品リスト表示） | ヘッダー **右** | ボタン「画像表示OFF」／「画像表示ON」（在庫更新・配送情報の左） | `OutboundHistoryDetail` / setHeader 内 s-button |
| **履歴詳細** | フッター 中央 | 文言「画像表示ON」（liteMode 時のみ表示・トグルではない） | `OutboundHistoryDetail` / フッター中央テキスト |

---

## 入庫（stock-transfer-inbound）

| 画面 | 設置箇所 | 内容 | ファイル／コンポーネント |
|------|----------|------|---------------------------|
| **コンディション**（入庫ID一覧） | フッター **左** | ボタン「画像表示:OFF」／「画像表示:ON」 | `Modal.jsx`（InboundConditions 用 setFooter）/ FixedFooterNavBar `leftLabel` |
| **シップメント選択** | （ボタンなし） | liteMode は props で受け取りのみ。フッターに画像表示ボタンはなし | `InboundShipmentSelection.jsx` |
| **商品リスト**（入庫リスト） | ヘッダー **右** | ボタン「画像表示」 | `InboundListScreen.jsx` / setHeader 内 s-button |
| **商品リスト** | フッター 中央付近 | 文言「画像表示ON」（liteMode 時のみ表示・トグルではない） | `InboundListScreen.jsx` / setFooter 内 |

---

## ロス（stock-transfer-loss）

| 画面 | 設置箇所 | 内容 | ファイル／コンポーネント |
|------|----------|------|---------------------------|
| **コンディション**（ロス登録開始） | フッター **左** | ボタン「画像表示:OFF」／「画像表示:ON」 | `LossConditions.jsx` / FixedFooterNavBar `leftLabel` |
| **商品リスト**（ロス登録） | ヘッダー **右** | ボタン「画像表示」（リセットの左） | `LossProductList.jsx` / setHeader 内 s-button |
| **履歴一覧** | フッター **中央** | ボタン「画像表示:OFF」／「画像表示:ON」 | `LossHistoryList.jsx` / FixedFooterNavBar `middleLabel` |
| **履歴詳細**（1件の商品リスト） | ヘッダー **右** | ボタン「画像表示」 | `LossHistoryList.jsx`（detailId 時）/ setHeader 内 s-button |

---

## 棚卸（stock-transfer-stocktake）

| 画面 | 設置箇所 | 内容 | ファイル／コンポーネント |
|------|----------|------|---------------------------|
| **コンディション**（棚卸ID一覧） | フッター **左** | ボタン「画像表示:OFF」／「画像表示:ON」 | `InventoryCountConditions.jsx` / FixedFooterNavBar `leftLabel` |
| **商品グループ選択** | （ボタンなし） | 画像表示トグルはなし | `InventoryCountProductGroupSelection.jsx` |
| **商品リスト**（棚卸リスト） | ヘッダー **右** | ボタン「画像表示」（在庫更新・データ数量反映・リセットの左） | `InventoryCountList.jsx` / setHeader 内 s-button |

---

## 一覧サマリー（設置箇所のみ）

| 機能 | コンディション | 一覧／選択 | 商品リスト | 履歴詳細 |
|------|----------------|------------|------------|----------|
| **出庫** | フッター左 | 履歴一覧：フッター中央 | ヘッダー右 | ヘッダー右 ＋ フッター文言 |
| **入庫** | フッター左 | なし | ヘッダー右 ＋ フッター文言 | — |
| **ロス** | フッター左 | 履歴一覧：フッター中央 | ヘッダー右 | ヘッダー右 |
| **棚卸** | フッター左 | なし | ヘッダー右 | — |

- **フッター左**：コンディション画面の「戻る」の左、または左ボタンとして「画像表示:ON/OFF」を配置。
- **フッター中央**：出庫・ロスの履歴一覧で「戻る」「再読込」の中央に「画像表示:ON/OFF」を配置。
- **ヘッダー右**：商品リスト／履歴詳細のヘッダー右側に「画像表示」ボタンを配置（商品リストと同様の位置）。
