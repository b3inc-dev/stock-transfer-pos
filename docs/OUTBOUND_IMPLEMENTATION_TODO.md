# 出庫 複数シップメント 実装 TODO

Modal.jsx を増やさず減らす方向で、1つずつ進めます。各ステップ後に容量・ビルドを確認してください。

---

## 全体 TODO

| # | 内容 | 状態 |
|---|------|------|
| 1 | OutboundHistoryScreens: export 追加 + import パス修正(../) | ✅ 完了 |
| 2 | Modal.jsx: outbound state に addingShipmentToTransferId 追加 | ✅ 完了 |
| 3 | Modal.jsx: OutboundHistoryConditions を import に差し替え | ✅ 完了 |
| 4 | Modal.jsx: OutboundHistoryDetail を import に差し替え | ✅ 完了 |
| 5 | Modal.jsx: OutboundList を import に差し替え（props 渡し） | 未 |
| 6 | OutboundListScreen: 下書き保存＝DRAFTのときのみ表示に変更 | 未 |
| 7 | OutboundListScreen: 編集時「確定する」＝シップメント出庫確定を追加 | 未 |
| 8 | OutboundHistoryDetail: シップメント2以上で一覧・選択・status表示 | 未 |

---

## ステップ1 完了内容（2025-02-01）

**ファイル**: `extensions/stock-transfer-tile/src/screens/OutboundHistoryScreens.jsx`

- **import パス修正**: `./modalHelpers.js` → `../modalHelpers.js`、`./modalHooks.js` → `../modalHooks.js`、`./modalUiParts.jsx` → `../modalUiParts.jsx`、`./outboundShipmentApi.js` → `../outboundShipmentApi.js`（screens/ から src/ を参照するため）
- **export 追加**: `OutboundHistoryConditions` と `OutboundHistoryDetail` に `export` を付与

**Modal.jsx**: 変更なし（容量変化なし）

**確認**: OutboundHistoryScreens.jsx に Lint エラーなし

---

## ステップ2 完了内容（2025-02-01）

**ファイル**: `extensions/stock-transfer-tile/src/Modal.jsx`

- **初期 state（Extension 直下）**: `outbound` のデフォルトに `addingShipmentToTransferId: ""` を追加（行 1867 付近）
- **OutboundList 内の getStateSlice フォールバック**: `outbound` のデフォルトに `addingShipmentToTransferId: ""` を追加（行 4401 付近）

**変更行数**: 2 行追加のみ（Modal.jsx の肥大化は最小限）

**確認**: Modal.jsx に Lint エラーなし

---

## ステップ3 完了内容（2025-02-01）

**ファイル**: `extensions/stock-transfer-tile/src/Modal.jsx`

- **import 追加**: `import { OutboundHistoryConditions } from "./screens/OutboundHistoryScreens.jsx";`
- **使用箇所**: `<OutboundHistoryConditions>` に `onOpenOutboundList`, `fetchTransfersForOriginAll`, `readInboundAuditLog`, `buildInboundOverIndex_`, `buildInboundExtrasIndex_`, `buildInboundRejectedIndex_`, `mergeInboundOverIntoTransfers_`, `FixedFooterNavBar` を渡すよう変更
- **インライン定義削除**: `OutboundHistoryConditions` 関数本体（約 362 行）を削除

**Modal.jsx 行数**: 約 13,340 行 → 約 12,980 行（約 360 行減）

**確認**: Modal.jsx に Lint エラーなし
