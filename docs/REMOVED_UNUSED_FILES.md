# 削除した不要ファイル（分割失敗時の残り）

## 対象: stock-transfer-tile のみ

入庫・出庫・ロス・棚卸のうち、**分割失敗で残っていた不要ファイルは「stock-transfer-tile」だけ**でした。  
入庫（stock-transfer-inbound）、ロス（stock-transfer-loss）、棚卸（stock-transfer-stocktake）は、エントリ（Tile + Modal）とその import 先だけが存在しており、未使用ファイルはありませんでした。

## stock-transfer-tile で削除したファイル

| ファイル | 理由 |
|----------|------|
| `src/Modal.jsx` | 元の巨大モーダル。現在のエントリは `ModalOutbound.jsx` のみで未使用 |
| `src/ModalInbound.jsx` | 入庫用に分割したが、入庫タイルは別拡張（stock-transfer-inbound）の Modal.jsx を使用するため未使用 |
| `src/Modal_tmp.jsx` | 64KB 対策用の一時版。何からも import されていない |
| `src/screens/Screens.jsx` | Modal_tmp が動的 import していたが、Modal_tmp 自体が未使用のため未使用 |
| `src/screens/Screens_part1.jsx` | 分割用の一部。エントリから参照されていない |
| `src/screens/Screens_part2.jsx` | 分割用の一部。エントリから参照されていない |
| `src/screens/OutboundHistoryScreens.jsx` | 出庫履歴画面。ModalOutbound.jsx 内に同機能が含まれており未使用 |
| `src/screens/OutboundListScreen.jsx` | 出庫リスト画面。ModalOutbound.jsx 内に同機能が含まれており未使用 |
| `src/_outbound_history_block.txt` | コードスニペット／バックアップ。未使用 |
| `src/_outbound_list_block.txt` | コードスニペット／バックアップ。未使用 |

## 更新したスクリプト

- `strip-comments-all.mjs` … FILES から削除したファイルを除き、`ModalOutbound.jsx` を追加
- `strip-comments.mjs` … 対象を `Modal.jsx` から `ModalOutbound.jsx` に変更
- `strip-comments.js` … 同上
- `remove-comments.js` … 対象を `Modal.jsx` から `ModalOutbound.jsx` に変更

## 現在の stock-transfer-tile の構成（削除後）

- **エントリ**: `Tile.jsx`（出庫タイル）, `ModalOutbound.jsx`（モーダル）
- **共通**: `modalConstants.js`, `modalHelpers.js`, `modalHooks.js`, `modalDialog.jsx`, `modalUiParts.jsx`, `OutboundReadyToShipEdit.jsx`
- **screens**: なし（ModalOutbound.jsx 内に出庫コンディション・リスト・履歴がすべて含まれている）
