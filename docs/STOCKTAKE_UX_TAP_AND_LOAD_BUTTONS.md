# 棚卸：グループ一覧タップ遅延・まとめて表示の読込ボタン要因と対応

**日付**: 2026-02

---

## 1. 商品グループ一覧 → 商品リストの「タップが効かない・遅い」要因

### 要因

- **onSelectProductGroup** 内で、画面遷移（`onNext`）の**前**に次の処理を **await** していたため、その完了まで画面が切り替わらず、タップの反応が遅く感じられていました。
  - `readInventoryCounts()` で棚卸一覧を取得
  - `writeInventoryCounts(updated)` でステータスを `draft` → `in_progress` に更新
- 上記の読み書きが重い環境やネットワークだと、**タップから 1〜2 秒以上**かかり、その間は何も変わらないため「タップが効いていない」ように見えていました。

### 対応

- **先に `onNext(...)` で商品リストへ遷移**し、その**後に**ステータス更新だけを**非同期（fire-and-forget）**で実行するように変更しました。
- タップ後はすぐに商品リストに切り替わり、ステータス更新はバックグラウンドで行われます。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`  
（`onSelectProductGroup` を同期的に `onNext` を呼ぶ形にし、draft 時の書き込みは即座に起動する async IIFE で実行）

---

## 2. まとめて表示のグループ横「読込」ボタンが反応しない要因

### 想定されていた要因

- **POS の `s-button`** では、環境によって **onPress** だけではタップが届かない場合があります。**onClick** を併用すると確実に発火します。
- **disabled={loadingGroupId != null}** のときは「いずれかのグループの読込中」なので、**すべての読込ボタンが無効**になります。別のグループの読込が終わっていない、または `loadingGroupId` が何らかの理由でクリアされていないと、どの読込ボタンも押せません。
- **loadGroupProducts(groupId)** の先頭で `!groupId` などの条件で return している場合、**loadingGroupId をセットする前に return** しているため、見た目上は「押しても何も起きない」ように見えます（通常は groupId は入っている想定）。

### 対応

- まとめて表示のグループ横「読込」ボタンに **onClick** を追加し、**onPress** と **onClick** のどちらでも `loadGroupProducts(groupId)` が呼ばれるようにしました。
- 読み込み中はもともと **「読込中...」** と表示され、**disabled** になるため、そのまま「読込中はボタンが読込中... で無効」という見た目でステータスが分かります。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx`  
（該当の `s-button` に `onClick={() => loadGroupProducts(groupId)}` を追加）

---

## 3. 商品グループ一覧の「在庫数読込」ボタン位置

- **要望**: 左側の明細4行（商品グループを選択・棚卸ID・ロケーション・商品グループ数）の**上下中央**に「在庫数読込」を配置する。
- **対応**: ヘッダーを **横並び（inline）** にし、**左にボタン**、**右に上記4行のテキスト**を配置。`alignItems="center"` でボタンとテキストブロックを縦方向中央揃えにしました。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`  
（setHeader 内のレイアウトを `s-stack direction="inline" alignItems="center"` で左＝ボタン・右＝明細に変更）

---

## 4. 商品グループ一覧の「在庫数読込」ボタンが反応しない要因（ヘッダー実装のまま）

### 要因

- **ヘッダーは setHeader で別ツリーに渡して描画**されているため、POS のヘッダー領域では **onPress だけでは発火しない**環境があり、**onClick を主に**する必要があります。
- **動いているヘッダーボタン**（例: InventoryCountList の「在庫更新」「画像ON/OFF」、InventoryCountConditions の「未完了/完了済み」）は **onClick** で実装されています。在庫数読込も同じパターンに揃える必要がありました。
- **onClick / onPress の両方が同じタップで発火**すると、処理が二重に走る可能性があるため、**ref による二重発火防止**を入れると安全です。

### 対応（本文には出さずヘッダーのまま）

- 在庫数読込ボタンを **onClick / onPress の両方で「インライン呼び出し」**（`onClick={() => handleLoadQuantities()}`）にし、**動いているヘッダーボタンと同じパターン**に統一しました。
- **読み込み中は「読込中...」** に切り替え、**disabled** のまま（本文には映さずヘッダー内でそのまま表示）。
- **loadingQuantitiesRef** で二重発火を防止しています。

**変更ファイル**: `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`

---

## 5. ヘッダー・スクロール内ボタンの統一（確実に処理されるように）

- **問題なく動いている箇所**: FixedFooterNavBar は **onClick のみ**。InventoryCountList のヘッダー（在庫更新・全数量反映・リセット・画像ON/OFF）は **onClick**。InventoryCountConditions のヘッダー（未完了/完了済み）は **onClick**。
- **対応**: 棚卸の「読込」系ボタン（在庫数読込・まとめて表示の読込・さらに読み込む）を、**onClick と onPress の両方でインライン呼び出し**に統一し、**ref で二重発火防止**を追加しました。
- 読み込み中はすべて **「読込中...」** 表示＋**disabled** で、目で見てステータスが分かります。
