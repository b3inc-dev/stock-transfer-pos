# POS Lite で POS Stock が使えるかの見直し（2026-11-23）

T さんの要件（11/23 3:12）: POS Lite では Shopify POS の標準の在庫移管・受領などが使えない。なので POS Stock の POS タイルで **出庫・入庫・移管・棚卸** を行い、Shopify の在庫に反映する。

この文書は、POS Stock の **タイル（拡張機能の出し場所）と、使っている Admin API が POS Lite のロケーションで動くか** を、コードと Shopify の公式の説明で確かめた結果です。**実機ではまだ確かめていません。** 「設計上は動くはず」と「店で切り替えてよい」は分けて書きます（要件の「切替条件」のとおり）。

- 対象: main `a7e2fc7`（2026-11-23 時点）。アプリのコードは変えていない（docs だけ）。
- 「アプリの Lite プラン」（POS Stock の料金プラン。`extensions/common/planAccess.js`）と「POS Lite」（Shopify POS の契約）は別のもの。この文書で「Lite」と書くときは **POS Lite** のこと。アプリのプランは「アプリの Lite / Pro」と書く。

---

## 1. 結論（短く）

| 問い | 答え | 確かさ |
|---|---|---|
| POS Lite で標準機能として使えないものは何か | 「Receiving stock transfers」「Fulfilling and receiving transfers」「Tracking and adjusting inventory」は POS Pro だけ（Shopify の比較表）。「Changing inventory quantities」は Lite でも使える | 事実（出典 S1） |
| POS Stock はその標準機能に頼っているか | **頼っていない。** 7 つのタイルはすべて自前の画面（`pos.home.tile.render` / `pos.home.modal.render`）で、在庫は Admin GraphQL（`shopify:admin/api/graphql.json` とアプリのサーバー）で直接動かす | 事実（コード） |
| タイルの出し場所に POS Lite / Pro の制限があるか | Shopify の説明には **書かれていない**（プランの条件なし） | 事実（S2・S3・S4）。実機は未確認 |
| 使っている Admin API に Shopify のプラン・POS Pro の条件があるか | 移管・発送・受領・在庫の mutation の説明は「スコープ」と「在庫を管理する権限」だけ。**プランの条件は書かれていない** | 事実（S5〜S7）。実機は未確認 |
| Pro だけの機能に頼っているところはあるか | 見つかった所は 2 つ。どちらも止まらない作り: (1) スタッフ一覧（`staffMembers`）は `read_users` が無いので今も空で動く。(2) `staffMemberId` は POS-only スタッフ（Pro）でなくても取れる想定（未確認） | 事実＋未確認 |
| すぐ直すべき大きな穴 | POS Lite 専用の穴は見つからなかった。**ただし POS Lite と関係なく**、Admin API 2026-01 が使えなくなると 2026-04 に繰り上がり、在庫の mutation が `@idempotent` なしでエラーになる（4 章 G1）。期限の目安は 2027-01 ごろ（推測） | 事実＋推測 |
| 開発ストアで POS Lite を試せるか | **そのままでは試せない可能性が高い。** 開発ストアは引き渡すまで自動で POS Pro になる（S8）。ロケーションを Pro から外せるかは未確認（5 章） | 事実＋未確認 |

---

## 2. タイルごとの表（機能・Lite での動き方・根拠・未確認）

「在庫の書き方」の列: **直** = POS 拡張から Direct API（`shopify:admin/api/graphql.json`）で書く。**鯖** = アプリのサーバー（`/api/inventory/apply-change` など。セッショントークンで認証）が書く。

| タイル（handle） | できること | 在庫の書き方と主な API | Lite での動き方（設計） | 根拠 | 未確認 |
|---|---|---|---|---|---|
| 出庫（`stock-transfer-tile`） | 店から別ロケーションへの出庫＝**在庫移管の作成**。下書き・配送準備完了・確定（発送）・Shipment 追加・追跡番号 | 直: `inventoryActivate` → `inventoryTransferCreateAsReadyToShip`（だめなら `Create`→`MarkAsReadyToShip`）→ `inventoryShipmentCreate` → `SetTracking` → `inventoryShipmentMarkInTransit`。ほか `SetItems`・`Edit`・`Cancel`・`Delete`・`Duplicate`。鯖: 履歴 `/api/log-inventory-change`、補正 apply-change | POS 標準の「移管の出荷（Fulfilling transfers）」は使わず、Admin の Transfer/Shipment を直接作る。Lite でも同じ API | S5（スコープ `write_inventory_transfers`＋在庫管理の権限。プランの条件なし）。`docs/STATE_MACHINE.md` 2〜4 章 | Lite のロケーションを出庫元にして実機で作れるか |
| 入庫（`stock-transfer-inbound`） | 自店宛ての移管の一覧・受領（部分受領・残り受領・予定外・超過）・メモ | 直: `inventoryTransfers`・`inventoryShipment` を読む → `inventoryShipmentReceive`（だめなら `ReceiveItems`）→ `inventoryTransferEdit`（メモ）。鯖: 予定外・超過の補正は apply-change、履歴 | POS 標準の「受領（Receiving stock transfers）」は Pro だけ（S1）。アプリは標準の受領画面を使わず、Admin API で受領する | S6（スコープ `write_inventory_shipments_received_items`＋在庫管理の権限。プランの条件なし）、S7（読むのは `read_inventory_shipments`。`write_inventory_shipments` があるので読める） | Lite のロケーションを宛先にして実機で受領できるか。受領で Shopify の在庫（入庫先の手持ち）が増えるか |
| ロス（`stock-transfer-loss`） | 破損・紛失などで在庫を減らす | 鯖: apply-change（`inventoryAdjustQuantities` / `inventorySetQuantities`） | アプリのサーバーが書くので POS の契約とは関係しない想定 | S1（「Changing inventory quantities」は Lite でも可。アプリはそれも使わずに API で書く） | 実機 |
| 棚卸（`stock-transfer-stocktake`） | 数えた数で在庫を合わせる。確定・メタフィールドの再試行 | 鯖: apply-change（`inventorySetQuantities`、`changeFromQuantity` 付き）→ `/api/pos-stocktake-complete`。直: 読み取り・`inventoryActivate`・`metafieldsSet` | 同上。POS 標準の在庫数え（Pro の「Tracking and adjusting inventory」）は使わない | `docs/STATE_MACHINE.md` 11 章 | 実機 |
| 調整（`stock-transfer-adjustment`） | 数を直接直す | 鯖: apply-change | 同上 | 同上 | 実機 |
| 仕入（`stock-transfer-purchase`） | 仕入れで在庫を増やす | 鯖: apply-change。直: 記録の `metafieldsSet` | 同上 | 同上 | 実機 |
| 発注（`stock-transfer-order`） | 発注の依頼を記録する（**在庫は動かさない**） | 直: `metafieldsSet`（アプリのメタフィールドに記録）。管理画面の発注（`app/routes/app.order.tsx`）で移管を作る | 在庫を動かさないので Lite の影響は小さい | コード（`orderApi.js` の `adjustInventoryAtLocation` はタイルから呼ばれていない） | 実機 |

### 要件の 4 つ（出庫・入庫・移管・棚卸）との対応

| 要件 | POS Stock での担い手 | 補足 |
|---|---|---|
| 出庫 | 出庫タイル | 出庫＝移管の作成と発送 |
| 入庫 | 入庫タイル | 受領で入庫先の在庫が増える |
| 移管 | 出庫タイル＋入庫タイル（管理画面の履歴・発注からも作れる） | POS Stock には「移管」という別のタイルは無い。出庫元＝今の POS のロケーション（`docs/BUSINESS_RULES.md` 1 章） |
| 棚卸 | 棚卸タイル | 自社用（Ciara・inhouse）は全機能が使える。**公開用ではアプリの Pro プランが要る**（`planAccess.js`。アプリの Lite プランは出庫・入庫だけ） |

---

## 3. 共通の前提（全タイルに効くもの）

| 項目 | 事実 | Lite での見方 | 未確認 |
|---|---|---|---|
| 出し場所 | 7 つとも `pos.home.tile.render` と `pos.home.modal.render`（各 `shopify.extension.toml`）。`api_version = "2026-01"` | Shopify の説明にプランの条件は無い（S2・S3）。スマートグリッドのテンプレートにタイルを置くと、そのテンプレートを使う全ロケーションに出る（S4） | Lite のロケーションのスマートグリッドにタイルを置けるか・出るか |
| Direct API | `fetch("shopify:admin/api/graphql.json")`。POS 10.6.0 以上・拡張 2025-07 以上で使える（S2）。オフラインでは動かない（S2） | 契約の条件は書かれていない | — |
| セッショントークン | `shopify.session.getSessionToken()` でアプリのサーバーを呼ぶ（apply-change・履歴・プラン確認）。トークンは **ログインしているユーザー** のもので、PIN で切り替えたスタッフのものではない。ユーザーにアプリの権限が無いと `undefined`（S9） | アプリは `undefined` なら送らずにエラーで止まる（`applyInventoryChange.js`）。在庫は動かない（安全側） | Lite の店の POS にログインしているアカウントに、アプリと「在庫を管理する」権限があるか（S5・S6 の「user must have permission to manage inventory」も同じ人に効くと推測） |
| 今の場所・スタッフ | `session.currentSession.locationId`（出庫元・入庫先）、`staffMemberId`（記録に使う。無くても動く） | `locationId` は契約によらず出る想定 | Lite で `staffMemberId` が入るか。「Unlimited POS-only staff」「Retail staff permissions」は Pro だけ（S1） |
| スタッフ一覧 | `/api/staff-members` → `staffMembers`。`read_users` を持っていないので、今も空の一覧を返して動く（`docs/ERROR_DEPLOY_READ_USERS_SCOPE.md`） | Lite でも同じ（空のまま）。Pro に頼っていない | — |
| スコープ | 自社用・公開用とも `read/write_inventory`・`read/write_inventory_transfers`・`write_inventory_shipments`・`write_inventory_shipments_received_items`・`read_locations`・`read_products`（自社用だけ `read_orders`） | 移管・受領に要るスコープはそろっている | — |
| Webhook | `inventory_levels/update`・`orders/updated`・`refunds/create` は履歴に取り込むだけ（在庫は動かさない） | Lite の店の売上でも同じ | — |
| アプリのプラン（公開用だけ） | アプリの Lite = 出庫・入庫、アプリの Pro = 全部（棚卸・ロスも） | 店が POS Lite かどうかとは関係しない。名前が似ているので案内に注意 | — |

---

## 4. 見つかった穴と直し方（このPRでは直さない）

| # | 穴 | POS Lite と関係するか | 直し方の案 | 大きさ |
|---|---|---|---|---|
| G1 | Admin API 2026-04 から、`inventoryTransferCreate`・`inventoryTransferCreateAsReadyToShip`・`inventoryTransferSetItems`・`inventoryTransferDuplicate`・`inventoryShipmentCreate`・`inventoryShipmentReceive`・`inventoryAdjustQuantities`・`inventorySetQuantities`・`inventoryActivate` などは `@idempotent` が無いと実行時にエラーになる（S10）。アプリは 2026-01 で、`@idempotent` を 1 か所も使っていない。2026-01 が使えなくなると、一番古い使える版に繰り上がる（S11） | 関係しない（全プラン）。ただし Lite で「アプリだけが頼り」になるので影響は大きい | 別 PR で、POS 拡張とサーバーの在庫の mutation に `@idempotent(key: …)` を付ける。キーは今の再試行の ID（出庫のチェックポイントの attemptId・apply-change の `appEventId`）から作る。拡張とサーバーの `api_version` を上げる前に入れる。`STATE_MACHINE.md` の冪等の表も直す | 大（★ 相当。在庫を動かす全経路） |
| G2 | 開発ストアは自動で POS Pro（S8）。今の開発ストアの試しは Pro の上で通っているだけで、Lite の証拠にならない | 関係する | 5 章の手順でロケーションを Pro から外せるか確かめる。外せなければ、Lite の実機の確かめは本番のロケーション（T さんの承認）で、在庫を動かさない読み取りから始める | 中（手順） |
| G3 | 「アプリの Lite / Pro」と「POS Lite / Pro」の名前が同じ | 関係する（案内の取り違え） | 掲載文・料金プランの画面で「POS Stock の Lite プラン」と書き、POS の契約とは別だと 1 行足す（docs・文言だけ。別 PR） | 小 |
| G4 | ログインしているアカウントにアプリ・在庫管理の権限が無いと、トークン・Direct API が使えない（S5・S9）。Lite には「Retail staff permissions」が無い（S1） | 関係する（推測） | 実機で確かめてから、利用者マニュアルに「POS にログインするアカウントの権限」を書く | 小（docs） |

POS Lite だけのための **アプリのコードの直しは今のところ要らない**（実機で違いが出たら足す）。

---

## 5. 開発ストア（bbbincbbb）で POS Lite を確かめる手順

開発ストアは `bbbincbbb` だけを使う（新しく作らない）。在庫を動かすのは開発ストアの中だけ。本番の店では行わない。

### 5.1 準備

1. 開発ストアに **自社用「POS Stock - Ciara」と公開用「POS Stock」のどちらが入っているか** を管理画面 → アプリ で見る。Ciara で使うのは自社用なので、できれば自社用の版で確かめる（公開用なら、棚卸・ロスを試すにはアプリの Pro のテスト契約が要る）。
2. ロケーションを 2 つ用意する（A: Lite にしたい店、B: 相手の店）。管理画面 → 設定 → ロケーション。
3. 試す商品を 2 つ用意し、A と B の両方で在庫を追跡する。数を控える（例: A=10、B=5）。

### 5.2 ロケーション A を POS Lite にする（できるかを確かめる）

1. 管理画面 → 販売チャネル → Point of Sale → 設定 → **POS Pro Subscription**（S12）。
2. A を選び「Cancel POS Pro」→「Confirm downgrade」。
3. 結果を記録する:
   - すぐ Lite になった → 5.3 へ。
   - 30 日の期間の終わりまで Pro のまま（S12 の「Downgrades take effect at the end of the current 30-day billing cycle」）、またはボタンが無い → **開発ストアでは Lite を試せない**（S8）。5.5 へ。
4. Lite になったかは、POS アプリで A にログインし、標準の「移管の受領」などが出ない・使えないことで確かめる（表示は未確認。見えたものを書き残す）。

### 5.3 POS アプリでタイルを出す

1. POS の端末（iPad / iPhone）に最新の POS アプリを入れ、A にログインする。ログインするアカウントの権限（アプリ・在庫の管理）を控える。
2. 管理画面 → Point of Sale → 設定 → POS editor で、A が使うスマートグリッドのテンプレートに 7 つのタイルを置く（S4）。
3. POS のホームにタイルが出るかを見る。

### 5.4 確かめる項目（A が Lite のとき）

各行で「期待」「見えたこと」「Shopify の管理画面の数」「アプリの履歴」を記録する。合成データだけを使う。

| # | 操作 | 期待 | 見る所 |
|---|---|---|---|
| L1 | 7 つのタイルを開く | すべて開く。プランの止め（公開用）以外で止まらない | POS |
| L2 | 出庫: A → B に商品 1 を 3 個、「確定する」 | Transfer が「処理中」、Shipment が「進行中」。A の手持ちが 3 減る（Shopify の動きどおり） | 管理画面 → 商品 → 移管、在庫 |
| L3 | 入庫: B を Lite にできたなら B で、できなければ A 宛ての移管を B から作って A で受領。予定 4 → 2 受領 → 残り 2 受領 | 受領の合計 4。入庫先の手持ちが 4 増える。2 回目に二重にならない | 移管の受領の数、在庫、アプリの履歴 |
| L4 | 入庫の受領中に機内モード → 戻して再確定 | 二重に受領しない（`STATE_MACHINE.md` 7 章の入庫の行） | 同上 |
| L5 | 棚卸: A で商品 2 を数えて確定 | Shopify の A の数が数えた数になる。メタフィールドも完了 | 在庫、アプリの棚卸の履歴 |
| L6 | ロス・調整・仕入: A で 1 個ずつ | 数が 1 ずつ動く。押し直しで二重にならない | 在庫、アプリの履歴 |
| L7 | 発注: A で 1 件記録 | 在庫は動かない。管理画面の発注に出る | 管理画面の発注 |
| L8 | PIN で別のスタッフに切り替えて L6 | 動く（トークンはログインしているアカウントのもの、S9）。履歴のスタッフの欄が空でもよい | アプリの履歴 |
| L9 | ログインするアカウントの「アプリ」の権限を外して L6 | 在庫は動かず、エラーが出る（安全側） | POS、在庫 |
| L10 | A で普通に販売 1 件 | `inventory_levels/update` などで履歴に入る | アプリの履歴 |

### 5.5 開発ストアで Lite にできなかったとき

- 5.4 を Pro のまま行い、「アプリが POS 標準の移管・受領を使っていない」ことだけを確かめる（標準の画面を一度も開かずに L2〜L7 が終わるか）。これは **Lite の証拠ではない**ので、表には「Pro で確認・Lite は未確認」と書く。
- Lite の実機の確かめは、本番の店のロケーションを Lite に切り替えるとき（T さんの承認）に、まず L1（開く）と読み取りだけ、次に 1 件ずつ、の順で行う。

### 5.6 記録の置き場

結果は連絡帳 #79 と Issue #48（実機の合格の証拠）に、合成データ・期待・見えたこと・対象の版（拡張の版と main のコミット）・合否で書く。店の情報・トークン・生のログは書かない。

---

## 6. 未確認の一覧（まとめ）

1. POS Lite のロケーションで 7 つのタイルが出るか（S2〜S4 に条件は無いが、実機は未確認）。
2. POS Lite のロケーションで Admin API の移管の作成・発送・受領が通るか（S5〜S7 にプランの条件は無いが、実機は未確認）。
3. 受領で入庫先の Shopify の在庫が増えるか（Shopify の動き。実機で数を見る）。
4. Lite で `staffMemberId` が入るか。POS にログインするアカウントに要る権限。
5. 開発ストアでロケーションを POS Pro から外せるか（S8・S12）。
6. G1 の期限（2026-01 がいつまで使えるか。S11 は「最低 12 か月」とだけ書いている）。

---

## 7. 出典（2026-11-23 に開いて確かめた）

| # | ページ | 確かめたこと |
|---|---|---|
| S1 | [Comparing POS Lite and POS Pro subscriptions](https://help.shopify.com/en/manual/sell-in-person/getting-started/pos-subscription-overview) | Pro だけ: Receiving stock transfers / Fulfilling and receiving transfers / Tracking and adjusting inventory / Retail staff permissions and management / Unlimited POS-only staff など。両方: Changing inventory quantities / Staff PINs。アプリ（拡張）については書かれていない |
| S2 | [POS UI extensions](https://shopify.dev/docs/api/pos-ui-extensions.md) | プランの条件は書かれていない。Direct API は POS 10.6.0 以上・拡張 2025-07 以上。オフラインでは Direct API は動かない |
| S3 | [Home screen targets](https://shopify.dev/docs/api/pos-ui-extensions/latest/targets/home-screen.md) | `pos.home.tile.render` / `pos.home.modal.render` の使える API。プランの条件は書かれていない |
| S4 | [Managing your POS Apps](https://help.shopify.com/en/manual/sell-in-person/getting-started/shopify-pos-from-admin/pos-ui-extensions) | タイルは POS editor でテンプレートに置く。そのテンプレートを使う全ロケーションに出る。プランの条件は書かれていない |
| S5 | [inventoryTransferCreateAsReadyToShip（2026-01）](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/inventoryTransferCreateAsReadyToShip) | `write_inventory_transfers` と「在庫を管理する権限」。プランの条件なし |
| S6 | [inventoryShipmentReceive](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryShipmentReceive) | `write_inventory_shipments_received_items` と「在庫を管理する権限」。プランの条件なし。2026-04 から冪等のキーが必須 |
| S7 | [InventoryShipment（2026-01）](https://shopify.dev/docs/api/admin-graphql/2026-01/objects/InventoryShipment) | `read_inventory_shipments`。プランの条件なし |
| S8 | [How to build a Shopify POS demo store](https://www.shopify.com/partners/blog/how-to-build-shopify-pos-demo-store) | 開発ストアは引き渡すまで自動で POS Pro |
| S9 | [Session API（2025-10）](https://shopify.dev/docs/api/pos-ui-extensions/2025-10/target-apis/standard-apis/session-api) | トークンはログインしているユーザーのもの（PIN のスタッフではない）。権限が無いと `undefined` |
| S10 | [Making idempotency mandatory for inventory adjustments and refund mutations](https://shopify.dev/changelog/making-idempotency-mandatory-for-inventory-adjustments-and-refund-mutations) | 2026-04 から在庫・ロケーションの 16 の mutation と `refundCreate` で冪等が必須。無いと実行時エラー |
| S11 | [About Shopify API versioning](https://shopify.dev/docs/api/usage/versioning) | 各版は最低 12 か月。使えない版を指定すると、一番古い使える版で答える |
| S12 | [Choosing your POS app subscription](https://help.shopify.com/en/manual/sell-in-person/getting-started/identify-your-pos-needs) | ロケーションごとに Pro を付け外しする手順。外すのは 30 日の期間の終わりに効く |
