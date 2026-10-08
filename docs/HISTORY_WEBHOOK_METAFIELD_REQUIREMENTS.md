# 在庫変動履歴・Webhook 紐づけ・Metafield 耐性要件

**日付**: 2026-10-08  
**実装フェーズ**: Phase F（棚卸 P0 = Phase A–D の後または同 workstream 後半）  
**親**: [`STOCKTAKE_UX_CANON.md`](./STOCKTAKE_UX_CANON.md)、棚卸改善プラン Phase F

---

## 結論

- Admin「在庫変動履歴」の正本は **PostgreSQL `InventoryChangeLog`**（metafield ではない）。
- webhook 紐づけ失敗の主因は metafield 容量ではなく **レースと共有冪等キー不足**。
- 成長ドキュメント（棚卸・グループ・entries・スナップ）は metafield チャンク暫定 → **DB 移行対象**。

## データ配置

| データ | 正本 |
|--------|------|
| 在庫変動履歴 | PostgreSQL `InventoryChangeLog` |
| apply-change イベント | PostgreSQL `InventoryChangeEvent`（`appEventId`） |
| 棚卸 / ロス / 仕入 / 発注 / 商品グループ / 日次スナップ | Shopify metafield（チャンク暫定）→ DB 移行 |
| Transfer / Shipment | Shopify Admin GraphQL |

## R-HIST（履歴）

1. 履歴は DB 正本。metafield に載せない／戻さない
2. アプリ起点の変動は `appEventId` で履歴確定。webhook 上書きに**依存しない**
3. 同一物理変動の `admin_webhook`＋業務行の二重を許容しない
4. webhook は ack 予算内（非売上に売上待機を課さない）— Phase C
5. 売上/返品は pending＋優先順位。POS 業務行を奪わない
6. 共有 idempotency を本線にし、30 分窓ヒューリスティックは best-effort

## R-META（Metafield）

1. 成長ドキュメントは DB 移行対象（`InventoryCountDocument` 等）
2. 移行までチャンク整合・backup/retry（Phase D）を維持。最終 SoT とはみなさない
3. `settings_v1` は当面 metafield 可
4. 数百チャンク／欠落を前提に失敗 UX と修復を要件化

## 実装メモ（本 workstream / Phase F shippable）

- apply-change: setQuantities **前**に `InventoryChangeLog` を `quantityAfter=null` + `note: appEventId:…` で upsert
- webhook: 業務行（非 admin_webhook）に加え、`note` が `appEventId:` で始まる先行履歴も合流して early-return。ただし `appEventId` 行は `quantityAfterExpected` と `available` が一致するときだけ null-latch（不一致は売上/返品マッチへ）
- apply-change 成功後: 同一 item/location の直近 `admin_webhook`（`quantityAfter` null または一致・短い時間窓）を業務 activity に coalesce（売上/返品救済を奪わない）
- Prisma: `InventoryCountDocument` / `InventoryCountDocumentChunk`
- **dual-write**: metafield 成功後に best-effort upsert（失敗しても metafield 成功は維持）
- **dual-read**: Admin loader は metafield を SoT のまま維持し、DB にだけある count を末尾追加（既存 count の DB overlay はしない。cancel/edit が metafield のみ更新する間の巻き戻し防止）。`readInventoryCountsChunked` 自体は metafield のみ（client bundle 制約）
- Admin 変更履歴 UI は引き続き `InventoryChangeLog` のみ
- フル DB 正本切替・本番 migrate は本 PR 対象外

詳細監査: Agent Store `internal/history-webhook-metafield-requirements.md`（参照用）。
