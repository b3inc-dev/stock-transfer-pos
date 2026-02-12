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

## 5. 参照したログ抜粋（対応関係の確認用）

- 18:29  
  - `inventory_item_id: 48093468524790`, `available: 0`, `delta=null`, `activity=admin_webhook` で保存。  
  - 直後に `orders/updated` で 4件のみ Remediated。
- 19:30  
  - `item=50331093467382`, `available=10` → 救済で order_sales。  
  - 続けて `available=9` の webhook で `Existing log quantityAfter (10) !== available (9); treating as new event` → admin_webhook で新規作成。
