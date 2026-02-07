# デバッグ: CSV出力と詳細ページの問題分析

## 問題1: CSV出力で商品リストが空になる

### 考えられる原因

1. **GraphQLクエリの構造の問題**
   - `inventoryTransfer`から`shipments`を取得し、その中から`lineItems`を取得している
   - しかし、`shipments`が空の場合、`lineItems`が取得できない
   - または、`shipments`の構造が期待と異なる可能性

2. **レスポンス構造の問題**
   - GraphQLのレスポンスが期待する構造と異なる
   - `data.data.inventoryTransfer.shipments.nodes`が空配列または存在しない

3. **非同期処理のタイミング問題**
   - `fetch`で取得したレスポンスが正しくパースされていない

### 確認方法

ブラウザの開発者ツールのコンソールで以下のログを確認：
- `Action - GraphQL response data:`: GraphQLの生のレスポンス
- `Action - transfer:`: 取得したtransferオブジェクト
- `Action - transfer.shipments:`: shipmentsの構造
- `Action - transfer.shipments.nodes:`: shipments.nodesの内容
- `Action - Found X shipments`: 見つかったshipmentの数
- `Action - Shipment X lineItems:`: 各shipmentのlineItems
- `Action - Total lineItems collected:`: 最終的に取得できたlineItemsの数

### 修正案

1. **GraphQLクエリの修正**
   - `shipments`が存在しない場合の処理を追加
   - `lineItems`が直接`inventoryTransfer`に存在する可能性を確認

2. **エラーハンドリングの改善**
   - 各段階でエラーログを出力
   - 空の場合の理由を特定

## 問題2: 詳細ページ（/app/history/:id）が404エラー

### 考えられる原因

1. **ルーティングの優先順位の問題**
   - `app.history.tsx`が`/app/history`にマッチし、`/app/history/:id`が`/app/history`として解釈されている可能性
   - React Router v7では、より具体的なルートが優先されるはずだが、認識されていない可能性

2. **パラメータ名の取得方法の問題**
   - `params.id`ではなく、`params.$id`で取得する必要がある可能性
   - または、パラメータ名が異なる可能性

3. **ファイル名の問題**
   - `app.history.$id.tsx`が正しく認識されていない
   - React Router v7のファイル命名規則に従っていない可能性

### 確認方法

ブラウザの開発者ツールのコンソールで以下のログを確認：
- `History detail loader - params:`: パラメータオブジェクト全体
- `History detail loader - params.id:`: params.idの値
- `History detail loader - params keys:`: paramsオブジェクトのキー一覧
- `History detail loader - transferId:`: 最終的に取得したtransferId

### 修正案

1. **ルーティング設定の確認**
   - `app/routes.ts`で`flatRoutes()`が正しく設定されているか確認
   - ファイル名が正しいか確認（`app.history.$id.tsx`）

2. **パラメータ取得の修正**
   - `params.id`と`params.$id`の両方をチェック
   - デバッグログで実際のパラメータ名を確認

3. **エラーハンドリングの改善**
   - `ErrorBoundary`でエラーを適切に処理
   - 404エラーの詳細をログに出力

## 問題3: 大量データへの対応

### 現在の制限

1. **商品明細の取得制限**
   - `lineItems(first: 100)`: 最大100件まで
   - 100件を超える商品がある場合、残りが取得できない

2. **履歴一覧の取得制限**
   - `inventoryTransfers(first: 100)`: 最大100件まで
   - ページネーション未実装

3. **Shipmentの取得制限**
   - `shipments(first: 10)`: 最大10件まで
   - 10件を超えるshipmentがある場合、残りが取得できない

### 対応が必要な箇所

1. **CSV出力時のページネーション**
   - 100件を超える商品がある場合、複数回クエリを実行
   - `pageInfo.hasNextPage`と`endCursor`を使用

2. **詳細ページのページネーション**
   - 100件を超える商品がある場合、追加読み込み機能を実装
   - または、全件取得するまで繰り返しクエリを実行

3. **履歴一覧のページネーション**
   - 100件を超える履歴がある場合、ページネーション機能を実装

### 実装方針

1. **ページネーション対応のGraphQLクエリ**
   ```graphql
   query TransferLineItems($id: ID!, $after: String) {
     inventoryTransfer(id: $id) {
       shipments(first: 10) {
         nodes {
           lineItems(first: 100, after: $after) {
             nodes { ... }
             pageInfo {
               hasNextPage
               endCursor
             }
           }
         }
       }
     }
   }
   ```

2. **繰り返し取得の実装**
   - `hasNextPage`が`true`の間、`endCursor`を使用して繰り返しクエリを実行
   - すべての`lineItems`を集約

3. **パフォーマンス考慮**
   - 大量データの場合は、非同期処理で段階的に取得
   - プログレス表示を追加

## 次のステップ

1. **デバッグログの確認**
   - ブラウザのコンソールでログを確認
   - 実際のレスポンス構造を特定

2. **問題の修正**
   - ログから特定した問題を修正
   - GraphQLクエリの構造を調整

3. **ページネーションの実装**
   - 大量データに対応できるようにページネーションを実装
   - パフォーマンステストを実施
