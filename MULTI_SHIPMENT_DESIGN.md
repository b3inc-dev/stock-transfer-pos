# 複数Shipment対応 設計方針

## 📋 現状分析

### 現在の実装状況
1. **Transferステータス**: `READY_TO_SHIP` で作成（`inventoryTransferCreateAsReadyToShip`）
2. **Shipment作成**: 1つのみ（tracking情報がある場合のみ）
3. **入庫処理**: `pickShipmentIdFromTransfer` で最初の未受領Shipmentを自動選択
4. **複数Shipment対応**: 未実装（shipments配列は取得しているが、UIで明示的に扱っていない）

### 問題点
- 複数Shipmentがある場合、どのShipmentを処理しているか不明確
- 出庫時に複数配送に分割できない
- 入庫時に複数Shipmentを同時に処理できない

---

## 🎯 理想的な方向性

### 1. 配送準備完了ステータス（READY_TO_SHIP）について

#### ✅ **推奨: READY_TO_SHIPは維持すべき**

**理由:**
1. **Shopifyの標準フロー**: `READY_TO_SHIP` → `IN_TRANSIT` → `RECEIVED` → `TRANSFERRED` という明確なステータス遷移
2. **在庫管理の明確性**: 
   - `READY_TO_SHIP`: 出庫準備完了（在庫はまだ出庫元にある）
   - `IN_TRANSIT`: 配送中（在庫は移動中）
   - `RECEIVED`: 受領済み（在庫は宛先にあるが未確定）
   - `TRANSFERRED`: 入庫確定（在庫が正式に宛先に移った）
3. **複数Shipment対応**: 各Shipmentが個別にステータスを持つため、部分的な受領も追跡可能
4. **既存実装との整合性**: 現在のコードが既に`READY_TO_SHIP`前提で実装されている

**結論**: `READY_TO_SHIP`は必要。複数Shipment対応でもこのステータスを維持する。

---

### 2. 複数Shipment対応の設計方針

#### Phase 1: 複数Shipmentの読み込み・表示 ✅ 最優先

**実装内容:**
1. **入庫一覧での表示**
   ```javascript
   // 例: "シップメント数: 3" を表示
   const shipmentCount = transfer.shipments?.length || 0;
   if (shipmentCount > 1) {
     // "シップメント数: 3" を表示
   }
   ```

2. **Shipment選択画面の追加**
   - Transfer選択後、Shipmentが2つ以上ある場合のみ表示
   - 各Shipmentの情報を表示:
     - Shipment ID（短縮表示: #T0000-1, #T0000-2）
     - ステータス（IN_TRANSIT, RECEIVED等）
     - 追跡情報（あれば）
     - 明細数・数量サマリー
   - 1つしかない場合は自動スキップ

3. **履歴詳細での全Shipment表示**
   - 1画面内に全Shipmentを表示
   - 各Shipmentをタイトルで区切る（例: "配送1（#T0000-1）"）
   - 各Shipmentの明細を個別に表示

**実装のポイント:**
- 後方互換性を保つ（Shipmentが1つの場合は既存の動作を維持）
- Shipmentの命名規則を統一（Transfer名 + 連番）

---

#### Phase 2: 出庫処理での複数Shipment作成 ✅ 推奨

**実装内容:**
1. **「配送分割」オプションの追加**
   - 出庫確定モーダルにチェックボックス「配送を分割する」
   - デフォルトはOFF（既存動作を維持）

2. **分割方法の選択**
   - **手動分割**: ユーザーが明細をドラッグ&ドロップで振り分け
   - **配送先ごと**: 複数宛先がある場合（現状は1宛先のみなので将来対応）
   - **配送方法ごと**: 配送会社が異なる場合（現状は1配送会社のみなので将来対応）
   - **数量分割**: 同一商品を複数Shipmentに分割（例: 100個 → 50個×2）

3. **各Shipmentへのtracking情報設定**
   - 分割後、各Shipmentごとにtracking情報を個別設定
   - 一括設定オプションも提供（全Shipmentに同じ情報を適用）

**実装のポイント:**
- 分割UIはシンプルに（POS環境を考慮）
- 分割後の各Shipmentは個別に`inventoryShipmentCreateInTransit`で作成
- Transferは1つのまま（複数Shipmentを持つ1つのTransfer）

**注意点:**
- 現時点では「手動分割」のみ実装し、他の分割方法は将来対応でも可
- 分割UIはタッチ操作に最適化

---

#### Phase 3: 入庫処理での複数Shipment処理 ✅ 推奨

**実装内容:**
1. **複数Shipment選択機能**
   - Shipment選択画面でチェックボックスを追加
   - 複数選択可能にする
   - 選択状態を視覚的に表示

2. **統合表示**
   - 選択した全ShipmentのlineItemsを1画面に統合表示
   - 各Shipmentをタイトルで区切る（例: "配送1（#T0000-1）"）
   - 同一商品はマージ表示（Shipmentごとの数量も表示）

3. **一括受領処理**
   - 選択した全Shipmentを同時に受領
   - 各Shipmentごとに`inventoryShipmentReceive`を実行
   - エラーが発生した場合は、成功したShipmentと失敗したShipmentを明確に表示

**実装のポイント:**
- 部分的な成功も許容（一部Shipmentの受領失敗があっても、成功した分は処理）
- 受領結果を明確に表示（どのShipmentが成功/失敗したか）
- 監査ログにも複数Shipment情報を記録

---

## 🔄 実装順序の推奨

### ステップ1: Phase 1（最優先）✅
**理由:**
- 既存の複数Shipmentデータを正しく表示できるようにする
- ユーザーが「どのShipmentを処理しているか」を明確にする
- 他のPhaseの基盤となる

**実装期間**: 1-2週間

### ステップ2: Phase 3（次優先）✅
**理由:**
- 入庫処理の効率化（複数Shipmentを一度に処理）
- 実務でよく使われる機能
- Phase 2より実装が簡単

**実装期間**: 2-3週間

### ステップ3: Phase 2（将来対応）⚠️
**理由:**
- 出庫時の分割は複雑（UI設計が難しい）
- 現時点では需要が低い可能性
- Phase 1, 3が動いてから検討

**実装期間**: 3-4週間（分割UIの設計次第）

---

## 💡 設計上の考慮事項

### 1. Shipment命名規則
```javascript
// 推奨: Transfer名 + 連番
// 例: Transfer名が "T0000" の場合
// - Shipment 1: "#T0000-1"
// - Shipment 2: "#T0000-2"
// - Shipment 3: "#T0000-3"

function formatShipmentLabel(transferName, index) {
  const base = transferName || "T0000";
  return `#${base}-${index + 1}`;
}
```

### 2. ステータス管理
- Transferステータス: 全Shipmentの状態を反映
  - 全Shipmentが`RECEIVED` → Transferは`TRANSFERRED`に近い状態
  - 一部Shipmentが`IN_TRANSIT` → Transferは`IN_PROGRESS`
- Shipmentステータス: 個別に管理
  - 各Shipmentは独立してステータス遷移

### 3. エラーハンドリング
- 複数Shipment受領時の部分失敗を許容
- 成功/失敗を明確に表示
- 失敗したShipmentは再試行可能にする

### 4. パフォーマンス
- 複数ShipmentのlineItems取得は並列処理
- 大量のShipmentがある場合はページネーション検討
- 軽量モード（liteMode）でも動作するように

---

## 📝 実装チェックリスト

### Phase 1: 複数Shipmentの読み込み・表示
- [ ] 入庫一覧でShipment数を表示
- [ ] Shipment選択画面の実装（2つ以上の場合のみ）
- [ ] 履歴詳細で全Shipmentを表示
- [ ] Shipmentのラベル表示（#T0000-1形式）
- [ ] 後方互換性の確認（Shipmentが1つの場合）

### Phase 2: 出庫処理での複数Shipment作成
- [ ] 「配送分割」オプションの追加
- [ ] 手動分割UIの実装
- [ ] 分割後の各Shipment作成処理
- [ ] 各Shipmentへのtracking情報設定
- [ ] 分割結果の確認画面

### Phase 3: 入庫処理での複数Shipment処理
- [ ] Shipment選択画面で複数選択機能
- [ ] 選択したShipmentのlineItems統合表示
- [ ] 一括受領処理の実装
- [ ] 受領結果の表示（成功/失敗）
- [ ] 監査ログへの複数Shipment情報記録

---

## 🎯 結論

### 推奨される実装方針

1. **READY_TO_SHIPステータスは維持** ✅
   - Shopifyの標準フローに沿う
   - 在庫管理が明確
   - 複数Shipment対応でも有効

2. **実装順序**
   - **Phase 1（最優先）**: 複数Shipmentの読み込み・表示
   - **Phase 3（次優先）**: 入庫処理での複数Shipment処理
   - **Phase 2（将来対応）**: 出庫処理での複数Shipment作成

3. **設計原則**
   - 後方互換性を保つ
   - シンプルなUI（POS環境を考慮）
   - エラーハンドリングを充実
   - パフォーマンスを考慮

この方針で進めることで、段階的に複数Shipment対応を実現でき、既存機能を壊すことなく拡張できます。
