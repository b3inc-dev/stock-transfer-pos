# 実装進行計画

## 📋 概要

このドキュメントは、管理画面・ロス登録・棚卸機能をスムーズに実装するための進行手順をまとめたものです。

---

## 🎯 実装の全体像

### 実装フェーズ
1. **準備フェーズ**: 共通コンポーネント・ユーティリティ・データ構造の準備
2. **Phase 1**: 管理画面の構成（4つのページ）
3. **Phase 2**: POS UI機能の実装

---

## 📅 詳細な進行手順

### Step 0: 準備フェーズ（共通基盤の構築）

#### 0.1 共通ユーティリティ関数の作成
**目的**: 各ページで共通して使用する機能をまとめる

**作成ファイル**: `/app/lib/utils.ts`（新規作成）

**実装内容**:
```typescript
// CSV出力用のユーティリティ
export function generateCSV(data: any[], headers: string[]): string
export function downloadCSV(filename: string, csvContent: string): void

// 日付フォーマット
export function formatDate(iso: string): string
export function formatDateTime(iso: string): string

// Metafield操作の共通関数
export async function readMetafield(admin, namespace: string, key: string): Promise<any>
export async function writeMetafield(admin, namespace: string, key: string, value: any): Promise<void>
```

**理由**: 各ページで同じ処理を繰り返さないようにするため

---

#### 0.2 共通コンポーネントの作成
**目的**: 履歴一覧、フィルター、CSV出力など共通UIを再利用可能にする

**作成ファイル**: `/app/components/` ディレクトリ（新規作成）

**実装内容**:
- `HistoryList.tsx`: 履歴一覧表示コンポーネント（チェックボックス、フィルター対応）
- `FilterBar.tsx`: フィルターバーコンポーネント（ロケーション、日付範囲、ステータス等）
- `CSVExportButton.tsx`: CSV出力ボタンコンポーネント
- `LocationSelector.tsx`: ロケーション選択コンポーネント

**理由**: UIの一貫性を保ち、実装時間を短縮するため

---

#### 0.3 データ型定義の作成
**目的**: TypeScriptの型安全性を確保し、データ構造を明確にする

**作成ファイル**: `/app/types/index.ts`（新規作成）

**実装内容**:
```typescript
// ロス登録関連
export type LossEntry = { ... }
export type LossItem = { ... }

// 棚卸関連
export type ProductGroup = { ... }
export type InventoryCount = { ... }
export type InventoryCountItem = { ... }

// 設定関連（SettingsV1の拡張）
export type SettingsV1 = { ... } // 既存を拡張
```

**理由**: 型安全性を確保し、IDEの補完を活用するため

---

#### 0.4 ナビゲーションメニューの更新
**目的**: 新しいページへのアクセスを可能にする

**更新ファイル**: `/app/routes/app.tsx`

**実装内容**:
```tsx
<s-app-nav>
  <s-link href="/app/settings">設定</s-link>
  <s-link href="/app/history">入出庫履歴</s-link>
  <s-link href="/app/loss">ロス登録履歴</s-link>
  <s-link href="/app/inventory-count">棚卸</s-link>
</s-app-nav>
```

**追加実装**: `/app/routes/app._index.tsx` を更新して、`/app` にアクセスした際に `/app/settings` にリダイレクトするようにする

**理由**: 最初にナビゲーションを更新することで、各ページの実装中にアクセスしやすくなる

---

### Step 1: 設定画面の拡張（`/app/settings`）

#### 1.1 SettingsV1型の拡張
**更新ファイル**: `/app/routes/app.settings.tsx`

**実装内容**:
- `SettingsV1` 型に以下を追加:
  - `visibleLocationIds?: string[]`
  - `outbound?: { allowForceCancel?: boolean }`
  - `inbound?: { allowOverReceive?: boolean; allowExtraReceive?: boolean }`

**理由**: 既存の設定画面を拡張するため、まず型定義を更新

---

#### 1.2 UIコンポーネントの追加
**更新ファイル**: `/app/routes/app.settings.tsx`

**実装内容**:
- 表示ロケーション選択セクション
- 強制キャンセル許可設定
- 過剰入庫許可設定
- 予定外入庫許可設定

**実装順序**:
1. セクションを追加（UIのみ、動作確認）
2. 状態管理を追加
3. 保存処理を実装
4. 動作テスト

**理由**: 段階的に実装することで、問題を早期に発見できる

---

### Step 2: 入出庫履歴画面（`/app/history`）

#### 2.1 基本構造の作成
**作成ファイル**: `/app/routes/app.history.tsx`

**実装内容**:
- ページの基本レイアウト
- タブまたはセクションで「出庫」「入庫」を切り替え
- 空のリスト表示（データ取得前）

**理由**: まず骨組みを作り、後から機能を追加していく

---

#### 2.2 データ取得機能の実装
**更新ファイル**: `/app/routes/app.history.tsx`

**実装内容**:
- `loader` 関数で GraphQL `inventoryTransfers` クエリを実行
- 出庫履歴の取得（`originLocationId` でフィルター）
- 入庫履歴の取得（`destinationLocationId` でフィルター）
- 監査ログの取得（過剰分・予定外分の表示用）

**実装順序**:
1. 出庫履歴の取得のみ実装（動作確認）
2. 入庫履歴の取得を追加
3. 監査ログの統合

**理由**: 1つずつ実装することで、問題の切り分けが容易

---

#### 2.3 一覧表示機能の実装
**更新ファイル**: `/app/routes/app.history.tsx`

**実装内容**:
- 履歴一覧の表示（ID、日付、ロケーション、ステータス等）
- チェックボックス機能
- ページネーション（必要に応じて）

**使用コンポーネント**: `HistoryList.tsx`（Step 0.2で作成）

**理由**: 共通コンポーネントを使用することで、実装時間を短縮

---

#### 2.4 フィルター機能の実装
**更新ファイル**: `/app/routes/app.history.tsx`

**実装内容**:
- 種別フィルター（出庫 / 入庫 / 全て）
- ロケーションフィルター
- 日付範囲フィルター
- ステータスフィルター

**使用コンポーネント**: `FilterBar.tsx`（Step 0.2で作成）

**理由**: フィルター機能は後から追加しても問題ないが、早めに実装することで使い勝手が向上

---

#### 2.5 CSV出力機能の実装
**更新ファイル**: `/app/routes/app.history.tsx`

**実装内容**:
- 選択した履歴のCSV出力
- 詳細画面からのCSV出力（後で実装）

**使用コンポーネント**: `CSVExportButton.tsx`（Step 0.2で作成）
**使用関数**: `generateCSV`, `downloadCSV`（Step 0.1で作成）

**理由**: CSV出力は比較的簡単な機能なので、一覧表示の後に実装

---

#### 2.6 詳細画面の実装（オプション）
**作成ファイル**: `/app/routes/app.history.$id.tsx`（オプション）

**実装内容**:
- 履歴IDから詳細情報を取得
- 商品明細の表示
- CSV出力機能

**理由**: 詳細画面は必須ではないが、あると便利

---

### Step 3: ロス登録履歴画面（`/app/loss`）

#### 3.1 基本構造の作成
**作成ファイル**: `/app/routes/app.loss.tsx`

**実装内容**:
- ページの基本レイアウト
- 空のリスト表示

**理由**: 入出庫履歴画面と同じ構造なので、コピーして修正するのが効率的

---

#### 3.2 データ取得機能の実装
**更新ファイル**: `/app/routes/app.loss.tsx`

**実装内容**:
- `loader` 関数で Metafield からロス登録履歴を取得
- `readMetafield` 関数を使用（Step 0.1で作成）

**実装順序**:
1. Metafieldからの読み込みのみ実装
2. データのパース処理
3. エラーハンドリング

**理由**: データ取得が正常に動作することを確認してから、表示機能を実装

---

#### 3.3 一覧表示・フィルター・CSV出力の実装
**更新ファイル**: `/app/routes/app.loss.tsx`

**実装内容**:
- 入出庫履歴画面と同じコンポーネントを再利用
- ロス登録特有のフィールド（理由等）を追加

**理由**: 共通コンポーネントを使用することで、実装時間を大幅に短縮

---

### Step 4: 棚卸画面（`/app/inventory-count`）

#### 4.1 基本構造の作成
**作成ファイル**: `/app/routes/app.inventory-count.tsx`

**実装内容**:
- タブまたはセクションで「設定」「履歴」を切り替え
- 設定セクション: 商品グループ設定、棚卸ID発行
- 履歴セクション: 棚卸履歴一覧

**理由**: 1つのページに設定と履歴の両方を含める

---

#### 4.2 商品グループ設定機能の実装
**更新ファイル**: `/app/routes/app.inventory-count.tsx`

**実装内容**:
- 商品グループの作成・編集・削除
- Shopifyコレクションからの選択
- 対象SKU数の表示

**実装順序**:
1. 商品グループのCRUD機能
2. Shopifyコレクション選択機能
3. 対象SKU数の計算・表示

**理由**: 商品グループ設定は棚卸ID発行の前提条件

---

#### 4.3 棚卸ID発行機能の実装
**更新ファイル**: `/app/routes/app.inventory-count.tsx`

**実装内容**:
- ロケーション選択
- 商品グループ選択
- 棚卸ID生成・保存

**理由**: 棚卸ID発行後、POS UIで使用する

---

#### 4.4 履歴表示・フィルター・CSV出力の実装
**更新ファイル**: `/app/routes/app.inventory-count.tsx`

**実装内容**:
- 入出庫履歴画面と同じコンポーネントを再利用
- 棚卸特有のフィールドを追加

**理由**: 共通コンポーネントの再利用で効率化

---

### Step 5: POS UI機能の実装

#### 5.1 ロス登録機能（POS UI）
**更新ファイル**: `/extensions/stock-transfer-tile/src/Modal.jsx`

**実装内容**:
- コンディション画面（ロケーション、日付、理由の選択）
- 商品リスト画面（出庫商品リストと同様）
- 在庫調整処理（`inventoryAdjustQuantity` mutation）
- 履歴保存処理（Metafieldへの保存）

**実装順序**:
1. コンディション画面のUI
2. 商品リスト画面のUI
3. 在庫調整処理
4. 履歴保存処理

**理由**: UIを先に実装し、動作確認してから処理を実装

---

#### 5.2 棚卸機能（POS UI）
**更新ファイル**: `/extensions/stock-transfer-tile/src/Modal.jsx`

**実装内容**:
- 棚卸ID入力画面
- 商品スキャン・入力画面
- 在庫調整処理（現在在庫と実数の差分で調整）
- 棚卸完了処理

**実装順序**:
1. 棚卸ID入力・検証
2. 商品リスト表示
3. 実数入力機能
4. 在庫調整処理
5. 棚卸完了処理

**理由**: 段階的に実装することで、問題を早期に発見

---

## 🔄 実装の進め方のコツ

### 1. 小さく始める
- まず最小限の機能を実装し、動作確認
- 動作確認できたら、次の機能を追加

### 2. 共通化を意識する
- 同じような処理は共通関数・コンポーネントにまとめる
- 後から修正する際の手間を減らせる

### 3. 段階的にテストする
- 各Step完了後に動作確認
- 問題があれば、次のStepに進む前に修正

### 4. 既存コードを参考にする
- `/app/routes/app.settings.tsx` を参考に新しいページを実装
- GraphQLクエリの書き方も既存コードを参考にする

### 5. 型定義を先に作る
- TypeScriptの型定義を先に作成することで、実装中にIDEの補完が効く
- データ構造が明確になり、実装ミスを減らせる

---

## 📝 チェックリスト

### 準備フェーズ
- [ ] 共通ユーティリティ関数の作成
- [ ] 共通コンポーネントの作成
- [ ] データ型定義の作成
- [ ] ナビゲーションメニューの更新

### Phase 1: 管理画面
- [ ] 設定画面の拡張（`/app/settings`）
- [ ] 入出庫履歴画面（`/app/history`）
- [ ] ロス登録履歴画面（`/app/loss`）
- [ ] 棚卸画面（`/app/inventory-count`）

### Phase 2: POS UI機能
- [ ] ロス登録機能（POS UI）
- [ ] 棚卸機能（POS UI）

---

## 🚀 推奨される実装順序

### 最速で動作確認したい場合
1. **Step 0.4**: ナビゲーションメニューの更新（5分）
2. **Step 1**: 設定画面の拡張（1-2時間）
3. **Step 2.1-2.2**: 入出庫履歴画面の基本構造とデータ取得（2-3時間）
4. **動作確認**: ここまでで管理画面の基本が動作することを確認

### 効率的に進めたい場合
1. **Step 0**: 準備フェーズを全て完了（1-2日）
2. **Step 1-4**: 管理画面の4つのページを順次実装（3-5日）
3. **Step 5**: POS UI機能を実装（2-3日）

### 段階的に進めたい場合
1. **Step 0.4 + Step 1**: ナビゲーション更新と設定画面拡張（1日）
2. **Step 2**: 入出庫履歴画面（1-2日）
3. **Step 3**: ロス登録履歴画面（1日）
4. **Step 4**: 棚卸画面（1-2日）
5. **Step 5**: POS UI機能（2-3日）

---

## 💡 注意事項

### データ保存方法について
- **Phase 1**: Metafield方式で実装（迅速な実装）
- **将来**: データ量が増えた場合、Prismaデータベースに移行を検討

### エラーハンドリング
- GraphQLクエリのエラー処理を必ず実装
- Metafieldの読み書き時のエラーハンドリングも実装

### パフォーマンス
- 大量データの取得時はページネーションを実装
- CSV出力時は非同期処理を検討（必要に応じて）

### テスト
- 各機能実装後、必ず動作確認
- 特に在庫調整処理は慎重にテスト

---

## 📚 参考資料

- 既存の設定画面: `/app/routes/app.settings.tsx`
- GraphQL API: Shopify Admin API ドキュメント
- Polaris コンポーネント: https://polaris.shopify.com/

---

この計画に沿って実装を進めることで、スムーズに機能を追加できます。不明点があれば、都度確認しながら進めてください。
