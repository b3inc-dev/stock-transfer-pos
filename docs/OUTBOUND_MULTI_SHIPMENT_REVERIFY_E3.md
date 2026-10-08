# 出庫 multi-shipment 再検証（E3 / 2026-10-08）

**正本実装**: `extensions/stock-transfer-tile/src/ModalOutbound.jsx`（`shopify.extension.toml` の `pos.home.modal.render`）。\
**参照しない**: `OUTBOUND_MULTI_SHIPMENT_IMPLEMENTATION_GAP.md` など **Modal.jsx 前提の陳腐 gap**（D7）。

要件正本: [`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md`](./OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md)

---

## 検証結果（コード突合）

| 要件 | ModalOutbound 現状 | 判定 |
|------|-------------------|------|
| シップメント追加で既存 `transferId` を渡す | `addingShipmentToTransferId` + `onAddShipment` | ✅ |
| 追加確定 = 既存 movement に Shipment（新規 Transfer しない） | `createInventoryShipmentInTransitChunked({ movementId })` | ✅ |
| 追加の下書き = `inventoryShipmentCreate`（DRAFT） | `createInventoryShipmentDraftChunked` | ✅ |
| 新規/編集/追加の 3 モード | `editingTransferId` / `addingShipmentToTransferId` / 新規 | ✅ |
| シップメント選択 UI | `OUTBOUND_SHIPMENT_SELECTION` | ✅ |
| 250 超の **新規確定** | **Transfer 複数**（各 1 Shipment）。同一 Transfer に溢れた SKU の 2 本目 Shipment **ではない**（D2） | ✅ 仕様どおり |
| 250 超の **既存へ追加** | 同一 `movementId` で Shipment 分割 | ✅ |

---

## E3 で追加した再実行安全

- モジュール: `extensions/stock-transfer-tile/src/outboundCreateCheckpoint.js`
- 新規/分割 Transfer 作成経路にチェックポイント + `[pos-cp:…]` note マーカー
- add-shipment（既存 movement への Shipment のみ）は Transfer 二重発行対象外のため本 PR の CP 対象外（残ギャップとして STATE_MACHINE に記載）

---

## 運用注意

部分成功後に内容（明細・宛先）を変えて再確定すると fingerprint が変わり **新規 attempt** になる。Shopify Admin で先行 Transfer の有無を確認すること。
