# 棚卸機能のデバッグ分析

## 問題の整理

### 1. 管理画面の問題
- **現象**: 完了しているグループが未完了と表示される
- **期待**: 完了しているグループは「完了済み」と表示される
- **確認ポイント**: `groupItems[groupId]`の存在チェックが正しく動作しているか

### 2. アプリ（まとめて表示）の問題
- **現象**: 完了しているグループも未完了と表示され、数量も反映されていない（在庫 2 / 実数 0）
- **期待**: 完了しているグループは「完了済み」と表示され、数量が正しく反映される
- **確認ポイント**: `groupItems[groupId]`から読み込んだデータの`currentQuantity`と`actualQuantity`が正しく設定されているか

### 3. アプリ（グループごとに表示）の問題
- **現象**: 処理済みをタップしても全てのグループの商品一覧が表示される
- **期待**: 選択したグループの商品のみが表示される
- **確認ポイント**: `storedItemsFromGroup`が正しく使用されているか

## データの流れ

### 保存処理（handleComplete）
1. `lines`から`linesSnapshot`を作成
2. `linesSnapshot`から`entry`を作成（`groupItems[groupId]`に保存）
3. `writeInventoryCounts(updated)`で保存

### 読み込み処理（loadProducts）
1. `count.groupItems`から`groupItemsMap`を取得
2. `groupItemsMap[groupId]`から該当グループのデータを取得
3. `storedItemsFromGroup`に設定
4. `storedItemsFromItems`は`storedItemsFromGroup`が存在しない場合のみ使用

## 修正内容

### 1. barcodeフィールドの追加
- **ファイル**: `extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
- **修正箇所**: 全ての`entry`作成箇所で`barcode`を追加
- **理由**: 管理画面でJANを表示するため

### 2. writeInventoryCountsの重複呼び出しを修正
- **ファイル**: `extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
- **修正箇所**: 1047-1049行目、1201-1203行目
- **理由**: `writeInventoryCounts`が2回呼ばれていたため、最初の保存が上書きされる可能性があった

### 3. storedItemsFromItemsの使用条件を修正
- **ファイル**: `extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
- **修正箇所**: 218行目
- **理由**: `storedItemsFromGroup`が存在する場合は、必ず`storedItemsFromGroup`を優先（選択したグループのデータのみを表示）

## 確認すべきポイント

### 1. データが正しく保存されているか
- `handleComplete`で`groupItems[groupId]`に正しく保存されているか
- `barcode`フィールドが含まれているか
- `currentQuantity`と`actualQuantity`が正しく保存されているか

### 2. データが正しく読み込まれているか
- `loadProducts`で`groupItemsMap[groupId]`から正しく読み込まれているか
- `storedItemsFromGroup`が正しく設定されているか
- `storedItemsFromItems`が使用されていないか（単一グループモードで`groupItems`にデータがある場合）

### 3. 完了判定が正しく動作しているか
- `groupItemsMap[groupId]`の存在チェックが正しく動作しているか
- `groupItemsFromMap.length > 0`の判定が正しく動作しているか

## 根本原因の分析

### 問題1: 完了しているグループが未完了と表示される

**原因の可能性**:
1. `groupItems[groupId]`にデータが保存されていない
2. `groupItems[groupId]`の存在チェックが正しく動作していない
3. データが保存されているが、読み込み時に正しく取得できていない

**確認方法**:
- 管理画面でモーダルを開き、`groupItemsMap`の内容を確認
- アプリで`count.groupItems`の内容を確認

### 問題2: 数量が反映されていない（在庫 2 / 実数 0）

**原因の可能性**:
1. `handleComplete`で`actualQuantity`が0のまま保存されている
2. `groupItems`から読み込んだデータの`actualQuantity`が正しく設定されていない
3. 在庫調整が実行されていない（`itemsToAdjust.length === 0`の場合）

**確認方法**:
- `handleComplete`で`linesSnapshot`の`actualQuantity`を確認
- `groupItems[groupId]`に保存されたデータの`actualQuantity`を確認

### 問題3: 処理済みをタップしても全てのグループの商品一覧が表示される

**原因の可能性**:
1. `storedItemsFromItems`が使用されている（`count.items`が全グループのデータを含んでいる）
2. `storedItemsFromGroup`が正しく設定されていない

**確認方法**:
- `loadProducts`で`storedItemsFromGroup`と`storedItemsFromItems`の値を確認
- `count.items`の内容を確認（全グループのデータが含まれているか）

## 修正内容の詳細

### 1. barcodeフィールドの追加
- **ファイル**: `extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
- **修正箇所**: 
  - 767-775行目（まとめて表示モード・在庫調整なし）
  - 861-869行目（まとめて表示モード・在庫調整あり）
  - 957-965行目（まとめて表示モード・在庫調整あり・別パス）
  - 1009-1017行目（単一グループモード・在庫調整なし）
  - 1077-1086行目（entryBeforeAdjustment）
  - 1126-1134行目（まとめて表示モード・在庫調整あり）
  - 791-799行目、886-897行目、1205-1213行目（mergedEntry）

### 2. writeInventoryCountsの重複呼び出しを修正
- **ファイル**: `extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
- **修正箇所**: 1047-1049行目、1201-1203行目
- **理由**: `writeInventoryCounts`が2回呼ばれていたため、最初の保存が上書きされる可能性があった

### 3. storedItemsFromItemsの使用条件を修正
- **ファイル**: `extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
- **修正箇所**: 218行目
- **理由**: `storedItemsFromGroup`が存在する場合は、必ず`storedItemsFromGroup`を優先（選択したグループのデータのみを表示）

### 4. 管理画面の列を変更
- **ファイル**: `app/routes/app.inventory-count.tsx`
- **修正箇所**: 1612-1620行目、1691-1701行目
- **変更内容**: 列を「商品グループ、商品名、SKU、JAN、オプション1、オプション2、オプション3、在庫、実数、差分」に変更

## 次のステップ

1. アプリを再起動して動作を確認
2. 管理画面でグループ名列が表示されるか確認
3. 完了済みのグループが正しく表示されるか確認
4. 数量が正しく反映されるか確認
5. 処理済みをタップした際に、選択したグループの商品のみが表示されるか確認
