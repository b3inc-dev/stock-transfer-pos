# IDEMPOTENT_MIGRATION — 在庫の書き込みに `@idempotent` を付ける設計（下書き）

状態: **設計の下書き（docs だけ）**。アプリのコードはまだ変えていない。実装は T さんの承認のあと、下の「入れる順」の PR に分けて行う。
書いた日: 2026-11-23（とりまとめ側の Claude Code）
関連: [`STATE_MACHINE.md`](./STATE_MACHINE.md)（正本）・[`DECISIONS.md`](./DECISIONS.md) の D1・D3・D3b・D3c・D4・D9・[`POS_LITE_READINESS.md`](./POS_LITE_READINESS.md) の G1（#106）

---

## 1. なぜ要るか（事実）

| 事実 | 出どころ |
|---|---|
| Admin API **2026-04** から、在庫・ロケーションの 16 の mutation と `refundCreate` は `@idempotent(key: …)` が無いと**実行時にエラー**になる。スキーマ上は必須に見えない（型チェックで気づけない） | [必須化の changelog](https://shopify.dev/changelog/making-idempotency-mandatory-for-inventory-adjustments-and-refund-mutations) |
| **2026-01** では付けても付けなくてもよい（このアプリの今の版）。つまり**今の版のまま先に付けられる** | [追加の changelog](https://shopify.dev/changelog/adding-idempotency-for-inventory-adjustments-and-refund-mutations) |
| キーは変数で渡せる（`@idempotent(key: $idempotencyKey)`）。UUID を勧める。決まった材料から作るなら UUID v5 の例がある | [実装の手引き](https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency) |
| Shopify がキーを覚えるのは最初の送信から **24 時間**。過ぎると同じキーでも新しい操作として動く | 同上 |
| 同じキー・同じ中身の 2 回目: 前が通っていれば**もう一度は動かさず答えだけ返す**。前が処理中なら `IDEMPOTENCY_CONCURRENT_REQUEST`（少し待って同じキーで）。前が断られていれば**同じ断り**が返ることがある | 同上 |
| 同じキー・違う中身: `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`（`userErrors`、`field: null`）。引数の並び順も見られることがある | 同上 |
| 前の送信で作ったものが後で消されていると `*_NOT_FOUND`（例 `SHIPMENT_NOT_FOUND`）。新しいキーにするのは「本当に作り直したい」ときだけ | 同上 |
| 2026-04 では `inventoryAdjustQuantities` などに `changeFromQuantity` も必須（いらないときは `null` をはっきり書く）。`inventorySetQuantities` は `changeFromQuantity` が必須（このアプリはもう付けている） | [changeFromQuantity の必須化](https://shopify.dev/changelog/making-changefromquantity-field-required)・D9 |
| 使えなくなった版を指定すると、一番古い使える版で答える。2026-01 が使えるのは **2027-01-16 15:00 UTC（日本時間 1/17 0:00）まで**。そのあとは自動で 2026-04 になり、このアプリの在庫の書き込みが止まる | [API の版](https://shopify.dev/docs/api/usage/versioning) |

推測: POS 拡張の Direct API（`shopify:admin/api/graphql.json`）は拡張の `api_version`（今は全部 `2026-01`）の版で答える。Shopify の POS のページには書いていない。
未確認: キーの長さの上限。キーがストアごとかアプリごとか。→ どちらにも困らないように、36 文字の UUID にし、材料にストアを入れる（3 章）。

全リポジトリの影響の一覧はとりまとめのメモ（`plan/idempotent-impact.md`）。このアプリは **`@idempotent` を 1 か所も使っていない**。

---

## 2. このアプリで付ける所（`main` の今）

| # | 経路 | 場所（関数） | mutation | 使っているか |
|---|---|---|---|---|
| A | POS 出庫の作成 | `ModalOutbound.jsx` `inventoryTransferCreateAsReadyToShip`（`createTransferReadyToShipWithFallback`） | `inventoryTransferCreateAsReadyToShip` | 使う |
| B | 同上（READY が無い古い版の代わり） | 同 `inventoryTransferCreateDraft` → `inventoryTransferMarkAsReadyToShip` | `inventoryTransferCreate` | 推測でほぼ通らない（2026-01 には READY の mutation がある） |
| C | POS 出庫の下書き保存 | 同 `inventoryTransferCreateDraftSafe`（`draft_transfer`） | `inventoryTransferCreate` | 使う |
| D | POS 出庫の Shipment | 同 `createInventoryShipmentDraft`（`createInventoryShipmentInTransit` から） | `inventoryShipmentCreate` | 使う |
| E | POS 出庫の編集・明細の追加 | 同 `inventoryTransferSetItemsSafe`（5 か所） | `inventoryTransferSetItems` | 使う |
| F | POS の在庫を使えるようにする | 同 `ensureInventoryActivatedAtLocation`・`inboundApi.js` の有効化 | `inventoryActivate` | 使う |
| G | POS 入庫の受領 | `inboundApi.js` `receiveShipmentWithFallbackV2`（`InboundListScreen.jsx` から 8 か所） | `inventoryShipmentReceive` | 使う |
| H | POS 出庫の「全部拒否で戻す」 | `ModalOutbound.jsx` `receiveShipmentWithFallbackV2` | `inventoryShipmentReceive` | 使う |
| I | サーバー apply-change（ロス・仕入れ・調整・棚卸・入庫補正） | `inventory-set-quantities-server.ts` `setInventoryQuantitiesServer`（前に進む・元に戻す） | `inventorySetQuantities` | 使う |
| J | 同上の有効化 | `ensure-inventory-activated-server.ts` `ensureInventoryActivatedAtLocation` | `inventoryActivate` | 使う |
| K | 管理画面の棚卸の確定・取り消し | `app.inventory-count.tsx` `adjustInventoryQuantitiesServer`（4 か所） | `inventorySetQuantities` | 使う |
| L | 管理画面の発注から移管 | `app.order.tsx` `createTransferForOrder` | `inventoryTransferCreateAsReadyToShip`・`inventoryTransferCreate` | 使う |
| M | 管理画面の仕入れの確定・取り消し | `app.purchase.tsx` `executePurchaseReceive`・`executePurchaseCancel` | `inventoryAdjustQuantities` | 使う。**`changeFromQuantity` も無い** |
| N | 呼び出し元が見つからない | `ModalOutbound.jsx` `inventoryTransferDuplicateSafe`、`inventory-set-quantities-server.ts` `adjustInventoryQuantitiesServer`、ロス・発注・仕入れ・調整・棚卸の拡張の `adjustInventoryAtLocation`／`adjustInventoryToActual`（とその中の有効化） | `inventoryTransferDuplicate`・`inventoryAdjustQuantities`・`inventorySetQuantities`・`inventoryActivate` | 推測で使っていない（`git grep` で呼び出しなし） |

17 の一覧に無いもの（`inventoryTransferMarkAsReadyToShip`・`inventoryShipmentMarkInTransit`・`inventoryShipmentSetTracking`・`inventoryTransferCancel`・`inventoryTransferDelete`）は、今は付けない。ただし ciara-system には `inventoryShipmentSetTracking` で「@idempotent が要る」と返った前提のテストがあるので、5 章の B で 2026-04 のときに確かめる。
`inventoryShipmentReceiveItems`（G・H の最初の試し）は推測で今の版に無い mutation。毎回エラーになってから `inventoryShipmentReceive` に進んでいる。実装の PR で消す。

---

## 3. キーの作り方

### 3.1 決まり（全部の経路で同じ）

```text
key = UUIDv5(名前空間, "pst1|" + shop + "|" + 操作の種類 + "|" + 操作の ID + "|" + 段 + "|" + チャンク + "|" + 回)
名前空間 = c5bcfcd2-b8f6-422b-a82c-b16e257f07a2（このアプリ専用。変えない）
```

| 材料 | 意味 | 変わるとき |
|---|---|---|
| `shop` | ストアの domain | — |
| 操作の種類 | `outbound_create`・`apply_change` など（4 章） | — |
| 操作の ID | **今ある再試行の ID**（出庫は `attemptId`、apply-change は `InventoryChangeEvent.id` など）。同じ操作の送り直しでは変わらず、新しい操作では必ず変わるもの | 新しい操作のとき |
| 段 | 1 つの操作の中の書き込みの種類（`transfer`・`shipment`・`set_fwd`・`set_rb` など） | — |
| チャンク | 250 件ずつに分けた何番目か（`1/3`）。分けないときは `1/1` | — |
| 回 | 同じ操作・同じ段で、**はっきり断られたあと**や、**わざと中身を変えて送り直す**とき（読み直して書き直すなど）だけ 1 つ増やす。応答なし・時間切れ・5xx・429・処理中の送り直しでは**増やさない** | 4 章 |

- 同じ操作の送り直し（応答なし・時間切れのあと）→ 材料が全部同じ → **同じキー** → Shopify は 2 回目を動かさない。
- 新しい操作（ボタンをもう一度押して新しく作る）→ 操作の ID が変わる → **新しいキー**。
- はっきり断られた（`userErrors`）あとに直して送る → 回が増える → **新しいキー**（同じキーだと、前の断りがそのまま返ることがあるため）。
- **書いたあとに元に戻した（取り消した）ものを、もう一度同じ中身で送るときは、必ず回を増やす**。同じキーだと、Shopify は前の成功の答えだけを返して書かない（戻したままになるのに「成功」と読める）。例: 250 件を超えて先のチャンクを書いてから戻したあとの丸ごとの呼び直し（4.5 の `tr1`）、管理画面の棚卸の確定 → 取り消し → 確定（4.6）、POS 出庫の作り直し（4.1）。
- UUID にするのは長さの上限が分からないため（36 文字。Shopify の例と同じ形）。材料に個人の情報（名前・メール）は入れない。ID だけ。
- 計算は POS とサーバーで同じにする: POS は `extensions/common/idempotencyKey.js`（SHA-1 を JS で書く。`crypto.subtle` が POS にあるかは未確認なので頼らない。部品は足さない）、サーバーは `app/utils/idempotency-key.server.ts`（`node:crypto`）。同じ材料から同じ UUID が出ることを同じテストの表（入力と答え）で確かめる。

### 3.2 ID の持ち方（STATE_MACHINE と DECISIONS に合わせる）

- **ID は送る前に端末（`SHOPIFY.storage`）かデータベースに残す**。送ったあとに残すと、応答なしのときに ID が消えて次が新しい操作になる（D3c と同じ考え）。
- **ID を手放すのは、成功がはっきりしたときと、はっきり断られたときだけ**（D3c の `finalRejection`）。分からない失敗では残す。
- **24 時間**: Shopify がキーを覚えているのは 24 時間。端末の ID（チェックポイント・D3c の ID）は 24 時間より長く残ることがある。なので**キーだけに頼らない**。今の守り（note の `[pos-cp:…]` の照会・`InventoryChangeEvent` の状態・入庫の `alreadyAccepted` の差分）はそのまま残す。チェックポイントが 23 時間より古いときは、送り直す前に必ず note の照会をする（pre-stock の `PENDING_MAX_MS = 23h` と同じ考え）。
- **2 台の端末**: 端末ごとに ID が違うので、キーでは防げない（STATE_MACHINE §7 の「同時実行（2 端末）」は**高**のまま）。

### 3.3 返事の扱い（新しく足す）

| 返事 | どうするか | ID |
|---|---|---|
| `IDEMPOTENCY_CONCURRENT_REQUEST` | 前の送信がまだ処理中。1 秒・2 秒・4 秒と待って**同じキーで**送り直す。POS は 20 秒の上限（D4）の中で、間に合わなければ「結果が分からない」として扱う | 残す |
| `IDEMPOTENCY_KEY_PARAMETER_MISMATCH` | 同じキーで中身を変えた＝**こちらの作りの間違い**。新しいキーで送り直さない（送り直すと二重になりうる）。「結果が分からない」としてログに残し、画面は「管理者が Shopify で確かめる」を出す | 残す |
| `*_NOT_FOUND`（前に作ったものが消されている） | 自動で作り直さない。今の状態を読んでから決める（画面は失敗として出す） | 手放す（はっきりした断り） |
| 前の送信と同じ答え（作った Transfer の ID など） | 成功として続ける。返事の中身は「今の」データから作られる（状態が前と違うことがある）ので、状態の値で分かれる処理は読み直してから | 成功で手放す |
| `@idempotent` が無いと言われた（トップの `errors`） | 付け忘れ。テスト（6 章）で出ないようにする | — |

`assertNoUserErrors` は今、`userErrors` があれば全部「はっきりした断り」として投げている。上の 2 つ（処理中・中身の違い）は**はっきりした断りに入れない**ように分ける（`finalRejection` に入れない）。

---

## 4. 経路ごとのキー

### 4.1 POS 出庫の作成（A・B・C・D。チェックポイントあり）

今の守り: `runChunkedOutboundCreateWithCheckpoint`（`outboundCreateCheckpoint.js`）が、作成の前に `attemptId` と指紋（`fingerprint`）を `SHOPIFY.storage` に残し、チャンクごとに進み具合を残す。同じ指紋の再確定は同じ `attemptId` で続きから。違う指紋は新しい `attemptId`（D3b）。

| 段 | mutation | 操作の ID | 段の名前 | チャンク | 回 |
|---|---|---|---|---|---|
| A | `inventoryTransferCreateAsReadyToShip` | `cp.attemptId` | `transfer_ready` | `i/n` | `cp.rounds[i].transfer`（新しい欄。初めは 0） |
| B | `inventoryTransferCreate`（A の代わり） | 同上 | `transfer_draft_for_ready` | 同上 | 同上 |
| C | `inventoryTransferCreate`（下書き保存） | 同上 | `transfer_draft` | 同上 | 同上 |
| D | `inventoryShipmentCreate` | 同上 | `shipment` | 同上 | `cp.rounds[i].shipment` |

- 時間切れ → 再確定（同じ指紋）→ 同じ `attemptId`・同じチャンク・同じ回 → **同じキー**。24 時間の中なら、note の照会の前に Shopify が前の Transfer をそのまま返す。照会（`confirmTransferAfterTimeout`）はそのまま残す（24 時間を過ぎたとき・別の経路の守り）。
- `afterRecoveredChunk`（Transfer は見つかったが Shipment が無い）の Shipment も同じキー → **前の Shipment ができていたのに記録できなかった場合の二重の Shipment**（今の残る穴）も 24 時間の中なら防げる。
- `userErrors` で断られた → そのチャンクの回を 1 つ増やしてチェックポイントに残してから投げる。次の再確定は新しいキー（同じキーだと同じ断りが返るため）。
- 明細を変えて再確定 → 指紋が変わる → 新しい `attemptId` → 新しいキー（今と同じ）。
- 段 B は A と中身が違う mutation なので段の名前を分ける（同じキーで違う mutation を送らない）。
- Shipment のあとの `inventoryShipmentSetTracking`・`inventoryShipmentMarkInTransit` は今は付けない（2 章）。

### 4.2 POS 出庫の編集・明細の追加（E と、そこからの D）

今は再試行の ID が無い。`inventoryTransferSetItems` は「明細をこの形にする」書き込みなので、同じ中身を 2 回送っても結果は同じ。困るのは「A → B → A と 24 時間の中で直したときに、3 回目が 1 回目の答えだけ返して書かれない」こと。

| 材料 | 中身 |
|---|---|
| 操作の種類 | `outbound_edit` |
| 操作の ID | `transferId` + **編集を始めたときに読んだ明細の指紋**（`inventoryItemId:quantity` を並べたもの。`buildOutboundCreateFingerprint` と同じ並べ方） |
| 段 | `set_items`（明細の追加で Shipment も作るときは `shipment`） |
| チャンク | `1/1`（分けるときは `i/n`） |
| 回 | 送る明細の指紋（下の「中身の指紋」）。断られたら `+1` |

- 編集の前の形が違えば必ず新しいキーになる（A → B → A の 3 回目は前の形が B なので別のキー）。
- 応答なしのあとに読み直さずに押し直す → 同じキー。読み直してから押し直す → 前の形が変わっているので新しいキーだが、同じ形にするだけなので二重にはならない。
- 「中身の指紋」を材料に入れるのはここと 4.4 だけ（操作の ID が中身を決めていないため）。ほかは操作の ID が中身を決めているので入れない。

### 4.3 有効化（F・J）

`inventoryActivate` は「この置き場所で在庫を使えるようにする」。2 回目は「もう使える」になるだけのことが多いが、`available`・`onHand` を渡すとき（F の初めの数）は二重に気をつける。

| 経路 | 操作の ID | 段 | 回 |
|---|---|---|---|
| POS 出庫・入庫（F） | 親の操作の ID（出庫は `attemptId`、編集は 4.2、入庫は 4.4） | `activate:<locationId>:<inventoryItemId>:<available>:<onHand>` | 在庫の追跡を直したあと・断られたあとは `+1` |
| 親の操作が無い呼び出し（取り消しのときの有効化など） | 呼ぶたびに新しい UUID（同じ呼び出しの中の送り直しだけ同じ） | 同上 | — |
| サーバー（J） | `InventoryChangeEvent.id` | `activate:<location>:<item>:<initial>:<initial>`（F と同じ形。初めの数を渡さないときは `-`） | 呼ぶ場所ごとに分ける（最初 `main`・失敗分のやり直し `act_retry1`/`act_retry2`・確かめのあとの足し `verify1`・在庫が無いと言われたあと `ns1`）。はっきり断られるたびに `.rej1`… |

### 4.4 POS 入庫の受領（G・H）

今の守り: 送る数は「受け取りたい数 − もう受け取った数（`alreadyAccepted`）」の差分。確定のあとの伝票の読み直しが終わるまでロックを外さない（`receiveReloadGate.js`）。履歴の `appEventId` は `buildInboundReceiveLogAppEventId`（差分から作る）。

| 材料 | 中身 |
|---|---|
| 操作の種類 | `inbound_receive`（H は `outbound_reject_all`） |
| 操作の ID | `shipmentId` + **伝票を読んだときの各明細の受け取り済み・拒否済みの数の指紋** |
| 段 | `receive_v2`（`reason` 付き）・`receive_v2b`（`reason` なしで送り直す）・`receive_capped`（予定を超えた分を外して送り直す）・`reject`（不足分の拒否） |
| チャンク | 分けて送るときは `i/n` |
| 回 | 送る明細の指紋（`shipmentLineItemId:quantity:reason`）。断られて有効化してから送り直すときは `+1` |

- 応答なしのあと読み直さずに押し直す → 同じキー → 二重に受け取らない。
- 読み直したあと → 受け取り済みが変わっているので差分が 0 になり送らない（今と同じ）。受け取れていなかったら前の形と同じなので同じキー（Shopify が前の失敗を返したら、はっきりした失敗として扱う）。
- 入庫先で在庫が無いと断られる → 有効化 → 同じ中身で送り直す、は今のコードにある。ここは**回を増やす**（増やさないと前の断りがそのまま返る）。
- `receive_v2b`・`receive_capped` は中身が違うので段を分ける（同じキーで違う中身を送ると `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`）。

### 4.5 サーバー apply-change（I・J）

今の守り: `appEventId`（POS が送る前に端末に残し、答えが出るまで持つ。D3c）。サーバーは `InventoryChangeEvent` に 1 行作る。`completed` は即 OK、`pending`・`applying` は 202、`failed` は**行を消して作り直す**（`id` が新しくなる）。

| 段 | 操作の ID | 段の名前 | チャンク | 回 |
|---|---|---|---|---|
| 前に進む書き込み | `InventoryChangeEvent.id` | `set_fwd` | `ci/n` | 下の表 |
| 元に戻す書き込み | 同上 | `set_rb` | `ri/n` | 同上 |
| 有効化 | 同上 | 4.3 | — | 4.3 |

`appEventId` でなく行の `id` を使う理由: `failed` の送り直しは行を作り直して最初から処理する（STATE_MACHINE §6）。`appEventId` をそのまま使うと、24 時間の中では前の失敗の答えが返って書けない。行の `id` なら処理の回ごとに変わる。

| いつ | 回 | 理由 |
|---|---|---|
| 1 回目 | `main` | — |
| `withGraphQLRetry` の 429・503 の送り直し | 同じ | 結果が分からない送り直し |
| `isTransientError` の丸ごとの送り直し | `tr1`（新しい回） | ここに来るのは在庫が動いていないとはっきりしているとき（はっきり断られた・元に戻すのが成功で終わった・読めずに止めた）だけ。結果が分からないときは `partiallyApplied` なので来ない。250 件を超えて先のチャンクを書いて**戻した**あとに同じキーで送ると、Shopify は戻したチャンクに前の成功の答えだけ返して書かず、元のまま `completed` になるので、新しい回にする（3.1 の「戻したものを送り直すときは回を増やす」） |
| 在庫が無いと言われて有効化したあと（`isNotStockedRetryableError`） | `ns1` | はっきり断られたあと |
| 棚卸の `compareWithLive` で `CHANGE_FROM_QUANTITY_STALE` のあと読み直して書き直す | `stale1` | わざと中身（`changeFromQuantity`）を変えて送る |

- 結果が分からないとき（5xx・例外・処理中のまま・`IDEMPOTENCY_KEY_PARAMETER_MISMATCH`）は `partial_failed` + `application_uncertain` にして、丸ごとの呼び直しはしない（`tr1` にも進まない）。なので棚卸（`compareWithLive`）で今の数を読み直して中身が変わっても、同じキーで送ることは無い（`tr1` はキーが違う）。それでも `IDEMPOTENCY_KEY_PARAMETER_MISMATCH` が返ったら作りの間違いなので、3.3 のとおり「結果が分からない」（`application_uncertain`）にし、新しいキーで送り直さない（二重には書かない）。
- 元に戻す書き込みは、D3c で「5xx のあとに送り直すと、1 回目が入っていたときに 2 回目が STALE で断られて取り違える」ので 429 だけ送り直している。同じキーにすれば 2 回目は 1 回目の答えになるので、**あとで** 5xx も送り直せるようになる。最初の PR では今の決まり（429 だけ）を変えない。

### 4.6 管理画面（K・L・M）

管理画面には POS のような操作の ID が無い。Shopify の手引きどおり「画面を開いたときに作り、成功したら作り直す」ID を足す。

| 経路 | 操作の ID | 段 | チャンク | 回 |
|---|---|---|---|---|
| K 棚卸の確定・取り消し | 画面の `opKey`（隠し欄。画面を開いたときに UUID、成功したら作り直す） + `countId` + 動き（`confirm`・`revert`・`confirm_all`・`revert_all`）+ `groupId` | `set` | `ci/n` | 断られたら `+1` |
| L 発注から移管 | `opKey` + 発注の `entry.id` | `transfer_ready`・`transfer_draft` | `1/1` | 同上 |
| M 仕入れの確定・取り消し | `opKey` + 仕入れの `entry.id` + `receive`・`cancel` | `adjust` | `ci/n` | 同上 |

- `opKey` が無い古い画面から送られたとき → その場で新しい UUID（今と同じ動き。守りは増えない）。
- M は 2026-04 で `changeFromQuantity` も要る。最初の PR では D9 のとおり `changeFromQuantity: null`（確かめない）をはっきり書く。条件付きにするかは別に決める。

### 4.7 使っていないコード（N）

付ける前に、使っていないことを開発ストアで確かめて**消す**（別の PR）。残すなら同じ決まりで付ける。`docs/restored-loss-stocktake-combined/` と一番上の `stock-transfer-loss/` は配備されない写し（推測）なので触らない。

---

## 5. 入れる順（どれも main に入れる前に T さんの承認）

| 順 | PR | 中身 | 確かめ |
|---|---|---|---|
| 0 | この PR（docs だけ） | 設計。T さんの承認で DECISIONS に追記する（番号は入れるときに決める） | 見直し |
| 1 | ★ キーの共通部品とサーバー | `idempotencyKey.js`・`idempotency-key.server.ts`・テストの表。I・J に付ける。3.3 の返事の分け方。**版は 2026-01 のまま**（付けても動きは変わらない） | 6 章の 1〜3。開発ストア bbbincbbb でロス・仕入れ・調整・棚卸・入庫補正を 1 回ずつ |
| 2 | ★ 管理画面 | K・L・M。`opKey`。M に `changeFromQuantity: null` | 開発ストアで棚卸・発注・仕入れ |
| 3 | ★ POS 入庫 | G・H・F（入庫）。`inventoryShipmentReceiveItems` を消す | 開発ストアの POS で一部入庫・全部入庫・不足の拒否・機内モードで送ってから押し直す |
| 4 | ★ POS 出庫 | A〜F（出庫）。チェックポイントに `rounds` を足す（`v: 1` のまま読める形） | 開発ストアの POS で 250 件以下・251 件以上・下書き・編集・機内モード |
| 5 | 使っていないコードを消す | N | ビルドが通る・画面が変わらない |
| 6 | 2026-04 での確かめ（コードは変えない） | 開発ストアの検証用の設定だけ版を 2026-04 以上にして、全部の画面を 1 回ずつ。17 の一覧に無い mutation（2 章）にエラーが出ないか | `X-Shopify-API-Version` の返事の見出しで版を見る |
| 7 | ★ 版を上げる | サーバー `ApiVersion`・手書きの `API_VERSION`（8 ファイル）・`.graphqlrc.ts`・拡張 7 つと toml 2 つの `api_version` を一度に上げる（2026-07 か 2026-10。webhook の中身の違いも見る） | 開発ストア → 自社用（Ciara） |

- 期限: **2027-01-16 15:00 UTC** より前に 7 まで終える。拡張の `api_version = "2026-01"` は 12 か月を過ぎると Shopify CLI が配備を止めるので、その前に 7 が要る（推測で 2027-01 ごろ）。
- 1〜4 は版を変えずに出せるので、7 を待たずに少しずつ出せる。1 つずつ main に入れて、自社用で 1 日以上見てから次へ（推奨）。
- 1〜4 の PR は STATE_MACHINE §7 の表と「Idempotency の境界」、DECISIONS D3 の「Shopify API 側 idempotency key なし」を同じ PR で直す。
- #80・#82・#103（App Events・契約の読み方）とはファイルが重ならない（`app/utils/` の別のファイル）。重なったら後の方が合わせる。

---

## 6. テスト

### 6.1 自動（`node --test`。今の `*.test.mjs` と同じ形）

1. **キーの計算**: 同じ材料 → 同じ UUID。材料が 1 つでも違う → 違う UUID。POS とサーバーで同じ表（入力と答え 10 組くらい）を通す。形が UUID v5 である。
2. **付け忘れの見張り**: `app/`・`extensions/` の `.ts`・`.tsx`・`.js`・`.jsx` を読み、17 の mutation の呼び出しに `@idempotent(key:` が付いていなければ失敗（使っていないコードを消すまでは、消す予定の場所の一覧を持つ）。`docs/` は見ない。
3. **サーバー apply-change**（`admin.graphql` を偽物にする）:
   - 1 回目 503 → 2 回目成功 → 2 回とも同じキー
   - `isTransientError` の丸ごとの送り直し → 違うキー（`tr1`）。250 件を超えて戻したあとも書き直す
   - 在庫が無いと断られて有効化 → 次の書き込みは違うキー（`ns1`）
   - STALE のあとの書き直し → 違うキー（`stale1`）
   - 元に戻す書き込み → 前に進む書き込みと違うキー。チャンクごとに違う
   - `failed` の行を作り直して処理 → 前の回と違うキー（行の `id` が違う）
   - `IDEMPOTENCY_CONCURRENT_REQUEST` → 待って同じキー。`IDEMPOTENCY_KEY_PARAMETER_MISMATCH` → `application_uncertain`（`partial_failed`）で、新しいキーで送らない
4. **POS 出庫**（`outboundCreateCheckpoint.test.mjs` に足す）:
   - 時間切れ → 同じ指紋で再確定 → 同じキー
   - `userErrors` → `rounds` が増えて残る → 次は違うキー
   - 指紋が違う → `attemptId` が違う → 違うキー
   - Shipment の補完は作成のときと同じキー
   - `rounds` の無い前の形のチェックポイントも読める
5. **POS 入庫**: `receive_v2` → `receive_v2b` → `receive_capped` で段が違う。受け取り済みの数が違えば違うキー。在庫が無いと断られて有効化したあとは回が増える。
6. **管理画面**: `opKey` が同じなら同じキー、成功のあとは新しい `opKey`。`opKey` が無いときは呼ぶたびに違う。

### 6.2 開発ストア bbbincbbb（手で。T さんの承認のあと）

- 各タイルで 1 回ずつ確定し、Shopify の在庫・移管が 1 回だけ動くこと。
- 確定を押してすぐ機内モード → 戻して押し直す → 移管・受領・在庫が 1 回だけ。
- 5 章の 6（2026-04 の版）で全部の画面を通し、`@idempotent` が要るというエラーが出ないこと。
- 本番（自社用 Ciara）では在庫を動かす試しをしない。版を上げた PR（5 章の 7）を出したあと、読むだけの画面と 1 店の 1 件だけを T さんの承認で確かめる。

---

## 7. 残る危険（これで防げないもの）

- 2 台の端末で同じ明細を別々に確定する（ID が端末ごと）。今と同じ。
- 24 時間を過ぎた送り直し（キーが効かない）。今の守り（note の照会・イベントの状態・差分）だけになる。
- 管理画面のタブを 2 つ開いて同じ確定を押す（`opKey` がタブごと）。今と同じ。
- Shopify の強制がいつ・どこまで厳しくなるか（掲示板に「2026-04 で付けずに通った」報告がある。未確認）。付け忘れの見張り（6.1 の 2）で、強制に頼らず全部付ける。
