# 4ファイル接続で要件を満たせるか（可否整理）

OutboundHistoryScreens.jsx / OutboundListScreen.jsx / Screens.jsx / outboundShipmentApi.js を「繋ぐ」ことで、`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` の要件を満たせるかを整理しました。

---

## 結論：**可能です（条件付き）**

4ファイルを正しく接続し、足りない部分を少し足せば、今回の要件の**大部分**を満たせます。  
ただし次の2点が必要です。

1. **接続作業**  
   Screens.jsx で「インライン実装」をやめ、OutboundHistoryScreens / OutboundListScreen を import して使うようにする。  
   あわせて、OutboundHistoryScreens の import パス修正と export の追加。

2. **要件との残りギャップ**  
   接続後も、要件どおりにするには「編集時の確定＝シップメント出庫確定」と「下書き保存の表示ルール（DRAFT のときのみ）」の対応が別途必要。

---

## 1. 各ファイルの役割と接続イメージ

| ファイル | 役割 | 接続で使うもの |
|----------|------|----------------|
| **outboundShipmentApi.js** | `createInventoryShipmentInTransit` / `inventoryShipmentCreateDraft`（`movementId` 対応） | そのまま利用。OutboundListScreen が既に import 済み。 |
| **OutboundListScreen.jsx** | 出庫リスト（新規・編集・**シップメント追加**の3モード）、`addingShipmentToTransferId` / `movementId` で追加時の確定・下書き | Screens.jsx の `<OutboundList>` を、ここから import したコンポーネントに差し替える。 |
| **OutboundHistoryScreens.jsx** | 履歴一覧＋**編集/追加モーダル**（READY_TO_SHIP 行で「編集」「追加」）、詳細、`addingShipmentToTransferId` をセットして `onOpenOutboundList` 呼び出し | Screens.jsx の `OutboundHistoryConditions` / `OutboundHistoryDetail` を、ここから import したコンポーネントに差し替える。 |
| **Screens.jsx** | 画面ルート・state・ナビ。現在は出庫まわりを**自前のインライン実装**で持っている | 出庫まわりを「OutboundHistoryScreens + OutboundListScreen」に差し替え、state に `addingShipmentToTransferId` を追加。 |

接続後の流れは次のとおりです。

- 履歴一覧・詳細・「編集/追加」モーダル → **OutboundHistoryScreens**
- 「編集」or「追加」選択 → `editingTransferId` / `addingShipmentToTransferId` をセットして `onOpenOutboundList()` → **Screens.jsx が OUTBOUND_LIST に遷移**
- 出庫リスト（3モード・確定・下書き・配送準備完了） → **OutboundListScreen**（内部で **outboundShipmentApi.js** 使用）

この形にすれば「編集/追加モーダル」「シップメント追加」「movementId で既存 Transfer に追加」は実現できます。

---

## 2. 接続のために必要な作業

### 2.1 OutboundHistoryScreens.jsx

| 作業 | 内容 |
|------|------|
| **export の追加** | `OutboundHistoryConditions` と `OutboundHistoryDetail` を export（現状は export なしで他ファイルから参照できない）。 |
| **import パスの修正** | ファイルが `screens/` にあるため、`./modalHelpers.js` などは `screens/` を参照しており、実際の `modalHelpers.js`・`modalHooks.js`・`modalUiParts.jsx`・`outboundShipmentApi.js`（いずれも `src/`）を指していない。`../modalHelpers.js` のように親ディレクトリ向けに修正する必要がある。 |

### 2.2 Screens.jsx

| 作業 | 内容 |
|------|------|
| **state の追加** | 出庫用 state（例: `outbound`）に **`addingShipmentToTransferId`** の初期値（例: `""`）を追加する。 |
| **コンポーネントの差し替え** | 自前のインライン `OutboundHistoryConditions` / `OutboundHistoryDetail` / `OutboundList` を削除し、代わりに以下を使う。<br>• `OutboundHistoryConditions` と `OutboundHistoryDetail` → `OutboundHistoryScreens.jsx` から import<br>• `OutboundList` → `OutboundListScreen.jsx` から import |
| **OutboundList に渡す props** | OutboundListScreen の `OutboundList` は、`inventoryTransferCreateDraftSafe` / `inventoryTransferSetItemsSafe` / `findMissingInventoryLevelsAtLocation` / `waitForMissingInventoryLevelsToClear` / `appendInventoryTransferNote_` / `ensureInventoryActivatedAtLocation` / `FixedFooterNavBar` / `INVENTORY_TRANSFER_NOTE_QUERY` / `VariantCache` など、多くの props を要求する。Screens.jsx のインライン OutboundList が今使っているものと同等のものを、すべて渡す必要がある。 |

### 2.3 OutboundListScreen.jsx

- **outboundShipmentApi.js** は既に `../outboundShipmentApi.js` で import 済み。Screens.jsx から使うだけなら追加変更は不要。
- 編集モード・下書き保存の表示については、次の「要件との残りギャップ」で対応する。

### 2.4 outboundShipmentApi.js

- 変更不要。そのまま「繋ぐ」だけで使える。

---

## 3. 接続後も残る要件ギャップ（対応が必要な点）

4ファイルを繋いだだけでは、要件の「完全一致」には次の2点が足りません。

| 項目 | 要件 | 現状（OutboundListScreen） | 必要な対応 |
|------|------|----------------------------|------------|
| **編集時の「確定する」** | そのシップメントの出庫確定（Shipment 作成/更新）を行い、トランスファーが確定される。 | 編集時は **`inventoryTransferSetItemsSafe` のみ**（明細更新して戻る）。Shipment の作成・更新（例: `inventoryShipmentCreateInTransit`）は行っていない。 | 編集モードで「確定する」を押したときに、**そのシップメントを出庫確定する**処理（Shipment 作成 or 更新）を追加する。 |
| **下書き保存の表示** | 編集対象が **DRAFT のときのみ表示**。READY_TO_SHIP や確定済みのときは非表示。 | `!editingTransferId` のときだけ表示（＝編集モードなら常に非表示）。 | 編集時は「**編集対象の Transfer / Shipment が DRAFT のときだけ**」下書き保存を表示するように分岐する。 |

この2つを OutboundListScreen.jsx 側で直せば、要件を満たせます。

---

## 4. 接続しても満たせない／別対応が必要な要件

- **シップメントが 2 以上のとき、詳細でシップメント一覧を表示し、1つ選んでから OutboundList を開く**  
  OutboundHistoryScreens の詳細（OutboundHistoryDetail）に、シップメント一覧・選択 UI があるか要確認。なければ詳細側の追加実装が必要。
- **シップメントリストで各シップメントの status（DRAFT / IN_TRANSIT / RECEIVED 等）を表示**  
 一覧や詳細で「シップメント単位の status 表示」がどこまであるか確認し、なければ表示を追加する必要あり。

これらは「4ファイルを繋ぐ」かどうかとは別の、UI/仕様の追加です。

---

## 5. まとめ

- **OutboundHistoryScreens.jsx / OutboundListScreen.jsx / Screens.jsx / outboundShipmentApi.js を繋ぐと、今回の要件の大部分は満たせます。**
- やることのイメージは次のとおりです。
  1. **OutboundHistoryScreens.jsx**  
     export 追加 ＋ `modalHelpers` / `modalHooks` / `modalUiParts` / `outboundShipmentApi` の import を `../` に修正。
  2. **Screens.jsx**  
     `addingShipmentToTransferId` を state に追加し、出庫まわりを OutboundHistoryScreens / OutboundListScreen のコンポーネントに差し替え、OutboundList に必要な props をすべて渡す。
  3. **OutboundListScreen.jsx**  
     編集時の「確定する」でシップメント出庫確定を追加、下書き保存を「DRAFT のときのみ表示」に変更。
  4. **outboundShipmentApi.js**  
     そのまま利用。

- エントリが **Modal.jsx** のままなら、この接続は **Screens.jsx を読むルート（例: Modal_tmp.jsx の lazy import）でしか有効になりません**。  
  **実際に POS のモーダルで使う**には、`shopify.extension.toml` の `pos.home.modal.render` を **Screens.jsx を表示するモーダル**に切り替えるか、または **Modal.jsx 側**で同様に OutboundHistoryScreens / OutboundListScreen を import して繋ぐ必要があります。

以上が、「4ファイルを繋ぐと今回の要件を満たすことが可能か」の整理です。
