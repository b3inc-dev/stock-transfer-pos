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
| 書込 | Admin `persistEntriesForShop` / POS `saveEntriesToDb`。DB 成功後 metafield は既定で書かない。ミラー ON 時は Admin が v1 をミラー。POS は DB 失敗時のみ従来の v2 チャンクへフォールバック |
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

## カットオーバー前チェックリスト（段階移行・本番 cutover 用）

**方針**: dual-read / dual-write（DB 必須 + metafield ミラー opt-in）のままマージ可能か判断する。**本番 SoT 完全切替・ミラー永久 OFF の最終 cutover は別ゲート。** 残リスクが少しでも許容外なら Draft 維持。

### Merge 前（コード / レビュー）

- [ ] Independent review が Approve（または残 blocker ゼロ）
- [ ] COMPLETE_RETRY / POS complete が DB persist 後に metafield 再読取で上書きしない
- [ ] 棚卸発行（create）が mirror OFF で metafield 本体に依存しない（DB-first + NEXT のみ）
- [ ] inventory_counts replace が orphan 削除 + 空配列全消し拒否
- [ ] POS `product_groups` 書き込み拒否
- [ ] `METAFIELD_DB_SOT_*=0` kill-switch が 4 タイプすべてで効く
- [ ] `npm run build` PASS

### ショップ適用順（ops・merge 後）

1. [ ] `prisma migrate deploy`
2. [ ] **migrate スクリプトを先に**（Deploy-before-migrate 窓を最短化）: `SHOP=… TYPES=inventory_counts,product_groups,entries,daily_snapshots node scripts/migrate-metafield-to-db.mjs`
3. [ ] Admin / POS で DB 由来読取を確認（棚卸一覧・entries・グループ・スナップ）
4. [ ] 問題時のみ一時 `METAFIELD_MIRROR_*=1`（ブリッジ）。定常は OFF
5. [ ] 緊急時 `METAFIELD_DB_SOT_<TYPE>=0` で prefer 停止（再デプロイ不要）
6. [ ] Shopify 拡張 PUBLIC → CIARA（旧 POS ビルドの metafield SoT 残存に注意）

### 段階フェーズで許容する残リスク（最終 cutover まで残る）

| 残リスク | 扱い |
|----------|------|
| Deploy-before-migrate 窓 | ops 順序で最小化。DB が空なら metafield フォールバック継続 |
| POS entries 全件 replace の LWW | 既存形状。最終 cutover 前に CAS 設計が必要なら別 workstream |
| DB 書込失敗時の POS metafield フォールバック | 段階中は残す（可用性）。409 競合時はフォールバックしない |
| `settings_v1` / Transfer / Shipment | 非対象のまま |
| `pending_complete_v1` | metafield 運用バックアップ（棚卸本体 SoT ではない） |

### 最終 cutover（別承認・本 PR では実行しない）

- [ ] 全対象ショップ migrate 完了 + 差分ゼロ確認
- [ ] POS/Admin で metafield フォールバック経路の退役計画
- [ ] ミラー永久 OFF・metafield キー退職の明示承認

---

## 非対象（再掲）

- `settings_v1`
- Transfer / Shipment ライフサイクルのアプリ DB 二重管理
- COMPLETE_RETRY の `pending_complete_v1`（運用バックアップ。棚卸本体 SoT とは別）
