# DECISIONS — 設計判断・負債・優先度

在庫移管まわりの意思決定ログ（調査時点の事実整理）。新しい実装判断を足すときは日付と根拠を追記する。

---

## D1. 移管の正は Shopify Transfer/Shipment（アプリ job なし）

**決定（現行実装）**: 出庫ライフサイクルを Prisma job にせず、Shopify オブジェクトを正とする。

| 利点 | 代償 |
|------|------|
| Admin UI と状態が一致 | 途中進捗・resume・分散ロックがアプリに無い |
| スキーマ単純 | timeout 後の二重作成をアプリが検知しにくい |

**評価**: ドメインとしては妥当。**再実行安全性をアプリが担保しきれていない**点が最大の負債。

---

## D2. 250 超は「複数 Transfer」（同一 Transfer 複数 Shipment ではない）

**根拠（コードコメント）**: Transfer に無い SKU を同一 movement の別 Shipment に載せると数量エラー。

**結果**: ユーザーから見ると「1 回の出庫」が Shopify 上は **複数の在庫移動**になる。

**負債**:

- ループ非アトミック
- 履歴ログが先頭 Transfer 基準（推測: 後続が薄い）
- 失敗時の「どこまで成功したか」が UI に残らない

---

## D3. 作成冪等は UI ロックのみ / 履歴冪等は appEventId

| 層 | 方針 |
|----|------|
| Transfer create | Shopify API 側 idempotency key **なし**（従来どおり） |
| 二重タップ | `submitLockRef` |
| 履歴 | `buildStableAppEventId` + DB unique |
| 数量調整 | `InventoryChangeEvent.appEventId` |

**意図**: 履歴・調整の再送安全性を先に固めた（Phase0/1）。

### D3b. 出庫作成チェックポイント（2026-10-08 / E3）

| 層 | 方針 |
|----|------|
| 作成進捗 | `SHOPIFY.storage` に fingerprint + attemptId + `nextChunkIndex` + created Transfer/Shipment IDs |
| timeout 成功確認 | Transfer note の `[pos-cp:<attemptId>#i/n]` を直近一覧から照会。見つかれば作成スキップ / Shipment 補完 |
| 再確定 | 同一 fingerprint なら途中チャンクから再開。不一致なら新規 attempt |
| 正の所在 | **引き続き Shopify Transfer/Shipment**（Prisma job は作らない = D1 維持） |

**残ギャップ**: 2 端末同時・指紋を変える編集後の再確定・add-shipment チャンク途中失敗は別途。

---

### D3c. ロス・仕入れ・調整の appEventId は答えが出るまで持ち続ける（2026-11-19）

| 層 | 方針 |
|----|------|
| ID を残す時 | **送る前**に `SHOPIFY.storage` の下書き（`appliedOperationsByLocation`）へ、ID と明細を店ごとに残す（`rememberOperationBeforeSend`） |
| ID を手放す時 | サーバーが「完了」を返したとき、またはサーバーがはっきり断ったとき（4xx。401・408・409・429 と `partial_failed` を除く。`finalRejection`）だけ |
| 一部だけ反映（`partial_failed`） | ID を手放さず、印（`partial: true`）を付けて端末にも残す。押し直しは同じ ID で送る。サーバーは同じ ID の `partial_failed` に在庫を動かさず 400 を返し続ける（残りだけ反映する道は無い。STATE_MACHINE §6）。画面は「もう一度押しても在庫は動かない・管理者が Shopify で直す」と出す。管理者が直したあと、「リセット」でその操作を明細ごと取りやめられる（`canDiscardPendingOperation`。印の無い結果待ちの操作はリセットできないまま） |
| 今の在庫数を読めない | delta の明細（ロス・仕入れ・取消・入庫補正）で今の在庫数を読めなかったら、0 として扱わず、イベントを作る前に 503（`current_quantity_unreadable`）を返す。在庫は動かない。POS は同じ ID で送り直す。商品そのものが見つからないときは 400（`inventory_item_not_found`） |
| 250 件超の元に戻す用の控え | `inventorySetQuantities` を 250 件ずつに分けるとき、最後より前のチャンクの今の数を、1 件も動かす前に全部読んで控える（250 件以下は戻すことが無いので読まない）。読み方は上と同じ（`readAvailableFromResponse`。在庫の記録が無いときだけ 0）。1 件でも読めなければ補正を始めず 503（`rollback_snapshot_unreadable`、イベントは `failed`）。戻す処理そのものが失敗したら `partial_failed` |
| 250 件超で元に戻す書き込み | 条件なし（`changeFromQuantity: null`）で控えの数を書くと、書いてから戻すまでの売上・入庫が消える。なので `changeFromQuantity` に「さっき書いた数」を入れる。合わなければ Shopify が `CHANGE_FROM_QUANTITY_STALE` で断る（1 回の書き込みは全部か無し）→ そのチャンクは戻さず `partial_failed`、管理者が Shopify で直す。送り直すのは 429 だけ（5xx は `application_uncertain`）。**選ばなかった案**: 書き込みの返事の増減（`inventoryAdjustmentGroup.changes` の delta）の逆を `inventoryAdjustQuantities` で足す案は、売上をすべて残せるが、増減の書き込みは送り直すと二重になり（このアプリは `@idempotent` をまだ使っていない。D9）、返事の `changes` が欠けると戻せない。STATE_MACHINE の「再実行で二重にしない」「分からないときは管理者に回す」を優先した。**残る危険**: 控えを読んでから前に進む書き込みまでの売上・入庫は、前に進む書き込み（`changeFromQuantity: null`）でもう上書きされているので戻らない（D9 / Phase E2 で前に進む書き込みも条件付きにするときに一緒に直す） |
| 結果が分からない失敗 | 応答なし（`fetch` が投げた例外すべて: TypeError・AbortError・時間切れ）・5xx・202・確定後のローカル保存の失敗では ID を残す。エラーの文の中身（"fetch" / "Network" / "Load failed"）では判断しない |
| 1 回の時間の上限 | 90 秒（超えたら AbortError → 応答なしとして同じ ID で送り直す） |
| 明細の確かめ | 残っている ID の明細（商品と数量）と画面の明細が違えば、送らずに前回の明細へ戻す（`pendingLinesChanged`）。D3b の fingerprint と同じ考え方 |

**意図**: 応答が届かないまま新しい ID を発行すると、前の送信が届いていた場合に在庫がもう一度動く。サーバーは同じ ID の completed に 200 を返す（STATE_MACHINE §6）ので、同じ ID で送り直せば在庫は 1 回だけ動く。

**残ギャップ**: 2 台の端末で同じ明細を別々に確定するのは防げない（端末ごとの保存）。`partial_failed` のあとにリセットして同じ明細を入れ直して確定すると、新しい ID として反映済みの分がもう一度動く（画面の文で止めるだけ）。`applying` のまま止まったイベントなど、印の無い結果待ちの操作は今もリセットできない（片づけはデータベースを直す）。

## D4. POS GraphQL は短 timeout、サーバーは 429 リトライ

| クライアント | timeout | 429 retry |
|--------------|---------|-----------|
| POS `adminGraphql` | 20s | なし |
| サーバー `withGraphQLRetry` | （HTTP 層） | あり |

**負債**: 同じ Shopify API でも経路で耐障害性が違う。POS の timeout は「成功不明」を生みやすい。

---

## D5. 確定 UX を 3 ボタン + 編集/追加モードで分岐

業務上必要（下書き / READY / 即発送）。\
**負債**: `ModalOutbound.jsx` 肥大、条件分岐の重複、ギャップ文書の陳腐化。

---

## D6. 日次処理は snapshot のみ（移管バッチなし） / GAS なし

移管はユーザー駆動。Cron は在庫スナップショット。GAS は採用していない。

---

## 技術的負債チェックリスト

| 負債 | 症状 | 関連 |
|------|------|------|
| **retry 重複** | 失敗後の再確定で Transfer 増殖 | D3, STATE_MACHINE §7 |
| **timeout 継ぎ足し** | 20s / 30s / 90s（棚卸）が機能ごとに散在 | D4 |
| **状態フラグ増加** | UI モードフラグ・編集 ID が増え、正は Shopify と二重管理気味 | D5 |
| **trigger 増加** | Webhook 救済リトライ等は履歴側。移管作成トリガーはまだ単一だが混同注意 | PROJECT_CONTEXT |
| **同一条件判定の複数実装** | activate/wait が確定・READY・下書きで類似コピー | ModalOutbound |
| **手動運用依存** | 部分成功後の Admin キャンセル/再作成。setQuantities rollback 失敗時の手動回復メッセージ | D1, D2 |
| **巨大単一ファイル** | ModalOutbound 1 万行超。レビュー・回帰困難 | D5 |
| **docs の陳腐化** | add-shipment 未実装と書いた文書など | 実装と照合必須 |
| **レガシーパス** | ルート `stock-transfer-loss/` 等 | extensions が正 |

「0 に戻して再実行」型の公式 runbook は **出庫 Transfer 用には未確認（UNKNOWN）**。棚卸・調整 UI のリセットや rollback 失敗メッセージは存在。

---

## 根本的に整理した方がよい部分

1. **出庫作成の冪等・チェックポイント**（チャンク進捗の永続化、または作成前の client request id）
2. **timeout 後の成功確認フロー**（作成直後に Transfer を照会してから再実行可否を決める）
3. **POS とサーバーのリトライ政策統一**
4. **ModalOutbound の分割**と確定パイプラインの単一路線化
5. **多 Transfer 分割時の履歴・ユーザー通知**の一貫性
6. **状態遷移ドキュメントを正本化し、症状パッチを禁止するプロセス**（本 docs セット）

---

## 推奨優先順位（実装は本 PR 範囲外）

| 優先度 | 項目 | 理由 |
|--------|------|------|
| **P0** | ~~部分成功・timeout 後の二重発行防止設計~~ → **E3 で CP+照会を導入**（端末ローカル。2端末は残） | 実在庫・実 Transfer |
| **P0** | 運用手順の明文化（Admin で残った Transfer の扱い） | 手動依存が現状の安全弁 |
| **P1** | ~~250 分割の進捗永続~~ → **E3 で進捗永続**。オールオアナッシング UX は未 | 部分成功の UX |
| **P1** | POS GraphQL の 429/成功確認（作成経路は note 照会で一部カバー） | timeout グレーゾーン削減 |
| **P2** | 履歴の多 Transfer 対応 | 監査・サポート |
| **P2** | ModalOutbound 分割・分岐整理 | 将来の症状継ぎ足し防止 |
| **P3** | 陳腐化 docs の整理・アーカイブ | 調査コスト削減 |

---

## 変更しない方がよいこと（現状維持の判断）

- Transfer の正をいきなりアプリ DB に二重管理する（同期地獄）
- 入庫の delta 受領モデルを崩す（比較的安全）
- apply-change の appEventId モデルを捨てる
- Cron で移管を自動再実行する（冪等なしでは危険）

---

## D7. 陳腐 docs の扱い（2026-10-08）

gap / 原因分析ドキュメントで「未実装」「準備中」と書いてあっても、**コード再検証なしに正本としない**。  
棚卸 UX の正本は [`STOCKTAKE_UX_CANON.md`](./STOCKTAKE_UX_CANON.md) + 39GROUPS + COMPLETE_RETRY。  
陳腐候補リスト（`Modal.jsx` 前提、仕入「未着手」矛盾等）は Canon §4。Issue/PR では「参照しない」と明記する。

## D8. REQUIREMENTS_FINAL の役割（2026-10-08）

- **`REQUIREMENTS_FINAL.md`**: 進捗台帳・横断チェックリスト
- **詳細要件**: 各機能の正本（棚卸は Canon / 39GROUPS / COMPLETE_RETRY、履歴は `HISTORY_WEBHOOK_METAFIELD_REQUIREMENTS.md`）
- 台帳と詳細が矛盾する場合は **詳細正本 + 現行コード** を優先し、台帳側を更新する

## D9. API 2026-04 `changeFromQuantity`（記録のみ・2026-10-08）

Shopify Inventory API 2026-04 で concurrency 制御として `changeFromQuantity` が必須化される見込み。  
**本 workstream では実装しない**（Phase E2）。適用対象は apply-change / loss / order / stocktake setQuantities 経路。  
API バージョンバンプとセットで別 PR。

## D10. 棚卸確定順と webhook（2026-10-08）

- 差異あり確定: **apply-change → metafield**（履歴先行で webhook が early-returnしやすくする）
- 非売上 webhook: PENDING_ORDER 長時間 sleep しない（Phase C）
- メタ失敗時: `needMetafieldRetry`、二重 setQuantities 禁止（Phase D）

## D11. POS の `e.nodeType` エラーは DOM ポリフィル不具合を共通補修で塞ぐ（2026-10-30）

- **症状**: 明細が 50 件を超える（表示ページネーションの「前へ/次へ」が出る）と `undefined is not an object (evaluating 'e.nodeType')`。入庫で #28〜#36 に繰り返した同名エラーも同じ系統と推定。
- **根本原因**: POS ランタイムの `@remote-dom/polyfill`（≤1.5.x）は `insertBefore(child, ref)` で ref が先頭以外のとき、直前ノードの `nextSibling` を更新しない。`childNodes` は正しいが連結リストが壊れ、Preact の差分が以降の更新で行の並び崩れ・欠落を起こして落ちる。上流は新しい版で修正済み（Shopify/remote-dom の insertBefore 修正）。
- **再現**: Preact 10.28 + polyfill 1.5.1 で 50→51 件にすると親 `s-stack` の childNodes 54 に対し nextSibling 辿りが 52。ランダム操作 400 回で 394 回不整合。polyfill 1.6.0 または本補修ありで 0 回。
- **判断**: 画面ごとの構造回避（Host 化・pageOverlay・行モーダル移設など）ではなく、壊れているプリミティブを [`extensions/common/remoteDomSiblingFix.js`](../extensions/common/remoteDomSiblingFix.js) で補修する。起動時に切り離しノードで不具合を検出したときだけ挿入系を包み、直前ノードの next を張り直す。ランタイムが修正版なら何もしない。
- **適用**: 全 POS 拡張の modal エントリ先頭で import（出庫・入庫・ロス・調整・発注・仕入・棚卸）。新しい POS 拡張を足すときも同じ import を入れる。
- **訂正（2026-10-31）**: D11 リリース後（pos-stock-178 / pos-stock-ciara-256）も実機で同じエラーが再発。真因は D12。ポリフィル補修は害がないため残すが、このエラーの原因ではなかった。

## D12. 拡張フォルダ外の共通 JSX は Preact でビルドする（2026-10-31）

- **症状**: 出庫・ロス・調整・発注・仕入で明細が 51 件以上になると `undefined is not an object (evaluating 'e.nodeType')`。
- **真因**: `extensions/common/ListPageControls.jsx` は拡張フォルダの外にあるため、esbuild（Shopify CLI）がリポジトリ直下の tsconfig（管理画面 React 用 `jsx: react-jsx`、jsxImportSource 未指定＝react）を使い、`react/jsx-runtime` でビルドされていた。51 件目で「前へ/次へ」が描画されると React 要素が Preact に渡り、Preact が DOM を持たない子を挿入しようとして落ちる。50 件以下では `return null` なので発症しない。棚卸はこの部品を使わず、入庫は現在ページネーションなしのため影響外。#35（入庫 E7 再適用）→ #36 revert の e.nodeType も同じ部品を使っていた。
- **再現**: 実際の ListPageControls.jsx を同じ設定でビルドし、Preact 10.28 + polyfill 1.5.1、`NODE_ENV=production` で 50→51 件にすると `Cannot read properties of undefined (reading 'nodeType')`。`extensions/common/tsconfig.json` を置くと 0 件。
- **判断**: `extensions/common/tsconfig.json`（jsxImportSource: preact）を追加し、共通フォルダの JSX を常に Preact でビルドする。`tests/extension-jsx-runtime.test.mjs` で全 POS エントリのバンドルに React の JSX ランタイムが混ざらないことを検査する（esbuild がある環境で実行）。

## D13. 在庫履歴の差分は通知の時刻の順で決める（2026-11-19）

- **症状（監査 P1-2）**: ひとつ前の履歴を時刻の条件なしで「いちばん新しい行」から取っていたため、10 → A(8) → B(7) が B, A の順に届くと A=+1・B=−3 で保存された。#57 の売上の照合はこの差分を使う。
- **判断**: 前の行は通知の時刻より前の行から選ぶ。古い通知があとから届いたら、すぐ後ろの管理の行だけ差分を出し直す（BUSINESS_RULES §6）。並べ替え用の新しい列や順番待ちの仕組み（キュー）は作らない（D1・D6 と同じく、仕組みを増やさない）。
- **残り**: 時計のずれ（推測）。すぐ後ろが業務の行のときは、その行の差分は変えない（業務の数を優先）。

## D14. 未契約の店は公開用で何も使えない。止めるのは画面とサーバーの両方（2026-11-21）

- **症状（#73 の B5 / G3）**: 公開用（`pos-stock`）で、契約していない店（`plan = null`）でも、管理画面の入出庫・設定と、POS の全タイル（ロス・棚卸・仕入・発注・調整を含む）と POS 用 API が使えた。開発ストアは契約なしで Pro 扱いだった。
- **原因**: プランを見ていたのは管理画面のレイアウトの loader だけで、しかも「Pro 専用の画面」だけを料金プランへ回していた（未契約は入出庫・設定を開けた）。画面の action は親の loader を通らないので、URL を直接送れば Pro の処理も動いた。POS 拡張と POS 用 API（apply-change・log-inventory-change・pos-stocktake-complete）はプランを全く見ていなかった。
- **判断**:
  - 決まりは `extensions/common/planAccess.js` の 1 か所（サーバーと POS 拡張が同じものを使う）。未契約＝何も使えない（ホームと料金プランだけ）。Lite＝設定・入出庫（管理画面の履歴と POS の出庫・入庫）。Pro＝すべて。
  - 判定は `app/utils/shop-plan.server.ts`（元の `getShopPlan` を移した。名前で Pro/Lite を読む決まりは `billing.ts` のまま）。
  - 開発ストアも契約で決める（Shopify App Pricing のテスト課金。請求はされない）。審査も課金の流れを通る。
  - 契約を Shopify から読めなかったときは「未契約」と言わず `plan_check_failed`（もう一度試す）にする。新しく在庫を動かす処理は止め、在庫が動いた後の記録（log-inventory-change）と棚卸の完了通知（pos-stocktake-complete）は通す（記録を落とさない）。apply-change の入出庫（`outbound_transfer`・`inbound_transfer`）も通す。POS が Shopify で出庫のキャンセル・入庫の拒否・受領を済ませたあとに、出庫元の在庫を戻す・過不足を合わせるために呼ぶため（止めると「キャンセルは済んだのに在庫は戻らない」で終わる。`applyChangeFailsOpenOnPlanCheckError`）。未契約（`plan_required`）は止めたまま。
  - 有効な契約があるのに名前に Pro も Lite も無いときは Lite にする（払っている店を止めない）。
  - 自社用は今まで通り全機能。サーバーは GraphQL を呼ばずに通す。POS 拡張は `appUrl.js` の `APP_MODE = "inhouse"` のとき確認しない。
  - 公開用／自社用の決まりは `app/utils/plan-distribution.ts` の `detectServerDistribution` の 1 つだけ（料金プランの門番と shop/redact の判断が同じものを使う）。順に: (1) `SHOPIFY_API_KEY` が自社用の client_id（`shopify.app.toml`）と同じなら、ほかの値に関係なく自社用（Ciara を止めない） (2) `APP_DISTRIBUTION=inhouse` か `CUSTOM_APP_STORE_IDS` → 自社用 (3) `APP_DISTRIBUTION=public` → 公開用 (4) `SHOPIFY_API_KEY` が公開用の client_id → 公開用 (5) キーが公開用とはっきり違う → 自社用 (6) それ以外は「分からない」。分からないときだけ、料金プランは公開用（今まで通り）、shop/redact は自社用（消さない）に倒す。client_id は cwd と、ビルドしたファイルの場所から上へたどって探す（起動する場所が違っても読めるように）。
- **止め口**:

| 経路 | 止め方 |
|---|---|
| 管理画面の画面 | `app.tsx` の loader で料金プランへ（`featureForAdminPath`） |
| 管理画面の action | 各 action の先頭で `adminPlanRedirect`（CSV は理由の入った CSV） |
| POS のタイル | `extensions/common/PlanGate.jsx` が開いたときに `/api/pos-plan` に聞き、止めたら理由と案内を出す |
| apply-change | イベントを作る前に 402（`plan_required`）/ 503（`plan_check_failed`）。在庫も DB も変わらない。completed の再送・処理中・一部反映は今まで通り答える。入出庫の activity は、契約を読めなかっただけなら通す（Shopify の操作のあとの在庫の戻し） |
| log-inventory-change / pos-stocktake-complete | 未契約とはっきり分かったときだけ 402。読めなかったときは通す |

- **残り（サーバーで止められないもの）**: 出庫の Transfer 作成・入庫の受領は POS から Shopify へ直接送る（D1）。ここはタイルの `PlanGate` だけが止め口。古い版の拡張が端末に残っている間は止まらない（推測。次の `shopify app deploy` で入れ替わる）。ロケーション数とプランの不一致は今まで通り管理画面だけで扱う。

## D16. 契約は Partner API の activeSubscription でも読めるようにする（既定オフ・2026-11-22）

- **背景**: T の決定（2026-11-21）。shopify.dev の Shopify App Pricing の説明は、店の契約の正しい確かめ方を Partner API の `activeSubscription(appId:, shopId:)` としている。Admin API の `currentAppInstallation.activeSubscriptions` に App Pricing の契約が出るかは書かれていない（未確認）。
- **判断**:
  - 読む処理は `app/utils/partner-subscription.server.ts` の 1 か所。同じ形のファイルを location-stock-indicator・review-qa にも置く（リポジトリをまたぐ共通パッケージは作らない）。
  - 既定オフ。`PARTNER_API_SUBSCRIPTION_ENABLED=1` と `PARTNER_API_TOKEN`・`PARTNER_API_ORG_ID`（Partner Dashboard の URL の数字）・`PARTNER_API_APP_ID` がそろったときだけ、公開用で聞く。版は既定 `2026-10`（`PARTNER_API_VERSION` で変えられる）。
  - 契約が見つかれば正にする（項目の `handle` を名前として、今と同じ Pro/Lite・3/10 の決まりで読む）。「契約なし」なら Admin API の結果を使う（払っている店を止めない）。失敗なら Admin API だけで決め、両方読めなければ D14 の `plan_check_failed`。
  - 店の ID は Admin API の `shop { id }` から取る（Admin を読めなければ Partner にも聞けない → D14 のまま）。
  - 店ごとに見つかった結果は 60 秒・契約なしは 15 秒覚え、同時の呼び出しは 1 回にまとめる（上限 4 回/秒）。失敗は覚えない。トークンはログに出さない。
- **残り**: 開発ストアのテスト課金が Partner の `activeSubscription` に出るかは未確認（出なければ「契約なし」→ Admin の結果を使うので止まらない）。

---

## 関連正本

- [`STATE_MACHINE.md`](./STATE_MACHINE.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`BUSINESS_RULES.md`](./BUSINESS_RULES.md)
- [`SHOPIFY.md`](./SHOPIFY.md)
- [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md)
- [`STOCKTAKE_UX_CANON.md`](./STOCKTAKE_UX_CANON.md)
- [`HISTORY_WEBHOOK_METAFIELD_REQUIREMENTS.md`](./HISTORY_WEBHOOK_METAFIELD_REQUIREMENTS.md)
- [`STOCKTAKE_PHASE_E_WORKSTREAMS.md`](./STOCKTAKE_PHASE_E_WORKSTREAMS.md)
- [`../AGENTS.md`](../AGENTS.md)
