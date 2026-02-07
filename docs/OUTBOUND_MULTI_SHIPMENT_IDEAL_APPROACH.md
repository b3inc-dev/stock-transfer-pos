# 出庫 複数シップメント 要件を満たす「一番理想」の進め方

`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` の要件を**漏れなく満たす**ための、一番理想的な方針と手順をまとめました。

---

## 結論：一番理想のやり方

**「Modal.jsx をエントリのままにし、出庫まわりだけ OutboundHistoryScreens / OutboundListScreen に差し替える」** のがいちばん理想です。

- エントリ（`shopify.extension.toml`）はそのまま → ユーザー体験・デプロイを変えない
- 出庫ロジックは **1か所**（OutboundHistoryScreens + OutboundListScreen）に集約 → 重複なし・保守しやすい
- 既に「編集/追加モーダル」「3モード」「movementId」まで実装済みのコードを流用できる
- 足りない部分だけ **OutboundListScreen と OutboundHistoryDetail に追加**すれば要件を満たせる

---

## なぜこのやり方が理想か

| 観点 | この方針でできること |
|------|----------------------|
| **要件** | 編集/追加モーダル、3モード、movementId、下書き表示ルール、編集時の確定＝シップメント出庫確定、シップメント一覧・選択・status 表示まで、すべて**同じ設計**で揃えられる。 |
| **エントリ** | Modal.jsx のままなので、extension 設定の変更や「どちらのモーダルが動くか」の切り替えが不要。 |
| **重複** | 出庫の「履歴・詳細・リスト」は OutboundHistoryScreens + OutboundListScreen の**1組だけ**にし、Modal.jsx はそれを import して表示するだけにできる。 |
| **保守** | 出庫の仕様変更は OutboundHistoryScreens / OutboundListScreen（＋outboundShipmentApi）だけ見ればよい。 |
| **既存資産** | 編集/追加モーダルや `addingShipmentToTransferId` など、すでに書かれている実装を活かせる。 |

---

## 具体的な進め方（4ステップ）

### ステップ1: 出庫用コンポーネントを「使える形」にする

**OutboundHistoryScreens.jsx**

- `OutboundHistoryConditions` と `OutboundHistoryDetail` を **export** する。
- ファイルが `screens/` にあるので、`modalHelpers` / `modalHooks` / `modalUiParts` / `outboundShipmentApi` は **`../`** で参照する（例: `../modalHelpers.js`, `../outboundShipmentApi.js`）。

**OutboundListScreen.jsx**

- すでに `OutboundList` を export しており、`../outboundShipmentApi.js` も参照済み。  
- ここでは**変更なし**でよい（不足はステップ3で対応）。

**outboundShipmentApi.js**

- そのままでよい。

---

### ステップ2: Modal.jsx で出庫まわりを「差し替え」する

1. **state の追加**  
   `outbound` の初期値に **`addingShipmentToTransferId: ""`** を追加する。

2. **インポートの追加**  
   - `OutboundHistoryConditions` と `OutboundHistoryDetail` を `./screens/OutboundHistoryScreens.jsx` から import  
   - `OutboundList` を `./screens/OutboundListScreen.jsx` から import  

3. **インライン実装の削除と差し替え**  
   - 現在の **OutboundHistoryConditions**（Modal.jsx 内の定義）を削除し、上記 import に差し替え  
   - 同様に **OutboundHistoryDetail** と **OutboundList** も削除し、import したコンポーネントに差し替え  

4. **props の受け渡し**  
   - 差し替え先の `OutboundList` には、今のインライン OutboundList に渡している **同じ props**（`inventoryTransferSetItemsSafe`, `findMissingInventoryLevelsAtLocation`, `waitForMissingInventoryLevelsToClear`, `appendInventoryTransferNote_`, `ensureInventoryActivatedAtLocation`, `FixedFooterNavBar`, その他必要なもの）を**すべて**渡す。  
   - 履歴・詳細側の `onOpenOutboundList` は、既存の「OutboundList 画面に遷移する処理」にそのまま繋げる。

これで「編集/追加モーダル」「シップメント追加」「3モード」が Modal.jsx 上で動くようになります。

---

### ステップ3: 要件とのギャップを OutboundListScreen で埋める

**編集時の「確定する」**

- 要件: そのシップメントの明細更新 **＋ そのシップメントのみ出庫確定**（Shipment 作成 or 更新）。確定した時点でトランスファーが確定される。
- 現状: 編集時は `inventoryTransferSetItemsSafe` のみで、Shipment 作成/更新をしていない。
- 対応: 編集モードで「確定する」を押したときに、  
  - 既存 Shipment がある場合はその Shipment を更新（例: `inventoryShipmentUpdateItemQuantities` 等）しつつ出庫確定、  
  - まだ Shipment がない場合は `inventoryShipmentCreateInTransit`（`movementId`: 当該 Transfer ID）で 1 シップメント分を作成して出庫確定、  
  という分岐を **OutboundListScreen.jsx** に追加する。

**下書き保存の表示ルール**

- 要件: **編集対象が DRAFT のときのみ表示**。READY_TO_SHIP または確定済み（IN_TRANSIT 等）のときは非表示。新規・シップメント追加時は表示。
- 現状: `!editingTransferId` のときだけ表示（編集時は常に非表示）。
- 対応: **OutboundListScreen.jsx** 内で、  
  - 新規 or `addingShipmentToTransferId` のとき → 下書き保存を**表示**  
  - 編集（`editingTransferId`）のとき → **編集対象の Transfer / Shipment の status が DRAFT のときだけ表示**、READY_TO_SHIP や IN_TRANSIT 等のときは**非表示**  
  に変更する（必要なら Transfer の status を取得する処理を追加）。

これで §3.0 / §3.0.1 / §3.1 / §4 の「確定する」「下書き保存」まわりが要件どおりになります。

---

### ステップ4: 詳細画面で「シップメント一覧・選択・status」を満たす

**OutboundHistoryDetail（OutboundHistoryScreens.jsx 内）**

- 要件（§3.4・§5）:  
  - シップメントが **2 以上**のときは、詳細で**シップメント一覧を表示**し、**編集したい 1 つを選択**してから OutboundList を開く。  
  - シップメントリストで各シップメントの **status**（DRAFT / IN_TRANSIT / RECEIVED 等）を表示する。
- 対応:  
  - 詳細画面に **シップメント一覧**（Transfer に紐づく Shipment のリスト）を表示する。  
  - 各シップメントに **status** を表示する。  
  - 2 以上のときは「編集」でいきなり OutboundList を開かず、**一覧から 1 つ選んでから** OutboundList を開く（選択したシップメントを編集対象にする）。  
  - 1 以下のときは従来どおり、詳細からそのまま「編集」で OutboundList を開く。

実装場所は **OutboundHistoryScreens.jsx** の `OutboundHistoryDetail` 内でよいです。

---

## 完了時の状態イメージ

- **エントリ**: これまでどおり `Modal.jsx`（`shopify.extension.toml` は変更なし）。
- **出庫の見た目・流れ**:  
  - 履歴一覧（OutboundHistoryConditions）→ READY_TO_SHIP で「編集」→ 「編集」or「追加」モーダル → 編集なら詳細（OutboundHistoryDetail）→ 必要ならシップメント一覧から 1 つ選択 → OutboundList → 「確定する」/「配送準備完了にする」/「下書き保存」。  
  - 追加なら「追加」→ OutboundList（`addingShipmentToTransferId`）→ 同様の 3 ボタン。
- **責務の分け方**:  
  - **Modal.jsx**: ルーティング・state・入庫など他機能。出庫は「OutboundHistoryScreens + OutboundListScreen を import して表示」だけ。  
  - **OutboundHistoryScreens.jsx**: 履歴一覧・編集/追加モーダル・詳細・シップメント一覧・選択・status。  
  - **OutboundListScreen.jsx**: 新規/編集/シップメント追加の 3 モード、確定・下書き・配送準備完了の挙動。  
  - **outboundShipmentApi.js**: `inventoryShipmentCreate` / `inventoryShipmentCreateInTransit` など API 呼び出し。

---

## 要件チェックリストとの対応（§5）

| チェック項目 | この方針での対応 |
|--------------|------------------|
| シップメントを追加で OutboundList を開くときに既存 transferId を渡す。確定時は movementId にその ID を渡す | ステップ2で `addingShipmentToTransferId` を渡し、OutboundListScreen が既に movementId で API 呼び出し済み。 |
| 「新規」「編集」「シップメント追加」の 3 パターンを state で区別 | ステップ2で `editingTransferId` / `addingShipmentToTransferId` を Modal の state に持ち、OutboundList に渡す。 |
| 編集時「配送準備完了にする」表示。下書き保存は DRAFT のときのみ表示、READY_TO_SHIP/確定済みは非表示 | ステップ3で OutboundListScreen の表示条件を要件どおりに変更。 |
| シップメント追加時の「確定する」＝inventoryShipmentCreateInTransit、「下書き保存」＝inventoryShipmentCreate（movementId: 既存 transferId） | OutboundListScreen で既に実装済み。 |
| シップメントリストで各シップメントの status を表示 | ステップ4で OutboundHistoryDetail にシップメント一覧・status 表示を追加。 |
| 「確定する」＝トランスファーが確定される | ステップ3で編集時の「確定する」をシップメント出庫確定まで実装すれば満たせる。 |
| 出庫履歴の「編集」モーダルは「編集」と「追加」の 2 つのみ | OutboundHistoryScreens のモーダルがすでにその形。 |
| シップメント 1 以下は詳細→編集→確定。2 以上は詳細でシップメント一覧から 1 つ選択→編集→確定 | ステップ4で OutboundHistoryDetail にシップメント一覧・選択を追加。 |

---

## まとめ

- **一番理想** = **Modal.jsx をエントリのまま、出庫だけ OutboundHistoryScreens + OutboundListScreen に差し替え、足りないところをそこに足す**。
- **やること**:  
  1. OutboundHistoryScreens の export と import パス修正  
  2. Modal.jsx の state に `addingShipmentToTransferId` を追加し、出庫 UI を上記 2 ファイルのコンポーネントに差し替え、必要な props を渡す  
  3. OutboundListScreen で「編集時の確定＝シップメント出庫確定」と「下書き保存＝DRAFT のときのみ表示」を実装  
  4. OutboundHistoryDetail でシップメント一覧・選択・status 表示を実装  

この順で進めれば、`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` の要件を満たす形にできます。
