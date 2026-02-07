# 4タイル分割 vs 元実装の差分確認

**最終更新**: 2026年2月

---

## 1. 実施した変更（今回）

- **棚卸**: 「（現在のロケーションで作成された棚卸のみ表示されます）」の文言を削除しました。
- 棚卸一覧の空メッセージは、タブ別・件数有無に応じた案内のみ表示します。

---

## 2. ロケーション取得について

- **元実装・4タイル共通**: POS の **Session API** の `currentSession.locationId` を参照しています。
  - 出庫タイル: `modalHooks.js` の `useSessionLocationId()` → `SHOPIFY?.session?.currentSession?.locationId`
  - 入庫・ロス・棚卸: 各拡張内の `useSessionLocationId()` で同じく `globalThis?.shopify?.session?.currentSession?.locationId` を参照。
- **公式**: [Session API](https://shopify.dev/docs/api/pos-ui-extensions/2025-04/apis/session-api) で `currentSession` に `locationId` が含まれるとされています。
- **取得できない場合**: `locationGid` が `null` になり、棚卸・ロスでは「ロケーションでフィルタしない＝全件表示」の動きになります（既存の fallback のまま）。
- それでも「店舗が読み込めていない」「リストが空のまま」になる場合は、POS 側でセッションが渡るタイミングや、拡張読み込み順の影響の可能性があります。その場合は POS のバージョンや、タイルを開くタイミングを変えての再現確認が有効です。

---

## 3. 4タイル vs 元実装の対応関係と差分

| 機能 | 元実装の場所 | 4タイル後の場所 | 差分・備考 |
|------|--------------|------------------|------------|
| **出庫** | tile `Modal.jsx` + `OutboundListScreen.jsx` + `OutboundHistoryScreens.jsx` 等 | 同じ（tile 内）。メニュー削除・出庫コンディション起点に変更 | 入庫関連を tile から削除。出庫フローは元実装を維持。 |
| **入庫** | tile `Modal.jsx`（InboundConditions, InboundShipmentSelection, InboundList） | `stock-transfer-inbound`（Modal + InboundShipmentSelection + InboundListScreen） | 入庫リストは「最小実装」（1シップメント読込・明細・確定・下書き復元）。tile の InboundList の完全版（予定外入荷・複数シップ・バリアント検索等）は未移植。 |
| **ロス** | tile `Modal.jsx` または `Screens.jsx` の LossConditions / LossProductList / LossHistoryList | `stock-transfer-loss`（LossScreen + LossConditions + LossProductList + LossHistoryList） | ロス専用に分離。棚卸は loss から削除。ロスの棚卸コンディション（InventoryCountConditions）は **厳密一致** `c.locationId === locationGid` のまま。 |
| **棚卸** | tile 内の StocktakeScreen / InventoryCountConditions / InventoryCountList 等 | `stock-transfer-stocktake`（同構成で棚卸専用拡張） | 棚卸専用に分離。ロケーション比較は **数値ID・GID 両対応**（`toLocationNumericId`）＋「フィルタ結果 0 件なら全件表示」の fallback を実装。 |

---

## 4. ロケーション比較の違い（棚卸 vs ロス）

- **棚卸拡張**（`stock-transfer-stocktake`）  
  - `toLocationNumericId` / `toLocationGid` で正規化し、数値ID と GID が混在していても一致するように比較。  
  - フィルタ結果が 0 件かつ全件数 > 0 のときは、全件表示に切り替える fallback あり。
- **ロス拡張**（`stock-transfer-loss`）の棚卸コンディション  
  - `c.locationId === locationGid` の **厳密一致** のみ。  
  - 保存データの `locationId` とセッションの `locationGid` の形式が違うと一覧に出ません。  
  必要であれば、棚卸拡張と同様に「数値ID・GID 正規化 ＋ 0 件時は全件表示」に揃えると、元の「店舗で絞りつつ見えなくならない」動きに近づきます。

---

## 5. 今後の確認ポイント

- **出庫**: コンディション → 一覧 → 履歴の流れと、閉じるボタンが元と同じか。
- **入庫**: コンディション → シップメント選択 or まとめて表示 → 入庫リスト → 確定まで、元と同じ操作で完了するか。表示遅延や「完全版」の機能が必要なら、tile の InboundList の移植を検討。
- **ロス**: コンディション → 商品リスト → 確定・履歴。ロケーションや店舗名が元どおり出ているか。
- **棚卸**: コンディションで棚卸ID一覧・店舗名が表示され、リスト・商品グループ選択・カウント入力〜確定まで元と同じか。ロケーションが取れていない場合は、上記「ロケーション取得」を参照して原因切り分け。

---

## 6. まとめ

- 文言「（現在のロケーションで作成された棚卸のみ表示されます）」は削除済みです。
- ロケーションは元実装と同じく `session.currentSession.locationId` を参照しており、取得できない場合は「ロケーションで絞らない」動きになります。
- 4タイル分割後も、出庫・ロス・棚卸の**処理の流れは元実装を踏襲**しています。入庫のみ「最小実装」のため、必要に応じて tile の InboundList 完全版の移植で差を埋められます。
- ロス拡張の棚卸コンディションは、棚卸拡張と同じロケーション比較（正規化＋0件時全件表示）に揃えると、4分割前の挙動に近づきます。
