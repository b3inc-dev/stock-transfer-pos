# 在庫変動履歴：Webhook変動数・反映漏れ洗い出しと強固化

**作成日**: 2026-02-13  
**目的**: ①管理画面Webhookに変動数が含まれないことの公式確認、②アクティビティ反映漏れ・二重の可能性を全て洗い出し、公開アプリとして確実に反映される強固な設計にする。

---

## 1. 管理画面からの Webhook に変動数は含まれるか（公式確認）

### 結論：**含まれない。間違いない。**

REST Admin API の **InventoryLevel リソース**は、Webhook のペイロードとしてそのまま届く対象です。

- **公式ドキュメント**: [InventoryLevel - Shopify REST Admin API](https://shopify.dev/docs/api/admin-rest/2024-04/resources/inventorylevel)  
  - **The InventoryLevel resource** の Properties は次のみ:
    - `available` … 変動**後**の数量
    - `inventory_item_id`（read-only）
    - `location_id`（read-only）
    - `updated_at`（read-only）
  - **delta（変動量）や available_adjustment はリソースに存在しない。**

- **変動量（adjustment）が使える場面**:
  - **API のリクエスト**（在庫を変更するとき）:  
    `POST /admin/api/.../inventory_levels/adjust.json` の **body** に `available_adjustment` を渡す。  
    これは「依頼」のパラメータであり、**Webhook のペイロードには含まれない**。
  - **Webhook** が届くのは「在庫レベルが更新された**結果**」であり、  
    ペイロードは **inventory_item_id, location_id, available, updated_at**（および `admin_graphql_api_id` 等）のみ。

- **inventory_adjustment_group_id**  
  管理画面での在庫調整時にペイロードに付くことがあるが、  
  これがあっても **delta はペイロードには含まれない**。  
  変動量が必要な場合は、GraphQL の `InventoryAdjustmentGroup.changes[].deltaQuantity` を**別途取得**する必要があり、  
  かつ `inventory_adjustment_group_id` が付かない操作（手動入力・他アプリ経由など）では取得できない。

したがって、**「管理画面からの変更の Webhook は変動数を含まないので、変動数は Webhook だけでは反映できない」** という理解は**公式仕様と一致しており正しい**。  
現在の実装（直前ログの quantityAfter からの算出、または InventoryAdjustmentGroup の GraphQL 取得）が、仕様上とりうる範囲の対応になっている。

---

## 2. 変動の発生源と記録経路（整理）

| 発生源 | 記録経路 | 期待アクティビティ | 変動数(delta)の取り方 |
|--------|----------|---------------------|------------------------|
| 管理画面での在庫調整 | inventory_levels/update のみ | admin_webhook（管理） | 直前ログの quantityAfter から算出。初回は null の可能性あり。 |
| POS 入庫・出庫・ロス・棚卸・仕入・仕入キャンセル | api/log-inventory-change → 後から inventory_levels/update | 各 activity | API で delta 送信。Webhook が先なら admin→API で上書き、または Webhook が既存行の quantityAfter 更新＋delta 補完。 |
| 売上（受注・履行） | orders/updated または OrderPendingLocation + inventory_levels/update | order_sales | オーダー数量（line_items.quantity）で確定。 |
| 返品 | refunds/create または inventory_levels/update 後で refund に更新 | refund | 返品数量で確定。 |
| 注文キャンセル | orders/updated（cancelled_at）または inventory_levels/update 後で order_cancel に更新 | order_cancel | 戻り数量。 |

---

## 3. 反映漏れ・二重になりうる箇所の洗い出し

### 3.1 inventory_levels/update Webhook

| # | リスク | 内容 | 現状の対策 | 残りうるギャップ |
|---|--------|------|------------|------------------|
| 1 | 既知アクティビティの見逃し | 検索が GID/数値の両方で行われていない | 両形式で検索済み（inventoryItemIdCandidates, locationIdCandidates） | 特になし |
| 2 | 時間窓外で API が遅延 | API が 30分超遅れて届くと、Webhook 側で既知ログにヒットせず admin_webhook で新規作成 | 窓は 30分前〜5分後。API が極端に遅いと「管理」のまま残る | 窓の拡大は二重リスクとトレードオフ。運用で「初回は管理画面を開く」案内で API 失敗を減らす |
| 3 | OrderPendingLocation のレース | Webhook 処理開始時点では未登録で、保存直前に orders/updated が登録するケース | 保存直前に OrderPendingLocation を再検索（18:29 型対策） | 再検索後〜create の間に別リクエストが割り込む可能性は理論上あり（DB トランザクション分離で軽減） |
| 4 | 連続売上で 2 件目が「別イベント」 | 既存 order_sales の quantityAfter ≠ 今回 available で新規 admin 作成 | 保存直前の OrderPendingLocation 再検索、既存 admin_webhook を order_sales に更新するブロック（20:11/20:14 型対策） | 2 件目用 OrderPendingLocation がまだ無いと「管理」で残る |
| 5 | 直近が admin_webhook のみの 2 本目 | 同一変動の 2 回目 Webhook で新規「管理」ができる | 2分前〜1分後の admin_webhook で quantityAfter 一致 or null ならその行を更新して新規を作らない | 特になし |
| 6 | idempotencyKey の重複 | 同一イベントが複数回送られて二重 create | updatedAt 秒単位で idempotencyKey、既存ならスキップ | 特になし |
| 7 | delta が null のまま残る | 直前ログが無く、adjustment_group も無い／取れない | 直前ログを遡って quantityAfter が null でない直近 1 件から delta 算出；既知アクティビティ行の quantityAfter 更新時に delta が null なら補完 | その item/location で履歴が 1 件も無い「初回」は delta=null 不可避（管理画面のみの仕様として注釈済み） |

### 3.2 api/log-inventory-change（POS）

| # | リスク | 内容 | 現状の対策 | 残りうるギャップ |
|---|--------|------|------------|------------------|
| 8 | セッションなしで 401 | 初回に管理画面を開いていないと API が失敗し、Webhook の「管理」だけ残る | セッションなしでも JWT から shop を取って保存する分岐あり；利用手順で「初回は管理画面を開く」案内 | トークン不正時は 401 のまま。案内遵守が前提 |
| 9 | admin_webhook の時間窓 | Webhook が先に admin で保存され、API が後から来るが窓外 | recentTo = max(ts+5分, now+2分) で広めに検索 | 極端な遅延ではヒットせず新規 create→二重の可能性（その場合は Webhook 側で既知ログ更新で 1 行にまとまる想定） |
| 10 | 同一 activity の二重 | POS の重複送信で入庫・出庫等が 2 行 | 同一 item/location/activity を時間窓で検索し、あれば update のみ | 特になし |
| 11 | order_sales/refund の二重 | orders/updated 等が先に記録した行に、同じ変動で API が新規 create | 時間窓で order_sales/refund を検索し、あれば update のみ | 特になし |
| 12 | ID 形式の不一致 | Webhook は数値ID・orders は GID で保存され、検索で漏れる | inventoryItemIdCandidates / locationIdCandidates で両方検索 | 特になし |

### 3.3 orders/updated（売上・キャンセル）

| # | リスク | 内容 | 現状の対策 | 残りうるギャップ |
|---|--------|------|------------|------------------|
| 13 | 救済の時間窓 | 注文編集で created_at が古く、編集直後の admin_webhook が窓外 | fulfillments なし時は **updated_at** 基準で 30分前〜5分後 | 特になし |
| 14 | ロケーション不明時の救済 | orderLocationId が null のとき、item だけで admin_webhook を検索すると他ロケーションを誤更新しうる | **対応済み**: ロケーション不明時は admin_webhook 救済を**行わない**。OrderPendingLocation のみ登録し、inventory_levels/update のマッチで order_sales に記録する | 特になし |
| 15 | 複数明細の並列処理 | 複数 line_items で inventory_levels/update が並列に来ると、1 件だけ救済漏れ | 保存直前の OrderPendingLocation 再検索で軽減済み | レースが残る場合は orders/updated の遅延要因 |
| 16 | order_cancel | キャンセル時の在庫戻りを order_cancel で記録 | 時間窓内の admin_webhook を order_cancel に更新して二重防止 | 特になし |

### 3.4 refunds/create

| # | リスク | 内容 | 現状の対策 | 残りうるギャップ |
|---|--------|------|------------|------------------|
| 17 | 時間窓 | 返品作成から時間が経ってから Webhook が届く | searchTo = max(返品作成+5分, 現在+2分) | 極端な遅延では救済漏れ |
| 18 | item/location の候補 | 数値と GID の両方で検索しているか | refunds/create では inventoryItemIdCandidates / locationIdCandidates で両形式検索済み | 特になし |

---

## 4. 強固化のための推奨対応

### 4.1 確実に実施すべきもの

1. **orders/updated：ロケーション不明時は救済を行わない（対応済み）**  
   - orderLocationId が null のとき、item のみで admin_webhook を検索すると他ロケーションの行を誤って order_sales に更新するリスクがあるため、**救済処理をスキップ**する実装に変更済み。  
   - OrderPendingLocation は従来どおり登録し、後から届く inventory_levels/update が OrderPendingLocation とマッチして order_sales で記録する。誤ロケーションへの order_sales 付与を防ぐ。

2. **refunds/create**  
   - 両形式（GID/数値）での検索は既に実装済み（inventoryItemIdCandidates / locationIdCandidates）。

3. **ドキュメント・チェックリストの更新**  
   - 本ドキュメントを `INVENTORY_ACTIVITY_REFLECTION_GUARANTEE.md` から参照し、公開アプリリリース前チェックリストに「ロケーション不明時の救済方針」を追記する。

### 4.2 運用で補うもの

- **初回は必ず管理画面でアプリを開く**  
  - POS の api/log-inventory-change が 401 にならないようにし、Webhook だけの「管理」残りを減らす。
- **Cron の日次スナップショット**  
  - 在庫高は別機能だが、トークンリフレッシュでセッションが維持され、Webhook/API の成功率が上がる。

### 4.3 監視・確認

- Render ログで次のメッセージを確認する:  
  `Updated recent admin_webhook (same event)`, `Remediated admin_webhook to order_sales`, `Updated admin_webhook to order_cancel`, `Before create: matched OrderPendingLocation`, `Updated existing admin_webhook to order_sales (avoid duplicate row)`.
- 変動履歴一覧で「想定どおり管理のみ・売上・返品・キャンセル戻りが 1 行ずつか」をスポット確認する。

---

## 5. 大量在庫処理（200SKU・1000個等）での漏れリスクと対策

### 5.1 漏れが発生しうる要因

| 要因 | 内容 |
|------|------|
| **API リクエストのタイムアウト** | POS が 200 件を 1 回の `api/log-inventory-change` で送ると、サーバー側で 200 件を順次処理する間に **リクエストがタイムアウト**（例: Render 30秒）する可能性がある。処理が途中で切れると、**処理済み分だけ正しいアクティビティで記録され、残りは API で記録されない**。後から届く `inventory_levels/update` だけが残り、それらは **「管理」** として記録される（アクティビティ反映の漏れ）。 |
| **Webhook の同時多発** | 200 SKU を一括変更すると、Shopify から **200 本前後の Webhook** が短時間に届く。各 Webhook は「その item/location の直近ログ」を見るため、**別々の item 同士で取り違えは起きない**。ただしサーバー負荷で一部 Webhook が遅延・リトライになる可能性はある（リトライ時は idempotencyKey で二重は防止される）。 |
| **レスポンス未受信でのクライアント挙動** | タイムアウトで API が途中で切れると、POS には「一部だけ成功」という情報が返らない。**リトライをしない**実装だと、未処理分は永続的に「管理」のまま残る。 |

### 5.2 対策（実装済み）

1. **POS 側でチャンク送信（実装済み）**  
   - `extensions/common/logInventoryChange.js` で、**deltas を 50 件ごとに分割**（`LOG_INVENTORY_CHANGE_CHUNK_SIZE = 50`）し、**複数回** `api/log-inventory-change` を呼ぶ。  
   - 200 件なら 4 リクエスト（50+50+50+50）となり、各リクエストがタイムアウト以内に完了し、**全件が正しいアクティビティで記録**される。  
   - チャンク送信は 2 件目以降のチャンクからログに `Sending in N chunks` と出る。

2. **運用での注意**  
   - 入庫・棚卸・ロスなど **大量件数を一度に確定する**運用では、上記チャンク送信により漏れを防ぐ。  
   - サーバー側のタイムアウトを延長するだけでは、ネットワークや DB 負荷で同じ問題が起きうるため、**チャンク送信が根本対策**となる。

3. **Webhook 側**  
   - 大量の Webhook が届いても、**同一 item/location で idempotencyKey と「直近 admin の同一イベント更新」** により二重は抑止される。  
   - アクティビティの「取り違え」は起きない（item/location 単位で検索しているため）。

---

## 6. まとめ

- **管理画面からの Webhook に変動数は含まれない** → 公式の InventoryLevel リソース仕様と一致。現状の「直前ログ or InventoryAdjustmentGroup から算出」が正しい対応。
- **反映漏れ・二重のリスク**は上記のとおり整理した。**orders/updated のロケーション不明時**は救済をスキップする実装に変更済みで、誤ロケーション更新を防止している。
- その他は、時間窓・OrderPendingLocation 再検索・同一 activity の更新・ID 両形式検索などで可能な範囲で強固化済み。
- **大量在庫処理**（200SKU 等）では、API の 1 リクエストあたりの件数が多すぎるとタイムアウトで途中で切れ、未処理分が「管理」で残る。**POS 側でチャンク送信**（例: 50 件ずつ）することで漏れを防ぐ。
- 公開アプリとして販売する場合は、本ドキュメントと `INVENTORY_ACTIVITY_REFLECTION_GUARANTEE.md` のチェックリストを合わせて確認するとよい。
