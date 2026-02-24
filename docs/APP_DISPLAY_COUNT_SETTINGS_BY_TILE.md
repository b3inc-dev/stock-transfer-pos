# アプリ表示件数（3項目）のタイル別反映状況

設定画面の「アプリ表示件数（初回読み込み）」は次の3項目です。

| 項目 | 設定キー | 用途 |
|------|----------|------|
| 履歴一覧リスト | `outbound.historyInitialLimit` / `inbound.listInitialLimit` | 出庫・入庫・ロス等の履歴一覧の初回件数 |
| 商品リスト | `productList.initialLimit` | 商品候補リスト（追加行）の初回表示件数 |
| 検索リスト | `searchList.initialLimit` | 検索結果の初回表示件数（API上限50） |

## デフォルト値（全箇所で統一）

| 項目 | デフォルト | 範囲 | 備考 |
|------|------------|------|------|
| 履歴一覧リスト | **100** | 1〜250 | API の `first` にそのまま渡す。管理画面・POS とも未設定時 100。 |
| 商品リスト | **250** | 1〜250 | 候補の「初回表示件数」（スライス表示）。未設定時 250。 |
| 検索リスト | **50** | 1〜50 | 検索 API の `first` と、検索結果の初回表示件数。API 上限 50。 |

- 管理画面の `defaultSettings()` と `sanitizeSettings` の clamp デフォルト、フォームの `value` フォールバック、POS 各拡張の `?? 100` / `?? 250` / `?? 50` は上記に合わせてある。
- 履歴は「API で取得する件数」＝「一覧に表示する件数」。検索は「API の first」＝ searchList、「結果を何件まで表示するか」は productList（検索結果リストのスライス）。商品リストは「候補を何件表示してから『さらに表示』にするか」に productList を使用。

## API 呼び出しと表示の対応

- **履歴一覧**: `fetchTransfersForOriginAll` / `fetchTransfersForDestinationAll` 等の `first` に **履歴一覧リスト**（historyInitialLimit / listInitialLimit）を渡している。取得件数＝表示件数で一致。
- **検索**: `searchVariants(..., { first: searchLimit })` の `first` に **検索リスト**（searchList.initialLimit）を渡している。取得件数＝検索 API の上限と一致。
- **商品リスト（候補の初回表示）**: API で取った候補を `candidates.slice(0, candidatesDisplayLimit)` で表示。`candidatesDisplayLimit` は **商品リスト**（productList.initialLimit）から設定。検索時は「検索結果の先頭 N 件」の N に productList を使用している。
- 以上のため、**API の呼び出し件数と画面上の表示件数は、いずれも3項目の設定に問題なく反映されている**。

## タイル別の反映状況（2026-02-24 全タイル3項目反映済み）

| タイル | 履歴一覧リスト | 商品リスト | 検索リスト |
|--------|----------------|------------|------------|
| 出庫 | ✅ historyInitialLimit | ✅ productList.initialLimit | ✅ searchList.initialLimit |
| 入庫 | ✅ listInitialLimit | ✅ productList.initialLimit | ✅ searchList.initialLimit |
| ロス | ✅ historyInitialLimit | ✅ productList.initialLimit | ✅ searchList.initialLimit |
| 棚卸 | ✅ historyInitialLimit | ✅ productList.initialLimit | ✅ searchList.initialLimit |
| 調整 | ✅ historyInitialLimit | ✅ productList.initialLimit | ✅ searchList.initialLimit |
| 発注 | ✅ historyInitialLimit | ✅ productList.initialLimit | ✅ searchList.initialLimit |
| 仕入 | ✅ historyInitialLimit | ✅ productList.initialLimit | ✅ searchList.initialLimit |

全タイルで「履歴一覧リスト」「商品リスト」「検索リスト」の3項目が設定に反映されます。

## 実装ファイル（参照箇所）

- **履歴一覧**: stocktakeApi.js, purchaseApi.js, orderApi.js, lossApi.js, adjustmentApi.js / ModalOutbound.jsx, Modal_REFERENCE.jsx, inbound/Modal.jsx, InboundShipmentSelection.jsx
- **商品リスト**: InventoryCountList.jsx（棚卸）, InboundListScreen.jsx（入庫）. 出庫は candidatesDisplayLimit=50 固定。ロス・発注・仕入・調整は candidatesDisplayLimit を searchLimit ベースで算出。
- **検索リスト**: 各タイルの ProductList 系コンポーネントで searchList.initialLimit を参照済み。
