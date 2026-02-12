# 在庫変動履歴「管理」になる要因分析（2026-02-12）

履歴とRenderログを突き合わせた分析です。

---

## 1. 2026/02/12 18:29 が「管理」になった要因

**対象**: ラインストーンカメラレンズカバー（ci08325005-23-ip14-14p）、Ciara梅田エスト店、変動後2、参照IDなし・アクティビティ「管理」。

### ログから分かること

- 注文 **6845521101046**（5明細）の在庫反映で、同一ロケーション（84233584886 = Ciara梅田エスト店）に **inventory_levels/update** が5本ほぼ同時に届いている。
- うち **4件** は `orders/updated` の救済で `order_sales` に更新されている:
  - `Remediated admin_webhook to order_sales (fulfillments exist): id=cmlj9bfz..., id=cmlj9bg7j..., id=cmlj9bg7i..., id=cmlj9bfl7...`
- **1件**（`inventory_item_id: 48093468524790`）は `delta=null, quantityAfter=0, activity=admin_webhook` のまま保存され、救済されていない。

### 要因（レース）

1. 5本の **inventory_levels/update** が並列で処理される。
2. 4本が先にコミットし、**orders/updated** がそのあと実行される。
3. **orders/updated** は「時間窓内の admin_webhook を1件ずつ order_sales に更新」するが、この時点では **5本目（48093468524790）はまだコミット前**のため、5本目用の admin_webhook が検索にヒットしない。
4. 5本目については admin_webhook が見つからないので、**OrderPendingLocation** が upsert される（後から届く inventory_levels/update 用）。
5. **その後**、5本目の **inventory_levels/update** がコミットする。このリクエストでは、**処理の冒頭**で OrderPendingLocation を検索した時点では、まだ orders/updated が OrderPendingLocation を登録していないため「マッチなし」となり、**admin_webhook** で保存される。
6. 結果として「5本目だけ管理のまま残る」。

つまり、**inventory_levels/update の処理開始時点と、orders/updated の OrderPendingLocation 登録タイミングの差**によるレースで、本来は売上にすべき1件が「管理」で確定している。

---

## 2. 2026/02/12 19:30 が「管理」になった要因

**対象**: グッズ ショッピングバッグ（ci09739005-00-F）、Ciara天王寺ミオ店、変動数-1、変動後9、参照IDなし・アクティビティ「管理」。

### ログから分かること

- 注文 **6845569892598** の1件が先に救済されている:
  - `Remediated admin_webhook to order_sales (fulfillments exist): id=cmlj9bfz...` 等。
- 同じ商品・ロケーション（item **50331093467382**、location **84233781494**）で、**2回目**の **inventory_levels/update** が届く:
  - 1回目: `available=10` → 上記の救済で order_sales、quantityAfter=10 になる。
  - 2回目: `available=9`（-1の変動）。
- 2回目の webhook では:
  - 時間窓内に **既存の order_sales**（quantityAfter=10）が見つかる。
  - 「既存の quantityAfter（10）≠ 今回の available（9）」のため、**別イベント**と判断し、**新規で admin_webhook 行を作成**している:
    - `Existing log quantityAfter (10) !== available (9); treating as new event, will create admin_webhook row`
    - `Saving log: ... item=50331093467382, ... activity=admin_webhook`

### 要因（連続する売上と「別イベント」判定）

- 2回目の -1 は、別注文 **6845569925366**（グッズ ショッピングバッグ 1個）の売上と考えられる。
- しかし **2回目の webhook が届いた時点**では、注文 6845569925366 の **orders/updated** がまだ届いておらず、**OrderPendingLocation** が未登録だった可能性が高い。
- そのため「既知の order_sales の quantityAfter と available が違う → 別イベント」という既存ロジックで **admin_webhook** が作成され、そのまま「管理」で表示されている。

つまり、**同一商品・同一ロケーションで連続して売上（10→9）が起きている場合に、2件目が「別イベント」扱いになり、かつ 2件目用の OrderPendingLocation がまだ無いタイミングで webhook が処理された**ことで「管理」になっている。

---

## 3. 他に意図しない「管理」になりうるパターン

- **レース（18:29 と同型）**  
  - 複数明細の **inventory_levels/update** と **orders/updated** の到達順で、最後の1本だけ「先に orders/updated が走り、その後に inventory_levels/update がコミット」すると、その1件だけ救済されず「管理」で残る。
- **連続売上（19:30 と同型）**  
  - 同じ商品・ロケーションで短時間に 2 回在庫減（2件の売上）があると、2件目で「既存 order_sales の quantityAfter ≠ 今回の available」となり、2件目用の OrderPendingLocation がまだ無いと「別イベント」で admin_webhook が作成される。
- **delta=null のまま保存**  
  - 直前ログが無く delta が null でも admin_webhook で保存する実装のため、上記レースや別イベント判定と重なると「管理」のまま残りやすい。

---

## 4. 対応方針（実装で行うこと）

1. **保存直前に OrderPendingLocation を再チェックする**  
   - **admin_webhook** で保存しようとする直前に、もう一度 OrderPendingLocation を検索する。  
   - 処理開始時には無くても、その間に **orders/updated** が OrderPendingLocation を登録している場合に拾い、**order_sales** で保存する。  
   - これで 18:29 型のレースを軽減する。

2. **「別イベント」として新規 admin_webhook を作る前に OrderPendingLocation を優先する**  
   - 既存ロジックでは「recentNonAdminLog あり & quantityAfter ≠ available」のとき、そのまま新規 admin_webhook を作成している。  
   - この「新規作成に進む直前」でも、OrderPendingLocation を再チェック（上記と同じ「保存直前チェック」に含める）し、マッチすれば **order_sales** で保存する。  
   - これで 19:30 型（連続売上の2件目が管理になる）を軽減する。

上記は `webhooks.inventory_levels.update.tsx` の「ログ create の直前に OrderPendingLocation を再検索し、見つかったら order_sales で保存する」処理の追加で対応する。

### この修正で解消されるか

- **18:29 型**: 5本目の webhook が「保存する直前に」OrderPendingLocation を再検索するため、その時点で orders/updated が登録済みなら **order_sales** で保存される。レースで遅れて届いた 1 件が「管理」で残るケースをかなり減らせる。
- **19:30 型**: 2件目の webhook で「別イベント」として admin_webhook を書く直前に同じ再検索が走るため、その時点で 2 件目用の OrderPendingLocation があれば **order_sales** で保存される。連続売上の 2 件目が「管理」になるケースを減らせる。
- **残りうる要因**: orders/updated が **inventory_levels/update よりかなり遅い**（例: 数分後）だと、再チェック時点でもまだ OrderPendingLocation が無く「管理」のままになる可能性はある。その場合は注文側の Webhook 遅延要因となる。

---

## 5. 2026/02/12 20:11 と 20:14 が「管理」になった要因

**対象**: iPhoneケース ビジューカメラフレーム マグセーフクリア プティ（ci08977201-09-ip16）、Ciara梅田エスト店。20:11 が変動後2・変動数「-」・管理、20:14 が変動後1・変動数-1・管理の2行になっている。

### ログから分かること

- **item**: 49055222759670、**location**: 84233584886（Ciara梅田エスト店）。
- **20:11**（updated_at 20:11:01）  
  - `No logs found at all for this item/location combination` → 同一商品・ロケーションの既存ログなし。  
  - OrderPendingLocation もマッチせず、`delta=null, quantityAfter=2, activity=admin_webhook` で保存。
- **20:14**（updated_at 20:14:30）  
  - 時間窓内に **1件の既存ログ** があるが `activity: admin_webhook`（20:11 で保存した行）。  
  - `Found 1 recent logs (but none match activity filter)` → order_sales / refund 等の「既知アクティビティ」には該当しない。  
  - 既存行の quantityAfter 更新は「recentNonAdminLog があるとき」だけ行う実装のため、**既存の admin_webhook は更新対象にならない**。  
  - その結果、**新規で admin_webhook を1件追加**（delta=-1, quantityAfter=1）。  
  - この時点でも OrderPendingLocation にはマッチしていない。

### 要因の整理

| 発生日時 | 要因 |
|----------|------|
| **20:11** | 在庫が 2 になった時点の **inventory_levels/update** が先に届き、その時点では同一 item/location の OrderPendingLocation がまだ無い（該当売上の orders/updated が未到着、または別経路で在庫変更）。そのため admin_webhook で保存され、参照IDなし・変動数「-」の「管理」1件目になる。 |
| **20:14** | 在庫が 2→1 になった **2回目の** inventory_levels/update。既存ログは 20:11 の **admin_webhook** のみで、order_sales 等ではないため「既存行の quantityAfter だけ更新」には進まず、**別行として新規 admin_webhook** が作成される。2件目の売上用の OrderPendingLocation もこの時点では無く、order_sales に切り替わらない。 |

### 19:30 との違い

- 19:30 のときは「既存ログが **order_sales**（quantityAfter=10）で、今回の available=9 と違う → 別イベント」として新規 admin_webhook を作成していた。
- 20:11/20:14 のときは、既存ログが **admin_webhook** なので、もともと「既存の order_sales の quantityAfter を更新する」分岐には入らない。代わりに「既知アクティビティのログなし」として毎回 **新規 admin_webhook** が作成される動きになる。

### 対応内容（2026-02-12 実装）

- OrderPendingLocation にマッチした場合、**新規行を作る前に**「同一 item/location で quantityAfter = available + 売上数量 の admin_webhook が時間窓内にないか」を検索する。
- 見つかったら、その **既存 admin_webhook 行を order_sales に更新**（delta・sourceId・quantityAfter 等を設定）し、新規行は作らずに return する。
- これにより「1件目が先に admin で保存 → 2件目で OrderPendingLocation が届いている」とき、2件目で新規「管理」を増やさず、1件目の行を「売上」に書き換える。同一商品で「管理」が2行並ぶ事象を防ぐ。実装: `webhooks.inventory_levels.update.tsx`（create の直前に「既存 admin_webhook を order_sales に更新」ブロックを追加）。

### 事実の補足（2026-02-12 認識修正）

- **20:11 と 20:14 は売上ではなく、管理画面での在庫調整だった**ことが判明している。
- 上記「対応内容」のコードは **そのままで問題ない**。理由: 今回のブロックは **OrderPendingLocation にマッチしたときだけ** 動く。管理画面のみの在庫変更では OrderPendingLocation は作成されないため、`pendingOrder` は常に null で、既存 admin_webhook を order_sales に書き換える処理は実行されない。管理画面由来の2行は従来どおり両方 admin_webhook のまま。

### Render ログで確認するとよいこと

- 20:11 と 20:14 の **inventory_levels/update** がそれぞれ何件届いているか（同一 item/location で 2 回 webhook が飛んだ理由）。
- 両方のリクエストで `OrderPendingLocation` にマッチしたか（`Matched OrderPendingLocation` や `Before create: matched OrderPendingLocation` の有無）。管理画面のみならこれらは出ない想定。
- 20:11 の webhook で `No logs found at all` → `delta=null, activity=admin_webhook` で保存、20:14 の webhook で `Found 1 recent logs (but none match activity filter)` → 新規 admin_webhook で保存、という流れになっているか。

### 20:11 の「変動数 -」行を出さない制御について

- **「管理画面の操作が 20:14 の1回だけだった」場合**に、20:11 の変動数「-」の行を **表示しない（または保存しない）** 必要があるかは、ログで原因を確認してから決めるのがよい。
- 想定パターン:
  - **A**: 1回の管理画面操作で Shopify から 20:11 と 20:14 の2本の webhook が届いた（中間状態 2 → 確定 1）。この場合、20:11 は「同じ1回の操作の途中経過」なので、一覧に 1 行だけ（20:14 のみ）出したいという要望はあり得る。
  - **B**: 20:11 と 20:14 は別々の操作（2回の在庫調整）。この場合は 2 行とも残すのが正しい。
- ログで **A か B か** が分かれば、A のときだけ「直近の admin_webhook（delta=null）を、次の admin_webhook 保存時に quantityAfter を引き継いで1行にまとめる」などの制御を検討できる。ただし「直前の admin_webhook を更新して新規行を作らない」ようにすると、履歴のタイムスタンプが 20:14 に寄り、20:11 の情報は失われる。要件として「1回の操作は1行にまとめたい」が明確なら、その方針で追加実装を検討するのがよい。

### Shopify 調整履歴との対応（2026-02-12 追記）

- Shopify 管理画面の調整履歴（同一商品・Ciara梅田エスト店）では、**①注文の編集 (#30366758) → ②注文の発送 (#30366758) → ③在庫の手動棚卸し** の順で 3 件が記録されている。
- **販売可能（available）** の変化だけを見ると: ①で 3→2、②で変化なし(2)、③で 2→1。`inventory_levels/update` は available が変わるたびに飛ぶため、アプリには **①の結果（available=2）** と **③の結果（available=1）** の 2 本の webhook が届く（20:11 と 20:14 に対応）。
- **アプリにあるべき表示**:  
  - **1行目（注文の編集）**: アクティビティ「売上」、変動数 -1、変動後 2、参照ID order_30366758（※注文の編集で販売可能が減った分）。  
  - **2行目（手動棚卸し）**: アクティビティ「管理」、変動数 -1、変動後 1、参照ID -。  
- **注文の発送**は販売可能数を変えない（引当済み→0・手持ち減のみ）ため、`inventory_levels/update` では「available の変化」として届かず、アプリの変動履歴に 1 行としては出ないのが仕様上正しい。
- **現状アプリが 2 行とも「管理」になる理由**: 20:11 の webhook 受信時点で、注文 #30366758 用の OrderPendingLocation がまだ登録されていなかった（orders/updated の到着順・タイミングのため）。そのため 20:11 は order_sales に紐づけられず admin_webhook（変動数「-」）で保存。20:14 も既存ログが admin_webhook のため新規 admin_webhook として保存され、結果として 2 行とも「管理」になっている。
- **記載の正しさについて**: 注文の編集による在庫減は**本来は売上に振り分けるべき**であり、今回の「2 行とも管理」という表示は**原因に照らすと誤り**。技術的には、注文編集時にも OrderPendingLocation が inventory_levels/update より先（または同時）に揃っていれば 1 行目が売上になる。現状は Webhook の到着順に依存しているため、注文編集由来の 1 行目が「管理」のままになることがある。
- **反映のための修正（2026-02-12）**: orders/updated ではもともと「fulfillments なし」時に直近の admin_webhook を order_sales に救済する処理があるが、時間窓が **注文作成日時（created_at）** 基準だった。注文が昔に作成され今回「編集」された場合、編集直後に保存された admin_webhook（例: 20:11）がその窓に入らず救済されない。**救済の時間窓を「注文更新日時（updated_at）」基準**に変更した（`webhooks.orders.updated.tsx`）。これにより、注文編集で orders/updated が届いたときに、直近 30 分以内の admin_webhook を探して売上に上書きできる。同様の事象が再発した場合、1 行目が「売上」に反映される。

---

## 6. 参照したログ抜粋（対応関係の確認用）

- 18:29  
  - `inventory_item_id: 48093468524790`, `available: 0`, `delta=null`, `activity=admin_webhook` で保存。  
  - 直後に `orders/updated` で 4件のみ Remediated。
- 19:30  
  - `item=50331093467382`, `available=10` → 救済で order_sales。  
  - 続けて `available=9` の webhook で `Existing log quantityAfter (10) !== available (9); treating as new event` → admin_webhook で新規作成。
- 20:11 / 20:14  
  - `item=49055222759670`, location=84233584886（Ciara梅田エスト店）。20:11 で `No logs found at all` → admin_webhook で保存（quantityAfter=2）。20:14 で `Found 1 recent logs (but none match activity filter): activity=admin_webhook` → 既存は admin のため quantityAfter 更新せず、新規 admin_webhook で保存（quantityAfter=1）。
