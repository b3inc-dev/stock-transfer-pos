# POS Stock — 販売可否（Sellable）監査

**Workstream**: E8（`docs/STOCKTAKE_PHASE_E_WORKSTREAMS.md`）  
**監査日**: 2026-10-08  
**対象 HEAD**: `main` @ `5cfeda2`（棚卸 P0 #5/#6 反映後）  
**方針**: App Store 審査観点 + `REQUIREMENTS_FINAL.md`（進捗台帳）+ `FEATURES.md`（陳腐化あり）+ 現行コード突合。  
**範囲外**: 本番 Shopify deploy / Render 手動操作（docs-only。本 PR のコード差分は E6 残ラベルの 1 行のみ）。

判定記号:

| 記号 | 意味 |
|------|------|
| **PASS** | コード／設定上、販売・審査のブロッカーにならない |
| **GAP** | 不足・不一致あり。提出前または運用前に対応が必要 |
| **FAIL** | 現状のままでは App Store 提出／一般販売に耐えない |
| **OWNER** | 他 Phase E トラックが担当（本監査は指摘のみ） |

---

## 0. 総合判定

| 観点 | 判定 | 要約 |
|------|------|------|
| **機能完成度（自社/カスタム）** | **PASS（条件付き）** | POS 7 タイル＋管理画面は実装済み。棚卸 P0 反映済み。出庫冪等・公開 webhook・リスティングは別途 |
| **App Store 提出準備** | **FAIL** | プライバシーポリシー URL・リスティング資産・審査用デモ／認証情報が未完。公開側 `orders/updated`・`refunds/create` が TOML コメントアウト |
| **課金・プラン** | **GAP（E1）** | Billing API＋プラン UI はある。Managed Pricing との二重経路・パートナー設定・設定 500 は E1 |
| **再実行安全性（出庫）** | **GAP（E3）** | Transfer 作成にアプリ冪等キーなし。UI ロック＋デバッグ toast 残存 |
| **ドキュメント鮮度** | **GAP** | `FEATURES.md` が「ロス/棚卸＝準備中」のまま等、陳腐 docs が正本を汚染しうる（D7/D8） |

**販売可能にするまでの最短ブロッカー（提出ゲート）**

1. プライバシーポリシー公開 URL を用意しリスティングに設定  
2. アイコン／スクショ／紹介文／デモ動画／テスト認証情報／緊急連絡先（`RELEASE_REQUIREMENTS_PUBLIC_APP.md` / `PUBLIC_APP_REMAINING_TASKS.md`）  
3. 公開アプリで売上・返品履歴を出すなら Protected Customer Data 承認後に `orders/updated`・`refunds/create` を有効化（現状 public TOML はコメントアウト）  
4. Partner 自動チェック再実行（compliance はコード上 PASS、環境側は運用確認）  
5. E1: Billing / Managed Pricing と設定 500 の解消  
6. E3: 出庫二重作成リスクの説明可能化（またはチェックポイント実装）

---

## 1. App Store / コンプライアンス

| 領域 | 判定 | 根拠（コード・docs） | 残件 |
|------|------|----------------------|------|
| **Session token / 埋め込み** | PASS | `embedded = true`、`app/shopify.server.ts` + Prisma Session | シークレットモード実機確認は提出前手動 |
| **OAuth 初回** | PASS（運用依存） | オフライントークンは管理画面オープン時保存。ホームで案内済み想定 | リスティング冒頭に「1回開く」文（PUBLIC_APP_REMAINING B-2） |
| **Compliance webhooks** | PASS（部分 GAP） | `shopify.app*.toml` に `customers/data_request`・`customers/redact`・`shop/redact` → `/webhooks/compliance`。HMAC は `authenticate.webhook` | **`shop/redact` が `InventoryChangeEvent` / `InventoryCountDocument` を削除しない**（Session・ChangeLog・Pending のみ）。新テーブル増設後の削除漏れ |
| **Privacy Policy URL** | FAIL | アプリ内 `/privacy` ルートなし。ガイドのみ（`LISTING_ASSETS_GUIDE.md`） | 外部静的ページ必須 |
| **Protected customer data** | GAP | public TOML で orders/refunds 購読をコメントアウト（未承認時 deploy エラー回避） | 売上/返品を公開アプリで出すなら申請＋購読復活。出さないなら「顧客データ不使用」宣言と機能説明の整合 |
| **過剰スコープ** | PASS | `read_orders` は売上・返品分類用。`read_users` は意図的除外（`ERROR_DEPLOY_READ_USERS_SCOPE.md`） | 審査で理由を説明できること |
| **TLS / HTTPS** | PASS（インフラ） | Render `application_url` | 証明書・本番 URL 一致は運用確認 |
| **重大エラーなし** | GAP（E1） | 設定 500 は E1 スコープ。`app.plan` loader は例外時 500 JSON | E1 調査結果を待つ |
| **Listing assets** | FAIL | `LISTING_ASSETS_GUIDE` / `PUBLIC_APP_REMAINING` で ⬜ 多数 | パートナー作業 |

---

## 2. Billing / プラン

| 項目 | 判定 | 根拠 | OWNER |
|------|------|------|-------|
| プラン取得・Lite/Pro 機能ゲート | PASS | `getShopPlan`（`app.tsx`）: public 時 Lite は入出庫中心、Pro で仕入/ロス/棚卸/発注/調整/在庫情報 | — |
| サブスク作成 UI | PASS | `app.plan.tsx` → `createAppSubscription`（Recurring + Usage） | — |
| ロケーション数ミスマッチ制限 | PASS | `locationPlanMismatch` → `/app/plan` リダイレクト＋バナー | — |
| 10loc 超 Usage | PASS | `reportUsageRecord` + idempotencyKey | — |
| 開発ストア課金スキップ | PASS | コード上 plan=pro 扱い | — |
| Managed Pricing 整合 | GAP | Partner 手順は `PARTNER_PRICING_SETUP_STEPS.md`。アプリ内は Billing API 作成。Managed リンクのみにする案は docs に残る | **E1** |
| パートナー料金実設定 | GAP | リポジトリ外（Partner Dashboard） | **E1** |
| 設定画面 500 | GAP | Phase E 表に明記 | **E1** |

---

## 3. Scopes / Webhooks / API バージョン

| 項目 | 判定 | 根拠 |
|------|------|------|
| **access_scopes（inhouse/public 同一）** | PASS | inventory / transfers / shipments / products / locations / `read_orders` |
| **Webhooks api_version** | PASS（E2 連動） | TOML・拡張とも `2026-01`。`ApiVersion.January26` |
| **app/uninstalled, scopes_update** | PASS | 両 TOML で購読 |
| **inventory_levels/update** | PASS | 両 TOML。履歴・売上突合の中核 |
| **orders/updated / refunds/create** | **inhouse: PASS / public: FAIL（機能）** | inhouse TOML は購読。**public はコメントアウト** → 公開アプリでは売上・返品の order 救済が動かない |
| **changeFromQuantity（2026-04）** | GAP | 棚卸・調整・サーバー setQuantities は `null` 送付済み。loss/order は現在数量を渡す経路あり。API バンプ本体は未 | **E2**（UX ラベルではない） |

---

## 4. 機能別（REQUIREMENTS_FINAL × コード）

### 4.1 出庫（Outbound）

| 項目 | 判定 | 根拠 |
|------|------|------|
| Transfer / Shipment 作成・履歴 | PASS | `ModalOutbound.jsx`（`Modal.jsx` は削除済み）。拡張 target は ModalOutbound |
| 複数シップメント | PASS（条件付き） | `addingShipmentToTransferId`・`OutboundReadyToShipEdit.jsx` あり。陳腐 gap 文書（Modal.jsx 前提）は **D7 で無視**し E3 再検証 | **E3** |
| 冪等・250 分割途中失敗 | GAP | 作成 API にアプリ idempotency なし。再確定で先頭チャンク二重のリスク（AGENTS.md / STATE_MACHINE） | **E3** |
| UI ロック | PASS（弱い） | `submitLockRef` のみセッション内 | — |
| デバッグ toast | GAP | `処理中です… (lock=… submitting=…)` がユーザー向けに露出 | 提出前に文言整理推奨（小さな UX） |
| Shopify 成功後の履歴 API 失敗 | GAP（既知） | Transfer は残り、ロールバックなし | 運用・監視 |

### 4.2 入庫（Inbound）

| 項目 | 判定 | 根拠 |
|------|------|------|
| 受領・部分受領・予定外 | PASS | `stock-transfer-inbound`、`alreadyAccepted` 差分 |
| 再実行安全性 | PASS（相対） | 安定 `appEventId` + alreadyAccepted。出庫より安全 | — |
| multi-shipment 一括表示 / settings | GAP | Phase E4 | **E4** |

### 4.3 棚卸（Stocktake）

| 項目 | 判定 | 根拠 |
|------|------|------|
| POS / Admin 確定・グループ・COMPLETE_RETRY | PASS | P0 #5/#6 merged。Canon / CONFIRM_VERIFICATION | — |
| メタフィールド容量・大規模 | GAP（既知） | 39 グループ級は metafield 制約。DB 移行は別 workstream | metafield→DB |
| 一覧 perf | GAP | E7 | **E7** |

### 4.4 ロス / 調整（E6 残）

| 項目 | 判定 | 根拠 |
|------|------|------|
| POS ロス・調整タイル | PASS | `stock-transfer-loss` / `stock-transfer-adjustment` 実装済み（FEATURES の「準備中」は陳腐） |
| 履歴 UI ラベル（管理画面） | PASS | `ACTIVITY_LABELS` に `loss_entry`→ロス、`adjustment`→調整（`app.inventory-info.tsx`） |
| **CSV ラベル `adjustment`** | **GAP → 本 PR で微小修正** | `export-change-history-csv.server.ts` の `ACTIVITY_LABELS` に **`adjustment` が欠落**（一覧は「調整」、CSV は「その他」になりうる）。E6 専用 worker は notes 上未割当。E2 は concurrency 専用でラベル非担当 |
| `inventory_adjustment` 別ラベル | GAP（軽微） | UI 上「在庫調整」と「調整」が併存。仕様として許容か要確認 | **E6** |
| changeFromQuantity 統一 | GAP | E2/E6 境界。ロスは cur、調整は null | **E2** 主、E6 は残 UX |

### 4.5 仕入 / 発注

| 項目 | 判定 | 根拠 |
|------|------|------|
| 実装有無 | PASS | 拡張＋ `app.purchase` / `app.order`。FEATURES「未着手」は陳腐 | **E5** 残件再監査 |
| Pro ゲート | PASS | public Lite ではナビ非表示＋パス制限 | — |

### 4.6 在庫変動履歴 / Webhook

| 項目 | 判定 | 根拠 |
|------|------|------|
| DB 永続化 | PASS | Prisma `postgresql` + migrations。SQLite 時代の RELEASE 記述は古い箇所あり |
| 二重防止・activity 振り分け | PASS | ChangeLog idempotencyKey、webhook 上書き経路 | — |
| 公開アプリの売上/返品 | FAIL | public webhook コメントアウト（§3） | 提出方針決定が必要 |
| console.log 残存 | GAP | `api.log-inventory-change`・refunds webhook 等に debug log 多数。REQUIREMENTS は「整理済み」だがコードは残存 | 提出前クリーンアップ推奨 |

### 4.7 設定 / ホーム / オンボーディング

| 項目 | 判定 | 根拠 |
|------|------|------|
| 設定 metafield | PASS | `app.settings.tsx`、フッター保存 UI | — |
| ホーム導入ステップ | PASS | `app._index.tsx`、POS チャネルリンク | — |
| 初回オープン案内 | GAP | アプリ内は冗長のため省略可。**リスティング記載が必須**（PUBLIC_APP_REMAINING B） | Partner |

---

## 5. Privacy / データ削除（詳細）

| データ | shop/redact | 備考 |
|--------|-------------|------|
| Session | 削除 | PASS |
| InventoryChangeLog | 削除 | PASS |
| OrderPendingLocation / RefundPendingLocation | 削除 | PASS |
| **InventoryChangeEvent (+ lines)** | **未削除** | GAP（Cascade で lines も消えるよう Event を deleteMany すべき） |
| **InventoryCountDocument (+ chunks)** | **未削除** | GAP（Phase F DB 基盤追加後の漏れ） |
| App Installation Metafields | Shopify 側アンインストールで消える想定 | アプリ DB 外 |

顧客 PII をアプリが保持していない旨は compliance handler コメントと一致。注文 ID を Pending テーブルに持つため、**顧客データ不使用**宣言と `read_orders` / 将来の orders webhook の説明は Partner 画面で整合させる。

---

## 6. ドキュメント鮮度（販売判断への影響）

| 文書 | 状態 | 扱い |
|------|------|------|
| `REQUIREMENTS_FINAL.md` | 台帳。棚卸は詳細正本優先（D8） | 進捗参照可。矛盾時はコード優先 |
| `FEATURES.md` | **陳腐**（ロス/棚卸「準備中」、構成が Modal.jsx 時代） | **販売判断の正本にしない**。更新は別 PR 推奨 |
| `OUTBOUND_MULTI_SHIPMENT_IMPLEMENTATION_GAP.md` | Modal.jsx 前提で陳腐 | E3 がコード再検証 |
| `RELEASE_REQUIREMENTS_PUBLIC_APP.md` / `PUBLIC_APP_REMAINING_TASKS.md` | 提出チェックリストとして有効。DB が SQLite 前提の節は古い | PostgreSQL 済みを前提に読み替え |
| `POS_STOCK_FULL_AUDIT.md` | 構成棚卸（2025-03 表記）。本ファイルが販売観点の後継 | 併読可 |

---

## 7. Phase E 他トラックとの関係（監査時点）

notes 上の並行 agents（いずれも RUNNING・PR 未登録）:

| ID | 内容 | 本監査での扱い |
|----|------|----------------|
| E1 | Billing / 設定 500 | 課金・設定 GAP の owner |
| E2 | API 2026-04 `changeFromQuantity` | **UX ラベル非担当**。concurrency のみ |
| E3 | 出庫冪等・multi-shipment 再検証 | 出庫 GAP |
| E4 | 入庫 multi / settings | 入庫 GAP |
| E5 | 仕入/発注残 | 残件のみ |
| E6 | ロス/調整ラベル・残 UX | **専用 agent なし** → 残ラベルは本監査で指摘。CSV `adjustment` は微小修正を同梱 |
| E7 | リスト perf | perf GAP |
| metafield→DB | 段階移行 | 棚卸大規模・redact 範囲に影響 |

---

## 8. 提出前チェックリスト（要約）

コード側でほぼ揃っているもの:

- [x] Compliance topics 購読 + handler  
- [x] PostgreSQL schema / migrations  
- [x] 埋め込み Admin + POS 拡張一式  
- [x] Billing ユーティリティ + プラン画面  
- [x] 棚卸 P0  

未完（Partner / 運用 / 他 E）:

- [ ] Privacy Policy URL  
- [ ] Listing assets + デモ + テスト認証情報  
- [ ] public: orders/refunds webhook 方針決定  
- [ ] shop/redact を新 DB テーブルまで拡張  
- [ ] E1 Billing/Managed/設定 500  
- [ ] E3 出庫冪等  
- [ ] E2 API 2026-04  
- [ ] 出庫デバッグ toast・余分な console.log 整理  
- [ ] `FEATURES.md` 更新（陳腐解消）

---

## 9. 本 PR のコード差分

| 変更 | 理由 |
|------|------|
| `app/export-change-history-csv.server.ts`: `adjustment: "調整"` 追加 | E6 残：一覧と CSV のラベル不整合（tiny obvious fix） |
| 本ファイル追加 | E8 成果物 |

それ以外の FAIL/GAP は docs 指摘または他 workstream に委譲（本番 deploy なし）。

---

## 10. 参照

- `REQUIREMENTS_FINAL.md`, `FEATURES.md`, `RELEASE_REQUIREMENTS_PUBLIC_APP.md`, `docs/PUBLIC_APP_REMAINING_TASKS.md`
- `docs/STOCKTAKE_PHASE_E_WORKSTREAMS.md`, `docs/DECISIONS.md`（D7–D10）
- `docs/STATE_MACHINE.md`, `docs/SHOPIFY.md`, `AGENTS.md`
- `shopify.app.toml`, `shopify.app.public.toml`
- `app/routes/webhooks.compliance.tsx`, `app/utils/billing.ts`, `app/routes/app.tsx`
