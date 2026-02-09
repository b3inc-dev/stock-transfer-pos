# 在庫変動履歴で「ロス以外が全て管理になる」要因

**作成日**: 2026年2月  
**対象**: 在庫情報画面の「在庫変動履歴」タブで表示されるアクティビティ種別

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

### 3. ロスだけ「ロス」と出る理由

- **ロス登録** は、Shopify 側で **InventoryAdjustmentGroup** が作られるフローになっている可能性が高く、  
  そのときだけ Webhook に `inventory_adjustment_group_id` が付与される、  
  もしくは **ロス操作時にアプリや別経路で `api/log-inventory-change` に `activity: "loss_entry"` を送っている** と考えられます。
- いずれにせよ、「ロス」は **種別が分かる経路で記録されている** ため、「ロス」と表示されます。
- それ以外（入庫・出庫・売上・返品・棚卸など）は、**Webhook のみで記録され、かつ adjustment group ID が来ない** ため「管理」のままです。

---

## ロスとその他の違い（まとめ）

| 項目 | ロス | その他（入庫・出庫・売上・返品など） |
|------|------|--------------------------------------|
| 記録経路 | adjustment group 付きの Webhook、または `api/log-inventory-change` で `loss_entry` を送信 | ほぼ Webhook のみ（adjustment group ID なし） |
| 種別の決まり方 | ID または API で「ロス」と確定 | ID が無いため「種別不明」→ **管理** |
| 表示 | 「ロス」 | 「管理」 |

---

## ロスと同様の処理（種別上書き）

**入庫・出庫・棚卸・仕入・ロス** は、いずれも「操作後に `api/log-inventory-change` を呼ぶ」ことで、履歴に正しい種別が付きます（ロスと同様の処理）。

1. 在庫が変わると Shopify が Webhook を送り、まず「管理」で 1 件保存される。
2. 続けて POS／管理画面の拡張が `api/log-inventory-change` を呼ぶ（`activity`: 入庫・出庫・ロス・棚卸・仕入など）。
3. API 側で「直近の同一 item・location の『管理』行」を検索し、その行の `activity` を受け取った種別に**上書き**する。

このため、**各操作の確定処理で必ず `api/log-inventory-change` を呼ぶ**ことが、ロスと同様に種別を付ける条件です。  
（入庫: InboundListScreen、出庫: ModalOutbound、ロス: LossProductList、棚卸: InventoryCountList、仕入: PurchaseProductList / PurchaseHistoryList で呼び出し済み。401 の場合はトークン設定を確認。）

## 変動がない（delta=0）の記録をしない

Webhook で「直前数量と今回数量が同じ」（実質変動なし）のときは、履歴に保存しないようにしています。

- 算出した `delta` が **0** のときはログを作成せず `OK` のみ返す。
- これにより「0」の行のあとに「-1」だけが残り、変動のない 0 が一覧に並ばなくなります。

## 今後の改善の方向性（参考）

- **売上・返品**: すでに `webhooks.orders.updated` / `webhooks.refunds.create` で `order_sales` / `refund` を記録する処理があれば、Webhook の「同一変動スキップ」により、二重に「管理」では記録されない。
- **POS での入庫・出庫・発注入庫など**: POS 拡張から `api/log-inventory-change` で正しい `activity` を送ると、その種別で表示される（上記の種別上書き）。  
  （`api/log-inventory-change` が 401 などで失敗していると、Webhook の「管理」だけが残る。）
- **管理画面での手動調整**: Shopify が Webhook に adjustment group ID を付けない限り、現状は「管理」のまま。  
  付与の有無は Shopify の API バージョンや操作種別に依存するため、公式ドキュメントや実機でのペイロード確認が必要。
