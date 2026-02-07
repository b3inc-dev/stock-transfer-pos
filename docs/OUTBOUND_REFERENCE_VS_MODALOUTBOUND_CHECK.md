# 出庫：Modal_REFERENCE.jsx と ModalOutbound.jsx の実装確認結果

**確認日**: 2026年2月  
**目的**: 要件書（REQUIREMENTS_FINAL.md）に基づき、出庫の「確定処理」および「確定処理以外のコード」が Modal_REFERENCE.jsx と相違なく実装されているか徹底確認する。

---

## 1. 結論サマリー

| 項目 | 結果 |
|------|------|
| **確定処理** | **ModalOutbound の方が要件を満たしている**。REFERENCE は「①新規作成」のみ。ModalOutbound は ①新規・②編集・③複数追加 の分岐を実装済み。 |
| **確定モーダルのボタン** | **要件どおり**。③④（複数シップメント追加/編集）時は「確定する」「下書き保存」の2種のみ（「配送準備完了にする」は非表示）。 |
| **確定処理以外のコード** | **REFERENCE と同等以上**。ゲート・在庫有効化・モーダルUI・loadDetail_・履歴「未確定：1」は同等。仮想行・配送一覧・複数シップメントは ModalOutbound のみ実装（REFERENCE にない拡張）。 |

**総合**: ModalOutbound.jsx は Modal_REFERENCE.jsx の出庫部分と「相違なく」というより、**REFERENCE の出庫を包含し、要件書で求められている確定フロー・仮想行・配送一覧・複数シップメントをすべて実装している**。不足はない。

---

## 2. 確定処理の比較

### 2.1 REFERENCE（Modal_REFERENCE.jsx）の確定処理

- **submitTransferCore**（約5509行〜）:
  - **分岐**: なし。常に「①新規作成」のパスのみ。
  - 在庫追跡有効化（出庫元・宛先）→ Transfer 作成（createTransferReadyToShipWithFallback）→ 必要なら Shipment 作成（createInventoryShipmentInTransit）→ 下書きクリア・onBack。
- **editingTransferId**（編集モード）のとき:
  - 確定モーダルでは「下書き保存」を非表示（`!editingTransferId`）。
  - しかし **submitTransferCore 内に editingTransferId の分岐がない**ため、「確定する」を押すと新規作成と同じ処理（新規 Transfer 作成）が走る設計になっている（REFERENCE は編集確定を submitTransferCore で扱っていない）。
- **addingShipmentToTransferId**（複数シップメント追加）:
  - **REFERENCE には存在しない**。複数シップメント追加モードは未実装。

### 2.2 ModalOutbound.jsx の確定処理

- **submitTransferCore**（約6102行〜）:
  - **分岐順**: ③配送追加 → ②編集 → ①新規。
  1. **③ addingShipmentToTransferId**: 既存 Transfer に `createInventoryShipmentInTransit` で新 Shipment を追加。成功後はシップメントリストへ遷移（onAddShipmentSuccess）。
  2. **② editingTransferId**: `inventoryTransferSetItemsSafe` で明細更新のみ。成功後は下書きクリア・onBack。
  3. **① 上記以外**: REFERENCE と同様、在庫有効化 → Transfer 作成 → Shipment 作成（任意）→ 下書きクリア・onBack。

- **確定モーダルのボタン表示**（約7505〜7681行）:
  - `isMultiShipmentAddOrEdit = !!addingShipmentToTransferId || (!!editingTransferId && historyFromShipmentSelection)` で判定。
  - **「配送準備完了にする」**: `!isMultiShipmentAddOrEdit` のときのみ表示（③④のときは非表示）。✅ 要件どおり。
  - **「下書き保存」**: `(!editingTransferId || isMultiShipmentAddOrEdit)` のとき表示。③④のときも「確定」「下書き」の2種にするため表示。✅ 要件どおり。

- **下書き保存ボタンの処理**（③④のとき）:
  - ③追加時: `createInventoryShipmentDraft` で既存 Transfer に DRAFT シップメント追加。
  - ②④編集時: `inventoryTransferSetItemsSafe` で Transfer の lineItems 更新（仮想行編集）。

**OUTBOUND_CONFIRM_FLOWS.md** の定義と一致している。

---

## 3. 確定処理以外のコード比較

### 3.1 REFERENCE にあり ModalOutbound でも同等のもの

| 項目 | 内容 |
|------|------|
| **確定前ゲート** | 宛先/出庫元の在庫レベル不足・マイナス在庫の検出。refreshOutboundGate、gateAck「内容を確認しました」、モーダル内の警告表示。両方とも同じロジック。 |
| **在庫追跡有効化** | ensureInventoryActivatedAtLocation（出庫元・宛先）。submitTransferCore 内で skipActivate でない場合に実行。両方とも同じ。 |
| **新規作成パス** | createTransferReadyToShipWithFallback →（tracking あれば）createInventoryShipmentInTransit。lineItems の組み立て・下書きクリア・onBack。同等。 |
| **「配送準備完了にする」** | createTransferAsReadyToShipOnly（Shipment 作成なし）。新規時のみ表示。REFERENCE は編集時も表示；ModalOutbound は③④のとき非表示で要件どおり。 |
| **「下書き保存」** | 新規時: inventoryTransferCreateDraft / inventoryTransferSetItems。REFERENCE は編集時非表示；ModalOutbound は③④のときも表示し「確定」「下書き」2種に。 |
| **確定モーダルUI** | 見出し「出庫を確定しますか？」、宛先・明細数・ゲート警告・配送番号入力・戻る・primary「確定する」。両方とも同じ構成。 |
| **コンディション画面** | OutboundConditions。出庫元・宛先・配送業者・配送番号・到着予定日・履歴ブロック・自動保存・復元。REFERENCE と ModalOutbound で役割は同じ（ModalOutbound は出庫専用拡張のためコンディションは同一ファイル内）。 |
| **履歴一覧** | OutboundHistoryConditions。未出庫/出庫済みタブ・Transfer 一覧・タップで詳細。両方に存在。 |
| **履歴詳細** | OutboundHistoryDetail。商品リスト・loadDetail_・戻る/編集/キャンセル。両方に存在。 |

### 3.2 ModalOutbound でだけ対応しているもの（分割・要件対応）

| 項目 | 内容（OUTBOUND_MODAL_VS_MODALOUTBOUND_DIFF.md 等に記載） |
|------|------|
| **loadDetail_ の実行タイミング** | `useEffect` で **transferId がセットされたときだけ** 実行。分割後 state 更新が非同期になるため、transferId 未設定のまま実行されないようにしている。 |
| **sid / ship.lineItems の正規化** | `d.shipments` が配列でないとき nodes を参照。`ship.lineItems?.nodes` も配列として扱う。API の返し方の違いに対応。 |
| **履歴「未確定：1」** | shipments の正規化で **node（単数）** を `[t.shipments.node]` に変換。1件だけのときも未確定件数が表示される。 |
| **履歴の setHistoryTransfers** | `setHistoryTransfers(Array.isArray(result?.transfers) ? result.transfers : [])` で配列のみ渡す。 |

### 3.3 ModalOutbound にのみ存在する機能（REFERENCE にはない）

| 項目 | 内容 |
|------|------|
| **OutboundShipmentSelection（配送一覧）** | 配送準備完了の Transfer を開いたときのシップメント一覧。仮想行（#T0127-L）・実 Shipment（#T0127-1, #T0127-2...）。左：戻る、中央：再読込、右：キャンセル。キャンセル確認モーダル。REFERENCE にはこの画面がない。 |
| **仮想行** | READY_TO_SHIP かつ lineItems を持つ Transfer の「発送準備完了」相当の行。`__transfer__${transferId}`、ラベル #T0127-L。タップ時は Transfer の lineItems のみ表示。 |
| **複数シップメント追加・編集** | addingShipmentToTransferId・編集モード（historyFromShipmentSelection 経由）での確定/下書きの2種。createInventoryShipmentInTransit / createInventoryShipmentDraft / inventoryTransferSetItems の使い分け。REFERENCE には addingShipmentToTransferId がなく、このモードは未実装。 |
| **配送情報モーダル** | OutboundList ヘッダーの「配送情報」ボタン。コンディションと同様の配送業者・配送番号・到着予定日入力。 |
| **在庫更新・再読込表記** | 「在庫再取得」→「在庫更新」、「再取得」→「再読込」に統一（要件書 2026-02）。 |
| **goBackFromOutboundHistoryDetail** | 履歴詳細から戻る際に履歴選択状態をクリア。リストに戻ったあと別IDを開いても前の詳細が残らない。 |

---

## 4. 要件書との対応

- **OUTBOUND_CONFIRM_FLOWS.md**: ①新規・②単一編集・③複数追加・④複数編集の「確定する」「下書き保存」「配送準備完了にする」の扱い → ModalOutbound で実装済み。③④は「確定」「下書き」の2種のみ。✅  
- **OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md**: マルチシップメント挙動・確定/下書き2種・編集モーダルから「シップメントを確定」削除 → ModalOutbound で反映済み。✅  
- **仮想行・配送情報・確定2種・在庫更新・シップメントID**（REQUIREMENTS_FINAL.md 直近更新）→ 上記のとおり ModalOutbound に実装済み。✅  
- **配送一覧フッター・キャンセル確認モーダル・履歴から詳細を開くときのフッター** → ModalOutbound で対応済み。✅  

REFERENCE は「出庫の参照用のひとつのスナップショット」であり、編集確定・複数シップメント・配送一覧・仮想行は含まれていない。それらは要件書と ModalOutbound 側で追加・整備されたもので、**ModalOutbound は REFERENCE と相違なくというより、REFERENCE の出庫をベースに要件を満たすように拡張されている**。

---

## 5. まとめ

- **確定処理**: ModalOutbound は ①新規・②編集・③複数追加 を実装し、確定モーダルも③④のとき「確定する」「下書き保存」の2種のみで要件と一致。REFERENCE は①のみで、②③は未実装。
- **確定処理以外**: ゲート・在庫有効化・新規作成フロー・モーダルUI・コンディション・履歴・履歴詳細は REFERENCE と同等。商品リスト読み込み・履歴「未確定：1」・sid/lineItems 正規化は ModalOutbound で分割・API 対応が入っている。仮想行・配送一覧・複数シップメント・配送情報モーダル・再読込表記は ModalOutbound のみの拡張で、不足はない。

**結論**: Modal_REFERENCE.jsx と ModalOutbound.jsx の関係は「相違なく」ではなく、**ModalOutbound が REFERENCE の出庫部分を包含し、確定処理（①〜③）とその他コードを要件どおりに実装・拡張している**。確定処理もそれ以外も、不足や後退はなく、REFERENCE にない機能はすべて ModalOutbound 側で追加されている。
