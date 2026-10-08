# 棚卸 UX 正本（Canon）

**日付**: 2026-10-08  
**役割**: 棚卸 POS の画面定義・初回読込方針・計測指標の短い正本。詳細改修方針は [`STOCKTAKE_39GROUPS_UX_IMPROVEMENTS.md`](./STOCKTAKE_39GROUPS_UX_IMPROVEMENTS.md)、確定リトライは [`STOCKTAKE_COMPLETE_RETRY_DESIGN.md`](./STOCKTAKE_COMPLETE_RETRY_DESIGN.md)。

---

## 1. 画面の取り違え防止

| 画面 | 実装 | 初回にやること | 初回にやらないこと |
|------|------|----------------|-------------------|
| **商品グループ選択** | `InventoryCountProductGroupSelection.jsx` | グループ名一覧（軽量 metafield / cache） | **在庫数量の自動取得**（`loadProductGroupQuantities` はユーザー操作のみ） |
| **棚卸ID一覧** | Modal / 一覧 | 軽量 list metafield | 全 count の明細・全グループ在庫 |
| **まとめて表示** | `InventoryCountList.jsx` (`productGroupMode=multiple`) | グループ見出し＋「読込」 | オープン時の全グループ `fetchProductsByGroups` |
| **商品明細リスト** | `InventoryCountList.jsx`（単一グループ） | 先頭 N 件＋「さらに読み込む」 | 全 SKU 一括 |

正本: 39GROUPS §1.1（まとめて）/ §1.2（グループ選択）。リスト初回の別議論は [`STOCKTAKE_LIST_INITIAL_LOAD_OPTIMAL_DESIGN.md`](./STOCKTAKE_LIST_INITIAL_LOAD_OPTIMAL_DESIGN.md)。

---

## 2. 必須ルール（実装チェック）

1. **マウント時に `loadProductGroupQuantities()` を呼ばない**（選択画面）。
2. `readProductGroups()` / 軽量 names は **1 回読み → `cachedProductGroups` で共有**。同一グループの二重 fetch 禁止。
3. ユーザー起動の一括数量読込は **限定並列（3〜5）＋進捗**。
4. まとめて表示は **グループごと読込**。未保存グループを「商品がありません」固定にしない。
5. 確定フローの状態は **setQuantities / metafield / history** を分離（[`STOCKTAKE_COMPLETE_RETRY_DESIGN.md`](./STOCKTAKE_COMPLETE_RETRY_DESIGN.md)、[`STATE_MACHINE.md`](./STATE_MACHINE.md) 棚卸節）。

---

## 3. ベースライン計測指標（TTFG 等）

| 指標名 | 定義 | 目標イメージ |
|--------|------|----------------|
| **TTFG_names** | グループ選択画面でグループ名が一覧に出るまで | 即時（軽量 metafield / cache、数量 API なし） |
| **qty_load_user** | 「在庫数読込」押下から全対象グループの件数/数量が埋まるまで | 並列 3〜5。自動マウント読込は **0** |
| **list_one_group** | 単一グループ明細の初回表示（先頭 N） | 現行 600 件＋さらに読み込み維持 |
| **bulk_open** | まとめて表示オープン〜見出し表示 | fetch ほぼゼロ。読込はグループ単位 |

計測は POS 実機またはログでよい。本 PR では指標名を固定し、回帰比較の軸とする。

---

## 4. 参照してよい正本 / 無視してよい陳腐 docs

### 正本（優先）

- 本ファイル（UX 画面・計測）
- `STOCKTAKE_39GROUPS_UX_IMPROVEMENTS.md`
- `STOCKTAKE_COMPLETE_RETRY_DESIGN.md`
- `STOCKTAKE_POS_LIST_PERFORMANCE_REQUIREMENTS.md`
- `INVENTORY_COUNT_MULTIPLE_GROUPS_REQUIREMENTS.md`（複数グループ要件）
- `POS_STOCKTAKE_COMPLETE_SIMPLE.md` / `METAFIELD_CHUNKED_READ_DESIGN.md`
- Canon: `AGENTS.md`, `STATE_MACHINE.md`, `DECISIONS.md`, `ARCHITECTURE.md`

### 陳腐・再検証前は参照しない（superseded / gap 注意）

- 出庫 gap で **`Modal.jsx` 前提**のもの（現行は `ModalOutbound.jsx`）
- `4_TILES_FAITHFUL_STATUS` の入庫「準備中」記述
- 仕入「Phase C 未着手 / UI 準備中」と実コード（`extensions/stock-transfer-purchase`）が矛盾するもの
- 入庫 migration gap の本文とヘッダが自己矛盾するもの
- 棚卸原因分析の古い 1 時点スナップ（`STOCKTAKE_*_CAUSE.md` 等）— **リンク参照のみ**。現行挙動は本 Canon + 39GROUPS + コード

方針の記録: [`DECISIONS.md`](./DECISIONS.md) D7 / D8。

---

## 5. 関連 Phase（プラン）

| Phase | 内容 |
|-------|------|
| B | グループ選択: 自動数量廃止・cache・並列 |
| B2 | まとめて表示: グループごと読込 |
| C | webhook 5s / 棚卸洪水緩和 |
| D | 確定リトライ（needMetafieldRetry） |
| F | 履歴 event-first / metafield→DB 基盤 |
