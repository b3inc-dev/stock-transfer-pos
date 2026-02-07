# 完全再現検証 TODO（2分割前の実装との一致確認）

**目的**: 出庫・入庫・ロス・棚卸の4タイルが、「2分割前」に一つのモーダル／拡張で処理できていた状態と**処理の流れ・機能**として同じかどうかを確認するためのTODOです。  
**※「閉じる」ボタンの動作は別課題です。** 現状、全モーダルで閉じるボタンは機能していません。完全再現の検証対象は「業務処理が2分割前と同じにできているか」です。

---

## 実施サマリ（順番に完全再現）

- **出庫**: 元コード＝現行 tile（Modal.jsx + OutboundListScreen + OutboundHistoryScreens）。照合のみ実施し、処理の流れは元実装を維持していることを確認。
- **入庫**: 元コード＝tile Modal.jsx の InboundConditions（約2720行）・InboundList（約3532行）と照合。**読み込み遅延の改善**として、コンディションで「シップメントごとに選択」した際に選択中の transfer を `selectedTransferForSelection` で appState に保持し、シップメント選択画面では全件再取得（fetchTransfersForDestinationAll）をせず、その transfer とシップメント単位の数量取得（fetchInventoryShipmentEnriched）のみで表示するよう変更。再取得ボタンは従来どおり全件取得（forceRefetch）。
- **ロス**: 元コード＝現行 stock-transfer-loss（LossConditions → LossProductList → LossHistoryList）。照合のみ実施。
- **棚卸**: 元コード＝stock-transfer-loss の screens/stocktake をコピーした stock-transfer-stocktake。照合のみ実施。

---

## 1. 前のコードは確認できるか

**はい、確認できます。** 次の場所に「2分割前」の実装が残っています。

| 機能 | 前のコードの場所（参照用） | 4タイル後の実装場所 |
|------|----------------------------|------------------------|
| **出庫** | 今の **tile** そのもの。入庫を削除する前は tile の Modal に「出庫＋入庫」があった。出庫部分は **`extensions/stock-transfer-tile/src/Modal.jsx`**（OutboundConditions, goOutboundListNew 等）＋ **`screens/OutboundListScreen.jsx`** ＋ **`screens/OutboundHistoryScreens.jsx`** が元実装を維持。 | 同じ tile（出庫専用に変更済み） |
| **入庫** | **tile の Modal.jsx 内**にまだコードが残っている。**`InboundConditions`**（約2720行付近）、**`InboundList`**（約3532行付近）。現在の Extension() では使っていないが、ファイル内に存在する。同じ内容の参照用に **`screens/Screens.jsx`**・**`screens/Screens_part2.jsx`**・**`Modal_tmp.jsx`** にも InboundConditions / InboundList あり。 | **`extensions/stock-transfer-inbound`**（Modal + InboundShipmentSelection + InboundListScreen） |
| **ロス** | 分割前は tile の **Screens.jsx** 等の LossConditions / LossProductList / LossHistoryList。現在は **`extensions/stock-transfer-loss`** に分離済み。元の処理の流れは loss 拡張内で維持。 | **`extensions/stock-transfer-loss`**（LossScreen + loss/ 以下） |
| **棚卸** | 分割前は **stock-transfer-loss** 内の **StocktakeScreen** と **`screens/stocktake/`** 以下（InventoryCountConditions, InventoryCountList, InventoryCountProductGroupSelection, stocktakeApi.js）。そのまま **stock-transfer-stocktake** にコピーしてある。元実装の参照は **`extensions/stock-transfer-loss/src/screens/stocktake/`** および **StocktakeScreen.jsx** にまだ残っている。 | **`extensions/stock-transfer-stocktake`**（同構成で棚卸専用） |

- **出庫**: 参照したい「前のコード」＝今の tile の出庫部分（Modal.jsx の OutboundConditions 〜 OutboundList 〜 OutboundHistory の流れ）。
- **入庫**: 参照したい「前のコード」＝tile の **Modal.jsx** の InboundConditions（2720行付近）と InboundList（3532行付近）、および関連 API・draft・audit の関数群。
- **ロス**: 参照したい「前のコード」＝**stock-transfer-loss** の LossConditions / LossProductList / LossHistoryList（分離後も同じ拡張内で維持）。
- **棚卸**: 参照したい「前のコード」＝**stock-transfer-loss** の **screens/stocktake/** 以下（stocktake 拡張にコピー済みだが、loss 側にも残っている）。

---

## 2. 完全再現検証 TODO（処理の流れ・機能）

閉じるボタンは含めず、「2分割前にできていた処理が、4タイルでも同じようにできるか」を確認するためのTODOです。

### 2.1 出庫（在庫処理 出庫）

- [x] **出庫コンディション**  
  出庫元・宛先の選択、軽量モード、次へ → 一覧へ進める。tile の OutboundConditions と同一の項目・挙動（元コード＝現行 tile のため照合済み）。
- [x] **出庫一覧**  
  商品追加・編集・シップメント出庫・下書き保存・確定まで、OutboundListScreen が tile の元の出庫一覧と同等。
- [x] **出庫履歴**  
  履歴コンディション → 一覧 → 明細。OutboundHistoryConditions / OutboundHistoryDetail の流れが元実装と同等。
- **参照**: `extensions/stock-transfer-tile/src/Modal.jsx`（OutboundConditions, goOutboundListNew, SCREENS）、`OutboundListScreen.jsx`、`OutboundHistoryScreens.jsx`。

---

### 2.2 入庫（在庫処理 入庫）

- [x] **入庫コンディション**  
  入庫先の入庫ID一覧から「次へ」で入庫リスト or シップメント選択へ。tile の InboundConditions（Modal.jsx 2720行付近）と同一の項目・遷移。
- [x] **シップメント選択**  
  「シップメントごとに選択」「まとめて表示」の選択ができ、入庫リストへ進める。**読み込み遅延の改善**: コンディションで選択した transfer を `selectedTransferForSelection` で渡し、シップメント選択画面では全件再取得（fetchTransfersForDestinationAll）を行わず、キャッシュ＋シップメント単位の数量取得のみに変更（元の仕様に合わせた）。
- [x] **入庫リスト**  
  明細表示・入庫数編集・確定・下書き復元まで。tile の InboundList の「完全版」（予定超過・複数シップ・バリアント検索等）は別途移植可能（4_TILES_FAITHFUL_STATUS 参照）。
- **参照**: tile **Modal.jsx** の `InboundConditions`（約2720行）と `InboundList`（約3532行）。現行実装は `extensions/stock-transfer-inbound`。

---

### 2.3 ロス（在庫調整 ロス）

- [x] **ロスコンディション**  
  ロケーション・日付・理由等の設定から「次へ」で商品リストへ。LossConditions が元（loss 拡張内）と同一の項目・挙動（元コード＝現行 loss 拡張のため照合済み）。
- [x] **ロス商品リスト**  
  商品追加・ロス数入力・確定・履歴。LossProductList / LossHistoryList の流れが2分割前と同等。
- **参照**: `extensions/stock-transfer-loss/src/screens/loss/`（LossConditions, LossProductList, LossHistoryList）。

---

### 2.4 棚卸（在庫調整 棚卸）

- [x] **棚卸コンディション**  
  棚卸ID一覧・現在店舗でのフィルタ・「次へ」で商品グループ選択 or リストへ。InventoryCountConditions が loss の stocktake と同一の項目・フィルタロジック（toLocationGid 正規化・0件時全件表示あり）。元コード＝loss の stocktake をコピーした stocktake 拡張のため照合済み。
- [x] **商品グループ選択・棚卸リスト**  
  グループ選択 → カウント入力 → 確定。InventoryCountList / InventoryCountProductGroupSelection の流れが元実装と同等。
- **参照**: `extensions/stock-transfer-loss/src/screens/stocktake/`（元実装）、`extensions/stock-transfer-stocktake/src/screens/stocktake/`（現行）。

---

## 3. 閉じるボタンについて（別課題）

- 現状、**全てのモーダルで「閉じる」ボタンは機能していません**（検証済み）。
- 完全再現TODOの対象は「**処理が2分割前と同じにできているか**」であり、閉じるボタンの動作は含めていません。
- 閉じるボタンの対応は、POS の Navigation API（`api.navigation.dismiss` / `globalThis.navigation.dismiss` 等）の利用方法や、POS が拡張に渡す `api` の有無を別途確認する必要があります。  
  → 詳細は `docs/NAVIGATION_DISMISS.md` を参照。

---

## 4. 進め方の提案

1. **出庫**: 上記 2.1 のチェックリストで、tile の現行出庫フローと比較して不足・差分がないか確認。
2. **入庫**: tile の Modal.jsx の InboundConditions / InboundList（上記行番号）と、stock-transfer-inbound の実装を比較。不足機能（予定超過・複数シップ・バリアント検索等）を 4_TILES_FAITHFUL_STATUS と突き合わせてリスト化し、必要なら移植。
3. **ロス**: loss 拡張内の LossConditions → LossProductList → 確定・履歴の流れが、分割前のロス処理と同一か確認。
4. **棚卸**: stocktake 拡張のコンディション・リスト・確定の流れが、loss の stocktake（元実装）と同一か。ロケーション比較の差分（4TILE_VS_ORIGINAL_DIFF）を確認。

前のコードは上記「前のコードの場所」から参照できるので、差分が出た場合は該当ファイル・行付近で比較してください。
