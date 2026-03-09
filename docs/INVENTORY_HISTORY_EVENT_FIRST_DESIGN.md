# 在庫変動履歴：イベント先行設計と修正方針

**目的**: 在庫変更と履歴記録を「後追い」ではなく「イベント先行」で束ね、漏れなく完全反映する設計に寄せるための方針を確定する。

---

## 1. 現状分析の評価（結論：その通り）

### 1.1 根本課題の整理

| 課題 | 現状 | 影響 |
|------|------|------|
| **在庫更新とログが別トランザクション** | POS が `adjustInventoryToActual`（Shopify API）→ 続けて `logInventoryChangeToApi`（/api/log-inventory-change）の順で呼ぶ。どちらかだけ成功しうる。 | 在庫だけ成功すると「意図」が取り戻せず、Webhook 由来の「管理」に寄る。 |
| **timestamp が送信開始時刻で統一** | `const timestamp = new Date().toISOString()` を全 entries に共通。チャンク送信で順序逆転が起きうる。 | 実処理順と一致せず、監査・突合が弱い。 |
| **sourceId が操作単位の一意キーになっていない** | Transfer ID・count.id・loss_xxx など種別ごとに形式が揺れ、同一操作の全行を束ねるキーとして弱い。 | 再送・突合・idempotency が不安定。 |
| **lineItems 補完が O(n²)** | `deltas` ごとに `lineItems?.find(...)`。200〜500SKU で遅延が増え、順序ズレの温床。 | 遅延 → 取りこぼし・「管理」残り。 |
| **失敗を呼び出し元が検知していない** | `sendChunkWithRetry` は boolean を返すが、呼び出し側は `await ... .catch(...)` で握りつぶし。 | 一部チャンク失敗でも「終わった風」になり、管理画面では「管理」のまま。 |

上記は現行コードと要件ドキュメントからいずれも妥当であり、**「後追い記録」の限界**を正しく指摘している。

### 1.2 設計の方向性（合意）

- **NG**: Shopify の在庫変動が先 → 後から「これは何の操作だったか」を記録する。
- **OK**: 先に「棚卸」「出庫」「ロス」などの**業務イベントをアプリ側で確定**し、そのイベントに基づいて Shopify 在庫を変更する。

これにより、

- 仮に Shopify 側で「管理」と見えても、**アプリの履歴画面では確実に「棚卸」「ロス」「入庫」などと表示できる**。
- **自アプリの変動履歴を正本、Shopify の標準アクティビティは参考**とする運用が現実解である。

### 1.3 「管理」アクティビティは捨てない

**「管理」の行は捨てません。** そのまま残し、一覧・CSV・フィルターでも従来どおり表示します。

| 種別 | 意味 | 扱い |
|------|------|------|
| **管理（admin_webhook）** | 変動の原因が「アプリの操作」と確定できなかったもの。Webhook で検知したが、どの業務（出庫・棚卸等）か後から判別できない。 | **捨てずに保存・表示する**。「原因不明・管理画面操作・他アプリ等」の変動として履歴に残す。 |
| **出庫・入庫・棚卸・ロス・仕入・調整など** | アプリ起点の操作として、イベント先行（または API で種別付き）で記録したもの。 | 正しい種別で表示。Phase 0/1 で「ここに寄せていく」対象。 |

変わるのは次の点だけです。

- **アプリ起点の操作**は、後追いで「管理」に落ちるのを減らし、**最初から正しい種別で記録する**（イベント先行 or appEventId で確実に送る）。
- **アプリ以外の変動**（Shopify 管理画面での手動変更・他アプリ・受注引当など）は、これまでどおり Webhook で検知し **「管理」のまま 1 行保存**する。これらは「原因を後から復元する」ことが難しいので、**「管理」というラベルのまま残す**。

つまり「管理」は、

- **捨てる**のではなく、
- **「種別が分からない変動」を表す区分**として残し、
- 一覧では「管理」でフィルター・表示できるようにする、

という扱いです。

---

## 2. 推奨する解決策の優先順位

| 順位 | 内容 | 説明 |
|------|------|------|
| **1位** | 在庫変更APIと履歴記録をサーバで1本化し、**イベントを先にDB保存**する | `inventory_change_events` / `inventory_change_event_lines` を先に pending で保存 → Shopify API 実行 → 結果で lines/event を更新。 |
| **2位** | **appEventId** を全操作に付与し、行単位で status 管理 | 1回の操作で複数SKUでも同一 `appEventId`。再送・突合・idempotency の軸になる。 |
| **3位** | 自アプリの履歴画面を**正本**とし、Shopify「管理」は参考表示に落とす | 表示は自アプリのイベントテーブルを正として、必要に応じて Shopify の adjustmentGroup / transfer / order / count と紐付け表示。 |
| **4位** | 同一 SKU × 同一ロケーションの更新を**直列化** | 並列で触ると順序競合し、後追いでは意図を復元できない。 |

---

## 3. 完全版の目標アーキテクチャ（Phase 1）

### 3.1 テーブル案

- **inventory_change_events**（操作ヘッダ）  
  - id, app_event_id, shop, activity, location_id, location_name, source_type, source_id, requested_by, requested_at  
  - status: pending | applying | completed | partial_failed | failed  
  - error_summary

- **inventory_change_event_lines**（操作明細）  
  - id, app_event_id, inventory_item_id, variant_id, sku, delta, quantity_before, quantity_after_expected, quantity_after_actual  
  - shopify_adjustment_group_id（取れる場合）  
  - line_status: pending | applied | failed  
  - error_message, applied_at

### 3.2 API の1本化

- **POST /api/inventory/apply-change**（例）  
  - 入力: appEventId, activity, locationId, sourceId, entries[]  
  - 処理:  
    1. イベント＋明細を **pending** で保存  
    2. Shopify API で在庫変更  
    3. 成功/失敗を lines に反映  
    4. イベント status を更新  
  - レスポンスで成否・失敗行を返却  

- フロント（POS）は **直接 /api/log-inventory-change を叩かず**、この「在庫変更＋履歴確定」をまとめて行う API を叩く設計にする（タブ閉じ・回線揺れ・トークン失効の影響をサーバ側に集約）。

### 3.3 運用方針

- **正本**: 自アプリ DB のイベント／履歴  
- **連携先**: Shopify（在庫数は Shopify が正だが、「何の操作か」はアプリのイベントが正）  
- Shopify のアクティビティ表示を 100% 自アプリ都合で制御することは諦め、**アプリ画面で確実に種別を表示する**ことを優先する。

---

## 4. 現実的な進め方：2段階

### Phase 0（すぐ実施）：現行コードの最小改善

大改修が難しい間は、以下で「漏れ・握りつぶし・性能」を抑える。

1. **appEventId の追加**  
   - 呼び出し元で `crypto.randomUUID()` 等で 1 操作 1 ID を発行し、全 entries に付与。  
   - `sourceId` は外部参照用、`appEventId` は自アプリの絶対キーとする。

2. **失敗チャンクを握りつぶさない**  
   - チャンク送信の成否を配列で集約し、1 つでも失敗したら **呼び出し元に throw**。  
   - 呼び出し側で `.catch()` で握りつぶさず、**確定フロー全体を失敗扱い**にできるようにする。

3. **lineItems を Map 化**  
   - `lineItems?.find(...)` をやめ、`inventoryItemId` をキーにした `Map` で O(1) 参照。  
   - 200〜500SKU 時の遅延を減らし、順序ズレのリスクを下げる。

4. **チャンクメタ情報の付与**  
   - chunkIndex, totalChunks, entryIndexStart（または entrySeq）をサーバへ送る。  
   - サーバ側で順序・再送の追跡がしやすくなる。

5. **サーバ側で appEventId を考慮した upsert**  
   - appEventId + inventoryItemId + locationId を一意にして、再送時に重複行が増えないようにする。

6. **呼び出し元で失敗を握りつぶさない**  
   - `logInventoryChangeToApi` は一部チャンク失敗時に **throw** する。呼び出し元では `.catch()` で catch した場合も **ユーザーにエラー表示（toast 等）し、必要なら確定フローを失敗扱い**にすること。そうしないと「履歴は一部だけ失敗したが成功したように見える」状態が残る。

Phase 0 では「イベントを先にDBに書く」まではやらず、**今の「在庫変更 → ログ送信」の順序は維持**する。  
そのうえで、後から Phase 1 に移行した際に appEventId がそのまま使えるようにする。

### Phase 1（中期）：イベント先行の完全版

- 上記「3. 完全版の目標アーキテクチャ」に沿って、  
  - イベント／明細テーブルの追加  
  - POST /api/inventory/apply-change 的な 1 本 API の実装  
  - POS 側は「在庫変更」もこの API 経由にし、`logInventoryChangeToApi` 単体呼び出しをやめる  
- 履歴画面は **自アプリのイベント／履歴を正本** として表示する。

#### Phase 1 実装状況（2026-03）

- **完了**: Prisma に `InventoryChangeEvent` / `InventoryChangeEventLine` を追加。マイグレーションは `prisma/migrations/20260309000000_add_inventory_change_events_and_lines/migration.sql`。**本番反映時は `npx prisma migrate deploy` を実行すること。**
- **完了**: `POST /api/inventory/apply-change` を実装（`app/routes/api.inventory.apply-change.tsx`）。イベント先保存→Shopify inventorySetQuantities→InventoryChangeLog 記録まで一括実行。
- **完了**: POS 共通 `applyInventoryChangeToApi`（`extensions/common/applyInventoryChange.js`）を追加。
- **完了**: **棚卸**（InventoryCountList）と**調整**（AdjustmentProductList）を apply-change API に切り替え。在庫変更と履歴が 1 本化されている。
- **対応済み**: **ロス**を apply-change に切り替え（entries を delta のみで送信。サーバで現在値取得→quantityAfter 正規化→setQuantities＋履歴記録）。
- **対応済み**: **仕入**を apply-change に切り替え（PurchaseProductList・PurchaseHistoryList の両方。delta で送信）。
- **対応済み**: **入庫・出庫**は Transfer API のため apply-change には載せず、`logInventoryChangeToApi` の失敗を握りつぶさないよう、出庫確定時の呼び出しを **await** に変更（Promise.all 内 .catch をやめ、失敗時はトースト表示）。

---

## 履歴API失敗時の通知と「失敗しない」ための対策

### 失敗したときにどこでどう通知されるか

| 画面 | 通知の場所 | 通知の内容 |
|------|------------|------------|
| **出庫**（ModalOutbound） | 1) **POS 画面上のトースト**（短いメッセージ）<br>2) **エラーダイアログ**（タイトル「確定に失敗」＋本文にエラー文言） | `確定に失敗: [エラーメッセージ]` |
| **入庫**（InboundListScreen） | **POS 画面上のトースト**のみ | `入庫確定エラー: [エラーメッセージ]` |

- いずれも、履歴API（`logInventoryChangeToApi`）が **throw した場合** に、その外側の try/catch で上記のように表示される。
- 「伝わる」＝**失敗した事実とエラー内容がユーザーに表示される**という意味。**「失敗しない」保証ではない**。

### 履歴処理を失敗させない（失敗を減らす）ためにできること

1. **管理画面を定期的に開く**  
   入庫・出庫の履歴APIは **オフラインアクセストークン** を使う。このトークンは「管理画面でアプリを開いたとき」に OAuth で更新される。  
   → **運用で「しばらくに1回は管理画面でアプリを開く」** ようにすると、トークン期限切れによる 401 を減らせる。

2. **ネットワーク環境**  
   タイムアウト・切断で失敗することがある。  
   → 安定した Wi‑Fi／回線で確定操作を行うと失敗しにくい。

3. **入庫・出庫を apply-change に載せない理由**  
   在庫変更そのものは **Shopify の Transfer API**（入庫受信・出庫作成）で行っており、アプリは「そのあとで履歴だけ記録」している。  
   → 履歴を「失敗しない」ようにするには、**サーバ側で「Transfer 結果を記録するAPI」を用意し、POS はそのAPIだけ await する**形にすると、タブを閉じる・クライアントの不安定さの影響を減らせる（現状はクライアントから履歴APIを叩いている）。

4. **リトライ**  
   現状の `logInventoryChangeToApi` はチャンク単位でリトライしているが、**呼び出し元でのリトライ**はない。  
   → 必要なら、入庫・出庫の確定処理で「履歴APIが失敗したら N 回までリトライしてから throw」するようにすると、一時的なネットエラーで失敗する確率を下げられる。

5. **棚卸・調整・ロス・仕入**  
   これらは **apply-change** でサーバが「在庫変更＋履歴」を一括して行うため、**クライアントのタブやトークンに依存しにくく、履歴が「管理」のまま残りにくい**。
- **変動履歴表示**: 従来どおり `InventoryChangeLog` を正本として表示。apply-change 成功時も同じテーブルに書き込んでいるため、既存の在庫情報画面でそのまま表示される。

### 実装済み：失敗しないための追求（全機能共通）

以下を実装し、一時的なネットワーク・サーバ障害やトークン切れで失敗する確率を下げている。

| 対象 | 内容 |
|------|------|
| **apply-change 呼び出し（クライアント）** | `applyInventoryChange.js`: リクエスト全体を最大 3 回リトライ。401 のときはトークン再取得して再試行。429／5xx／ネットワークエラー時は指数バックオフ（1s → 2s）で再試行。 |
| **履歴API 呼び出し（クライアント）** | `logInventoryChange.js`: チャンクあたりのリトライを 3 回に増加し、指数バックオフを適用。1 回目の送信で失敗したチャンクがある場合、**トークン再取得して全チャンクを 1 回だけ再送**（idempotency で重複は防止）。 |
| **Shopify GraphQL（サーバ）** | `inventory-set-quantities-server.ts`: 全 GraphQL 呼び出しを **graphqlWithRetry** でラップ。429／503／5xx のときは最大 3 回リトライ（1s → 2s のバックオフ）。`setInventoryQuantitiesServer`・`fetchCurrentQuantityServer`・`adjustInventoryQuantitiesServer` で共通利用。 |
| **apply-change API（サーバ）** | `api.inventory.apply-change.tsx`: `setInventoryQuantitiesServer` が一時障害（429／5xx／timeout／network 等）で失敗した場合、1.5 秒待って **1 回だけ再実行**。 |

これにより、**棚卸・調整・ロス・仕入**はクライアント・サーバ両方でリトライが効き、**入庫・出庫**の履歴記録もチャンク単位＋トークン再取得による再送で失敗しにくくなっている。

---

## 5. 修正方針の確定事項（まとめ）

| 項目 | 方針 |
|------|------|
| **設計思想** | 「後追い記録」をやめ、「在庫変更の前にイベントを確定」する設計に寄せる。 |
| **正本** | 自アプリの変動履歴（イベント／履歴テーブル）。Shopify の標準アクティビティは参考。 |
| **Phase 0** | appEventId 追加・失敗時 throw・lineItems Map 化・チャンクメタ・サーバ upsert を実施。現行の「在庫変更 → ログ送信」は維持。 |
| **Phase 1** | イベント＋明細テーブルを導入し、在庫変更＋履歴確定を 1 本のサーバ API にまとめ、POS はそこだけ叩く形に変更。 |
| **完全反映の限界** | 他アプリ・管理画面からの直接変更・短時間の集中・Webhook 順序前後などは、後追いでは 100% 復元できない。その分は「アプリ起点の操作」にだけイベント先行を適用し、確実にする。 |

この方針で Phase 0 を実装し、Phase 1 はスキーマ・API 設計を固めたうえで段階的に移行する。
