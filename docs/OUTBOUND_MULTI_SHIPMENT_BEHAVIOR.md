# 出庫 複数シップメント 挙動整理（要件確定版）

## 0. 公式 API 確認結果（Shopify Admin GraphQL に基づく要件の確定）

以下は [Shopify Admin API](https://shopify.dev/docs/api/admin-graphql) の公式ドキュメントに基づく確認結果である。これに合わせて要件を確定する。

### 0.1 既存 Transfer にシップメントを追加

| 項目 | 公式上の結論 | 使用 API |
|------|--------------|----------|
| 既存 Transfer にシップメントを追加できるか | **可能** | `inventoryShipmentCreate` |
| Input | `InventoryShipmentCreateInput` の **`movementId`** に **Transfer の ID** を指定する。「The ID of the inventory movement (transfer or purchase order) this shipment belongs to.」 |
| 作成されるシップメントの状態 | **DRAFT**（下書き） | `inventoryShipmentCreate` は "Adds a **draft** shipment to an inventory transfer." |
| 確定（出庫）として追加する場合 | **可能** | `inventoryShipmentCreateInTransit` で同一 `movementId` に **IN_TRANSIT** のシップメントを追加できる |

**確定要件**: 「シップメントを追加」では **既存の `transferId` を `movementId` に渡し、`inventoryShipmentCreate`（下書き）または `inventoryShipmentCreateInTransit`（確定）で追加する。新規 Transfer は作らない。

### 0.2 READY_TO_SHIP を下書き（DRAFT）に戻す

| 項目 | 公式上の結論 |
|------|--------------|
| Transfer を READY_TO_SHIP → DRAFT に戻す Mutation | **存在しない** |
| 利用可能な Transfer 関連 Mutation | `inventoryTransferCreate`, `inventoryTransferCreateAsReadyToShip`, `inventoryTransferMarkAsReadyToShip`, `inventoryTransferEdit`, `inventoryTransferSetItems`, `inventoryTransferRemoveItems`, `inventoryTransferCancel`, `inventoryTransferDuplicate` のみ。**逆方向（READY_TO_SHIP → DRAFT）の API はなし** |

**確定要件**: **配送準備完了（READY_TO_SHIP）の編集時は「下書き保存」を非表示にする。**（API が下書きに戻せないため。）

### 0.3 明細の更新（配送準備完了のまま保存）

| 項目 | 公式上の結論 |
|------|--------------|
| READY_TO_SHIP の Transfer で lineItems を更新できるか | **可能** | `inventoryTransferSetItems` は DRAFT および READY_TO_SHIP の Transfer で利用可能（公式ドキュメント・ユーザーエラー仕様上）。 |
| 挙動 | "Will replace the items already set, if any." ＝ Transfer にセットされている lineItems をまとめて置き換え。 |

**確定要件**: 編集モードで「配送準備完了にする」＝ **`inventoryTransferSetItems`** で明細を反映し、Transfer は READY_TO_SHIP のまま維持する。Shipment は作らない。

### 0.4 シップメントのステータスと「シップメント単位の下書き」

| 項目 | 公式上の結論 |
|------|--------------|
| InventoryShipmentStatus | **DRAFT**, **IN_TRANSIT**, PARTIALLY_RECEIVED, **RECEIVED**, OTHER |
| シップメント単位の下書き | 既存 Transfer に **`inventoryShipmentCreate`** で **DRAFT** シップメントを追加できる ＝ **シップメント単位の下書き保存は可能** |
| 既に READY_TO_SHIP / IN_TRANSIT 等のシップメントを「下書きに戻す」 | **API に存在しない**（Shipment 用の revert 系 Mutation はなし） |

**確定要件**:  
- 「シップメントを追加」で**下書き保存** → **`inventoryShipmentCreate`**(`movementId`: 既存 transferId, lineItems) で同じ Transfer に DRAFT シップメントを追加。  
- **編集対象が READY_TO_SHIP の Transfer または既に確定済み（IN_TRANSIT 等）のシップメントの場合**は、下書きに戻せないため「下書き保存」を**非表示**にする。  
- シップメントリストでは各シップメントの **status**（DRAFT / IN_TRANSIT / RECEIVED 等）を表示する。

### 0.5 Transfer ステータス（参考）

- **InventoryTransferStatus**: DRAFT, READY_TO_SHIP, IN_PROGRESS, TRANSFERRED, CANCELED, OTHER  
- 遷移: DRAFT → READY_TO_SHIP（`inventoryTransferMarkAsReadyToShip`）→ シップメント確定等で IN_PROGRESS → 受領完了で TRANSFERRED。**READY_TO_SHIP → DRAFT の逆遷移は API なし。**

### 0.6 参照 URL（公式）

- [InventoryTransfer](https://shopify.dev/docs/api/admin-graphql/latest/objects/inventorytransfer)  
- [InventoryShipment](https://shopify.dev/docs/api/admin-graphql/latest/objects/inventoryshipment)  
- [inventoryShipmentCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryShipmentCreate)（`movementId` = Transfer ID）  
- [inventoryShipmentCreateInTransit](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryShipmentCreateInTransit)  
- [InventoryShipmentCreateInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryShipmentCreateInput)（`movementId`, lineItems 等）  
- [inventoryTransferSetItems](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryTransferSetItems)（DRAFT / READY_TO_SHIP で利用可）  
- [InventoryTransferStatus](https://shopify.dev/docs/api/admin-graphql/latest/enums/InventoryTransferStatus)  
- [InventoryShipmentStatus](https://shopify.dev/docs/api/admin-graphql/latest/enums/InventoryShipmentStatus)

---

## 1. シップメントを追加時の前提（重要）

- **既存の Transfer ID を必ず引き継ぐ**
- 新規シップメントは「同じトランスファー（既存 READY_TO_SHIP の Transfer）」に紐づく形で作成する
- **新規 Transfer を作成してはいけない** → **既存 Transfer にシップメントを追加**する流れにする

### 実装時の注意（公式 API に基づき確定）

- 履歴一覧の「編集」→「シップメントを追加」で OutboundList を開く際、**既存の `transferId` を state に必ず渡す**（`addingShipmentToTransferId` など）。確定時は **`inventoryShipmentCreate`** の **`movementId`** にこの ID を渡す。
- OutboundList 側で「新規」「編集」「シップメント追加」の 3 パターンを state で区別する（§0 の API に合わせて実装する）。

---

## 2. OutboundList 確定モーダル：3 ボタンの役割

確定モーダルには次の 3 選択肢がある:

| 選択肢 | 役割（概要） |
|--------|----------------|
| **確定する** | 在庫ゲート通過後、Shipment 作成 or 更新しつつ出庫確定（トランスファー確定） |
| **下書き保存** | 新規作成時などに表示。Draft の作成 or 既存 Draft の明細更新 |
| **配送準備完了にする** | Shipment を作らず、Transfer を DRAFT → READY_TO_SHIP にする（明細だけ反映） |

---

## 3. モード別：ボタン表示と挙動一覧

OutboundList を「新規」「シップメントを編集」「シップメントを追加」のどれで開いたかで、**どのボタンを表示するか**と**押したときの挙動**を整理する。

### 3.0 一覧（表示ルール・挙動）【公式 API に基づき確定】

| モード | 確定する | 配送準備完了にする | 下書き保存 |
|--------|----------|--------------------|------------|
| **新規** | 表示・新規 Transfer を作成して確定 | 表示・新規 Transfer を READY_TO_SHIP で作成 | **表示**・Draft 作成 or 既存 Draft 更新 |
| **シップメントを編集** | 表示・そのシップメントの明細更新＋**そのシップメントのみ確定**（トランスファーは未確定のまま） | **表示**・`inventoryTransferSetItems` で明細を反映し **READY_TO_SHIP のまま維持**（§0.3） | **編集対象が DRAFT のときのみ表示**。**READY_TO_SHIP または確定済みのときは非表示**（§0.2：API で下書きに戻せない） |
| **シップメントを追加** | 表示・**既存 Transfer ID を `movementId` に渡し** `inventoryShipmentCreateInTransit` で新シップメントを確定（§0.1） | 表示・既存 Transfer に新シップメント分を追加して READY_TO_SHIP 維持（例: `inventoryShipmentCreate` で DRAFT 追加等） | 表示・**`inventoryShipmentCreate`**（`movementId`: 既存 transferId）で同じ Transfer に DRAFT シップメントを追加（§0.4） |

### 3.0.1 下書き保存の表示ルール（編集モード・複数シップメント）【公式 API に基づき確定】

- **編集モードで「下書き保存」を表示する条件**
  - **編集対象が DRAFT の Transfer / シップメント** → **表示**（再度下書き保存したい想定。`inventoryTransferSetItems` 等で明細更新）。
  - **編集対象が READY_TO_SHIP の Transfer、または既に IN_TRANSIT / RECEIVED 等のシップメント** → **非表示**（§0.2・§0.4：**API に READY_TO_SHIP → DRAFT や Shipment の下書き戻しは存在しない**）。
- **複数シップメントのトランスファー**
  - **シップメント単位の下書き**は **`inventoryShipmentCreate`** で可能（§0.4）。シップメントリストで各シップメントの **status**（DRAFT / IN_TRANSIT / RECEIVED 等）を表示する。
  - 一つのシップメントが配送準備完了（READY_TO_SHIP の Transfer に属する）や確定（IN_TRANSIT 等）している場合、そのシップメントを「下書きに戻す」API はないため、**その編集時は「下書き保存」を非表示**にする。

### 3.1 シップメントを編集（既存 READY_TO_SHIP の 1 シップメントを編集）【公式 API に基づき確定】

| ボタン | 表示 | 挙動（使用 API） |
|--------|------|------------------|
| **確定する** | ✅ | そのシップメントの明細を更新し、在庫ゲート通過後**そのシップメントのみ**出庫確定（Shipment の作成 or 更新。例: `inventoryShipmentCreateInTransit` や既存 Shipment の `inventoryShipmentUpdateItemQuantities` 等）。**トランスファー自体は未確定のまま**（§4 参照）。 |
| **配送準備完了にする** | ✅ | **「まだ準備完了のまま保存したい」用**。**`inventoryTransferSetItems`** で編集内容（明細）を反映し、**Transfer は READY_TO_SHIP のまま維持**（§0.3）。Shipment は作らず、在庫も動かさない。 |
| **下書き保存** | ❌（READY_TO_SHIP 編集時） | **編集対象が READY_TO_SHIP の Transfer または確定済みシップメントのときは非表示**（§0.2：READY_TO_SHIP → DRAFT に戻す API なし）。**編集対象が DRAFT のときのみ表示**し、`inventoryTransferSetItems` 等で明細だけ保存。 |

**補足（編集モードのトランスファー確定について）**

- 「確定する」は**そのシップメント単位**の確定（在庫控除・Shipment 作成/更新等）。トランスファー全体の確定は別タイミング（§4 参照）。

### 3.2 シップメントを追加（既存 Transfer に新シップメントを追加）【公式 API に基づき確定】

| ボタン | 表示 | 挙動（使用 API） |
|--------|------|------------------|
| **確定する** | ✅ | **既存 Transfer ID を `movementId` に渡し**、**`inventoryShipmentCreateInTransit`** でこの商品リストを「新シップメント」として **IN_TRANSIT** で追加し、出庫確定とする（§0.1）。既存の他シップメントはそのまま。 |
| **配送準備完了にする** | ✅ | 新シップメント分を既存 Transfer に反映し READY_TO_SHIP を維持。例: **`inventoryShipmentCreate`**（`movementId`: 既存 transferId）で **DRAFT** シップメントを追加する等。Transfer は READY_TO_SHIP のまま。 |
| **下書き保存** | ✅ | **`inventoryShipmentCreate`**（**`movementId`**: 既存 transferId, **lineItems**）で、同じ Transfer に **DRAFT** シップメントを追加（§0.1・§0.4）。のちに確定する場合は当該 Shipment に対して `inventoryShipmentMarkInTransit` 等を使用。 |

### 3.3 出庫履歴リストの「編集」：モーダルは「編集」と「追加」の 2 つのみ【シンプル化】

履歴リストで「編集」を押したときに開くモーダルから**「シップメントを確定」は不要**とする。モーダルは **「編集」** と **「追加」** の 2 つのみとし、**編集から確定** または **追加して確定** のいずれかで、**確定した時点でトランスファーが確定される**（トランスファー確定）ようにする。シンプルな流れにする。

| モーダルの選択肢 | 挙動 |
|------------------|------|
| **編集** | 詳細（OutboundHistoryDetail）へ遷移し、詳細から OutboundList を開いて編集。OutboundList の「確定する」を押すと **トランスファーが確定される**。 |
| **追加** | OutboundList を「シップメントを追加」モードで開く。OutboundList の「確定する」を押すと新シップメントを追加し **トランスファーが確定される**。 |

**「シップメントを確定」ボタンは廃止**  
- モーダルに「シップメントを確定」は出さない。確定は **編集 → OutboundList → 確定する** または **追加 → OutboundList → 確定する** のどちらかで行い、その時点でトランスファーが確定される。

### 3.4 シップメントが 1 つ vs 2 つ以上（編集時の遷移先）

編集を選んだあと、**そのトランスファーにシップメントが 1 つか 2 つ以上か**で遷移先を切り分ける。

| ケース | 挙動 |
|--------|------|
| **シップメントが 1 つだけ**（または Shipment がまだなく Transfer の lineItems だけ） | **編集** → 詳細へ遷移 → 詳細から「編集」で OutboundList を開く。**確定する** ＝ その 1 シップメント（または Transfer 全体）を確定し、**トランスファーが確定される**。 |
| **シップメントが 2 つ以上** | **編集** → 詳細へ遷移し、詳細で**シップメント一覧**を表示。ユーザーが**編集したいシップメントを 1 つ選択**してから OutboundList を開く。**確定する** ＝ 選択したその 1 シップメントを確定し、**トランスファーが確定される**（API 上はその Shipment を IN_TRANSIT 等にし、Transfer の status は API に従う）。 |

---

## 4. 複数シップメント出庫の流れ：確定する ＝ トランスファーが確定される【シンプル化】

**方針**: 「確定する」を押した時点で**トランスファーが確定される**（出庫確定として扱う）ようにする。モーダルに「シップメントを確定」は出さず、**編集から確定** or **追加して確定**のどちらかで確定し、その時点でトランスファー確定とする（§3.3）。

1. **Transfer は 1 つ**（READY_TO_SHIP で作成、または既存の READY_TO_SHIP の Transfer に **`inventoryShipmentCreate`** / **`inventoryShipmentCreateInTransit`** でシップメントを追加）。
2. **編集 or 追加 → OutboundList → 「確定する」**
   - 「確定する」を押すと、その編集/追加内容で出庫確定（在庫控除・Shipment 作成/更新等）を行い、**トランスファーが確定される**（API 上は Transfer の status が IN_PROGRESS 等に更新される流れに合わせる）。
3. **複数シップメントがある場合**
   - 詳細でシップメント一覧から**編集対象を 1 つ選んで** OutboundList を開き、「確定する」＝その 1 シップメントを確定し、トランスファー確定。全シップメントを順に確定する場合は、同じ流れを繰り返すか、詳細に「全シップメントを確定」を用意するかは要件次第（§3.4）。
   - 公式の **InventoryTransferStatus** は DRAFT → READY_TO_SHIP → **IN_PROGRESS**（シップメントが IN_TRANSIT 等）→ **TRANSFERRED**（受領完了）。**確定する**＝出庫確定を行い、Transfer の status は API に従って更新される（§0.5 参照）。

---

## 5. 実装時のチェックリスト【公式 API に基づき確定】

- [ ] **シップメントを追加**で OutboundList を開くときに、**既存の `transferId` を必ず渡している**（新規 Transfer を作らない）。確定時は **`inventoryShipmentCreate`** / **`inventoryShipmentCreateInTransit`** の **`movementId`** にこの ID を渡す。
- [ ] OutboundList で「新規」「編集」「シップメント追加」の 3 パターンを state で区別している（`editingTransferId` / `addingShipmentToTransferId`）。
- [ ] 確定モーダル: **編集**時は「配送準備完了にする」**表示**（`inventoryTransferSetItems` で READY_TO_SHIP のまま明細更新）。**下書き保存**は**編集対象が DRAFT のときのみ表示**、**READY_TO_SHIP または確定済みのときは非表示**（§0.2）。
- [ ] 編集対象の Transfer / Shipment ステータスに応じて「下書き保存」の表示/非表示を切り分け（READY_TO_SHIP または IN_TRANSIT 等の編集時は非表示）。
- [ ] シップメント追加時の「確定する」＝**`inventoryShipmentCreateInTransit`**（`movementId`: 既存 transferId）、「下書き保存」＝**`inventoryShipmentCreate`**（`movementId`: 既存 transferId）。「配送準備完了にする」＝既存 Transfer に DRAFT シップメント追加等で READY_TO_SHIP 維持。
- [ ] シップメントリストで各シップメントの **status**（DRAFT / IN_TRANSIT / RECEIVED 等）を表示する。
- [ ] **確定する**＝**トランスファーが確定される**（編集から確定 or 追加して確定のいずれも、確定した時点でトランスファー確定）。§3.3・§4。
- [ ] **出庫履歴の「編集」モーダル**：「シップメントを確定」は**廃止**。モーダルは**「編集」と「追加」の 2 つのみ**。§3.3。
- [ ] **出庫履歴の「編集」**：シップメントが **1 以下**のときはそのまま詳細→編集→確定。**2 以上**のときは詳細で**シップメント一覧を表示**し、**編集対象の 1 シップメントを選択**してから OutboundList を開き、「確定する」＝その 1 シップメントを確定しトランスファー確定（§3.4）。

---

## 6. 参照

- **公式 API**: §0.6 の URL（InventoryTransfer, InventoryShipment, inventoryShipmentCreate, inventoryShipmentCreateInTransit, inventoryTransferSetItems 等）
- 入庫の複数シップメント: 履歴一覧の「リスト」ボタン・シップメント選択モーダル・InboundList の複数 Shipment 表示
- OutboundList 確定モーダル: `CONFIRM_TRANSFER_MODAL_ID`、`editingTransferId`、`addingShipmentToTransferId`、`createTransferAsReadyToShipOnly`、`inventoryTransferSetItemsSafe`
- MULTI_SHIPMENT_DESIGN.md: Transfer ステータス・複数 Shipment の設計方針
