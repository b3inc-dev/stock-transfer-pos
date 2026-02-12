# 売上・返品のアクティビティと変動数が反映されない要因と Webhook/API の関係

**作成日**: 2026年2月12日  
**対象**: 在庫変動履歴で「売上」「返品」および「変動数」が正しく出ない／出る場合の差分整理と、確実に反映するための手段検討

---

## 0. 売上関係の流れ（オンライン／POS）と取り扱い方針

### 0.1 オンラインストア（売上発生時と配送時に分かれる）

| タイミング | イベント | Webhook の有無（想定） |
|------------|----------|------------------------|
| **売上発生時** | 注文：未配送のステータスで発生 | **orders/updated** が届く（fulfillments が 0 の可能性あり） |
| | 在庫：**販売可能在庫変動**（available の変動） | **inventory_levels/update** が届く |
| **梱包準備・発送時** | 配送完了としてステータス変更 | **orders/updated** が届く（fulfillments が 1 以上になる） |
| | 在庫：**手持ち在庫の変動** | **inventory_levels/update** が届く |

→ オンラインでは「販売可能」と「手持ち」の 2 回、在庫変動が起きうる。**変動数は注文（order の line_items）を正とする**と、どちらの inventory_levels/update が先に来ても、後から届く **orders/updated で救済**すればよい。

### 0.2 POS（売上発生時に全て完了）

| タイミング | イベント | Webhook の有無（想定） |
|------------|----------|------------------------|
| **売上発生時** | 注文：未配送のステータスで発生 | **orders/updated** が届く（POS は即履行のため **fulfillments が 1 以上**で届くことが多い） |
| | 在庫：販売可能在庫変動 | **inventory_levels/update** が届く |
| | 配送完了としてステータス変更 | 同上 orders/updated に含まれる |
| | 在庫：手持ち在庫の変動 | **inventory_levels/update** が届く |

→ POS でも在庫変動は 1 回または 2 回（販売可能＋手持ち）来うる。**orders/updated は fulfillments ありで届く**ため、現状はスキップされていたが、**fulfillments ありのときも「注文情報で救済」**すれば、変動数は order の line_items で確実に反映できる。

### 0.3 取り扱い方針（変動数はオーダー情報を必ず反映）

- **変動数（delta）**は、在庫の増減件数ではなく **注文の明細数量（line_items[].quantity）** を正とする。
- そのため、**orders/updated が届いた時点で**、その order の line_items と履行ロケーションを使って、
  - 既に **inventory_levels/update** で保存されている「管理」行（admin_webhook）を探し、
  - それを **order_sales** に更新し、**delta = -(line_item.quantity)** を設定する
  という**救済処理**を行う。
- これにより、
  - **オンライン**：受注時（fulfillments=0）で処理できなくても、配送完了時（fulfillments あり）の orders/updated で救済できる。
  - **POS**：最初から fulfillments ありで届いても、同じ救済で「売上」＋変動数を付けられる。
- 販売可能在庫と手持ち在庫の**2 回** inventory_levels/update が来る場合は、**1 件だけ**を order_sales に更新する（同一 order・同一 item・同一 location で既に order_sales があれば上書きしない／または時間窓内で最も古い admin_webhook を 1 件だけ order_sales にする）ことで、二重表示を防ぐ。

### 0.4 受注時 vs 配送完了時：届く情報の差

| 項目 | 受注時（fulfillments なし） | 配送完了時（fulfillments あり） |
|------|-----------------------------|----------------------------------|
| **orders/updated のペイロード** | `order.id`, `order.line_items`, `created_at` は同じ。`fulfillments` は **空 or 未設定**。 | 同上に加え **`fulfillments[0].location_id`** がそのまま取れる。 |
| **ロケーションの取得** | GraphQL の **FulfillmentOrder.assignedLocation** で取得を試みるが、受注直後は **null になりやすい**（Shopify の仕様）。 | ペイロードの **fulfillments[0].location_id** で確実に取れる。 |
| **注文内容** | 同じ（order.id, line_items, 数量）。 | 同じ。 |

→ **中身は同じ注文**で、差は「**ロケーションがペイロードで取れるか**」と「**fulfillments の有無**」だけ。オンラインでは別の日に配送完了になることが多いため、**受注時で反映し、配送完了時の orders/updated では「既にこの注文で order_sales が 1 件でもあれば救済しない」**ようにすると、受注時を優先できる。

### 0.5 受注時を優先し、配送完了時はスキップする方針（実装）

- **受注時（fulfillments=0）**  
  - 常に **OrderPendingLocation** を登録する（ロケーションが取れなくても取れても）。  
  - 後から **inventory_levels/update** が届けば、OrderPendingLocation にマッチして **order_sales**（変動数＝オーダー数量）で記録される。  
  - ロケーションが取れる場合は、さらに直近の **admin_webhook** を order_sales に上書きする（inventory_levels/update が先に届いていた場合に即反映）。上書きした行については、同じ注文の OrderPendingLocation を削除し、二重記録を防ぐ。
- **配送完了時（fulfillments あり）**  
  - **この order の order_sales が 1 件でも既に存在する**（＝受注時で既に反映済み）なら、**救済は一切行わずスキップ**する。  
  - 1 件も無い場合のみ（受注時の orders/updated が届いていない・POS など）救済する。  

→ オンラインでは「受注内容だけ反映し、配送完了のタイミングではスキップ」できる。

### 0.6 Webhook の到着順が逆でも問題なく反映する方針（実装）

- **orders/updated（受注時）が先に届く場合**  
  - 常に **OrderPendingLocation** を登録するため、その後に届く **inventory_levels/update** がマッチし、order_sales ＋変動数で記録される。  
- **inventory_levels/update が先に届く場合**  
  - いったん **admin_webhook** で保存される。  
  - 後から **orders/updated（受注時）** が届き、ロケーションが取れれば直近の admin_webhook を order_sales に上書き；ロケーションが取れなくても OrderPendingLocation は登録され、**次の inventory_levels/update**（同じ商品・手持ち分など）が OrderPendingLocation にマッチして order_sales になる。  
- **POS で orders/updated（fulfillments あり）が先に届く場合**  
  - 救済対象の admin_webhook がまだ無いため、**OrderPendingLocation** に登録する。後から届く **inventory_levels/update** が OrderPendingLocation にマッチし、order_sales ＋変動数で記録される。  
- いずれの順でも、**変動数はオーダー情報（OrderPendingLocation の quantity / line_items.quantity）** で反映される。

### 0.7 注文・返品の扱いのイメージ（どのタイミングで届いても確実に反映）

- **注文・返品情報は「どのタイミングで届いても、先に同じ情報が既に記録されていないか探す。無ければ、後から届く在庫変動（inventory_levels/update）に備えて OrderPendingLocation に登録するか、既存の admin_webhook を order_sales / refund に更新する」**という動きになっている。
- 返品は **refunds/create** で同様に「既存の admin_webhook を refund に更新する」か新規記録で反映する。

### 0.8 Render ログで見えること（POS の注文・配送）

- ログに `[orders/updated] Order details: id=..., fulfillments.length=1` のように **1 回の orders/updated** で fulfillments が 1 以上になっている場合は、**「注文」と「配送完了」が同じ 1 イベント**として届いている（POS では受注と同時に履行されるため、別々の「受注用」「配送完了用」の 2 本が飛ばないことが多い）。
- オンラインストアでは、受注時（fulfillments=0）と配送完了時（fulfillments あり）で **2 回** orders/updated が届く想定。

### 0.9 オンラインストアと POS のどちらでも不具合なく処理されるようにするための組み方（まとめ）

| 経路 | オンラインストア | POS |
|------|------------------|-----|
| **受注時（fulfillments=0）** | 常に OrderPendingLocation 登録。ロケーション取れれば admin_webhook を order_sales に更新。 | 通常は届かない（即履行のため fulfillments ありで 1 本だけ届く）。 |
| **配送完了時（fulfillments あり）** | 既に order_sales があればスキップ（受注時で反映済み）。無ければ救済（admin_webhook → order_sales）または OrderPendingLocation 登録。 | 救済（admin_webhook → order_sales）。admin_webhook がまだ無ければ OrderPendingLocation に登録し、後から inventory_levels/update でマッチ。 |
| **inventory_levels/update** | OrderPendingLocation にマッチすれば order_sales＋変動数。既に order_sales/refund があれば quantityAfter のみ更新。 | 同上。 |
| **到着順** | どちらが先でも、OrderPendingLocation または admin_webhook 救済で order_sales にできる。 | orders/updated が先でも OrderPendingLocation に登録して後続でマッチ；inventory_levels/update が先でも admin_webhook を後から救済。 |

→ オンライン・POS どちらでも、「注文／返品情報がどのタイミングで届いても、既存の order_sales/refund を探し、無ければ OrderPendingLocation または救済で後から届く情報と突き合わせて反映する」形で一貫して処理される。

### 0.10 販売可能数と手持ち在庫数を分けて履歴を残すか（検討メモ・未実装）

**結論の目安**  
「一番いい」かどうかは**何を重視するか**で変わります。**売上を「1 注文＝1 行・変動数＝オーダー数量」で見たい**なら現状の「1 行にまとめる」方が向いています。**予約と実在庫の流れを区別して監査・分析したい**なら、販売可能／手持ちを分けて残す方が向いています。

| 観点 | 現状（1 行にまとめる） | 販売可能・手持ちを分けて残す |
|------|-------------------------|------------------------------|
| **履歴の見え方** | 1 注文＝1 行。変動数＝オーダー数量で分かりやすい。 | 1 注文で「販売可能の減り」と「手持ちの減り」の 2 行になりうる。同じ参照IDが 2 回出る。 |
| **監査・分析** | 何が売れたか・返品されたかは分かるが、「予約」と「実在庫減」のタイミングは区別できない。 | 受注時（販売可能）と配送完了時（手持ち）を別々に追える。在庫の流れを細かく分析できる。 |
| **データの裏付け** | オーダー情報を正とし、在庫変動と突き合わせて 1 行に集約している。 | 在庫変動の「種類」（販売可能 vs 手持ち）を区別して記録する必要がある。 |

**技術的な前提**  
- 現在の **inventory_levels/update** のペイロードは **`available`（数量）と `updated_at` など**で、**「販売可能」か「手持ち」か**は含まれていません（Shopify の Webhook 仕様）。  
- そのため「分けて残す」には、  
  - 仕様で **販売可能／手持ちを区別できる API や Webhook** が用意されているか、  
  - または「受注由来か履行由来か」を **orders/updated の fulfillments 有無や時刻で推測**する必要があります。  
- 推測で分ける場合は、到着順や複数ロケーションなどで誤判定の可能性があります。

**分けて残す場合のイメージ（未実装）**  
- 例：アクティビティを `order_sales` のままにして、**種別フラグ**（例：`inventory_type: "sellable" | "on_hand"`）を 1 列追加する。  
- または `order_sales_sellable` / `order_sales_on_hand` のようにアクティビティを分ける。  
- いずれにしても「1 注文＝2 行」になるため、一覧では「同じ注文を 1 行にまとめて表示する」などの表示方針が必要になります。

**推奨の整理**  
- **まずは現状の「1 注文＝1 行・変動数＝オーダー数量」のまま運用**し、  
- 「販売可能と手持ちを分けて見たい」要件がはっきりした段階で、Shopify の API／Webhook で区別できるか確認したうえで、分けて残す案を検討するのが安全です。  
- **方針決定**：販売可能と手持ちは**分けない**方向で運用する。

---

## 1. 現在の Webhook と API の関係（全体像）

| 経路 | 役割 | いつ動くか | アクティビティ・変動数の決まり方 |
|------|------|------------|----------------------------------|
| **inventory_levels/update**（Webhook） | 在庫数が変わったときの「結果」を記録 | Shopify で在庫が増減するたびに呼ばれる | ペイロードは `available`（変動後数量）のみ。**直前の値が無いため delta（変動数）は原則 null**。種別は「OrderPendingLocation マッチ → order_sales」「既存 order_sales/refund 等 → その行の quantityAfter のみ更新」「それ以外 → admin_webhook（管理）」 |
| **orders/updated**（Webhook） | 注文更新（オンライン受注・履行） | 注文の作成・更新・履行時に呼ばれる | **fulfillments が 1 件以上ある場合は処理しない**（スキップ）。fulfillments が 0 のときだけ：ロケーション取得 → 取れれば直近 admin_webhook を order_sales に上書き／取れなければ OrderPendingLocation に登録し、後から届く inventory_levels/update で order_sales に突き合わせ |
| **refunds/create**（Webhook） | 返品の記録 | 管理画面や API で返品が作成されたとき | 返品ロケーション・数量で order_sales と同様に **refund** で記録。既に inventory_levels/update で admin_webhook が保存されていれば、その行を refund に更新 |
| **api/log-inventory-change**（API） | POS/アプリから「この変動は〇〇」と明示 | 出庫・入庫・ロス・棚卸・仕入の**確定処理の直後**に POS 拡張から呼ぶ | 受け取った activity（outbound_transfer, inbound_transfer, loss_entry, inventory_count, purchase_entry, order_sales, refund）で、直近の admin_webhook を上書きするか、新規で記録 |

**重要**:  
- **通常の POS レジ売上・返品**では、**api/log-inventory-change を呼ぶ処理は実装されていません**。出庫・入庫・ロス・棚卸・仕入のタイルでの確定時のみ API を呼んでいます。  
- そのため、**POS ロケーションでレジを通した売上・返品**は、在庫変動は **inventory_levels/update のみ**で記録され、種別は「管理」・変動数は null のままになります。

---

## 2. ① オンラインストアで売上／返品のアクティビティ・変動数が取れていない要因（反映できているものとの差分）

### 2.1 設計上の想定フロー（オンラインストア）

1. 顧客が注文 → 注文作成時点で **orders/updated** が 1 回目で飛ぶ（この時点では **fulfillments が 0** の想定）。
2. アプリは **fulfillments が 0** なので処理する。
   - FulfillmentOrder.assignedLocation でロケーションが取れれば → 直近の admin_webhook を order_sales に上書き（変動数 = -line_item.quantity）。
   - ロケーションが取れない（受注直後で null になりがち）→ **OrderPendingLocation** に line_items を登録。
3. その後、在庫が減る → **inventory_levels/update** が飛ぶ。
   - OrderPendingLocation に同一商品・時刻が近いものがあれば → **order_sales** で保存し、**変動数 = -pending.quantity**。
   - 先に inventory_levels/update が来て admin_webhook で保存されていた場合は、後から届いた orders/updated（fulfillments なし）で直近 admin_webhook を order_sales に**救済**で上書き。

### 2.2 反映できているものとできていないものの差分（要因）

| 状況 | 結果（履歴上の見え方） | 要因 |
|------|--------------------------|------|
| orders/updated が **fulfillments なし**で先に届き、ロケーションが取れた | アクティビティ「売上」・変動数あり・参照ID あり | 設計どおり。直近 admin_webhook を order_sales に上書きしている。 |
| orders/updated が **fulfillments なし**で先に届き、ロケーションが取れず OrderPendingLocation に登録 → その後に inventory_levels/update | アクティビティ「売上」・変動数あり・参照ID あり | 設計どおり。OrderPendingLocation マッチで order_sales + delta を保存。 |
| **最初から orders/updated に fulfillments が 1 件以上ある**（自動履行や履行が早いなど） | スキップするため OrderPendingLocation も救済も動かない → **inventory_levels/update のみ**で記録 | **fulfillments ありは「処理しない」**ため、OrderPendingLocation が一度も作られず、inventory_levels/update は OrderPendingLocation にマッチできない → **admin_webhook（管理）** または、別経路で order_sales になっていても **変動数は null** になりがち。 |
| 同一注文で **inventory_levels/update が orders/updated より先に届く**（商品・ロケーションごとに到達順が違う） | その行は先に admin_webhook で保存される。後から orders/updated が **fulfillments なし**で届けば救済で order_sales に更新されるが、**fulfillments ありで届くと救済されない** | 到達順と「fulfillments の有無」に依存。 |
| 同一注文の **一部の line_item だけ**変動数が「-」になる | その商品は OrderPendingLocation マッチまたは orders/updated 救済の対象になっていない（先に inventory_levels/update のみで admin_webhook になり、その後 orders/updated が fulfillments ありで届いて救済されない、など） | 商品ごとの Webhook 到達順と、orders/updated が fulfillments ありで来るかどうかに依存。 |

**まとめ（オンラインストア）**  
- **反映できている**: orders/updated が **fulfillments なし**で届くタイミングがあり、かつ「ロケーション取得」または「OrderPendingLocation ＋ その後の inventory_levels/update マッチ」または「admin_webhook 救済」のいずれかが成立している場合。  
- **反映できていない**:  
  - 最初の orders/updated から **fulfillments が 1 件以上ある**（受注と同時履行・自動履行など）→ 一切処理されず、OrderPendingLocation も救済も動かない。  
  - その結果、**inventory_levels/update だけ**で記録され、**admin_webhook（管理）** または **order_sales でも変動数 null** になる。

---

## 3. ② POS ロケーションで売上／返品のアクティビティ・変動数が取れていない要因

### 3.1 現状の実装

- **POS の「出庫・入庫・ロス・棚卸・仕入」**では、確定処理の直後に **api/log-inventory-change** を呼んでおり、履歴に正しいアクティビティと変動数が付く。
- **POS の「通常のレジ売上・返品」**（ショップの POS で商品を販売／返品するだけの操作）では、  
  **api/log-inventory-change を呼ぶコードがどこにもない**（POS UI Extension で「売上完了時」にフックしていない）。

### 3.2 実際の流れ

1. POS で売上または返品が行われる → Shopify 側で在庫が増減する。
2. Shopify が **inventory_levels/update** だけを送る。
3. アプリは「OrderPendingLocation にマッチするか」「既存の order_sales/refund があるか」を検索するが、  
   - POS 売上では **orders/updated を fulfillments ありでスキップ**しているため OrderPendingLocation は作られず、  
   - **api/log-inventory-change も呼ばれない**ため、種別を「売上」「返品」に書き換える経路がない。
4. 結果として **admin_webhook（管理）** のまま保存され、**変動数は null**、**参照ID もなし**になる。

**まとめ（POS ロケーション）**  
- 売上・返品の「種別」と「変動数」を付けるには、現状は **api/log-inventory-change** または **orders/updated / refunds/create** のいずれかで記録する必要がある。  
- POS レジ売上では orders/updated は **fulfillments ありで来るためスキップ**され、refunds/create は主に管理画面／API 返品用で、POS 返品が同じように飛ぶかはショップ設定に依存する。  
- さらに **POS から api/log-inventory-change を売上・返品用に呼んでいない**ため、**POS ロケーションの売上・返品はほぼすべて「管理」・変動数なし・参照ID なし**になる。

---

## 4. Webhook と API の関係（図解）

```
[ オンラインストア ]
  注文作成 → orders/updated (fulfillments=0) → OrderPendingLocation 登録 or admin_webhook を order_sales に更新
  在庫減   → inventory_levels/update        → OrderPendingLocation マッチで order_sales+delta
                                             or 既存 order_sales/refund の quantityAfter 更新
                                             or 新規 admin_webhook（delta=null）
  問題: 最初から fulfillments>0 で orders/updated が来ると上記が一切動かず「管理」や変動数なしになる

[ POS レジ売上・返品 ]
  売上/返品 → 在庫変動 → inventory_levels/update → OrderPendingLocation なし・API 呼びなし
                        → admin_webhook（管理）、delta=null、参照ID なし
  ※ orders/updated は fulfillments ありで来るためスキップ。api/log-inventory-change は売上・返品では未使用

[ POS 出庫・入庫・ロス・棚卸・仕入 ]
  確定処理 → api/log-inventory-change → 直近 admin_webhook を正しい activity に上書き（変動数も付与）
  在庫変動 → inventory_levels/update   → 既存の order_sales/refund 等があれば quantityAfter のみ更新
```

---

## 5. 確実に反映するための手段（検討）

### 5.1 オンラインストア

| 手段 | 内容 | メリット・注意 |
|------|------|------------------|
| **A. orders/created を追加する** | 注文作成専用 Webhook を登録し、**受注時点（fulfillments なしがほぼ保証）**で OrderPendingLocation 登録または order_sales 記録を行う。 | 受注と履行のタイミングに依存しにくく、OrderPendingLocation を確実に作れる。Shopify が orders/created を送るか・ペイロードは要確認。 |
| **B. orders/updated で fulfillments ありでも「救済だけ」行う** | fulfillments がある場合でも「新規で order_sales は作らない」が、**同一商品・ロケーション・時間窓内の admin_webhook を 1 件だけ order_sales に更新する**（変動数は **line_items から算出**：delta = -line_item.quantity）。 | 二重記録を避けつつ、inventory_levels/update で先に admin_webhook になった行を後から order_sales にできる。**※ 2026-02 に実装済み。** |
| **C. inventory_levels/update で「直前の在庫」を API で取得** | 変動数（delta）を付けたい場合、inventory_levels/update 受信時に GraphQL 等で「直前の available」を別途取得して delta を計算する。 | 実装・レート制限・タイミングのずれに注意。あくまで補助向け。 |

### 5.2 POS ロケーション（売上・返品）

| 手段 | 内容 | メリット・注意 |
|------|------|------------------|
| **D. POS 売上完了時に api/log-inventory-change を呼ぶ** | POS UI Extension で「取引完了」や「支払い完了」に紐づくフック（利用可能な API がある場合）で、その取引の line_items を元に api/log-inventory-change（activity: order_sales / refund）を呼ぶ。 | 仕様上、POS 側で「売上完了」イベントをアプリが受け取れるかが前提。Shopify POS Extension API の制約要確認。 |
| **E. orders/updated で POS 注文も救済する** | orders/updated で **fulfillments が 1 件以上ある場合でも**、最初の fulfillment の location_id と line_items を使い、時間窓内の admin_webhook を 1 件だけ order_sales に更新する（変動数は line_items から算出）。オンライン・POS 共通。 | Webhook のみで完結。POS 拡張の変更が不要。**※ B と同一処理で 2026-02 に実装済み。** |

### 5.3 返品（オンライン・POS 共通）

- **refunds/create** はすでに返品を refund で記録するように実装されている。  
- POS 返品が refunds/create で届くかは、Shopify の返品フロー次第。届く場合は、既存の admin_webhook を refund に更新する処理で変動数・参照ID を付与できる（既存の searchTo 拡大などの救済ロジックと合わせて運用）。

---

## 6. 推奨する進め方（優先度の目安）

1. **短期（Webhook だけで改善）** — **実施済み**  
   - **B・E**: orders/updated で **fulfillments ありのときも救済**を実施（同一商品・ロケーション・時間窓内の admin_webhook を 1 件だけ order_sales に更新、変動数 = -line_item.quantity）。オンライン・POS 共通。  
   → オンライン・POS ともに「すでに inventory_levels/update で admin_webhook になっている行」を後から order_sales にでき、**変動数はオーダー情報で確実に反映**される。

2. **中期（受注タイミングの安定化）**  
   - **A**: orders/created を登録し、受注時点で OrderPendingLocation または order_sales を記録する。  
   → オンラインで「最初から fulfillments あり」でも、受注イベントで確実に OrderPendingLocation が作られ、inventory_levels/update との突き合わせがしやすくなる。

3. **POS 売上を API で明示的に記録する場合**  
   - **D**: POS の取引完了フックで api/log-inventory-change を呼ぶ。  
   → 利用可能な API がある場合に、POS 売上・返品を確実に「売上」「返品」と変動数付きで残せる。

---

## 7. 参照コード・設定

| 目的 | ファイル・メモ |
|------|------------------|
| orders/updated で fulfillments ありのときスキップしている箇所 | `app/routes/webhooks.orders.updated.tsx` 125–131 行付近 |
| OrderPendingLocation 登録・マッチ | `webhooks.orders.updated.tsx`（登録）、`webhooks.inventory_levels.update.tsx`（マッチ・order_sales 保存） |
| admin_webhook を order_sales に救済 | `webhooks.orders.updated.tsx`（fulfillments なし時の救済） |
| api/log-inventory-change（種別上書き） | `app/routes/api.log-inventory-change.tsx` |
| POS から API を呼ぶ共通処理 | `extensions/common/logInventoryChange.js`（出庫・入庫・ロス・棚卸・仕入で使用。売上・返品では未使用） |
| 在庫変動履歴で「管理」になる理由の全体 | `docs/INVENTORY_CHANGE_ACTIVITY_WHY_MANAGEMENT.md` |

---

以上が、売上・返品のアクティビティと変動数が「反映できているもの」と「できていないもの」の差分、および Webhook と API の関係、確実に反映するための手段の整理です。
