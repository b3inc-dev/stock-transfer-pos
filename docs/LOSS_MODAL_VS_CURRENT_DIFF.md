# 復元版 Modal.jsx と現在のロス拡張の相違（ロス機能のみ）

**比較対象**:
- **復元版**: `docs/restored-loss-stocktake-combined/extensions/stock-transfer-loss/src/Modal.jsx`（ロス＋棚卸が一緒だったとき）
- **現在**: `extensions/stock-transfer-loss/src/Modal.jsx`（ロス専用）

**ロス機能**に限った相違をまとめています。

---

## 1. 結論サマリー

| 項目 | 復元版（一緒だったとき） | 現在（ロス専用） | 評価 |
|------|--------------------------|------------------|------|
| 入口 | タイルを開く → **メニュー**（ロス／棚卸）→ ロスを選択 | タイルを開く → **ロス画面を直接表示** | 現在がロス専用タイルとして正しい |
| 戻るボタン | コンディションで「戻る」→ **メニューに戻る**（モーダルは閉じない） | **コンディション画面には「戻る」ボタンはない**。フッター左＝画像表示 ON/OFF、中央＝履歴一覧、右＝次へ。モーダルを閉じるのは POS の閉じる操作のみ。 | 現在は左が画像表示で正しい |
| 軽量モード | メニューにのみ ON/OFF あり。**LossScreen には渡していない** | **LossScreen に liteMode / onToggleLiteMode を渡す**。LossConditions でフッターに「画像表示 ON/OFF」 | 現在はロス画面内で軽量モード対応 |
| ページ見出し | 「在庫調整」（メニュー時） | 「ロス」 | 現在がロス専用として正しい |
| POS API（閉じる） | なし（rootArg/apiArg 未使用） | **posModalApi** を保持し **dismissModal** は用意しているが、コンディション画面に「戻る」ボタンがないため画面上からは呼ばれない。POS の閉じる操作でモーダルを閉じる。 | 現在は左＝画像表示で正しい |

**ロスとしての動きは現在の方が揃っており、復元版にしかないロス用の処理はありません。**  
復元版にあった「メニュー」「棚卸」は、ロス専用化に伴って削除されただけで、ロス機能そのものは現在の方が進んでいます。

---

## 2. Modal.jsx の相違（ロスまわり）

### 2.1 入口と戻る

| 項目 | 復元版 | 現在 |
|------|--------|------|
| **初期表示** | `VIEW.MENU`（メニュー）。ロス／棚卸ボタン。 | 常に `LossScreen`（メニューなし）。 |
| **ロス開始** | 「ロス」ボタン → `setView(VIEW.LOSS)` → `LossScreen`。 | 最初から `LossScreen`。 |
| **コンディションのフッター** | メニューに戻るボタンあり（`onBack={goMenu}`）。 | **「戻る」ボタンは表示されていない**。フッターは左＝画像表示 ON/OFF、中央＝履歴一覧、右＝次へ。`onBack`（dismissModal）は LossConditions に渡しているが、画面上のどのボタンからも呼ばれていない。 |

### 2.2 POS API（モーダルを閉じる）

| 項目 | 復元版 | 現在 |
|------|--------|------|
| **export default** | `export default async () => { ... }`（引数なし） | `export default async (rootArg, apiArg) => { ... }`。`apiArg?.navigation` を `posModalApi` に保存。 |
| **dismissModal** | なし。 | `posModalApi?.navigation?.dismiss` 等を順に試してモーダルを閉じる。**ただしコンディション画面には「戻る」ボタンがなく**、この処理を呼ぶ UI はない（POS の閉じる操作でモーダルを閉じる想定）。 |
| **handleBackFromConditions** | なし。 | `dismissModal()` を呼ぶ。LossConditions に `onBack` として渡しているが、**LossConditions はフッター左に「画像表示 ON/OFF」を表示しており、戻るボタンは出していない**。 |

### 2.3 軽量モード（liteMode）

| 項目 | 復元版 | 現在 |
|------|--------|------|
| **メニューでの軽量** | メニュー画面に「軽量モード（画像OFF） ON/OFF」あり。 | メニューなし。 |
| **LossScreen に渡す** | **渡していない**。（`liteMode` / `onToggleLiteMode` なし） | **渡している**。（`liteMode={liteMode}` / `onToggleLiteMode={onToggleLiteMode}`） |
| **LossConditions での表示** | 復元版 LossConditions は **liteMode 未使用**（props にもない）。 | 現在の LossConditions は **liteMode / onToggleLiteMode** を受け、フッターに「画像表示:ON/OFF」を表示。 |

### 2.4 スキャナー購読

| 項目 | 復元版 | 現在 |
|------|--------|------|
| **条件** | `view === VIEW.LOSS && lossView === LOSS_VIEW.PRODUCT_LIST` のときだけロス用キューに積む。 | `lossView === LOSS_VIEW.PRODUCT_LIST` のときだけキューに積む（view は常にロスなので不要）。 |
| **ロスとしての挙動** | 同じ（ロス商品リストのときだけスキャンがロスに渡る）。 | 同じ。 |

### 2.5 見出し

| 項目 | 復元版 | 現在 |
|------|--------|------|
| **s-page heading** | `"在庫調整"`（メニュー／ロス／棚卸共通）。 | `"ロス"`。 |

---

## 3. LossScreen.jsx の相違

| 項目 | 復元版 | 現在 |
|------|--------|------|
| **props** | `{ onBack, setHeader, setFooter, onViewChange }` のみ。 | 上記に **`liteMode`** と **`onToggleLiteMode`** を追加。 |
| **LossConditions に渡す** | `liteMode` / `onToggleLiteMode` は渡していない。 | `liteMode={liteMode}` / `onToggleLiteMode={onToggleLiteMode}` を渡している。 |

コンディション→商品リスト→履歴の流れや、`onViewChange` の扱いは同じです。

---

## 4. LossConditions.jsx の相違（軽量モード）

| 項目 | 復元版 | 現在 |
|------|--------|------|
| **liteMode / onToggleLiteMode** | **未使用**（props にない）。 | **props で受け、フッター左に「画像表示:ON/OFF」** を表示。`onToggleLiteMode` で永続化。 |

ロス専用タイルでは「コンディション画面からも画像 ON/OFF を切り替えたい」という要望に合わせて、現在版で追加された部分です。

---

## 5. 相違があるものの一覧（再まとめ）

### 復元版にあって現在にないもの（ロス専用化で削除）

| # | 内容 |
|---|------|
| 1 | **メニュー画面**（ロス／棚卸の選択）。タイルを開くとメニュー→「ロス」で LossScreen へ。 |
| 2 | **棚卸**（StocktakeScreen、screens/stocktake/、棚卸用スキャンキュー）。ロスとは別機能のため削除。 |
| 3 | **VIEW 定数**（MENU / LOSS / STOCKTAKE）と view 状態。現在は常にロスなので不要。 |
| 4 | **メニューでの軽量モード**（「軽量モード（画像OFF） ON/OFF」ボタン）。現在はロス画面内のフッター左で切り替え。 |

### 現在にあって復元版にないもの（ロス専用化で追加・変更）

| # | 内容 |
|---|------|
| 1 | **入口がロス直接**。メニューなしで最初から LossScreen を表示。 |
| 2 | **ページ見出し「ロス」**。復元版は「在庫調整」（メニュー共通）。 |
| 3 | **liteMode / onToggleLiteMode を LossScreen に渡す**。復元版は渡していない。 |
| 4 | **LossConditions のフッター左＝画像表示 ON/OFF**。復元版の LossConditions は liteMode 未使用でフッター左に画像表示ボタンなし。 |
| 5 | **posModalApi と dismissModal**。export default で rootArg/apiArg を受け、モーダルを閉じる処理を用意（※画面上の「戻る」ボタンはコンディションにないため、現状は POS の閉じる操作で閉じる）。 |
| 6 | **handleBackFromConditions**。onBack として LossConditions に渡しているが、LossConditions は「戻る」ボタンを出していない（フッター左＝画像表示 ON/OFF）。 |

### ロスとしての結論

- **ロス機能で「復元版にあって現在にない」ものはない**（メニュー・棚卸はロス以外の部分）。
- **現在の方がロス専用として進んでいる**（入口・見出し・軽量モードの渡し方・フッター左の画像表示 ON/OFF）。
- 相違は「ロス専用化に伴う削除・追加」であり、**ロスとして困る欠落はない**。

---

## 6. 確定処理・キャンセル処理の比較（同一かどうか）

### 確定処理（LossProductList.jsx の handleConfirm）

| 項目 | 復元版 | 現在 | 同一 |
|------|--------|------|------|
| バリデーション | canSubmit・conds.locationId チェック | 同じ | ✅ |
| 在庫調整 | deltas = lines.map(-Math.abs(qty)) → adjustInventoryAtLocation({ locationId, deltas }) | 同じ | ✅ |
| エントリ作成 | items（inventoryItemId, variantId, sku, lossName, option1–3, quantity 等）→ entry → writeLossEntries([entry, ...existing]) | 同じ | ✅ |
| 下書きクリア | LOSS_DRAFT_KEY / LOSS_CONDITIONS_DRAFT_KEY を delete | 同じ | ✅ |
| 完了後 | toast「ロスしました」→ モーダル閉じる → onAfterConfirm() | 同じ | ✅ |

**結論: 確定処理は復元版と現在で同じ処理がされている。**

### キャンセル処理（LossHistoryList.jsx の handleCancel）

| 項目 | 復元版 | 現在 | 同一 |
|------|--------|------|------|
| バリデーション | entry.status === "active" かつ items.length | 同じ | ✅ |
| 在庫を戻す | deltas = entry.items.map(+quantity) → adjustInventoryAtLocation({ locationId: entry.locationId, deltas }) | 同じ | ✅ |
| 履歴更新 | status: "cancelled", cancelledAt を付与 → writeLossEntries(updated) → setEntries(updated) | 同じ | ✅ |
| 完了後 | toast「キャンセルしました（在庫を戻しました）」 | 同じ | ✅ |

**結論: キャンセル処理も復元版と現在で同じ処理がされている。**

### lossApi.js（readLossEntries / writeLossEntries / adjustInventoryAtLocation）

- **readLossEntries** … 両方とも currentAppInstallation.metafield から JSON 配列を取得。同一。
- **writeLossEntries** … 両方とも metafieldsSet で上書き保存。同一。
- **adjustInventoryAtLocation** … 両方とも toLocationGid / toInventoryItemGid で GID 化 → inventoryAdjustQuantities。同一。

### 確定・キャンセルまわりで唯一の相違（処理には影響しない）

| ファイル | 相違 | 影響 |
|----------|------|------|
| LossHistoryList.jsx | タブボタンのプロパティが **kind**（復元版）→ **variant**（現在） | 見た目用の Polaris/s-button のプロパティ名の違いのみ。確定・キャンセルのロジックには無関係。 |

**総合: 確定処理とキャンセル処理は、復元版と現在で同じ処理がされている。**
