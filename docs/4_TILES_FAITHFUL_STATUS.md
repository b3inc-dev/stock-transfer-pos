# 4タイル：元実装との忠実性

## 棚卸（在庫調整 棚卸）

**結論: 元々実装していた内容を忠実に実装できている。**

- **元の実装**: `stock-transfer-loss` 拡張内の `StocktakeScreen` および `screens/stocktake/` 以下（InventoryCountConditions, InventoryCountList, InventoryCountProductGroupSelection, stocktakeApi.js）。
- **現状**: 上記をそのまま `stock-transfer-stocktake` 拡張にコピーして構成している。
- **差分**:
  - **InventoryCountConditions.jsx**: 棚卸一覧の「現在の店舗」フィルタで、ロケーションIDの形式（GID と数値）が混在すると一覧が空になる問題を避けるため、`toLocationGid` を使った正規化を追加。
  - **stocktakeApi.js**: `toLocationGid` をエクスポートし、`getLocationName` 内でロケーションIDを GID に正規化してから `locations` と照合するように変更（店舗名が読めない問題の修正）。
- **ファイル構成**: loss と stocktake で同じ 4 ファイル（InventoryCountConditions.jsx, InventoryCountList.jsx, InventoryCountProductGroupSelection.jsx, stocktakeApi.js）＋ StocktakeScreen.jsx。stocktake 側は `screens/loss/` に FixedFooterNavBar.jsx と fetchSettings 用の最小 lossApi.js を置き、import パスを維持。

**まとめ**: 棚卸は元実装を忠実にコピーしており、上記のロケーションIDまわりの修正のみ追加した状態です。

---

## 入庫（在庫処理 入庫）

**結論: 現状はプレースホルダーのみ。元実装を忠実に移す作業を実施する。**

- **元の実装**: `stock-transfer-tile` の `Modal.jsx` 内にあった入庫フロー（InboundConditions → InboundShipmentSelection / InboundList）および関連する API・draft・audit の関数群。
- **現状**: 入庫拡張の Modal は「入庫機能は別拡張として用意しました」という説明文のみ表示するプレースホルダー。
- **忠実実装に必要な作業**:
  - 出庫タイルの Modal.jsx から、入庫専用の以下を抽出し、入庫拡張に移植する。
    - 画面: InboundConditions, InboundShipmentSelection, InboundList, InboundAddedLineRow
    - API・draft・audit: fetchTransfersForDestinationAll, fetchInventoryShipmentEnriched, receiveShipmentWithFallbackV2, loadInboundDraft, saveInboundDraft, clearInboundDraft, readInboundAuditLog, buildInboundOverIndex_, buildInboundExtrasIndex_, buildInboundRejectedIndex_, buildInboundOverItemIndex_, mergeInboundOverIntoTransfers_, appendInboundAuditLog, buildInboundNoteLine_ など
    - 共通: getStateSlice, setStateSlice, adminGraphql, useSessionLocationId, useOriginLocationGid, useLocationsIndex, getLocationName_, useUnifiedDialog, FixedFooterNavBar, VariantCache, resolveVariantByCode, renderInboundShipmentItems_ など入庫が参照しているもの
  - 入庫拡張の Modal で「初期画面 = 入庫コンディション」「コンディションで戻る = モーダルを閉じる」に接続する。

**実施した実装**

- **inboundHelpers.js** … `getStateSlice`, `setStateSlice`, `adminGraphql`, `assertNoUserErrors`, `toUserMessage` を用意（出庫タイルの modalHelpers から入庫用にコピー）。
- **inboundHooks.js** … `useSessionLocationId`, `useOriginLocationGid`, `useLocationsIndex`, `getLocationName_` を用意（出庫タイルの modalHooks からコピー）。
- **inboundApi.js** … 入庫用 API を一式用意。  
  `fetchPendingTransfersForDestination`, `fetchTransfersForDestinationAll`, `fetchInventoryShipmentEnriched`, `receiveShipmentWithFallbackV2`, `adjustInventoryAtLocationWithFallback`, 下書き・監査（`loadInboundDraft`, `saveInboundDraft`, `clearInboundDraft`, `readInboundAuditLog`, `buildInboundOverIndex_`, `buildInboundExtrasIndex_`, `buildInboundOverItemIndex_`, `buildInboundRejectedIndex_`, `mergeInboundOverIntoTransfers_`, `appendInboundAuditLog`, `buildInboundNoteLine_`）を出庫タイルの Modal から抽出して配置。
- **Modal.jsx** … 入庫コンディション画面（InboundConditions）を同一ファイル内に実装。  
  - 初期画面は **入庫コンディション**（宛先の入庫ID一覧）。  
  - コンディションで「戻る」→ モーダルを閉じる。  
  - 一覧でタップすると「入庫リスト」または「シップメント選択」へ遷移するが、**InboundList / InboundShipmentSelection はまだプレースホルダー**（「準備中」表示＋コンディションに戻るボタン）。  
  - 元実装の InboundList・InboundShipmentSelection を出庫タイルの Modal.jsx から移植すると、入庫確定まで一通り利用可能になる。
