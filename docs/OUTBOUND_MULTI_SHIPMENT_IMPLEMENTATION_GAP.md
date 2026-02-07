# 出庫 複数シップメント 実装差分（要件 vs 現状）

`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` の要件と、現状のコード実装の差分を整理したドキュメントです。  
※編集ボタンは現在表示されていない前提で記載しています。

---

## 前提：どのコードが動いているか

- **実際に使われているのは `Modal.jsx`** 内の出庫まわりです。
  - 出庫履歴一覧: `Modal.jsx` 内の `OutboundHistoryConditions`
  - 出庫リスト（明細編集）: `Modal.jsx` 内の `OutboundList`
  - 出庫履歴詳細: `Modal.jsx` 内の `OutboundHistoryDetail`
- `OutboundHistoryScreens.jsx` / `OutboundListScreen.jsx` には「編集／追加」モーダルや `addingShipmentToTransferId` の実装がありますが、**Modal.jsx の画面遷移では使われていません**（別ルート用の可能性あり）。

以下は **Modal.jsx を基準にした差分** です。

---

## 1. 出庫履歴一覧（OutboundHistoryConditions）

| 要件（§3.3・§3.4） | 現状（Modal.jsx） | 差分 |
|-------------------|-------------------|------|
| READY_TO_SHIP の行で「編集」を押すと、**「編集」と「追加」の 2 つのみ**のモーダルを表示する | 行タップで**そのまま詳細へ遷移**。編集/追加を選ぶモーダルは**ない** | ❌ **編集/追加モーダルが未実装** |
| モーダルで「編集」→ 詳細 → OutboundList で編集 → 「確定する」でトランスファー確定 | 詳細のフッターに「編集」があるが、**現在は表示されていない**（ご指摘の通り） | ❌ **編集入口がユーザーに触れない** |
| モーダルで「追加」→ OutboundList を「シップメントを追加」モードで開く | 「追加」を選ぶモーダル自体がないため、**追加フローに到達できない** | ❌ **追加フロー未実装** |
| シップメントが **2 以上**のときは、詳細で**シップメント一覧を表示**し、**編集したい 1 つを選んで**から OutboundList を開く | 詳細画面に**シップメント一覧・選択 UI はない**。Transfer 単位の明細のみ表示 | ❌ **複数シップメント時の「1つ選んで編集」が未実装** |

---

## 2. State（outbound）

| 要件（§1・§5） | 現状（Modal.jsx） | 差分 |
|----------------|-------------------|------|
| **`addingShipmentToTransferId`** で「シップメントを追加」モードを表し、既存 Transfer ID を渡す | **`addingShipmentToTransferId` は state に存在しない**（初期値も未定義） | ❌ **追加モード用 state がない** |
| 「新規」「編集」「シップメント追加」の 3 パターンを state で区別する | `editingTransferId` のみあり、「新規」と「編集」の 2 パターンのみ | ❌ **シップメント追加の区別ができない** |

---

## 3. OutboundList（確定モーダルの 3 ボタン）

| 要件（§3.0・§3.0.1） | 現状（Modal.jsx） | 差分 |
|----------------------|-------------------|------|
| **下書き保存**は「**編集対象が DRAFT のときのみ表示**」。READY_TO_SHIP や確定済みのときは**非表示** | **`!editingTransferId` のときだけ表示**（編集モードなら常に非表示） | ⚠️ **DRAFT のみ表示という要件とずれている**。編集時は「DRAFT なら表示・READY_TO_SHIP/確定済みなら非表示」にすべき |
| **シップメントを追加**モードでは「下書き保存」を**表示**し、`inventoryShipmentCreate`（`movementId`: 既存 transferId）で DRAFT 追加 | `addingShipmentToTransferId` がないため、追加モード自体がない | ❌ **追加モードでの下書き保存は未実装** |
| **シップメントを追加**モードの「確定する」＝`inventoryShipmentCreateInTransit`（`movementId`: 既存 transferId） | 編集時は `inventoryTransferSetItemsSafe` のみ。**既存 Transfer にシップメントを追加する処理はない** | ❌ **追加モードの確定（IN_TRANSIT 追加）が未実装** |
| **シップメントを追加**モードの「配送準備完了にする」＝既存 Transfer に DRAFT シップメント追加等で READY_TO_SHIP 維持 | 同上。追加モードがない | ❌ **未実装** |

---

## 4. 編集モード時の「確定する」の挙動

| 要件（§3.1・§4） | 現状（Modal.jsx） | 差分 |
|------------------|-------------------|------|
| 編集時「確定する」＝**そのシップメント**の明細更新＋**そのシップメントのみ出庫確定**（Shipment 作成/更新。例: `inventoryShipmentCreateInTransit` や既存 Shipment の更新）。**トランスファーが確定される** | 編集時「確定する」は **`inventoryTransferSetItemsSafe` のみ**（Transfer の lineItems を更新して戻る）。**Shipment の作成・更新や出庫確定は行っていない** | ❌ **編集確定＝シップメント出庫確定になっていない** |

---

## 5. シップメント一覧・ステータス表示

| 要件（§0.4・§5） | 現状（Modal.jsx） | 差分 |
|------------------|-------------------|------|
| シップメントリストで各シップメントの **status**（DRAFT / IN_TRANSIT / RECEIVED 等）を表示する | 詳細画面に**シップメント単位のリストや status 表示はない** | ❌ **未実装** |

---

## 6. 出庫履歴詳細（OutboundHistoryDetail）

| 要件（§3.4） | 現状（Modal.jsx） | 差分 |
|--------------|-------------------|------|
| シップメントが **1 以下**のとき: 詳細 → 編集 → OutboundList → 「確定する」でトランスファー確定 | 詳細から「編集」で OutboundList を開く流れはあるが、**編集ボタンが表示されていない**ため利用できない | ❌ **編集入口が無い** |
| シップメントが **2 以上**のとき: 詳細で**シップメント一覧を表示** → **編集したい 1 つを選択** → OutboundList → 「確定する」でその 1 シップメントを確定しトランスファー確定 | シップメント一覧・選択 UI がない | ❌ **未実装** |

---

## 7. 実装チェックリストとの対応（§5 抜粋）

| チェック項目 | Modal.jsx 現状 | 状態 |
|--------------|----------------|------|
| シップメントを追加で OutboundList を開くときに既存 `transferId` を渡す。確定時は `movementId` にその ID を渡す | `addingShipmentToTransferId` がなく、追加で開く経路もない | ❌ |
| OutboundList で「新規」「編集」「シップメント追加」の 3 パターンを state で区別 | `editingTransferId` のみで 2 パターンのみ | ❌ |
| 編集時「配送準備完了にする」表示。下書き保存は**編集対象が DRAFT のときのみ表示**、READY_TO_SHIP/確定済みは非表示 | 編集時は常に下書き保存非表示。DRAFT のみ表示の分岐はなし | ⚠️ |
| シップメント追加時の「確定する」＝`inventoryShipmentCreateInTransit`、「下書き保存」＝`inventoryShipmentCreate`（いずれも `movementId`: 既存 transferId） | 追加モードがないため該当処理なし | ❌ |
| シップメントリストで各シップメントの status を表示 | なし | ❌ |
| 「確定する」＝トランスファーが確定される（編集から確定 or 追加して確定） | 編集時の「確定する」は明細更新のみで、シップメント確定・トランスファー確定の扱いになっていない | ❌ |
| 出庫履歴の「編集」モーダルは「編集」と「追加」の 2 つのみ。「シップメントを確定」は廃止 | 編集/追加モーダル自体がない | ❌ |
| シップメント 1 以下のときは詳細→編集→確定。2 以上のときは詳細でシップメント一覧から 1 つ選択→編集→確定 | 詳細にシップメント一覧・選択がなく、編集ボタンも表示されていない | ❌ |

---

## 8. 実装済み・流用できる部分

- **OutboundHistoryScreens.jsx**
  - READY_TO_SHIP 行に「編集」ボタンがあり、押すと「編集」と「追加」のモーダルを表示する実装がある。
  - 「追加」で `addingShipmentToTransferId` をセットして OutboundList を開く `onAddShipment` がある。
- **OutboundListScreen.jsx**
  - `addingShipmentToTransferId` を参照し、「シップメントを追加」時の「確定する」で `createInventoryShipmentInTransit`（`movementId`）、「下書き保存」で `inventoryShipmentCreateDraft`（`movementId`）を呼ぶ実装がある。
- **outboundShipmentApi.js**
  - `createInventoryShipmentInTransit` と `inventoryShipmentCreateDraft`（`movementId` 対応）が用意されている。

これらは **Modal.jsx の画面遷移には組み込まれていない**ため、要件を満たすには **Modal.jsx 側に同様の state・モーダル・分岐を取り込む**必要があります。

---

## 9. 実装するときの優先順位の目安

1. **編集ボタンを表示する**  
   詳細フッターの「編集」を表示し、押したら OutboundList に遷移するようにする（現状は `middleDisabled={!isEditable}` で無効化されている可能性あり）。
2. **履歴一覧で「編集／追加」モーダルを入れる**  
   READY_TO_SHIP の行では行タップで詳細に行かず、「編集」ボタン→「編集」or「追加」のモーダル→詳細 or 追加用 OutboundList、という流れにする（OutboundHistoryScreens.jsx のパターンを Modal.jsx に移植）。
3. **`addingShipmentToTransferId` を Modal.jsx の state に追加**  
   追加モードで OutboundList を開くときに既存 `transferId` を渡し、確定時は `movementId` にその ID を渡す。
4. **Modal.jsx の OutboundList で 3 モード対応**  
   新規 / 編集（`editingTransferId`）/ シップメント追加（`addingShipmentToTransferId`）で分岐し、追加時は `inventoryShipmentCreate`・`inventoryShipmentCreateInTransit` を `movementId` 付きで呼ぶ。
5. **下書き保存の表示ルール**  
   編集対象が DRAFT のときのみ表示、READY_TO_SHIP または確定済みのときは非表示。シップメント追加モードのときは表示。
6. **詳細画面でシップメント一覧・選択**  
   シップメントが 2 以上のとき、詳細でシップメント一覧を表示し、1 つ選んでから OutboundList を開く。
7. **編集時の「確定する」**  
   明細更新だけでなく、シップメントの出庫確定（Shipment 作成/更新）を行い、「確定した時点でトランスファーが確定される」ようにする。

---

以上が、`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` と現状コード（主に Modal.jsx）の差分です。実装前に要件を揃える際の参照として使えます。
