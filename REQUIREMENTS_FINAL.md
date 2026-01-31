# 管理画面・ロス登録・棚卸 実装要件書

**最終更新日**: 2026年2月（本番検証対応: 2カラムSP対応、コレクション/SKU全件読み込み、表示件数入力検証、読み込み中表示まで反映）

**直近の主な更新（2026-02）**:
- **2カラムレイアウトのSP対応**: 入出庫履歴・ロス履歴・棚卸（商品グループ設定、棚卸ID発行、履歴）で、SP時は右カラムを左カラム下部に回す。flexWrap + flex-basis で折り返し。
- **コレクション全件読み込み**: 250件以上のコレクションを持つショップに対応。ページネーションで全件取得。
- **商品SKU全件読み込み**: 650件以上のSKUを持つショップに対応。商品・バリアントをページネーションで全件取得（250商品/ページ、250バリアント/商品）。
- **アプリ表示件数の入力検証**: 半角数字以外（全角数字・スペース等）の検証と対処。範囲外・不正入力時は「値を確認してください。半角数字で入力をお願いします。」を入力欄下に表示。バックエンドでもサニタイズ。
- **読み込み中表示**: loader実行中に画面上部に「読み込み中…」バナーを表示（棚卸等の重いloader対応）。

**以前の主な更新**:
- **SKU/CSVグループの確認・編集**: 編集で「SKU選択から作成」タブに切り替え、選択済みSKUを復元。一覧外のinventoryItemIdは維持。右パネルに「SKU一覧（N件）を確認・編集」を表示。
- **CSV**: 登録済みをCSVダウンロード、インポートモード（新規作成・追加・上書き）、新規作成を選択肢の一番上に配置。
- **CSV行数**: 最大10000行まで対応。SKU解決をバッチ（25件/クエリ）＋並列（10本）で行い、行数に応じて処理を分岐。
- 商品グループ作成方法: コレクション / SKU選択 / CSV一括登録の3方式。タブ・ボタン・編集中バナー統一、選択済み絞り込み、編集リセットバグ修正済み。

## 📋 目次
1. [ここまでの要件まとめ](#ここまでの要件まとめ)（直近チャットで整理した要件・対応状況）
2. [管理画面](#1-管理画面)
3. [ロス登録](#2-ロス登録)
4. [棚卸](#3-棚卸)
5. [データベース設計](#4-データベース設計)
6. [実装優先順位](#5-実装優先順位)

---

## ここまでの要件まとめ

棚卸管理画面（`/app/inventory-count`）まわりで要望された要件と、対応済み・未対応の整理。

### 対応済み

| 要件 | 内容 | 対応内容 |
|------|------|----------|
| 商品グループ作成方法 | コレクションに依存せず、グループ名＋SKUで指定したい | **コレクションから作成** / **SKU選択から作成** / **CSVで一括登録** の3方式を実装。CSVは「グループ名,SKU」行で指定可能 |
| CSVテンプレート | CSVインポート近くにテンプレートダウンロードが欲しい | 「CSVテンプレートダウンロード」ボタンを「CSVでインポート」付近に配置 |
| 上部タブのスタイル | 選択中タブだけ背景をつけたい（ライトグレー・角丸） | 商品グループ設定 / 棚卸ID発行 / 履歴のタブを `borderRadius: 8px`、選択時 `background: #e5e7eb` に統一 |
| 商品グループ作成ボタン | タブと同様の見た目にしたい | コレクションから作成 / SKU選択から作成 / CSVで一括登録を通常ボタンで実装し、選択時はグレー背景・角丸でタブと統一 |
| 編集中バナー | 背景色・はみ出し・文言を調整したい | 背景を薄グレー、枠線をグレーに変更。長文のはみ出しを防止。「（コレクションから作成）」等の接尾辞を削除し「「{グループ名}」編集中」のみ表示 |
| コレクション・SKU一覧UI | 履歴フィルターのように、絞り込み＋選択済み表示にしたい | コレクションは「コレクションで絞り込み」、SKUは全件取得＋クライアント絞り込み。いずれも「選択済み」トグルで選択済みのみ表示可能に |
| SKU検索の不具合 | 検索結果が表示されない | 初回ロードでバリアント一覧を loader 取得（最大1000件）、クライアント側で SKU・商品名・JAN・オプションで絞り込み。useFetcher 依存を廃止し表示安定化 |
| 編集中の編集が戻る | グループ編集でコレクションを外すと数秒で元に戻る | 編集中フォーム初期化の useEffect の依存を `[editingGroupId]` のみに変更し、loader 再検証で上書きされないように修正 |
| SKU/CSVグループの確認・編集 | SKU選択・CSVで作成したグループのリストを確認・編集したい | 編集クリックで「SKU選択から作成」タブに切り替え、選択済みSKUを復元。一覧外のinventoryItemIdは `editingSkuOnlyPreservedIds` で維持。右パネルに「SKU一覧（N件）を確認・編集」を表示。更新・キャンセル対応。アクション側で一覧外SKUの skus を既存グループから補完して保存。 |
| CSVダウンロード・上書き | アップロードしたものをダウンロードして再度上書きアップロードしたい | 「登録済みをCSVダウンロード」でSKU指定グループをCSV出力。インポートモードに「上書き」を追加（同じグループ名のSKUをCSVの内容で置き換え）。 |
| CSVインポートモード「新規作成」 | 既存は触れず、存在しない名前だけ新規作成したい | 選択肢「新規作成」を追加（既存のグループ名はスキップ、存在しない名前だけ新規グループ作成）。選択肢の並びは新規作成・追加・上書きの順。 |
| CSV最大行数 | 10000行まで耐えたい | 最大行数を10000行に変更。SKU解決をバッチ（25件/クエリの OR 検索）＋並列（10本）で実行。3件以下は従来の1件1クエリ。OR失敗時はそのバッチのみ1件ずつフォールバック。 |
| 2カラムレイアウトのSP対応 | PCで2カラムの画面がSPで右カラムが狭すぎる | 入出庫履歴・ロス履歴・棚卸（商品グループ設定、棚卸ID発行、履歴）で flexWrap と flex-basis を調整し、SP時は右カラムを左カラム下部に回す |
| コレクション250件以上の全件読み込み | 5000件以上のコレクションを持つショップで250件しか表示されない | loader でページネーション（first: 250, after: cursor）をループし、全件取得 |
| 商品SKU650件以上の全件読み込み | 22000件以上のSKUを持つショップで650件しか表示されない | loader で商品・バリアントをページネーション（products first: 250, variantsFirst: 250）でループし、全件取得 |
| アプリ表示件数の入力検証 | 半角数字以外（全角・スペース等）の検証が未対応 | フロント・バックエンドでサニタイズ。不正入力・範囲外時に「値を確認してください。半角数字で入力をお願いします。」を入力欄下に表示 |
| loader 読み込み中表示 | 棚卸等の重いloader実行中の表示がない | 画面上部に「読み込み中…」バナーを固定表示（useNavigation().state === 'loading'） |

### 未対応・今後の改善要件

| 要件 | 内容・希望 |
|------|------------|
| CSV1行目 | テンプレート1行目（`グループ名,SKU`）の区切り・表示の不具合があれば要修正 |
| 履歴モーダルのデバッグ情報 | 履歴一覧モーダルからデバッグ用表示を非表示にしたい |
| 未完了グループの商品リスト読込 | 未完了ステータスの商品リスト読込が重い場合の軽減策 |
| 棚卸ID発行UI | 棚卸ID発行を商品グループ設定と同程度に分かりやすいレイアウト・説明にしたい |
| 履歴タブのCSV案内 | 「履歴タブで結果を確認・CSV出力できます」の文言の必要性・配置の見直し |
| 履歴フィルターUI | 棚卸ID発行の「直近発行一覧」のように、履歴のフィルターを左側の選択式（チェックまたは背景色で選択状態表示）にしたい |
| 入出庫履歴とロス履歴の統一 | 入出庫履歴とロス（ロス登録）履歴のUIを揃え、「ロス登録」表記を「ロス」に統一したい |
| 履歴のページネーション | ページネーションと「表示: N件 / 全M件」を右寄せ。ロス履歴の「全N件件」のような表記ゆれの修正 |
| 設定レイアウト | 設定を2カラムで項目ごとにブロック分けしたい |
| 店舗設定UI | 設定画面を履歴フィルターのような選択UIにし、「表示件数（初回読み込み）」は左カラムに配置したい |
| 設定の保存・破棄ボタン | 保存・破棄ボタンを画面の一番上に配置したい |
| コレクション検索・SKU検索の不具合 | コレクション検索・SKU検索の追加のバグがあれば随時修正 |

---

## 1. 管理画面構成

### 管理画面の構造
管理画面は以下の4つのページに分割します：

1. **TOP（設定）**: `/app/settings` - 基本的な設定項目
2. **入出庫**: `/app/history` - 入出庫の履歴管理
3. **ロス登録**: `/app/loss` - ロス登録の履歴管理
4. **棚卸**: `/app/inventory-count` - 棚卸の設定と履歴管理

---

### 1.1 設定画面（`/app/settings` - TOP）

#### 現在の実装状況（2026-01-27更新）
- ✅ **店舗グループ（destinationGroups）設定**: 実装済み（後方互換性のため残す、非推奨）
- ✅ **配送会社（carriers）設定**: 実装済み
- ✅ **表示ロケーション選択設定**: 実装済み（`visibleLocationIds`）
- ✅ **出庫：強制キャンセル処理許可設定**: 実装済み（`outbound.allowForceCancel`）
- ✅ **入庫：過剰入庫許可設定**: 実装済み（`inbound.allowOverReceive`）
- ✅ **入庫：予定外入庫許可設定**: 実装済み（`inbound.allowExtraReceive`）
- ✅ **表示件数設定**: 実装済み
  - ✅ **履歴一覧リスト**: 出庫履歴・入庫履歴・ロス履歴に適用（`outbound.historyInitialLimit`、`inbound.listInitialLimit`）
  - ✅ **商品リスト**: 出庫・入庫・ロス登録に適用（`productList.initialLimit`）
  - ✅ **検索リスト**: 出庫・入庫・ロス登録に適用（`searchList.initialLimit`）

#### 実装済み設定項目の詳細

##### ① 表示ロケーション選択設定 ✅ 実装済み
- **目的**: POS側で表示するロケーションを制限
- **データ構造**:
  ```typescript
  {
    visibleLocationIds: string[]; // 表示するロケーションIDの配列（空配列=全ロケーション表示）
  }
  ```
- **UI**: ボタンでロケーションを選択（複数選択可、選択済みは緑色で表示）
- **デフォルト**: 空配列（全ロケーション表示）
- **実装ファイル**: `/app/routes/app.settings.tsx`

##### ② 配送業者選択設定 ✅ 実装済み
- **現在の実装**: `carriers` として実装済み
- **機能**: 表示名、company、表示順の設定が可能
- **デフォルト**: 日本の配送会社（ヤマト運輸、佐川急便、日本郵便、エコ配）
- **実装ファイル**: `/app/routes/app.settings.tsx`

##### ③ 出庫：強制キャンセル処理許可設定 ✅ 実装済み
- **目的**: 出庫処理で強制キャンセル（在庫を戻す処理）を許可するかどうか
- **データ構造**:
  ```typescript
  {
    outbound: {
      allowForceCancel: boolean; // デフォルト: true（許可）
    }
  }
  ```
- **UI**: ボタンで許可/不許可を切り替え（許可時は緑色）
- **デフォルト**: `true`（許可）
- **影響範囲**: 出庫履歴画面のキャンセルボタンの表示/非表示
- **実装ファイル**: `/app/routes/app.settings.tsx`

##### ④ 入庫：過剰入庫許可設定 ✅ 実装済み
- **目的**: 予定数量を超える入庫を許可するかどうか
- **データ構造**:
  ```typescript
  {
    inbound: {
      allowOverReceive: boolean; // デフォルト: true（許可）
    }
  }
  ```
- **UI**: ボタンで許可/不許可を切り替え（許可時は緑色）
- **デフォルト**: `true`（許可）
- **影響範囲**: 入庫処理時の過剰入庫チェック
- **実装ファイル**: `/app/routes/app.settings.tsx`

##### ⑤ 入庫：予定外入庫許可設定 ✅ 実装済み
- **目的**: 予定にない商品の入庫を許可するかどうか
- **データ構造**:
  ```typescript
  {
    inbound: {
      allowExtraReceive: boolean; // デフォルト: true（許可）
    }
  }
  ```
- **UI**: ボタンで許可/不許可を切り替え（許可時は緑色）
- **デフォルト**: `true`（許可）
- **影響範囲**: 入庫処理時の予定外商品チェック
- **実装ファイル**: `/app/routes/app.settings.tsx`

##### ⑥ 表示件数設定 ✅ 実装済み
- **目的**: 各画面の初回読み込み時の表示件数を設定
- **データ構造**:
  ```typescript
  {
    outbound: {
      historyInitialLimit?: number; // 履歴一覧リスト（出庫・入庫・ロス履歴）初回件数。API上限250、推奨100
    },
    inbound: {
      listInitialLimit?: number; // 履歴一覧リスト（出庫・入庫・ロス履歴）初回件数。API上限250、推奨100
    },
    productList?: {
      initialLimit?: number; // 商品リスト（出庫・入庫・ロス登録）初回件数。lineItems上限250、推奨250
    },
    searchList?: {
      initialLimit?: number; // 検索リスト（出庫・入庫・ロス登録）初回件数。productVariants上限50、推奨50
    }
  }
  ```
- **UI**: 数値入力フィールド（履歴一覧リスト、商品リスト、検索リスト）。半角数字以外（全角・スペース等）は検証し、入力欄下に「値を確認してください。半角数字で入力をお願いします。」を表示（2026-02追加）
- **デフォルト**: 
  - 履歴一覧リスト: 100件
  - 商品リスト: 250件
  - 検索リスト: 50件
- **影響範囲**: 
  - 履歴一覧リスト: 出庫履歴・入庫履歴・ロス履歴の一覧表示
  - 商品リスト: 出庫・入庫・ロス登録の商品リスト表示
  - 検索リスト: 出庫・入庫・ロス登録の検索結果表示
- **実装ファイル**: `/app/routes/app.settings.tsx`

#### 設定データの保存先
- **現在**: `currentAppInstallation.metafield` (namespace: `stock_transfer_pos`, key: `settings_v1`)
- **拡張**: 既存の `SettingsV1` 型を拡張して保存

#### 実装ファイル
- `/app/routes/app.settings.tsx` を拡張（基本的な設定項目のみ）

---

### 1.2 入出庫履歴管理画面（新規作成: `/app/history`）

#### 実装状況
- ✅ **履歴一覧表示**: 実装済み（出庫・入庫を統合表示）
- ✅ **フィルター機能**: 実装済み（出庫ロケーション、入庫ロケーション、ステータス - 複数選択対応）
- ✅ **ページネーション**: 実装済み（次へ/前へボタン、ページ表示）
- ✅ **モーダル表示**: 実装済み（履歴クリックで商品リストをモーダル表示）
- ✅ **CSV出力**: 実装済み（モーダルから個別CSV出力）
- ✅ **予定数/入庫数表示**: 実装済み（予定数と入庫数を分けて表示）
- ✅ **予定外入庫表示**: 実装済み（メモから抽出、薄い赤背景で表示）
- ✅ **予定外入庫を含めた数量**: 実装済み（一覧表示の数量に予定外入庫を含める）
- ✅ **予定外入庫の件数表示**: 実装済み（一覧の状態横に「（予定外: X件）」を表示）
- ⏸️ **一括CSV出力**: 調整中（一時的に非表示、チェックボックス機能も非表示）
- ❌ **詳細ページ**: 不要と判断（モーダルで代替）

#### 機能概要
- 出庫・入庫履歴をID毎に確認
- 全ロケーション＋フィルター可能
- モーダルから個別CSV出力
- 予定外入庫の表示と数量計算

#### 画面構成

##### ① 履歴一覧画面
- **表示項目**:
  - 履歴ID（Transfer ID）
  - 名称
  - 出庫元 / 入庫先（改行表示）
  - 日付
  - ステータス（予定外入庫がある場合は「（予定外: X件）」を表示）
  - 数量（入庫数/予定数、予定外入庫を含む）
- **フィルター機能**:
  - 出庫ロケーションフィルター（複数選択可）
  - 入庫ロケーションフィルター（複数選択可）
  - ステータスフィルター（複数選択可）
- **ページネーション**:
  - 次へ/前へボタン
  - ページ表示（1/2形式）
  - 表示件数/全件数表示
- **CSV出力機能**:
  - ⏸️ 一括CSV出力: 調整中（一時的に非表示）
  - ✅ モーダルから個別CSV出力: 実装済み

##### ② 商品リストモーダル
- **表示項目**:
  - 履歴情報（履歴ID、名称、日付、出庫元、入庫先、ステータス、数量）
  - 商品リスト（商品名、SKU、JAN、オプション1-3、予定数、入庫数）
  - 予定外入庫は薄い赤背景で表示
- **CSV出力機能**:
  - 表示している商品リストをCSVでダウンロード
  - CSV形式: 履歴ID, 名称, 日付, 出庫元, 入庫先, ステータス, 商品名, SKU, JAN, オプション1-3, 予定数, 入庫数, 種別

#### データ取得方法
- **出庫履歴**: `inventoryTransfers` GraphQLクエリ（出庫元ロケーションでフィルター）
- **入庫履歴**: `inventoryTransfers` GraphQLクエリ（入庫先ロケーションでフィルター）
- **監査ログ**: 既存の `readInboundAuditLog()` を使用（入庫履歴の詳細情報取得）

#### 実装ファイル
- 新規作成: `/app/routes/app.history.tsx`
- 必要に応じて: `/app/routes/app.history.$id.tsx`（詳細画面）

---

### 1.3 ロス登録履歴管理画面（新規作成: `/app/loss`）

#### 機能概要
- ロス登録履歴をID毎に確認
- 全ロケーション＋フィルター可能
- 選択した履歴をCSV出力
- 詳細確認時は表示詳細のCSV出力

#### 画面構成

##### ① 履歴一覧画面
- **表示項目**:
  - チェックボックス（選択用）
  - ロス登録ID
  - ロケーション
  - 日付
  - 理由
  - 商品数
  - 数量サマリー（合計ロス数量）
  - ステータス（登録済み / キャンセル済み）
- **フィルター機能**:
  - ロケーションフィルター（全ロケーション / 特定ロケーション）
  - 日付範囲フィルター（開始日 / 終了日）
  - 理由フィルター（破損 / 紛失 / その他 / カスタム）
  - ステータスフィルター（登録済み / キャンセル済み）
- **CSV出力機能**:
  - チェックボックスで選択した履歴をCSVでダウンロード
  - CSV形式: ロス登録ID, ロケーション, 日付, 理由, 商品数, 数量サマリー, ステータス

##### ② 履歴詳細画面
- **表示項目**:
  - ロス登録ID
  - ロケーション
  - 日付
  - 理由
  - 商品明細（商品名, SKU, 数量等）
  - ステータス
- **CSV出力機能**:
  - 表示している詳細情報をCSVでダウンロード
  - CSV形式: 商品名, SKU, 数量等

#### 実装ファイル
- 新規作成: `/app/routes/app.loss.tsx`
- 必要に応じて: `/app/routes/app.loss.$id.tsx`（詳細画面）

---

## 2. ロス登録（POS UI機能）✅ 実装完了（2026-01-27更新）

**実装状況**: POS UI機能は実装完了。商品リスト画面の初期化エラーは修正完了。管理画面（履歴管理・CSV出力）も実装完了。

### 2.1 機能概要
- 出庫処理のロス（在庫マイナス調整）版
- コンディション画面でロケーション、日付、理由、スタッフ名を選択入力
- ロス登録リストから対象ロケーションの履歴確認（現在のロケーションで自動フィルター）
- 商品リスト画面は出庫商品リストと完全に同じUI/UX、確定で選択SKUと数量の差分調整

### 2.2 実装状況（2026-01-27更新・機能検証完了）
- ✅ **コンディション画面**: 実装完了（`LossConditions.jsx`）
  - ✅ 自動保存・復元機能: 実装完了（入力値変更時に500msデバウンスで自動保存、確定時にクリア）
  - ✅ 復元時に「下書きを復元しました」トーストを表示
  - ✅ 商品リストに進む時点では下書きをクリアしない（確定時のみクリア）
  - ✅ 商品リストから戻った時に下書きを復元
- ✅ **商品リスト画面**: 実装完了（`LossProductList.jsx`）- **エラー修正完了・機能検証完了**
  - ✅ スキャナー処理を`Modal.jsx`に移動、出庫/入庫と同じ実装に統一
  - ✅ 設定から検索リストの表示件数を読み込むように修正
  - ✅ 自動保存・復元機能: 実装完了
  - ✅ 確定時にコンディション画面の下書きもクリア
- ✅ **履歴一覧画面**: 実装完了（`LossHistoryList.jsx`）
- ✅ **キャンセル機能**: 実装完了（`LossHistoryList.jsx`内で実装、在庫を戻す処理も含む）
- ✅ **データ保存**: 実装完了（Metafield方式、`loss_entries_v1`）
- ✅ **在庫調整**: 実装完了（`inventoryAdjustQuantity` GraphQL mutation）

### 2.3 画面構成

#### ① コンディション画面（ロス登録開始画面）✅ 実装完了
- **入力項目**:
  - ✅ ロケーション選択（必須、セッションのロケーションをデフォルト選択）
  - ✅ 日付選択（必須、デフォルト: 今日）
  - ✅ 理由選択（必須、選択肢: 破損 / 紛失 / その他、横3列で均等に表示）
  - ✅ 「その他」選択時はカスタム入力欄を表示
  - ✅ スタッフ名入力（必須、手入力）
- **機能**:
  - ✅ 「次へ」ボタンで商品リスト画面へ遷移
  - ✅ 「履歴一覧」ボタンで履歴一覧画面へ遷移
  - ✅ 自動保存機能: 入力値変更時に500msデバウンスで自動保存
  - ✅ 下書き復元機能: マウント時に下書きを復元、復元時に「下書きを復元しました」トーストを表示
  - ✅ 商品リストに進む時点では下書きをクリアしない（確定時のみクリア）
  - ✅ 商品リストから戻った時に下書きを復元（コンポーネント再マウント）
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/loss/LossConditions.jsx`

#### ② 商品リスト画面 ✅ 実装完了（機能検証完了）
- **表示**: 出庫商品リストと完全に同じUI/UX
  - ✅ 検索フィールド（商品名 / SKU / バーコード）
  - ✅ 検索結果リスト（OutboundListと同じデザイン）
  - ✅ 追加済み商品リスト（OutboundListと同じデザイン）
  - ✅ 数量コントロール（OutboundListと同じUI）
  - ✅ 「さらに表示」ボタン（検索結果が50件以上の場合）
- **機能**:
  - ✅ 商品スキャンまたは手動選択
  - ✅ 数量入力（マイナス調整用）
  - ✅ 確定ボタンで確認モーダルを表示（OutboundListと同じ仕様）
  - ✅ 確認モーダルで確定すると在庫調整を実行
- **在庫調整処理**:
  - ✅ `inventoryAdjustQuantity` GraphQL mutationを使用
  - ✅ 数量はマイナス値として処理（例: ロス5個 → -5で調整）
- **修正内容（2026-01-27）**:
  - ✅ スキャナー処理を`Modal.jsx`に移動、出庫/入庫と同じ実装に統一
  - ✅ エラー解消完了
  - ✅ 設定から検索リストの表示件数を読み込むように修正
  - ✅ 確定時にコンディション画面の下書きもクリア
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/loss/LossProductList.jsx`

#### ③ ロス登録リスト画面 ✅ 実装済み
- **表示項目**:
  - ✅ ロス登録ID（自動生成: `loss_${timestamp}_${random}`）
  - ✅ ロケーション
  - ✅ 日付
  - ✅ 理由
  - ✅ スタッフ名
  - ✅ 商品数
  - ✅ 数量サマリー（合計ロス数量）
  - ✅ ステータス（登録済み / キャンセル済み）
- **機能**:
  - ✅ 現在のロケーションで自動フィルター（フィルターUIは削除済み）
  - ✅ 詳細確認（商品明細表示）
  - ✅ キャンセル機能（実装済み、在庫を戻す処理も含む）
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/loss/LossHistoryList.jsx`

### 2.4 データ保存 ✅ 実装済み

#### データ構造
```typescript
type LossEntry = {
  id: string; // ロス登録ID（自動生成: loss_${timestamp}_${random}）
  locationId: string; // ロケーションID
  locationName: string; // ロケーション名
  date: string; // ISO日付文字列（YYYY-MM-DD形式）
  reason: string; // 理由（破損 / 紛失 / その他 / カスタム入力）
  staffMemberId: string | null; // スタッフID（現在は使用しない、null）
  staffName: string | null; // スタッフ名（手入力）
  items: Array<{
    inventoryItemId: string;
    variantId: string;
    sku: string;
    title: string;
    quantity: number; // ロス数量（正の値で保存、調整時はマイナスで処理）
  }>;
  status: "active" | "cancelled"; // ステータス（現在は "active" のみ）
  createdAt: string; // 作成日時（ISO）
  cancelledAt?: string; // キャンセル日時（ISO、未実装）
};
```

#### 保存先 ✅ 実装済み
- **実装方法**: `currentAppInstallation.metafield` にJSON配列として保存
  - namespace: `stock_transfer_pos`
  - key: `loss_entries_v1`
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/loss/lossApi.js`
  - `readLossEntries()`: ロス登録履歴を読み取り
  - `writeLossEntries()`: ロス登録履歴を書き込み

### 2.5 実装ファイル ✅ 実装済み
- ✅ POS UI: `/extensions/stock-transfer-loss/src/screens/loss/` に実装
  - `LossConditions.jsx`: コンディション画面
  - `LossProductList.jsx`: 商品リスト画面
  - `LossHistoryList.jsx`: 履歴一覧画面
  - `lossApi.js`: API関数（検索、在庫調整、データ保存）
  - `FixedFooterNavBar.jsx`: フッターナビゲーション（出庫処理から移植）
- ⏸️ 管理画面: `/app/routes/app.loss.tsx` - 未実装（将来的に実装予定）

### 2.6 修正履歴（2026-01-27更新）

#### 問題1: 商品リスト画面の初期化エラー ✅ 解決完了
- **発生タイミング**: コンディション画面から「次へ」を押した瞬間
- **エラーメッセージ**: `undefined is not an object (evaluating 'Object.prototype.hasOwnProperty.call(e,t)')`
- **根本原因**: スキャナー処理の実装場所の違い（出庫/入庫は`Modal.jsx`でタイルを開いた時点で開始、ロス登録は`LossProductList`内で開始）
- **最終修正（2026-01-27）**:
  1. ✅ `Modal.jsx`にscanner subscribeを追加（出庫/入庫と同じ実装）
  2. ✅ `LossScreen`からviewを親に通知する仕組みを追加
  3. ✅ `LossProductList`内のscanner subscribeを削除
  4. ✅ `pushScanToQueue_`を`Modal.jsx`に移動
  5. ✅ `normalizeScanQueueObj_`を出庫/入庫と同じ実装に修正（`if (raw && typeof raw === "object")`）
- **修正結果**: ✅ 完了（エラー解消確認済み）

#### 追加実装（2026-01-27）
- ✅ ロスコンディション画面の自動保存・復元機能を実装（500msデバウンス）
  - ✅ 復元時に「下書きを復元しました」トーストを表示
  - ✅ 商品リストに進む時点では下書きをクリアしない（確定時のみクリア）
  - ✅ 商品リストから戻った時に下書きを復元（コンポーネント再マウント）
- ✅ 出庫コンディション画面にも自動保存・復元機能を実装（ロス登録と同様）
  - ✅ 復元時に「下書きを復元しました」トーストを表示
  - ✅ 商品リストに進む時点では下書きをクリアしない（確定時のみクリア）
- ✅ モーダルの「キャンセル」を「戻る」に修正（ロス登録のリセット確認モーダル）
- ✅ 設定から検索リストの表示件数を読み込むように修正
- ✅ スキャナーのトースト整理
  - ✅ `scanner subscribe start`のトーストを削除（出庫/入庫、ロス登録の両方）
  - ✅ `env: toast=... scanner=...`のデバッグ用トーストを削除
  - ✅ `SCAN: ${data} (${source})`のトーストは残す（スキャン確認用）
- ✅ 配送番号のスキャン機能を実装
  - ✅ 出庫コンディション画面でスキャンした際に配送番号に自動入力
  - ✅ 確定モーダル内でもスキャン可能（モーダルが開いている時は配送番号に自動入力）
  - ✅ ラベルを「配送番号（任意）※スキャン可能」に変更

---

## 3. 棚卸 ✅ 実装完了（2026-01-27更新）

**実装状況**: 管理画面は実装完了。POS UI機能も実装完了（UI改善・バグ修正完了）。

### 3.1 機能概要
- 棚卸の指定された商品をPOS UIから実数のスキャン・入力処理
- 在庫絶対値処理（現在の在庫数を実数に更新）
- 入庫機能の棚卸版として実装（UI/UXを模倣）

### 3.2 管理画面での設定と履歴管理（`/app/inventory-count`）

#### ① 対象商品グループ設定（カテゴリ設定）✅ 実装完了（2026-01更新）

- **画面**: `/app/inventory-count` の「商品グループ設定」タブ
- **UIレイアウト**: ✅ 二分割レイアウト
  - **左側（約300px固定幅）**: グループ名入力 + 「グループを追加する」ボタン + 作成方法タブ（コレクションから作成 / SKU選択から作成 / CSVで一括登録）＋ 編集モード時のフォーム
  - **右側（残りの幅）**: 登録済み商品グループのリスト（各グループにコレクション/SKU/CSV由来の内容と商品数量を表示）
- **商品の選択方法（3方式）**:
  - **方法1: コレクションから作成** ✅ 実装済み
    - Shopifyコレクションから選択（複数選択可）。ラベル「コレクションで絞り込み」、クライアント側絞り込み。「選択済み」トグルで選択済みコレクションのみ表示可能。
    - コレクション内商品の個別選択: モーダルでデフォルト全選択、チェックで対象外に可能。コレクション名横に「選択数 / 合計数」表示。
    - 右側のコレクション名クリックで直接編集可能。
  - **方法2: SKU選択から作成** ✅ 実装済み
    - ページネーションで全商品・全バリアントを loader 取得（250件以上のショップ対応）。クライアントで SKU・商品名・JAN・オプションにて絞り込み。「選択済み」トグルで選択済みSKUのみ表示可能。
    - 表示形式: 商品名 / SKU / JAN / オプション（4行）。「表示: X件 / 全Y件」を表示。
  - **方法3: CSVで一括登録** ✅ 実装済み
    - CSV形式: `グループ名,SKU` の行で指定。コレクションに依存せずグループ名＋SKUで商品グループを定義可能。
    - 「CSVテンプレートダウンロード」でテンプレートをダウンロード。「CSVでインポート」で一括登録。
    - **登録済みをCSVダウンロード**: SKU指定のグループのみをCSV出力。編集して再アップロード可能。
    - **インポートモード**: 新規作成（既存のグループ名はスキップ）・追加（同じグループ名にSKUを足す）・上書き（同じグループ名のSKUをCSVの内容で置き換え）。選択肢の並びは新規作成・追加・上書き。
    - **行数**: 1ファイル最大10000行。SKU解決はバッチ（25件/クエリの OR 検索）＋並列10本で実行し、タイムアウトを抑制。
- **タブ・ボタンスタイル**: 上部タブ（商品グループ設定 / 棚卸ID発行 / 履歴）および作成方法ボタンは、選択時のみ `background: #e5e7eb`、`borderRadius: 8px` で統一。
- **編集中バナー**: 「「{グループ名}」編集中」のみ表示。背景・枠は薄グレー。長文のはみ出し防止のスタイル適用。
- **編集中のリセット不具合**: 編集フォーム初期化の useEffect 依存を `[editingGroupId]` のみにし、loader 再検証で編集中内容が上書きされないよう修正済み。
- **データ構造**:
  ```typescript
  type CollectionConfig = {
    collectionId: string; // コレクションID
    selectedVariantIds: string[]; // 選択されたバリアントIDの配列（空配列=全選択）
    totalVariantCount?: number; // コレクション内の全バリアント数（0/0表示用）
  };

  type ProductGroup = {
    id: string; // グループID（自動生成）
    name: string; // グループ名（カテゴリ名）
    collectionIds: string[]; // ShopifyコレクションIDの配列（後方互換性のため残す）
    collectionConfigs?: CollectionConfig[]; // コレクションごとの選択商品設定
    productIds?: string[]; // 直接指定する商品ID（オプション）
    variantIds?: string[]; // 直接指定するバリアントID（SKU選択・CSVで一括登録時に使用）
    inventoryItemIds?: string[]; // 商品グループに含まれるinventoryItemIdのリスト（判定用に保存）
    createdAt: string; // 作成日時（ISO）
  };
  ```
  - **CSV一括登録**: 取り込み後は `variantIds` / `inventoryItemIds` 等に展開して保存。フォーマットは「グループ名,SKU」行。

#### ② 棚卸ID発行処理 ✅ 実装完了（2026-01-27更新）
- **画面**: `/app/inventory-count` の「棚卸ID発行」セクション
- **機能**:
  - ✅ ロケーション選択（必須、検索機能付き、空白で全ロケーション表示）
  - ✅ 対象商品グループ選択（必須、複数選択可、チェックボックス形式）
  - ✅ 「棚卸ID発行」ボタンで棚卸IDを生成
  - ✅ 棚卸ID表示形式: `#C0000`形式（ロス登録の`#L0000`と同様）
- **データ構造**:
  ```typescript
  type InventoryCount = {
    id: string; // 棚卸ID（自動生成: count_${timestamp}_${random}）
    countName?: string; // 表示用名称（#C0000形式）
    locationId: string; // ロケーションID
    locationName?: string; // ロケーション名
    productGroupId?: string; // 商品グループID（後方互換性のため残す）
    productGroupIds: string[]; // 商品グループIDの配列（複数選択対応）
    productGroupName?: string; // 後方互換性のため残す
    productGroupNames?: string[]; // 商品グループ名の配列
    inventoryItemIdsByGroup?: Record<string, string[]>; // ✅ 商品グループごとのinventoryItemIds（生成時の状態を保持、2026-01-27追加）
    status: "draft" | "in_progress" | "completed" | "cancelled";
    createdAt: string; // 作成日時（ISO）
    completedAt?: string; // 完了日時（ISO）
    groupItems?: Record<string, Array<{
      inventoryItemId: string;
      variantId?: string;
      sku?: string;
      title?: string;
      currentQuantity?: number; // 現在の在庫数
      actualQuantity?: number; // 実数
      delta?: number; // 差分（actualQuantity - currentQuantity）
    }>>; // 商品グループごとの完了データ（key: productGroupId）
    items?: Array<{
      inventoryItemId: string;
      variantId?: string;
      sku?: string;
      title?: string;
      currentQuantity?: number; // 現在の在庫数
      actualQuantity?: number; // 実数
      delta?: number; // 差分（actualQuantity - currentQuantity）
    }>; // 後方互換性のため残す（最後に完了したグループのデータ）
  };
  ```
- **注意**: 
  - `productGroupId`（単数）から`productGroupIds`（複数）に変更
  - **複数グループ対応**: `groupItems`でグループごとの完了データを管理、全グループ完了時のみ`status: "completed"`に設定
  - ✅ **商品グループ編集の影響を受けないようにする**: 棚卸ID生成時に`inventoryItemIdsByGroup`を保存し、POS UI側で商品リストを取得する際は保存された`inventoryItemIdsByGroup`を優先的に使用（2026-01-27追加）
    - これにより、商品グループを編集しても、既に生成済みの棚卸IDには影響しない
- **実装ファイル**: `/app/routes/app.inventory-count.tsx`

#### ③ 棚卸履歴表示
- **画面**: `/app/inventory-count` の「履歴」タブまたはセクション
- **表示項目**: 
  - チェックボックス（選択用）
  - 棚卸ID
  - ロケーション
  - 商品グループ（複数選択時は「グループ1, グループ2...」形式で表示）
  - ステータス（draft / in_progress / completed / cancelled）
  - 作成日時
  - 完了日時
- **フィルター機能**: 
  - ロケーションフィルター（全ロケーション / 特定ロケーション）
  - 商品グループフィルター
  - ステータスフィルター
  - 日付範囲フィルター（開始日 / 終了日）
- **CSV出力機能**: 
  - チェックボックスで選択した棚卸履歴をCSVでダウンロード
  - 詳細画面からも詳細情報をCSV出力可能
  - CSV形式: 棚卸ID, ロケーション, 商品グループ, ステータス, 作成日時, 完了日時, 商品明細（商品名, SKU, 現在在庫数, 実数, 差分等）

### 3.3 POS UIでの処理

#### 画面遷移フロー
```
棚卸ID入力画面（コンディション相当）
  ↓
商品グループ選択画面（シップメント選択相当、商品グループが複数の場合のみ）
  ↓
商品リスト画面（入庫商品リスト相当）
  ↓
確定処理（在庫絶対値調整）
```

#### ① 棚卸ID入力画面（コンディション画面相当）✅ 実装完了
- **機能**: 
  - ✅ 棚卸ID一覧を表示（未完了/完了済みタブ）
  - ✅ 棚卸IDが存在し、ステータスが `draft` または `in_progress` であることを確認
  - ✅ 商品グループが1つの場合は直接商品リストへ、複数の場合は商品グループ選択画面へ
  - ✅ 選択時にステータスを`in_progress`に更新（`draft`の場合のみ）
- **UI**: 入庫のコンディション画面（入庫ID一覧）と同じUI/UX
  - ✅ 棚卸ID表示形式: `#C0000`形式（既存データにも自動付与）
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountConditions.jsx`

#### ② 商品グループ選択画面（シップメント選択画面相当）✅ 実装完了（2026-01-27更新）
- **表示条件**: 棚卸IDに紐づく商品グループが複数の場合のみ表示
- **機能**: 
  - ✅ 商品グループ一覧を表示（入庫のシップメント選択画面と同じUI/UX）
  - ✅ 商品グループごとに状態（未処理/処理中/処理済み）と数量進捗（実数/在庫数）を表示
  - ✅ 商品グループを選択して商品リスト画面へ遷移
  - ✅ 選択時にステータスを`in_progress`に更新（`draft`の場合のみ）
  - ✅ **完了済みグループの判定**: `groupItems[productGroupId]`が存在するか、または`count.status === "completed"`の場合、`readOnly`モードで表示
  - ⏸️ 「まとめて表示」オプション（管理画面で設定可能な場合、デフォルト動作を設定、将来拡張）
- **スキップ条件**: 商品グループが1つの場合は自動で商品リスト画面へ遷移
- **管理画面設定（将来拡張）**: 
  - 商品グループが複数の場合のデフォルト動作を設定可能に
  - 選択肢: 「リスト選択（個別選択）」「まとめて表示（全グループの商品を1画面で表示）」
  - 入庫処理にも同様の設定を追加（シップメントが複数の場合のデフォルト動作）
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`

#### ③ 商品リスト画面（入庫商品リスト相当）✅ 実装完了
- **表示**: 
  - ✅ 選択した商品グループ（カテゴリ）に含まれる商品リスト
  - ✅ **重要**: 対象ロケーションに在庫レベルがないSKUは初期表示では非表示
  - ✅ スキャンや検索入力で該当商品が見つかった場合は、リストに追加して有効化（表示・編集可能）して処理できる
- **機能**:
  - ✅ 商品をスキャンまたは手動選択（検索機能、VariantCache活用）
  - ✅ 実数を入力（初期値は0、スキャンで積み上げる方式）
  - ✅ 「データ数量反映」ボタン: 現在在庫数を実数に一括反映
  - ✅ 「リセット」ボタン: 実数を0にリセット
  - ✅ 確定ボタンで確認モーダルを表示（入庫の確定モーダルを参考）
  - ✅ 確認モーダルで確定すると在庫調整を実行
  - ✅ 在庫レベルがないSKUもスキャン/検索で追加可能
- **在庫調整処理**:
  - ✅ `inventorySetQuantities` GraphQL mutationを使用（ロス登録と同じ処理方法）
  - ✅ **絶対値処理**: 現在の在庫数に関係なく、入力した実数に在庫を設定
  - ✅ 例: 現在10個、実数8個 → 在庫を8個に設定
  - ✅ 例: 現在5個、実数10個 → 在庫を10個に設定
- **UI**: 入庫商品リスト画面と完全に同じUI/UX
  - ✅ 軽量モードボタン（ヘッダー右側、「軽量」のみ表示、色でON/OFF表現）
  - ✅ ヘッダーに「在庫再取得」「全数量反映」「リセット」ボタン
  - ✅ フッターに「在庫 / 実数」表示（ボタンと上下中央揃え）
  - ✅ フッターに「超過 / 不足」表示（差分がある場合は赤色表示）
  - ✅ 予定外リスト表示（初期リストにない商品を最下部に別表示、数量1の場合は×ボタンで削除可能）
- **自動保存・復元機能**: ✅ 実装完了
  - ✅ 下書きの自動保存（lines変更時に300msデバウンスで保存）
  - ✅ 下書きの復元（マウント時に下書きを確認、条件一致時のみ復元）
  - ✅ 確定時に下書きをクリア
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`

#### ④ 棚卸完了処理 ✅ 実装完了（2026-01-27更新）
- **機能**: 全ての商品の実数入力が完了したら「確定」ボタンで確認モーダルを表示
- **確認モーダル**: 
  - ✅ 入庫の確定モーダルを参考に実装
  - ✅ サマリー表示（在庫 / 実数 / 差分）
  - ✅ 調整対象の明細表示（1件のみ表示、「…他X件」形式）
  - ✅ 「戻る」ボタンと「確定する」ボタン
  - ✅ 空白ボタン問題を修正（slot="footer"を明示的に空にする）
- **処理**: 
  - ✅ 在庫調整を実行（`inventorySetQuantities`で絶対値設定、ロス登録と同じ方法）
  - ✅ 在庫調整と履歴更新を分離し、エラーハンドリングを改善（HTTP 400エラー修正）
  - ✅ **複数グループ対応**: `groupItems[productGroupId]`にグループごとの完了データを保存
  - ✅ **完了判定の修正**: 全`productGroupIds`の`groupItems[id]`が存在し、かつ配列の長さが0より大きい場合のみ`status: "completed"`に設定
  - ✅ 下書きをクリア
- **完了済み商品リストの編集不可対応** ✅ 実装完了（2026-01-27）
  - ✅ `readOnly`モード: `count.status === "completed"`または`groupItems[productGroupId]`が存在する場合、編集不可
  - ✅ 編集不可時の挙動: 商品追加・数量変更・削除を禁止、在庫再取得・全数量反映・リセット・確定ボタンを無効化
  - ✅ 完了済みグループタップ時のフリーズ修正: `groupItems`から直接読み込み、API取得をスキップ

### 3.4 データ保存

#### 保存先
- **商品グループ**: `currentAppInstallation.metafield` (namespace: `stock_transfer_pos`, key: `product_groups_v1`)
- **棚卸ID**: `currentAppInstallation.metafield` (namespace: `stock_transfer_pos`, key: `inventory_counts_v1`)

### 3.5 実装ファイル ✅ 実装完了
- ✅ **管理画面**: `/app/routes/app.inventory-count.tsx`（設定・履歴・CSV出力を含む）
- ✅ **POS UI**: `/extensions/stock-transfer-loss/src/screens/stocktake/` に実装
  - `InventoryCountConditions.jsx`: 棚卸ID入力画面
  - `InventoryCountProductGroupSelection.jsx`: 商品グループ選択画面
  - `InventoryCountList.jsx`: 商品リスト画面
  - `stocktakeApi.js`: API関数（商品検索、在庫調整、データ保存、VariantCache）
  - `StocktakeScreen.jsx`: 画面ルーター
- ✅ **メニュー画面**: `/extensions/stock-transfer-loss/src/Modal.jsx`に「棚卸」ボタンを追加
  - ✅ 軽量モードボタンを追加（メニュー画面、商品リスト画面）
  - ✅ スキャナー処理を実装（出庫/入庫と同じ方式）

### 3.7 入庫処理UIの流用（実装時の参考）

棚卸機能のPOS UIは、入庫（受領）処理のUIをそのまま流用します。以下の対応関係で実装します：

#### 画面構成の対応関係

| 入庫処理（既存） | 棚卸処理（新規） | 説明 |
|----------------|----------------|------|
| `InboundConditions` | `InventoryCountConditions` | 棚卸ID入力画面（コンディション画面相当） |
| `InboundShipmentSelection` | `InventoryCountProductGroupSelection` | 商品グループ選択画面（シップメント選択相当） |
| `InboundList` | `InventoryCountList` | 商品リスト画面（入庫商品リスト相当） |

#### ① InventoryCountConditions（棚卸ID入力画面）

**流用元**: `InboundConditions` (7463行目～)

**変更点**:
- 入庫ID一覧 → 棚卸ID一覧
- Transfer → InventoryCount
- タブ「未受領/受領済み」→ タブ「未完了/完了済み」
- 出庫元/入庫先 → ロケーション/商品グループ
- `fetchTransfersForDestinationAll` → 棚卸ID取得API
- `onTapTransfer` → `onTapInventoryCount`（商品グループが1つの場合は直接商品リストへ、複数の場合は商品グループ選択画面へ）

**実装箇所**: `/extensions/stock-transfer-tile/src/Modal.jsx` に `InventoryCountConditions` 関数を追加

#### ② InventoryCountProductGroupSelection（商品グループ選択画面）

**流用元**: `InboundShipmentSelection` (8070行目～)

**変更点**:
- シップメント選択 → 商品グループ選択
- シップメント一覧 → 商品グループ一覧
- Transfer情報 → 棚卸ID情報
- `onSelectShipment` → `onSelectProductGroup`
- シップメントの数量情報 → 商品グループの対象SKU数（オプション）

**実装箇所**: `/extensions/stock-transfer-tile/src/Modal.jsx` に `InventoryCountProductGroupSelection` 関数を追加

**表示条件**: 棚卸IDに紐づく商品グループが複数の場合のみ表示（1つの場合は自動で商品リストへ）

#### ③ InventoryCountList（商品リスト画面）

**流用元**: `InboundList` (8346行目～)

**変更点**:
- 入庫商品リスト → 棚卸商品リスト
- 予定数/受領数 → 現在在庫数/実数
- 受領確定処理 → 在庫絶対値調整処理
- `receiveConfirm` → `inventoryCountConfirm`（絶対値処理）
- 予定外入庫/過剰入庫の警告 → 不要（絶対値処理のため）
- ヘッダーの「出庫元/入庫先」→「ロケーション/商品グループ」
- フッターの「予定/受領」→「現在在庫/実数」

**実装箇所**: `/extensions/stock-transfer-tile/src/Modal.jsx` に `InventoryCountList` 関数を追加

**重要な違い**:
- **在庫調整処理**: 入庫は差分調整、棚卸は絶対値調整
- **初期表示**: 在庫レベルがないSKUは非表示（スキャン/検索で追加可能）
- **数量入力**: 実数を直接入力（現在在庫数は参考表示のみ）

#### データ構造の対応関係

| 入庫処理 | 棚卸処理 | 説明 |
|---------|---------|------|
| `inbound.selectedShipmentId` | `inventoryCount.selectedProductGroupId` | 選択中の商品グループID |
| `inbound.selectedTransferId` | `inventoryCount.selectedCountId` | 選択中の棚卸ID |
| `inbound.selectedTransferName` | `inventoryCount.selectedCountName` | 棚卸ID名 |
| `inbound.selectedOriginName` | `inventoryCount.selectedLocationName` | ロケーション名 |
| `inbound.selectedDestinationName` | `inventoryCount.selectedProductGroupName` | 商品グループ名 |

#### 実装時の注意事項

1. **appStateの拡張**: `appState` に `inventoryCount` スライスを追加
   ```typescript
   type AppState = {
     // ... 既存のスライス ...
     inventoryCount?: {
       selectedCountId: string;
       selectedCountName: string;
       selectedLocationId: string;
       selectedLocationName: string;
       selectedProductGroupId: string;
       selectedProductGroupIds: string[]; // 複数選択時
       productGroupMode: "single" | "multiple";
       selectedProductGroupName: string;
       selectedReadOnly: boolean;
       // ... その他の状態 ...
     };
   };
   ```

2. **SCREENS定数の追加**: 
   ```javascript
   const SCREENS = {
     // ... 既存の画面 ...
     INVENTORY_COUNT_COND: "inv_count_cond",
     INVENTORY_COUNT_PRODUCT_GROUP_SELECTION: "inv_count_group_selection",
     INVENTORY_COUNT_LIST: "inv_count_list",
   };
   ```

3. **メニュー画面への追加**: メニュー画面に「棚卸」ボタンを追加

4. **スキャナー処理**: 入庫処理と同じように `Modal.jsx` の `Extension` コンポーネントでスキャナーを購読し、`INVENTORY_COUNT_LIST` 画面の時だけキューに積む

5. **在庫調整API**: `inventoryAdjustQuantity` GraphQL mutationを使用（絶対値処理）

### 3.6 実装時の注意事項

#### 在庫レベルがないSKUの扱い
- **初期表示**: 対象ロケーションに在庫レベルがないSKUは商品リストに表示しない
- **スキャン/検索時**: スキャンや検索入力で該当商品が見つかった場合、リストに追加して有効化（表示・編集可能）して処理できる
- **実装方法**: 
  - 商品グループのコレクションから商品を取得する際、在庫レベルでフィルタリング
  - スキャン/検索時は在庫レベルの有無に関係なく商品を検索し、見つかった場合はリストに追加

#### 商品グループ選択画面の表示制御
- **商品グループが1つの場合**: 商品グループ選択画面をスキップして商品リスト画面に直接遷移
- **商品グループが複数の場合**: 商品グループ選択画面を表示（入庫のシップメント選択と同じUI/UX）
- **将来拡張**: 管理画面でデフォルト動作を設定可能に（「リスト選択」or「まとめて表示」）

#### 入庫処理への影響
- 棚卸機能実装時に、入庫処理にも同様の設定を追加することを検討
- シップメントが複数の場合のデフォルト動作を管理画面で設定可能にする

---

## 4. データベース設計

### 4.1 現在の実装
- **Session管理**: Prisma SQLite（`/prisma/schema.prisma`）
- **設定データ**: Shopify Metafield（`currentAppInstallation.metafield`）

### 4.2 新規データの保存方法

#### オプション1: Metafield方式（推奨・現状維持）
- **メリット**: 実装が簡単、Shopify標準
- **デメリット**: データ量に制限がある可能性、検索・集計が難しい
- **適用**: ロス登録、棚卸設定、棚卸ID

#### オプション2: Prismaデータベース方式
- **メリット**: 検索・集計が容易、データ量制限なし
- **デメリット**: スキーマ変更が必要、マイグレーション管理が必要
- **適用**: 将来的な拡張を考慮する場合

#### 推奨方針
- **Phase 1**: Metafield方式で実装（迅速な実装）
- **Phase 2**: 必要に応じてPrismaデータベースに移行（データ量・パフォーマンス問題が発生した場合）

### 4.3 データ構造の統一

#### SettingsV1 の実装（2026-01-27更新）
```typescript
type SettingsV1 = {
  version: 1;
  destinationGroups?: DestinationGroup[]; // 非推奨（後方互換性のため残す）
  carriers: CarrierOption[];
  // 実装済み設定項目
  visibleLocationIds?: string[]; // 表示ロケーション選択設定（空配列=全ロケーション表示）
  outbound?: {
    allowForceCancel?: boolean; // 強制キャンセル処理許可（デフォルト: true）
    historyInitialLimit?: number; // 履歴一覧リスト（出庫・入庫・ロス履歴）初回件数。API上限250、推奨100
  };
  inbound?: {
    allowOverReceive?: boolean; // 過剰入庫許可（デフォルト: true）
    allowExtraReceive?: boolean; // 予定外入庫許可（デフォルト: true）
    listInitialLimit?: number; // 履歴一覧リスト（出庫・入庫・ロス履歴）初回件数。API上限250、推奨100
    shipmentSelectionMode?: "list" | "all"; // シップメントが複数の場合のデフォルト動作（"list": リスト選択, "all": まとめて表示、将来拡張）
  };
  productList?: {
    initialLimit?: number; // 商品リスト（出庫・入庫・ロス登録）初回件数。lineItems上限250、推奨250
  };
  searchList?: {
    initialLimit?: number; // 検索リスト（出庫・入庫・ロス登録）初回件数。productVariants上限50、推奨50
  };
  inventoryCount?: {
    productGroupSelectionMode?: "list" | "all"; // 商品グループが複数の場合のデフォルト動作（"list": リスト選択, "all": まとめて表示、将来拡張）
  };
};
```

**注意**: 
- `outbound.historyInitialLimit`と`inbound.listInitialLimit`は、設定画面で統合して「履歴一覧リスト」として表示・設定されます
- 設定画面で変更すると、両方の値が同時に更新されます（出庫履歴・入庫履歴・ロス履歴に適用）
- `productList.initialLimit`と`searchList.initialLimit`は、出庫・入庫・ロス登録の全てに適用されます

---

## 5. 実装優先順位

### Phase 1: 管理画面の設定拡張（最優先）✅ 完了
1. ✅ 設定画面の拡張（`/app/settings.tsx`）- 完了（2026-01-27）
   - ✅ 表示ロケーション選択設定
   - ✅ 履歴一覧リスト表示件数設定（出庫・入庫・ロス履歴に適用）
   - ✅ 商品リスト表示件数設定（出庫・入庫・ロス登録に適用）
   - ✅ 検索リスト表示件数設定（出庫・入庫・ロス登録に適用）
   - ✅ 各種許可設定（強制キャンセル、過剰入庫、予定外入庫）

### Phase 2: 入出庫履歴管理画面（高優先度）
2. ✅ 履歴管理画面の作成（`/app/history.tsx`）
   - ✅ 履歴一覧表示（出庫・入庫統合表示）
   - ✅ フィルター機能（出庫ロケーション、入庫ロケーション、ステータス - 複数選択対応）
   - ✅ ページネーション（次へ/前へボタン、ページ表示）
   - ✅ モーダル表示（履歴クリックで商品リストをモーダル表示）
   - ✅ モーダルから個別CSV出力
   - ✅ 予定数/入庫数表示（分けて表示）
   - ✅ 予定外入庫表示（メモから抽出、薄い赤背景）
   - ✅ 予定外入庫を含めた数量計算（一覧表示に反映）
   - ✅ 予定外入庫の件数表示（一覧の状態横に表示）
   - ⏸️ 一括CSV出力（調整中、一時的に非表示）
   - フィルター機能
   - CSV出力機能
   - 詳細画面

### Phase 3: ロス登録機能（中優先度）
3. ⚠️ ロス登録機能の実装（POS UI実装中、エラー発生）
   - ⚠️ POS UIでのロス登録処理
     - ✅ コンディション画面（ロケーション、日付、理由、スタッフ名入力）
     - ⚠️ 商品リスト画面（出庫処理と完全に同じUI/UX）- **エラー発生中**
       - 問題: コンディションから次へを押した瞬間に`hasOwnProperty`エラーが発生
       - 修正状況: 出庫/入庫の実装を参考に修正済み（2026-01-26）だが、エラーが継続
       - 優先度: 高（機能が使用できない状態）
     - ✅ 履歴一覧画面（現在のロケーションで自動フィルター）
     - ✅ 在庫調整処理（`inventoryAdjustQuantity` GraphQL mutation）
     - ✅ データ保存（Metafield方式、`loss_entries_v1`）
   - ✅ 管理画面でのロス登録履歴表示（実装済み）
   - ✅ CSV出力機能（実装済み）
   - ✅ キャンセル機能（実装済み、在庫を戻す処理も含む）

### Phase 4: 棚卸機能（中優先度）
4. ⏸️ 棚卸機能の実装
   - ✅ 管理画面での商品グループ設定（実装済み）
   - ✅ 管理画面での棚卸ID発行処理（実装済み、複数商品グループ選択対応が必要）
   - ✅ 管理画面での棚卸履歴表示（実装済み）
   - ❌ POS UIでの棚卸処理（未実装）
     - 棚卸ID入力画面（コンディション画面相当）
     - 商品グループ選択画面（シップメント選択相当、商品グループが複数の場合のみ）
     - 商品リスト画面（入庫商品リスト相当）
     - 在庫絶対値調整処理
     - 在庫レベルがないSKUの扱い（スキャン/検索で追加可能）

---

## 6. 実装時の注意事項

### 6.1 既存機能への影響
- 既存の出庫・入庫機能を壊さないよう注意
- 設定項目のデフォルト値は既存の動作を維持するように設定

### 6.2 パフォーマンス
- 履歴一覧の表示件数に制限を設ける（ページネーション対応）
- 大量データのCSV出力は非同期処理を検討

### 6.3 エラーハンドリング
- 在庫調整時のエラーを適切に処理
- キャンセル処理時の差分調整を確実に実行

### 6.4 UI/UX
- Shopify Polarisデザインガイドラインに準拠
- POS UI Extensionの制約を遵守
- タッチ操作に最適化

---

## 7. 確認事項

### 7.1 現状コードの確認結果 ✅（2026-01-27更新）
- [x] 出庫履歴リストの現在の表示件数: **100件/ページ**（`fetchTransfersForOriginAll`、設定で変更可能）
- [x] 入庫リストの現在の表示件数: **100件/ページ**（設定で変更可能、`outbound.historyInitialLimit`と`inbound.listInitialLimit`で統合管理）
- [x] ロス履歴リストの表示件数: **設定画面の履歴一覧リスト設定に従う**（`outbound.historyInitialLimit`と`inbound.listInitialLimit`で統合管理）
- [x] 商品リストの現在の表示件数: **250件（初期）**、20件ずつ追加読み込み（`candidatesDisplayLimit`、設定で変更可能、`productList.initialLimit`）
- [x] 検索リストの現在の表示件数: **50件（初期）**（設定で変更可能、`searchList.initialLimit`、出庫・入庫・ロス登録に適用）
- [x] 強制キャンセル処理の現在の実装状況: **実装済み**（noteに"[強制キャンセル]"が含まれているかで判定、設定で許可/不許可を切り替え可能）
- [x] 過剰入庫・予定外入庫の現在の実装状況: **実装済み**（監査ログで管理、`over`と`extras`として処理、設定で許可/不許可を切り替え可能）

### 7.2 設計判断が必要な項目
- [x] 管理画面のURL構造: **決定済み**（4つのページに分割）
- [ ] ロス登録・棚卸のデータ保存方法（Metafield vs Prisma）
- [ ] 商品グループのネスト機能の必要性
- [ ] CSV出力の詳細フォーマット

---

## 8. 次のステップ

1. ✅ **現状コードの確認**: 完了（表示件数、強制キャンセル、過剰入庫・予定外入庫の実装状況を確認）
2. ✅ **管理画面の構造**: 決定済み（4つのページに分割）
3. ✅ **ロス登録機能のエラー修正**: **完了・機能検証完了**（2026-01-27）
   - エラー: `undefined is not an object (evaluating 'Object.prototype.hasOwnProperty.call(e,t)')`
   - 発生タイミング: コンディション画面から「次へ」を押した瞬間
   - 根本原因: スキャナー処理の実装場所の違い（出庫/入庫は`Modal.jsx`で開始、ロス登録は`LossProductList`内で開始）
   - 修正内容: スキャナー処理を`Modal.jsx`に移動、出庫/入庫と同じ実装に統一
   - 修正状況: ✅ 完了（機能検証完了）
4. ✅ **自動保存・復元機能の改善**: **完了**（2026-01-27）
   - ✅ ロスコンディション画面: 復元時にトースト表示、商品リストから戻った時に復元
   - ✅ 出庫コンディション画面: 自動保存・復元機能を実装（ロス登録と同様）
5. ✅ **配送番号のスキャン機能**: **完了**（2026-01-27）
   - ✅ 出庫コンディション画面でスキャンした際に配送番号に自動入力
   - ✅ 確定モーダル内でもスキャン可能
6. ✅ **スキャナーのトースト整理**: **完了**（2026-01-27）
   - ✅ 不要なデバッグ用トーストを削除
7. **棚卸機能（POS UI）の実装**: **未着手**
   - [ ] 棚卸ID入力画面（コンディション画面相当）の実装
   - [ ] 商品グループ選択画面（シップメント選択相当）の実装
   - [ ] 商品リスト画面（入庫商品リスト相当）の実装
   - [ ] 在庫絶対値調整処理の実装
   - [ ] 在庫レベルがないSKUの扱い（スキャン/検索で追加可能）
   - [ ] 管理画面での棚卸ID発行処理の複数商品グループ選択対応
8. **設計判断**: データ保存方法、商品グループのネスト機能、CSV出力フォーマット等を決定
9. **実装開始**: Phase 1から順次実装
   - ✅ ナビゲーションメニューの更新（`/app/routes/app.tsx`）- 完了
   - ✅ 各管理画面ページの実装 - 完了
10. **テスト**: 各Phase完了後にテスト実施
11. **ドキュメント更新**: 実装完了後にREADME等を更新

---

## 9. 実装サマリー

### 9.1 管理画面の構成（4つのページ）

#### ① TOP（設定）: `/app/settings` ✅ 実装完了
- **ファイル**: `/app/routes/app.settings.tsx`
- **実装済み設定項目**: 
  - ✅ 店舗グループ（destinationGroups）設定（非推奨、後方互換性のため残す）
  - ✅ 配送会社（carriers）設定
  - ✅ 表示ロケーション選択設定（`visibleLocationIds`）
  - ✅ 出庫：強制キャンセル処理許可設定（`outbound.allowForceCancel`）
  - ✅ 入庫：過剰入庫許可設定（`inbound.allowOverReceive`）
  - ✅ 入庫：予定外入庫許可設定（`inbound.allowExtraReceive`）
  - ✅ 履歴一覧リスト表示件数設定（`outbound.historyInitialLimit`、`inbound.listInitialLimit`、出庫・入庫・ロス履歴に適用）
  - ✅ 商品リスト表示件数設定（`productList.initialLimit`、出庫・入庫・ロス登録に適用）
  - ✅ 検索リスト表示件数設定（`searchList.initialLimit`、出庫・入庫・ロス登録に適用）
- **データ保存**: `SettingsV1` 型で `currentAppInstallation.metafield` に保存

#### ② 入出庫履歴: `/app/history`
- **新規ファイル**: `/app/routes/app.history.tsx`（一覧画面）、`/app/routes/app.history.$id.tsx`（詳細画面、オプション）
- **機能**: 履歴一覧表示、フィルター、CSV出力、詳細表示
- **データ取得**: GraphQL `inventoryTransfers` クエリ + 監査ログ

#### ③ ロス登録履歴: `/app/loss`
- **新規ファイル**: `/app/routes/app.loss.tsx`（一覧画面）、`/app/routes/app.loss.$id.tsx`（詳細画面、オプション）
- **機能**: 履歴一覧表示、フィルター、CSV出力、詳細表示
- **データ保存**: `currentAppInstallation.metafield` (key: `loss_entries_v1`)
- **POS UI**: `/extensions/stock-transfer-loss/src/screens/loss/` に実装
  - ⚠️ **商品リスト画面**: 実装済みだが、初期化時にエラーが発生（要修正）
- **在庫調整**: `inventoryAdjustQuantity` GraphQL mutation（マイナス値で処理）

#### ④ 棚卸: `/app/inventory-count` ✅ 実装完了（確定処理のエラー修正中）
- **ファイル**: `/app/routes/app.inventory-count.tsx`（設定・履歴・CSV出力を含む）
- **実装状況**: ✅ 管理画面は実装完了、✅ POS UIも実装完了（確定処理のエラー修正中）
- **機能**: 
  - ✅ 商品グループ設定（カテゴリ設定、コレクション選択）
  - ✅ 棚卸ID発行（ロケーション選択、商品グループ複数選択対応）
  - ✅ 履歴一覧表示、フィルター、CSV出力
  - ✅ 棚卸ID表示形式: `#C0000`形式（既存データにも自動付与）
- **データ保存**: 
  - ✅ 商品グループ: `currentAppInstallation.metafield` (key: `product_groups_v1`)
  - ✅ 棚卸ID: `currentAppInstallation.metafield` (key: `inventory_counts_v1`)
- **POS UI**: ✅ `/extensions/stock-transfer-loss/src/screens/stocktake/` に実装完了
  - ✅ 棚卸ID入力画面（コンディション画面相当）
  - ✅ 商品グループ選択画面（シップメント選択相当、商品グループが複数の場合のみ）
  - ✅ 商品リスト画面（入庫商品リスト相当）
  - ✅ 確定モーダル（入庫の確定モーダルを参考）
  - ✅ 自動保存・復元機能（下書きの自動保存・復元）
  - ✅ VariantCache活用（スキャン時の商品検索を高速化）
  - ✅ 軽量モード（画像OFF機能）
- **在庫調整**: ✅ `inventorySetQuantities` GraphQL mutation（ロス登録と同じ処理方法、絶対値設定）

### 9.5 実装優先順位（2026-01-27更新）
1. **Phase 1（最優先）**: 管理画面の構成 ✅ 完了
   - ✅ TOP（設定）: `/app/settings` の拡張（完了）
   - ✅ 入出庫履歴: `/app/history` の作成（完了）
   - ✅ ロス登録履歴: `/app/loss` の作成（完了）
   - ✅ 棚卸: `/app/inventory-count` の作成（完了）
2. **Phase 2（高優先度）**: POS UI機能の実装 ✅ 完了
   - ✅ ロス登録機能（POS UI）（完了、エラー修正済み）
   - ✅ 棚卸機能（POS UI）（実装完了、確定処理のエラー修正中）

---

## 10. 確認事項と判断が必要な項目

### 10.1 設計判断が必要な項目
- [x] 管理画面のURL構造: **決定済み**
  - `/app/settings` - TOP（設定）
  - `/app/history` - 入出庫履歴
  - `/app/loss` - ロス登録履歴
  - `/app/inventory-count` - 棚卸（設定・履歴）
- [ ] ロス登録・棚卸のデータ保存方法（Metafield vs Prisma）
  - **推奨**: Phase 1はMetafield方式で実装、必要に応じてPrismaに移行
- [ ] 商品グループのネスト機能の必要性
  - **判断**: まずはフラットな構造で実装、必要に応じてネスト機能を追加
- [ ] CSV出力の詳細フォーマット
  - **判断**: 基本的な項目（ID, 日付, ロケーション, 商品明細等）を出力、必要に応じて拡張

### 10.2 技術的な確認事項（2026-01-27更新）
- [ ] Metafieldのデータ量制限（大量の履歴データを保存する場合）
- [ ] CSV出力時のパフォーマンス（大量データの処理）
- [ ] 在庫調整時のエラーハンドリング（同時更新の競合等）
- [x] ✅ ロス登録機能の商品リスト画面の初期化エラー: **修正完了・機能検証完了**（2026-01-27）
  - エラー: `undefined is not an object (evaluating 'Object.prototype.hasOwnProperty.call(e,t)')`
  - 発生タイミング: コンディション画面から「次へ」を押した瞬間
  - 根本原因: スキャナー処理の実装場所の違い（出庫/入庫は`Modal.jsx`で開始、ロス登録は`LossProductList`内で開始）
  - 修正内容: スキャナー処理を`Modal.jsx`に移動、出庫/入庫と同じ実装に統一
  - 修正状況: ✅ 完了（機能検証完了）
- [x] ✅ 自動保存・復元機能の改善: **完了**（2026-01-27）
  - ロスコンディション画面: 復元時にトースト表示、商品リストから戻った時に復元
  - 出庫コンディション画面: 自動保存・復元機能を実装
- [x] ✅ 配送番号のスキャン機能: **完了**（2026-01-27）
  - 出庫コンディション画面と確定モーダル内でスキャン可能
- [ ] ⚠️ 棚卸機能の確定処理エラー: **修正中**（2026-01-27）
  - HTTP 400エラーが発生している可能性
  - ロス登録と同じ処理方法（`inventorySetQuantities`で絶対値設定）に変更済み
  - エラーハンドリングを改善済み（詳細なエラーメッセージとデバッグログを追加）
  - `graphql`関数に`#graphql`コメント削除処理を追加済み
- [ ] ⚠️ 棚卸機能の確定処理エラー: **修正中**（2026-01-27）
  - HTTP 400エラーが発生している可能性
  - ロス登録と同じ処理方法（`inventorySetQuantities`で絶対値設定）に変更済み
  - エラーハンドリングを改善済み（詳細なエラーメッセージを表示）

---

## 11. 参考情報

### 11.1 現状コードの主要な実装箇所
- **設定管理**: `/app/routes/app.settings.tsx`
- **ナビゲーション**: `/app/routes/app.tsx`（ナビゲーションメニューの更新が必要）
- **出庫処理**: `/extensions/stock-transfer-tile/src/Modal.jsx` (OutboundHistoryConditions, OutboundHistoryDetail等)
  - ✅ 出庫コンディション画面: 自動保存・復元機能実装済み（2026-01-27）
  - ✅ 配送番号のスキャン機能実装済み（出庫コンディション画面、確定モーダル内）
- **入庫処理**: `/extensions/stock-transfer-tile/src/Modal.jsx` (InboundList, InboundReceive等)
- **監査ログ**: `/extensions/stock-transfer-tile/src/Modal.jsx` (readInboundAuditLog, appendInboundAuditLog等)
- **ロス登録**: `/extensions/stock-transfer-loss/src/screens/loss/` (LossConditions, LossProductList, LossHistoryList等)
  - ✅ 自動保存・復元機能実装済み（2026-01-27）
  - ✅ スキャナー処理を`Modal.jsx`に移動、出庫/入庫と同じ実装に統一

### 11.4 ナビゲーションメニューの更新
`/app/routes/app.tsx` のナビゲーションメニューを以下のように更新する必要があります：

```tsx
<s-app-nav>
  <s-link href="/app/settings">設定</s-link>
  <s-link href="/app/history">入出庫履歴</s-link>
  <s-link href="/app/loss">ロス登録履歴</s-link>
  <s-link href="/app/inventory-count">棚卸</s-link>
</s-app-nav>
```

**注意**: `/app` (Home) は `/app/settings` にリダイレクトするように実装済み（`/app/routes/app._index.tsx` で `redirect("/app/settings")` を実行）

### 11.2 GraphQL API
- **在庫調整**: `inventoryAdjustQuantity` mutation
- **Transfer取得**: `inventoryTransfers` query
- **Shipment取得**: `inventoryShipment` query
- **商品検索**: `productVariants` query

### 11.3 データ構造
- **SettingsV1**: `/app/routes/app.settings.tsx` で定義
- **監査ログ**: `/extensions/stock-transfer-tile/src/Modal.jsx` で定義（INBOUND_AUDIT_NS, INBOUND_AUDIT_KEY）

---

## 12. 最新の修正履歴（2026-01-27）

### 12.1 UI改善（2026-01-27）

#### ① タイル・メニュータイトルの変更 ✅ 完了
- **タイルタイトル**: 「ロス・棚卸」→「在庫調整」
- **タイルサブタイトル**: 「ロス登録/棚卸」→「ロス / 棚卸」
- **メニュータイトル**: 「ロス・棚卸」→「メニュー」
- **実装ファイル**: 
  - `/extensions/stock-transfer-loss/src/Tile.jsx`
  - `/extensions/stock-transfer-loss/src/Modal.jsx`

#### ② ロス登録コンディション画面の改善 ✅ 完了
- **理由ボタンのレイアウト**: 縦並び→横3列で均等に表示
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/loss/LossConditions.jsx`

#### ③ 棚卸商品グループリストの改善 ✅ 完了
- **棚卸ID表示**: ID数値→名称（#C0000形式）で表示
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`

#### ④ 棚卸商品リストの改善 ✅ 完了
- **フッター表示**: 「現在在庫」→「在庫」に変更、差分を改行して赤色表示
- **ヘッダーボタン**: 「軽量ON/OFF」→「軽量」のみ表示（色でON/OFF表現）、「在庫再取得」ボタンを追加
- **予定外リスト**: 初期リストにない商品を最下部に別表示、数量1の場合は×ボタンで削除可能
- **検索リストの数量ボタン**: -数字+形式に変更（直接数字入力可能）
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`

#### ⑤ 在庫再取得機能の改善 ✅ 完了
- **問題**: 在庫再取得時に商品リストが消えてしまう、在庫数が更新されない
- **修正内容**:
  - `refreshing`状態を追加（出庫リストと同じ方式）
  - `stockLoading`フラグを使用して在庫数部分だけ「…」を表示
  - キャッシュを無効化するオプション（`noCache: true`）を追加
  - 在庫再取得時に数量（actualQuantity）を保持し、在庫数（currentQuantity）だけを更新
- **実装ファイル**: 
  - `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
  - `/extensions/stock-transfer-loss/src/screens/stocktake/stocktakeApi.js`

#### ⑥ 確定モーダルの改善 ✅ 完了
- **調整対象リスト**: 最大10件→1件のみ表示（「…他X件」形式）
- **空白ボタン問題**: `slot="footer"`を明示的に空にして解決
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`

#### ⑦ 確定処理のエラーハンドリング改善 ✅ 完了
- **問題**: HTTP 400エラーが発生しても在庫調整が実行されてしまう
- **修正内容**:
  - 在庫調整（`adjustInventoryToActual`）と履歴更新（`writeInventoryCounts`）を分離
  - 在庫調整が失敗した場合は処理を中断
  - 在庫調整が成功しても履歴更新が失敗した場合は警告を表示
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`

#### ⑧ 数量モーダルのレイアウト改善 ✅ 完了
- **問題**: 削除ボタンと戻るボタンの順序が不自然、幅が統一されていない
- **修正内容**:
  - レイアウト順序: 下線→削除ボタン→下線→戻るボタン→確定ボタン
  - 削除ボタンと戻るボタンの幅を統一（`padding="none"`を設定）
  - `slot="footer"`を明示的に空にして空白ボタンを防止
- **実装ファイル**: 
  - `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
  - `/extensions/stock-transfer-loss/src/screens/loss/LossProductList.jsx`

#### ⑨ 管理画面UI改善（2026-01-27）✅ 完了
- **商品グループ設定の改善**:
  - ✅ コレクション検索機能: 大量のコレクションがある場合を想定し、検索で候補を表示
  - ✅ コレクション内商品の個別選択: コレクション選択時にモーダルで商品リストを表示、デフォルトは全選択、チェックを外すと対象外
  - ✅ 選択数/合計数の表示: コレクション名の横に「選択数 / 合計数」を表示（例: `5 / 10`）
  - ✅ グループ合計数量の表示: 登録済み商品グループに「合計: 選択 X / Y」を表示
  - ✅ コレクション名をクリックすると、選択商品の確認・編集が可能
- **棚卸ID発行の改善**:
  - ✅ ロケーション検索機能: 検索で候補を表示、空白で全ロケーション表示
- **履歴画面の改善**:
  - ✅ 入出庫履歴・ロス登録履歴とUIを統一（フィルター、モーダル表示、CSV出力）
- **実装ファイル**: `/app/routes/app.inventory-count.tsx`

#### ⑫ 商品グループ設定UI改善（2026-01-27）✅ 完了
- **二分割レイアウトの実装**:
  - ✅ 左側（約300px固定幅）: グループ名入力 + 「グループを追加する」ボタン + 編集モード時のコレクション選択フォーム
  - ✅ 右側（残りの幅）: 登録済み商品グループのリスト（各グループにコレクションリストと商品数量を表示）
- **コレクション表示の改善**:
  - ✅ ボタン形式から画像カード形式に変更
  - ✅ 横並びから縦並びのカード形式に変更（画像・タイトル・数量が横並びの横長カード）
  - ✅ 画像サイズ: 40px × 40px（編集モード時と登録済みグループ内で統一）
  - ✅ 画像がない場合は、コレクション名の頭文字を表示
- **右側のコレクションリストから直接編集機能**:
  - ✅ 登録済み商品グループ内のコレクションリストをクリックするとモーダルが開く
  - ✅ モーダルで商品選択を変更して確定すると、直接その商品グループが更新される（編集モードに入る必要がない）
- **実装ファイル**: `/app/routes/app.inventory-count.tsx`

#### ⑬ 棚卸ID生成時の商品リスト保存機能（2026-01-27）✅ 完了
- **目的**: 商品グループを編集しても、既に生成済みの棚卸IDには影響しないようにする
- **実装内容**:
  - ✅ 棚卸ID生成時に、選択された商品グループの`inventoryItemIds`を`inventoryItemIdsByGroup`に保存
  - ✅ `InventoryCount`型に`inventoryItemIdsByGroup`フィールドを追加（商品グループごとの`inventoryItemIds`を保存）
  - ✅ POS UI側の`fetchProductsByGroups`関数を修正して、`inventoryItemIdsByGroup`が指定されている場合はそれを使用
  - ✅ `InventoryCountList.jsx`で`fetchProductsByGroups`を呼び出す際に、`count.inventoryItemIdsByGroup`を渡すように修正
- **動作**:
  - **生成済みの棚卸ID**: `inventoryItemIdsByGroup`に保存された生成時の商品リストを使用
  - **商品グループを編集後**: 既存の棚卸IDは生成時の商品リストを使用するため、影響なし
  - **新規生成の棚卸ID**: 編集後の商品グループの状態を使用
- **実装ファイル**: 
  - `/app/routes/app.inventory-count.tsx`
  - `/extensions/stock-transfer-loss/src/screens/stocktake/stocktakeApi.js`
  - `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`

#### ⑩ 複数グループ対応・完了判定修正（2026-01-27）✅ 完了
- **問題1**: 2つ以上の商品グループを持っていて片方だけ処理済みで他が未処理のものが完了済みに振り分けられている
  - **原因**: 完了判定が`Array.isArray(groupItems[id])`のみで、空配列でも完了扱いになっていた
  - **修正内容**: `Array.isArray(items) && items.length > 0`で、配列が存在し、かつ長さが0より大きい場合のみ完了と判定
- **問題2**: 完了済みの商品リストも編集できるようになっている
  - **原因**: `readOnly`判定が`groupItems[productGroupId]`の存在のみで、`count.status === "completed"`の場合を考慮していなかった
  - **修正内容**: 
    - `readOnly`判定を`readOnlyProp || count?.status === "completed"`に変更
    - `InventoryCountProductGroupSelection`でも`count.status === "completed"`を考慮
    - 完了済みグループタップ時のフリーズ修正: `groupItems`から直接読み込み、API取得をスキップ
- **実装ファイル**: 
  - `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
  - `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountProductGroupSelection.jsx`

#### ⑪ 棚卸機能のバグ修正・データ保存改善（2026-01-27）⏸️ 修正中
- **問題1**: 管理画面で完了しているグループが未完了と表示される
  - **原因**: `groupItems[groupId]`の存在チェックが不十分
  - **修正内容**: 
    - `isGroupCompleted`ロジックを改善: `groupId && groupItemsMap[groupId] && Array.isArray(groupItemsMap[groupId])`をチェック
    - `groupItemsFromMap.length > 0`で完了判定
- **問題2**: アプリ（まとめて表示）で完了しているグループも未完了と表示され、数量も反映されていない
  - **原因**: 
    - `groupItems[groupId]`から読み込んだデータの`currentQuantity`と`actualQuantity`が正しく設定されていない可能性
    - `barcode`フィールドが保存されていない
  - **修正内容**: 
    - `barcode`フィールドを`linesSnapshot`、`entry`、`mergedEntry`に追加
    - `handleComplete`で`barcode`を保存するように修正
    - 完了済みアイテムを読み込む際に`isReadOnly: true`を明示的に設定
- **問題3**: アプリ（グループごとに表示）で処理済みをタップしても全てのグループの商品一覧が表示される
  - **原因**: `storedItemsFromItems`が使用されている（`count.items`が全グループのデータを含んでいる）
  - **修正内容**: 
    - `storedItemsFromItems`の使用条件を修正: `!isMultipleGroups && !storedItemsFromGroup`の場合のみ使用
    - `storedItemsFromGroup`が存在する場合は、必ず`storedItemsFromGroup`を優先
- **問題4**: 管理画面のモーダルに「グループ名」列が表示されない
  - **修正内容**: 
    - テーブルヘッダーに「商品グループ」列を追加
    - 列を「商品グループ、商品名、SKU、JAN、オプション1、オプション2、オプション3、在庫、実数、差分」に変更
- **問題5**: `writeInventoryCounts`の重複呼び出し
  - **原因**: `handleComplete`内で`writeInventoryCounts`が2回呼ばれていた
  - **修正内容**: 重複呼び出しを削除
- **問題6**: ビルドエラー（`Unexpected "else"`）
  - **原因**: `if (itemsToAdjust.length === 0)`のブロック内で`else`ブロックが重複していた
  - **修正内容**: 重複した`else`ブロックを削除
- **実装ファイル**: 
  - `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`
  - `/app/routes/app.inventory-count.tsx`
- **修正状況**: ✅ 修正完了（2026-01-27）

### 12.16 POS入庫・出庫のリスト戻り時バグ修正（2026-02）✅ 完了

入庫確定後や出庫送信後にリストに戻り、別IDを開いた際に「先程確定した商品リストが表示されて別IDの商品が見れない」という現象の修正。

#### 要因
- **入庫**: 入庫確定後に入庫条件画面（INBOUND_COND）に戻る際、`inbound` の `selectedTransferId` / `selectedShipmentId` 等をクリアしていなかった。このため「続ける」で再度入庫リストを開くと前回確定したIDが選ばれたままになり、前の商品リストが表示されていた。
- **下書き復元**: 入庫の下書きは transferId 別キーで保存され、確定時に `clearInboundDraft` で削除されている。表示が前のままになる主因は「選択状態が残っていたこと」であり、下書き復元そのものは副次的。

#### 修正内容（入庫）
- `onAfterReceive` 内で、全シップメント完了で INBOUND_COND に戻る直前に `setStateSlice(setAppState, "inbound", { ... })` で入庫の選択状態（`selectedTransferId`, `selectedShipmentId`, `selectedShipmentIds`, `shipmentMode`, 表示用メタ）をクリア。
- 未完了でシップメント選択画面に戻る場合は、同じ Transfer の別シップメント選択のため、`selectedTransferId` 等は維持し、`selectedShipmentId` / `selectedShipmentIds` / `shipmentMode` のみクリア。

#### 修正内容（出庫）
- **送信成功時**: 既存下書き更新・新規作成の両方で、`setStateSlice` に `lines: []`, `result: null` を追加し、appState の `outbound` をクリア。次に別IDを開いたときに前の商品リストが残らないようにした。
- **履歴詳細から戻る時**: `goBackFromOutboundHistoryDetail` を新規追加。出庫履歴詳細で「戻る」を押したときに `historySelectedTransferId` をはじめとする履歴選択用 state をクリアし、その後 `nav.pop()`。`OutboundHistoryDetail` の `onBack` をこのコールバックに変更。

#### ロス・棚卸について
- **ロス**: `LossScreen` で商品リストから戻る際に `handleBackFromProduct` で `setConds(null)` しており、条件は戻るたびにクリアされている。同様の「前のIDが残る」現象は起きにくい構造のため、追加修正はしていない。
- **棚卸**: React Router の別ルートで、選択状態は主にコンポーネント内の `useState`。画面を離れるとアンマウントされるため、入庫・出庫と同じパターンのリスクは低いと判断。追加修正はしていない。

- **実装ファイル**: `/extensions/stock-transfer-tile/src/Modal.jsx`

### 12.17 本番検証対応（2026-02）✅ 完了

本番環境での検証で発見された問題の修正。

#### ① 2カラムレイアウトのSP対応 ✅ 完了
- **問題**: PCで2カラムのレイアウト（入出庫履歴一覧など）がSPで見ると右カラムの領域が狭すぎてUIが悪い
- **対応**: `app.history.tsx`、`app.loss.tsx`、`app.inventory-count.tsx` の2カラムレイアウトに `flexWrap: "wrap"` を追加。右カラムを `flex: "1 1 400px"`、左カラムを `flex: "0 1 260px"` に変更し、SP時は右カラムが左カラム下部に折り返されるように修正

#### ② コレクション250件以上の全件読み込み ✅ 完了
- **問題**: 5000件以上のコレクションを持つショップで、検索しても250件以上が表示されない
- **対応**: `app.inventory-count.tsx` の loader で、collections クエリにページネーション（pageInfo.hasNextPage, endCursor）を追加し、全件取得するまでループ

#### ③ 商品SKU650件以上の全件読み込み ✅ 完了
- **問題**: 22000件以上のSKUを持つショップで、検索しても650件以上が表示されない
- **対応**: `app.inventory-count.tsx` の loader で、products クエリにページネーションを追加（products first: 250, variantsFirst: 250）。全件取得するまでループ。SKUタブの説明を「全商品・全バリアントを読み込み」に変更

#### ④ アプリ表示件数の入力検証 ✅ 完了
- **問題**: 設定のアプリ表示件数（履歴一覧リスト、商品リスト、検索リスト）に半角数字以外（全角数字・スペース等）が入力された場合の検証と対処が未対応
- **対応**: 
  - フロント: 全角→半角変換、不正入力・範囲外時に「値を確認してください。半角数字で入力をお願いします。」を入力欄下（helpText）に表示
  - バックエンド: `normalizeToHalfWidthDigits` で全角→半角変換と数字以外除去を実装。`clampInt` が文字列を受け取るよう拡張

#### ⑤ loader 読み込み中表示 ✅ 完了
- **問題**: 棚卸等の重いloader実行中、何も表示されずフリーズしたかわかりにくい
- **対応**: `app/routes/app.tsx` で `useNavigation()` を用い、`state === "loading"` の間画面上部に「読み込み中…」バナーを固定表示（Shopifyグリーン背景）

- **実装ファイル**: 
  - `/app/routes/app.tsx`（読み込み中表示）
  - `/app/routes/app.history.tsx`（2カラムSP対応）
  - `/app/routes/app.loss.tsx`（2カラムSP対応）
  - `/app/routes/app.inventory-count.tsx`（2カラムSP対応、コレクション/SKU全件読み込み）
  - `/app/routes/app.settings.tsx`（表示件数入力検証）

### 12.18 POS入庫表示と運用メモ（2026-02）✅ 完了

#### ① 入庫未処理リストで「予定 / 入庫」に差がある行を赤表示 ✅ 完了
- **要望**: 入庫未処理の商品リストで、まだ何もカウントしていない（実数0）ときの「予定 1 / 入庫 0」も赤色で表示したい。編集前でも予定と入庫に差があるものは赤にしたい。
- **対応**: `renderInboundShipmentItems_` 内の差異判定を変更。従来は「進捗がある行だけ」赤にしていた（`hasAnyProgress && received !== planned`）ため、予定 1 / 入庫 0 は赤にならなかった。**予定と入庫に差がある行はすべて赤**にするよう、`hasDiff = (planned !== received)` に変更。編集前・未カウントでも差があれば赤で表示される。
- **実装ファイル**: `/extensions/stock-transfer-tile/src/Modal.jsx`（`renderInboundShipmentItems_`）

#### ② 修正反映のための作業メモ（ビルド・プッシュ・デプロイ）
- **ビルド**: `npm run build` で実行。GitHub にプッシュするだけならビルドは必須ではない（ソースを push すればよい）。
- **プッシュ**: `git add` → `git commit` → `git push`。認証が必要なため、手元のターミナルで実行する。上流未設定の場合は `git push --set-upstream origin main`。
- **デプロイ**: `shopify app deploy`（または `npm run deploy`）。Shopify CLI が設定フォルダに書き込むため、手元のターミナルで実行する。非対話環境では `--force` が必要な場合あり。
- コードを残すだけなら「コミット＋プッシュ」、POS で実際に動かすには「デプロイ」まで実施する。

### 12.12 本チャット時点での棚卸不具合の整理（2026-01-27）

※この節は、ユーザーとのチャットで確認した「まだ解消していない挙動」と、その時点で特定できた要因をメモしたものです。  
コードの最終状態とは完全には一致しない可能性がありますが、「どこを見れば良いか」の道標として残しています。

- **状態A: 管理画面で完了しているはずの商品グループが未完了になっている**
  - **現象**:
    - POS側（`InventoryCountProductGroupSelection`）では「処理済み」と判定されている商品グループが、管理画面の棚卸履歴では「未完了」と表示されている。
  - **要因候補**:
    - 管理画面側（`app.inventory-count.tsx`）の完了判定は、複数グループの場合に **`groupItems` のみ** を信用しており、`items` フィールドを後方互換として参照しない設計になっている。
    - 一方、POS側のグループ判定（`InventoryCountProductGroupSelection.jsx`）は、`groupItems[groupId]` が空のときに **`items` から対象グループの商品だけをフィルタリングして完了判定** をしている。
    - そのため「`items` にはデータがあるが、`groupItems` がまだ埋まっていない（または古い形式のデータ）」という棚卸IDについては、  
      - **POS** … `items` を見て「処理済み」と判定  
      - **管理画面** … `groupItems` が空なので「未完了」と判定  
      というズレが発生している。
  - **現時点の方針メモ**:
    - 管理画面側で複数グループに対しても `items` を使った厳密なフィルタリングを行うには、GraphQLで商品リストを引き直すなどの **非同期処理** が必要になるが、Remixのloader内では重くなりやすい。
    - そのため現状は「複数グループの完了判定は `groupItems` を唯一の信頼ソースとし、`items` は単一グループの後方互換に限定する」方針になっており、**旧形式データや移行途中データでは表示のズレが残る** 可能性がある。

- **状態B: アプリ（まとめて表示）で未完了グループの商品リストが出てこない** ✅ 解決完了（2026-01-27）
  - **現象**:
    - まとめて表示モードでは、完了済みグループは正しく「完了済み（実数も正しく表示）」される。
    - しかし「未完了」側のグループは、グループ名と「商品を読み込み中…」までは表示されるものの、その下の **商品リストが最後まで描画されない**。
  - **原因**:
    - `loadProducts`関数の最初の処理ブロック（単一グループモード用）で`isReadOnly && storedItems`の条件が`true`になり、そこで`return`して終了していた。
    - まとめて表示モードの処理（`if (isMultipleMode)`）に到達していなかった。
  - **修正内容**:
    - `isReadOnly && storedItems && !isMultipleMode`の条件に変更し、まとめて表示モードの場合は最初の処理ブロックをスキップするように修正。
    - `filterByInventoryLevel: false`に変更し、在庫レベルが0でも商品を表示するように修正。
    - まとめて表示モードの処理完了後、未完了グループがある場合は`isReadOnlyState`を`false`に設定するように修正。
  - **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`

- **状態C: アプリ側の完了判定と管理画面の完了判定の思想の違い**
  - **POS側**:
    - ユーザー体験優先で、「`groupItems` が無くても `items` からグループ単位に切り出せれば完了扱いにする」という柔軟な後方互換ロジック。
  - **管理画面側**:
    - データの一貫性優先で、「複数グループの場合は `groupItems` による明示的な完了記録が揃っているときだけ `completed` にする」保守的なロジック。
  - **結果**:
    - 旧データや移行途中データでは「POSでは処理済み／管理画面では未完了」というギャップが発生しうる。  
      今後この差を埋めるには、どちらの基準を正とするか（もしくは管理画面側に移行用ロジックを追加するか）の設計判断が必要。

### 12.13 まとめて表示モードの追加修正（2026-01-27）✅ 修正完了

#### 修正1: 全数量反映ボタンとリセットボタンが確定済みグループまで編集してしまう問題 ✅ 解決
- **現象**: まとめて表示モードで「全数量反映」ボタンや「リセット」ボタンを押すと、確定済みグループ（`isReadOnly: true`）の商品も編集されてしまう。
- **原因**: `setLines`内の`map`処理で、`isReadOnly: true`の商品も含めて全ての商品を更新していた。
- **修正内容**: 
  - 「全数量反映」ボタンと「リセット」ボタンの処理で、`isReadOnly: true`の商品は元のデータをそのまま返すように条件を追加。
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`（1608-1636行目）

#### 修正2: まとめて表示モードで確定ボタンを押した際、カウントしていないグループも確定されてしまう問題 ✅ 解決
- **現象**: まとめて表示モードで、グループ1（確定済み）、グループ2（未確定でカウント済み）、グループ3（まだカウントしていなくて全て0）の状態で確定ボタンを押すと、グループ3も確定されてしまう。
- **原因**: `hasCountedItems`の判定条件が`actualQty > 0 || currentQty !== actualQty`となっており、`currentQuantity = -1`、`actualQuantity = 0`（未カウント）の場合も`currentQty !== actualQty`が`true`になってしまっていた。
- **修正内容**: 
  - `hasCountedItems`の判定条件を`actualQty > 0 || (actualQty !== 0 && currentQty !== actualQty)`に変更。
  - `actualQuantity === 0`の場合は、カウントしていないと判断し、確定しないように修正。
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`（1011-1015行目、1132-1136行目、1243-1247行目、1430-1434行目）

#### 修正3: まとめて表示モードでの自動保存と復元機能の追加 ✅ 追加完了
- **現象**: まとめて表示モードでは、自動保存は機能していたが、下書きの復元が機能していなかった。
- **原因**: 下書きの復元処理が単一グループモードのセクションにのみ実装されており、まとめて表示モードのセクションには実装されていなかった。
- **修正内容**: 
  - まとめて表示モードの処理開始時に、下書きを読み込む処理を追加。
  - 下書きがあれば優先的に復元し、`productGroupId`と`isReadOnly`も正しく復元するように修正。
  - まとめて表示モードでも下書き復元時に`isReadOnlyState`を適切に設定するように修正。
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`（372-420行目）

#### 修正4: デバッグ用トーストメッセージの削除 ✅ 完了
- **内容**: まとめて表示モードのデバッグ用トーストメッセージ（`[DEBUG]`で始まるもの）と画面表示のデバッグ情報を削除。
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`

#### 修正5: まとめて表示モードでの自動保存・復元機能の修正 ✅ 完了（2026-01-27）
- **問題**: まとめて表示モードで一度棚卸リストに戻って再度まとめて表示を表示した際、自動保存が空の`lines`で上書き保存され、下書きが0件になって復元されない。
- **原因**: 
  - `loadProducts`が呼ばれた際、下書きを読み込む前に`lines`が空の状態になり、自動保存の`useEffect`が空の`lines`で上書き保存していた。
  - 自動保存時に`isReadOnly`が保存されていなかった。
  - `draftLoadedRef.current`が一度`true`になると、`count.id`や`locationId`が変わってもリセットされず、下書き読み込みがスキップされていた。
- **修正内容**: 
  - `isLoadingProductsRef`を追加し、`loadProducts`実行中は自動保存をスキップするように修正。
  - 自動保存時に`isReadOnly`も保存するように修正。
  - まとめて表示モードでは、`draftLoadedRef`のチェックを行わず、毎回下書きを読み込むように修正。
  - `count.id`や`locationId`が変わったときに`draftLoadedRef`をリセットする処理を追加。
- **実装ファイル**: `/extensions/stock-transfer-loss/src/screens/stocktake/InventoryCountList.jsx`

#### 修正6: 入庫処理のまとめて表示モードでの自動保存・復元機能の追加 ✅ 完了（2026-01-27）
- **問題**: 入庫処理のまとめて表示モードでは、自動保存・復元機能が実装されていなかった。
- **修正内容**: 
  - `loadMultipleShipments`関数に下書き読み込み処理を追加。
  - 下書きから復元する際のマッチングロジックを修正（`shipmentId`と`shipmentLineItemId`の両方で一致）。
  - 下書きから復元した際に`extras`、`reason`、`note`、`onlyUnreceived`も復元。
  - 自動保存処理を修正（まとめて表示モードでも`transferId`があれば保存可能、`shipmentId`も保存）。
- **実装ファイル**: `/extensions/stock-transfer-tile/src/Modal.jsx`

### 12.14 棚卸履歴モーダルの改善（2026-01-27）✅ 修正完了

#### 修正1: 予定外商品の赤背景表示（単一商品グループの場合）✅ 解決
- **現象**: 入庫履歴モーダルでは予定外商品に赤背景がついているが、棚卸履歴モーダルでは予定外商品に赤背景がついていない（単一商品グループの場合）。
- **原因**: 
  - 複数商品グループの場合: `isExtra`フラグを判定し、赤背景を設定していた（2293行目）。
  - 単一商品グループの場合: `isExtra`フラグを判定していなかった（2382行目）。
- **修正内容**: 
  - 単一商品グループの場合でも、`isExtra`フラグを判定し、`true`の場合は`backgroundColor: "#ffe6e6"`を設定するように修正。
- **実装ファイル**: `/app/routes/app.inventory-count.tsx`（2363-2382行目）

#### 修正2: 複数商品グループのモーダルで完了の商品グループが初回モーダルを開いた際に2秒ほどは完了の表示になっているが、2秒後ぐらいに未完了になってしまう問題 ✅ 解決
- **現象**: 複数商品グループのモーダルで、完了の商品グループの商品リストが初回モーダルを開いた際に2秒ほどは完了の表示になっているが、2秒後ぐらいに未完了になってしまう。モーダルを閉じて再度開いた際には完了にもどる。
- **原因**: 
  - 未完了グループ判定ロジック（834-837行目）と完了判定ロジック（2200-2212行目）でキー取得方法が異なっていた。
  - 未完了グループ判定では、`groupItemsMap[groupId]`が直接存在するかどうかしかチェックしていなかった。
  - 完了判定では、キーの型を考慮した複数のチェックを行っていた。
  - そのため、キーの型が一致しない場合、完了済みグループが誤って`incompleteGroupIds`に含まれ、`incompleteGroupProducts`が更新されると、完了判定が`false`になってしまっていた。
- **修正内容**: 
  1. 未完了グループ判定ロジックを、完了判定ロジックと同じ方法に統一（キーの型を考慮した複数のチェックを追加）。
  2. `completedGroupsMap`を追加し、`itemsByGroup`の構築時に完了済みとして設定されたグループを追跡。
  3. 完了判定ロジックで、`wasCompletedInItemsByGroup`が`true`の場合、`incompleteProductsForGroup`の値に関係なく完了済みと判定。
- **実装ファイル**: `/app/routes/app.inventory-count.tsx`（833-851行目、2039-2240行目）

#### 修正3: CSV出力の改善 ✅ 解決
- **問題1**: 複数グループの場合、商品グループ列に全てのグループ名がカンマで繋がっている → 対象の商品の対象商品グループに変更したい。
- **問題2**: ステータス未完了の商品グループが一つでもある場合、完了の商品グループも進行中となっている → 完了している商品グループの商品は完了にしたい。
- **問題3**: 予定外の商品がCSVでわからないので、予定外の列を追加して予定外と出力されるようにしたい。
- **原因**: 
  - CSV出力ロジックとモーダル表示ロジックが異なっていた。
  - CSV出力では、全てのグループ名をカンマで結合していた。
  - CSV出力では、`modalCount.status`を使用していたため、全ての商品が同じステータスになっていた。
  - 予定外商品を識別する列がなかった。
- **修正内容**: 
  1. CSV出力ロジックをモーダル表示ロジックと同じ方法に統一（キーの型を考慮、後方互換性対応）。
  2. 各商品にグループ情報を追加: `itemsByGroup`から取得した商品に、`groupId`、`groupName`、`isGroupCompleted`を追加。
  3. 商品グループ列の修正: 各商品が属するグループの名前のみを表示。
  4. ステータス列の修正: 各商品が属するグループが完了済みか未完了かを判定し、「完了」または「進行中」を表示。
  5. 予定外列の追加: `isExtra`フラグをチェックし、「予定外」または空文字を表示。
- **実装ファイル**: `/app/routes/app.inventory-count.tsx`（2462-2618行目）

### 12.15 棚卸管理画面UI・商品グループ作成方法の拡張（2026-01）✅ 完了

#### 商品グループ作成方法の3方式対応
- **コレクションから作成**: 既存のコレクション選択に加え、「コレクションで絞り込み」「選択済み」トグルで一覧をフィルター表示。
- **SKU選択から作成**: loader でバリアント一覧を最大1000件取得し、クライアントで SKU・商品名・JAN・オプションで絞り込み。useFetcher 廃止で検索結果の表示不具合を解消。「選択済み」トグル対応。表示形式は商品名/SKU/JAN/オプションの4行。
- **CSVで一括登録**: 「グループ名,SKU」形式のCSVでコレクションに依存せずグループを定義。CSVテンプレートダウンロードボタンを「CSVでインポート」付近に配置。

#### タブ・ボタン・編集中バナーのスタイル統一
- 上部タブ（商品グループ設定 / 棚卸ID発行 / 履歴）: 選択時のみ `background: #e5e7eb`、`borderRadius: 8px`。
- 商品グループ作成ボタン（コレクションから作成 / SKU選択から作成 / CSVで一括登録）: 同様の選択時スタイルに統一。
- 編集中バナー: 背景・枠を薄グレーに変更。「（コレクションから作成）」等の接尾辞を削除し「「{グループ名}」編集中」のみ表示。長文のはみ出し防止のスタイルを追加。

#### バグ修正
- **編集中の編集が戻る**: グループ編集でコレクションを外すと数秒で元に戻る問題。編集中フォーム初期化の useEffect の依存配列を `[editingGroupId]` のみに変更し、loader 再検証時に上書きされないように修正。
- **SKU検索が表示されない**: 初回から loader でバリアント一覧を取得し、クライアント絞り込みに一本化。useFetcher による検索を廃止し表示を安定化。

- **実装ファイル**: `/app/routes/app.inventory-count.tsx`

### 12.16 SKU/CSVグループの確認・編集・CSVエクスポート・10000行対応（2026-01）✅ 完了

#### SKU/CSV由来グループの確認・編集
- **編集時の挙動**: SKU指定のみのグループ（コレクションなし・inventoryItemIds あり）で「編集」を押すと「SKU選択から作成」タブに切り替え、選択済みSKUを復元。
- **一覧外SKUの維持**: loader の skuVariantList（最大1000件）に含まれない inventoryItemId は `editingSkuOnlyPreservedIds` で保持。保存時にマージして送信。アクション側で既存グループの skus から一覧外分を補完して保存。
- **右パネル**: SKU指定のみのグループに「SKU一覧（N件）を確認・編集」を表示。クリックで編集モード＋SKUタブに遷移。
- **SKUタブ**: 編集中は「更新」「キャンセル」を表示。選択済み＋一覧外の件数表示。キャンセルで editingGroupId / editingSkuOnlyPreservedIds をクリア。

#### CSVエクスポート・インポートモード
- **登録済みをCSVダウンロード**: SKU指定のグループのみを「グループ名,SKU」形式でCSV出力。コレクションのみのグループは含めない。
- **インポートモード**: 新規作成（既存のグループ名はスキップ）・追加（同じグループ名にSKUを足す）・上書き（同じグループ名のSKUをCSVの内容で置き換え）。選択肢の並びは新規作成・追加・上書き。
- **結果件数**: 実際に作成・更新したグループ数（importedCount）を返却・表示。

#### CSV最大10000行・バッチ処理
- **行数上限**: 1ファイル最大10000行（従来2000行から変更）。
- **SKU解決の分岐**: `resolveSkusToInventoryItemIds` で、3件以下は従来の1 SKU 1クエリ。4件以上はバッチ（25件/クエリの `sku:A OR sku:B OR ...`）＋並列10本で実行。OR クエリ失敗時はそのバッチのみ1件ずつフォールバック。
- **定数**: `SKU_BATCH_SIZE = 25`、`SKU_BATCH_CONCURRENCY = 10`（必要に応じて調整可能）。

- **実装ファイル**: `/app/routes/app.inventory-count.tsx`
