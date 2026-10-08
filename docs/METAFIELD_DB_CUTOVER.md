# Metafield → DB SoT 段階カットオーバー

**日付**: 2026-10-08  
**Workstream**: F（metafield→DB staged migration）  
**親**: [`ARCHITECTURE_EXTERNAL_DB.md`](./ARCHITECTURE_EXTERNAL_DB.md)、[`HISTORY_WEBHOOK_METAFIELD_REQUIREMENTS.md`](./HISTORY_WEBHOOK_METAFIELD_REQUIREMENTS.md)

---

## 方針

| 残す | 移行する（この workstream） |
|------|---------------------------|
| `settings_v1`（metafield） | `inventory_counts_*` |
| Transfer / Shipment（Shopify GraphQL 正本。アプリ DB で二重管理しない） | `product_groups_v1` |
| `InventoryChangeLog` / `InventoryChangeEvent`（既存 DB） | loss / adjustment / purchase / order_request entries（v1+v2） |
| | `inventory_info` / `daily_snapshots` |

順序（承認済み）: **(1) inventory_counts → (2) product_groups → (3) entries → (4) daily_snapshots**

---

## タイプ別カットオーバー

### 1. inventory_counts

| 項目 | 内容 |
|------|------|
| DB | `InventoryCountDocument` (+ `InventoryCountDocumentChunk`) |
| 読取 | Admin loader: `mergeInventoryCountsWithDb`（DB 優先、空なら metafield）。POS: `/api/pos-app-documents` → metafield フォールバック |
| 書込 | `writeInventoryCountsChunked` / POS `writeInventoryCounts` は DB 必須。metafield は `METAFIELD_MIRROR_INVENTORY_COUNTS=1` のときのみ |
| 移行 | `node scripts/migrate-metafield-to-db.mjs`（`TYPES=inventory_counts`） |
| 退職 | ミラー OFF が既定。チャンク metafield への新規書き込みなし |

### 2. product_groups

| 項目 | 内容 |
|------|------|
| DB | `ProductGroupDocument` |
| 読取 | Admin + POS: DB 優先、空なら metafield |
| 書込 | Admin `persistProductGroupsForShop`（DB 必須）。POS は読取のみ |
| 移行 | `TYPES=product_groups` |
| ミラー | `METAFIELD_MIRROR_PRODUCT_GROUPS=1` |

### 3. entries（loss / adjustment / purchase / order_request）

| 項目 | 内容 |
|------|------|
| DB | `AppEntryDocument`（`entryType` で区別） |
| 読取 | Admin loader/action + POS read*: DB 優先 |
| 書込 | Admin `persistEntriesForShop` / POS `saveEntriesToDb`。成功時 metafield v2 は書かない（ミラー時のみ v1） |
| 移行 | v2 meta+chunks 優先、無ければ v1（`TYPES=entries`） |
| ミラー | `METAFIELD_MIRROR_ENTRIES=1` |

### 4. daily_snapshots

| 項目 | 内容 |
|------|------|
| DB | `InventoryDailySnapshotRow`（shop+date+locationId） |
| 読取 | `getSavedSnapshots(..., { shopDomain })` が DB 優先 |
| 書込 | Cron / Admin「本日集計」→ `saveSnapshotsForDate` が DB 必須 |
| 移行 | `TYPES=daily_snapshots` |
| ミラー | `METAFIELD_MIRROR_DAILY_SNAPSHOTS=1` |

---

## 運用フラグ

| 環境変数 | 既定 | 意味 |
|----------|------|------|
| `METAFIELD_DB_SOT_<TYPE>=0` | 未設定=ON | 当該タイプの DB 優先読取を緊急停止 |
| `METAFIELD_MIRROR_<TYPE>=1` | OFF | DB 成功後も metafield へミラー（移行期の互換） |

`<TYPE>`: `INVENTORY_COUNTS` / `PRODUCT_GROUPS` / `ENTRIES` / `DAILY_SNAPSHOTS`

---

## デプロイ手順（概要）

1. Prisma migrate deploy（`ProductGroupDocument` / `AppEntryDocument` / `InventoryDailySnapshotRow`）
2. ショップごとに `migrate-metafield-to-db.mjs` 実行（TYPES を段階指定可）
3. Admin / POS で読取が DB 由来であることを確認
4. ミラーは既定 OFF のまま。問題時のみ一時的に `METAFIELD_MIRROR_*=1`
5. Render: `main` auto-deploy。Ciara は手動の可能性あり（設定は変更しない）
6. Shopify 拡張: Location Stock 方式（PUBLIC → CIARA）。`APP_MODE` churn はコミットしない

---

## 非対象（再掲）

- `settings_v1`
- Transfer / Shipment ライフサイクルのアプリ DB 二重管理
- COMPLETE_RETRY の `pending_complete_v1`（運用バックアップ。棚卸本体 SoT とは別）
