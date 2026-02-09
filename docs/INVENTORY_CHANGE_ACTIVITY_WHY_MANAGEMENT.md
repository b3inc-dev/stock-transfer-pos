# 在庫変動履歴で「ロス以外が全て管理になる」要因

**作成日**: 2026年2月  
**対象**: 在庫情報画面の「在庫変動履歴」タブで表示されるアクティビティ種別

---

## 実装の所在（過去の「ロス軸で他も正しく処理」対応）

「ロスを軸に他アクティビティも正しく記録する」ための実装は次のとおりです。

| 役割 | ファイル・内容 |
|------|----------------|
| **POS から種別を送る共通処理** | `extensions/common/logInventoryChange.js` の `logInventoryChangeToApi`。`sourceId` が無くても API を呼ぶ（条件から外済み）。 |
| **API（種別上書き）** | `app/routes/api.log-inventory-change.tsx`。直近の同一 item・location の「管理」行を検索し、受け取った `activity` で上書きする。 |
| **入庫** | `extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx` で `logInventoryChangeToApi({ activity: "inbound_transfer", ... })` を呼ぶ箇所が複数。 |
| **出庫** | `extensions/stock-transfer-tile/src/ModalOutbound.jsx` で `logInventoryChangeToApi({ activity: "outbound_transfer", ... })` を呼ぶ。 |
| **ロス** | `extensions/stock-transfer-loss/src/screens/loss/LossProductList.jsx` で `logInventoryChangeToApi({ activity: "loss_entry", ... })` を呼ぶ。Webhook では種別を設定しないため、ロスも他と同様「API で上書き」の1本。 |
| **棚卸** | `extensions/stock-transfer-stocktake/src/screens/stocktake/InventoryCountList.jsx` で `logInventoryChangeToApi` を呼ぶラッパー使用。 |
| **仕入** | `extensions/stock-transfer-purchase/` の `PurchaseProductList.jsx` と `PurchaseHistoryList.jsx` で `logInventoryChangeToApi({ activity: "purchase_entry", ... })` を呼ぶ。 |
| **Webhook（まず「管理」で保存）** | `app/routes/webhooks.inventory_levels.update.tsx`。adjustment_group が無い場合は `admin_webhook` で保存し、後から POS の API 呼び出しで上書きされる想定。 |

---

## 現象

- **ロス**（ロス登録）だけは正しく「ロス」と表示される。
- **入庫・出庫・棚卸・売上・返品・発注入庫など**はすべて「管理」と表示される。

---

## 要因（なぜ「管理」になるか）

### 1. 在庫変動の記録元は2つある

| 経路 | いつ動くか | アクティビティの決まり方 |
|------|------------|---------------------------|
| **Webhook** `inventory_levels/update` | Shopify で在庫数が変わるたびに Shopify から呼ばれる | ペイロードに `inventory_adjustment_group_id` が**あれば** GraphQL で種別を取得して設定。**なければ「管理」(admin_webhook)** のまま。 |
| **API** `api/log-inventory-change` | POS 拡張や管理画面のアプリから「この変動は〇〇です」と明示的に送る | リクエストの `activity` をそのまま使う（入庫・出庫・ロス・売上など）。 |

多くの変動は **Webhook だけ** で記録されています。  
そのとき、**Shopify の Webhook ペイロードに `inventory_adjustment_group_id` が含まれない**ことが多く、ID が無いと「どの操作で変わったか」を判別できないため、**デフォルトの「管理」** になります。

### 2. Shopify の Webhook の仕様

- `inventory_levels/update` の公式ペイロードには、多くの場合  
  `inventory_item_id`, `location_id`, `available`, `updated_at`, `admin_graphql_api_id` のみで、  
  **`inventory_adjustment_group_id` は含まれない** ことが多いです。
- そのため、「管理画面で数量を変更した」「注文で減った」「返品で増えた」などは、  
  Webhook 経路ではすべて「種別不明」として **admin_webhook（表示上は「管理」）** になります。

### 3. ロスだけ「ロス」と出ていた理由（2026年2月以降は「同じ処理」に統一）

- **以前**: ロス登録時は Webhook に `inventory_adjustment_group_id` が付くことが多く、Webhook 側で referenceUri から「ロス」と判定して `loss_entry` で保存していました。入庫・出庫・棚卸・仕入は Webhook に ID が付かないため「管理」のままで、API の上書きに依存していました。
- **現在**: **入庫・出庫・ロス・棚卸・仕入をすべて同じ処理にする**ため、Webhook では **adjustment_group の有無にかかわらず種別を判定せず、常に `admin_webhook`（管理）で保存**しています。種別は **すべて** POS/アプリの `api/log-inventory-change` で上書きするため、ロスも他と同じ「API で上書き」の1本の流れになっています。

---

## ロスとその他の違い（まとめ）※現在は「同じ処理」に統一済み

| 項目 | ロス・入庫・出庫・棚卸・仕入（アプリ起因） | 売上・返品・管理画面の手動調整 |
|------|--------------------------------------------|--------------------------------|
| 記録経路 | (1) Webhook がまず `admin_webhook` で保存 (2) POS/アプリが `api/log-inventory-change` で正しい activity に**上書き** | Webhook のみ（売上・返品は各 Webhook で `order_sales` / `refund` を保存）。手動調整は `admin_webhook` のまま。 |
| 種別の決まり方 | **すべて API で上書き**（ロスも他と同じ） | 各 Webhook または「管理」のまま |
| 表示 | ロス・入庫・出庫・棚卸・仕入（API が成功した場合） | 売上・返品・管理 |

---

## ロスと同様の処理（種別上書き）

**入庫・出庫・棚卸・仕入・ロス** は、いずれも「操作後に `api/log-inventory-change` を呼ぶ」ことで、履歴に正しい種別が付きます（ロスと同様の処理）。

1. 在庫が変わると Shopify が Webhook を送り、まず「管理」で 1 件保存される。
2. 続けて POS／管理画面の拡張が `api/log-inventory-change` を呼ぶ（`activity`: 入庫・出庫・ロス・棚卸・仕入など）。
3. API 側で「直近の同一 item・location の『管理』行」を検索し、その行の `activity` を受け取った種別に**上書き**する。

このため、**各操作の確定処理で必ず `api/log-inventory-change` を呼ぶ**ことが、ロスと同様に種別を付ける条件です。  
（入庫: InboundListScreen、出庫: ModalOutbound、ロス: LossProductList、棚卸: InventoryCountList、仕入: PurchaseProductList / PurchaseHistoryList で呼び出し済み。）

### 入庫・出庫・仕入・棚卸と Webhook の違い

- **記録の流れは同じ**です。在庫が変わると (1) Webhook が先に「管理」で 1 件入り、(2) 続けて POS が `api/log-inventory-change` を呼ぶと、その行の種別が入庫・出庫・ロス・棚卸・仕入に**上書き**されます。
- **ロス・入庫・出庫・棚卸・仕入のいずれかが「管理」のまま**のときは、**そのフローの API 呼び出しが 401 などで失敗している**可能性が高いです（ロスも他と同じく API で上書きするため）。  
  - **401 の主な原因**: インストール後しばらく**管理画面でアプリを開いていない**と、オフラインセッションが DB に無く、POS からの API が「Unauthorized」になります。その場合、Webhook で入った「管理」の行だけが残ります。  
  - **確認**: 利用手順で「初回は必ず1回、管理画面でアプリを開く」を案内しているか。Render の Web サービスの **Logs** で `api/log-inventory-change` の 401 や `POS auth failed` が出ていないかを見ると原因を切り分けやすくなります。

### コード上の扱い：ロスと他は同じか（修正済み）

**「ロスは記録されている」なら、初回に管理画面を開いているかどうかはこの問題には関係ありません。** 同じセッションで他フローも動く前提です。

**問題だった可能性がある点（修正済み）**: ロスは **fetch を直書き**しており、`sourceId` が無くても **送信しないという early return がありません**。一方、出庫・入庫・棚卸・仕入で使う **共通関数**（`extensions/common/logInventoryChange.js`）では以前 `if (!sourceId) return;` があり、**sourceId が空のときは API を呼ばずに return していました**。呼び出し元で `sourceId` が未設定・空になるパスがあると、ロスだけ記録されて他が「管理」のままになる原因になります。

**対応（現在のコード）**: 共通関数では **「sourceId が無いと呼ばない」** 条件は**外してあり**、`if (!session?.getSessionToken || !deltas?.length) return;` のみ。**sourceId が無い場合も API は呼ぶ**（body の sourceId は `sourceId || null`）。これでロスと同じく「トークンと変動データがあれば必ず記録を試みる」動きになっています。

- **出庫** `ModalOutbound.jsx` の `logInventoryChangeToApi`: `!sourceId` を条件から削除、body は `sourceId: sourceId || null`
- **入庫** `InboundListScreen.jsx` の `logInventoryChangeToApi`: 同様
- **棚卸** `InventoryCountList.jsx` の `logInventoryCountToApi`: 同様
- **仕入** `PurchaseHistoryList.jsx` の `logPurchaseToApi`: 同様

### なぜロスは直書きで他は共通関数になっているか

コードの履歴上、**「ロスだけ直書き、他は共通関数」と決めた仕様書はありません**。想定される経緯は次のとおりです。

- **ロス**は、拡張 `stock-transfer-loss` の **LossProductList.jsx** 内で、確定処理の直後に「在庫変動ログを直接記録（webhookが来る前に記録）」する目的で、**その場で fetch を直書き**しています。1行ずつループで API を呼ぶ形で実装されたため、共通化されていません。
- **出庫・入庫・棚卸・仕入**は、それぞれ別の拡張（tile / inbound / stocktake / purchase）で、**「在庫変更のあとに api/log-inventory-change を呼ぶ」** という同じパターンが繰り返し出てきたため、**各ファイル内で共通関数**（`logInventoryChangeToApi` / `logInventoryCountToApi` / `logPurchaseToApi`）にまとめられています。重複を避けるためのリファクタの結果です。
- その結果、**ロスは「sourceId が無くても return しない」**、**共通関数は「sourceId が無いと呼ばない」** という条件の差が生まれ、ロスだけ記録されて他が「管理」のままになる原因の一つになり得ました。上記のとおり、共通関数側の条件を外して挙動を揃えています。

## 変動がない（delta=0）の記録をしない

Webhook で「直前数量と今回数量が同じ」（実質変動なし）のときは、履歴に保存しないようにしています。

- 算出した `delta` が **0** のときはログを作成せず `OK` のみ返す。
- これにより「0」の行のあとに「-1」だけが残り、変動のない 0 が一覧に並ばなくなります。

## ロスしか記録されていないときの確認（チェックリスト）

「変動履歴でロスだけ正しく出て、入庫・出庫・棚卸・仕入が『管理』のまま」のときは、次を順に確認してください。

| # | 確認項目 | 内容 |
|---|----------|------|
| 1 | **デプロイ** | 入庫・出庫・棚卸・仕入で `logInventoryChangeToApi` を呼ぶ**最新の拡張**がデプロイされているか。古いバンドルだと共通関数の import パス違いや `sourceId` 必須のままの可能性がある。`shopify app deploy` で再デプロイし、POS アプリを更新してから再度操作してみる。 |
| 2 | **API の 401** | Render の Web サービス **Logs** で `api/log-inventory-change` にリクエストが来ているか、**401** や **POS auth failed** が出ていないか。401 なら「管理画面でアプリを1回開く」でオフラインセッションが DB にあり、同じショップの POS からは通る想定。 |
| 3 | **全種別とも API で上書き** | ロス含め入庫・出庫・棚卸・仕入はすべて「Webhook は admin_webhook で保存 → API で上書き」の同じ流れ。どれかだけ「管理」のままなら、そのフローの API が届いていないか 401 等で失敗している。上記 1・2 を確認する。 |
| 4 | **共通モジュールのパス** | 各拡張から `extensions/common/logInventoryChange.js` を参照しているか。デプロイ時の「Could not resolve ... logInventoryChange.js」が出ていたら、その拡張はバンドルに共通処理が含まれておらず、API が呼ばれない。inbound は `../../../common/`、tile は `../../common/` など、拡張のディレクトリ深さに合わせた相対パスになっているか確認する。 |

---

## 今後の改善の方向性（参考）

- **売上・返品**: すでに `webhooks.orders.updated` / `webhooks.refunds.create` で `order_sales` / `refund` を記録する処理があれば、Webhook の「同一変動スキップ」により、二重に「管理」では記録されない。
- **POS での入庫・出庫・発注入庫など**: POS 拡張から `api/log-inventory-change` で正しい `activity` を送ると、その種別で表示される（上記の種別上書き）。  
  （`api/log-inventory-change` が 401 などで失敗していると、Webhook の「管理」だけが残る。）
- **管理画面での手動調整**: Shopify が Webhook に adjustment group ID を付けない限り、現状は「管理」のまま。  
  付与の有無は Shopify の API バージョンや操作種別に依存するため、公式ドキュメントや実機でのペイロード確認が必要。
