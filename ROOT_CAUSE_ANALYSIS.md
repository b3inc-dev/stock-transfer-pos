# 根本原因分析: CSV出力と詳細ページの問題

## 問題の要因

### 1. GraphQLクエリの構造の問題

**既存の動作しているコード（Modal.jsx）の分析**:

1. **`fetchInventoryTransferDetailForHistory`** (11863行目):
   - `inventoryTransfer.lineItems`から直接取得
   - フィールド: `title`, `shippableQuantity`, `shippedQuantity`, `processableQuantity`, `inventoryItem { id, sku }`
   - **注意**: `variant`情報は取得していない（最小限の情報のみ）

2. **`fetchInventoryShipmentEnriched`** (12515行目):
   - `inventoryShipment.lineItems`から取得
   - フィールド: `quantity`, `acceptedQuantity`, `rejectedQuantity`, `unreceivedQuantity`, `inventoryItem.variant { ... }`
   - **注意**: `variant`情報を含む詳細な情報を取得

**問題点**:
- 現在の実装では、`inventoryTransfer.lineItems`から`variant`情報を取得しようとしている
- しかし、`inventoryTransfer.lineItems`には`variant`情報が含まれていない可能性がある
- `shipments`経由で取得する必要がある可能性がある

### 2. 404エラーの原因

**React Router v7のルーティング**:
- ファイル名: `app.history.$id.tsx` ✅ 正しい
- パラメータ名: `params.id` ✅ 正しいはず
- しかし、404エラーが発生している

**考えられる原因**:
1. ルーティングが正しく認識されていない
2. `app.history.tsx`が先にマッチしている
3. パラメータの取得方法が間違っている

## 解決策

### 1. GraphQLクエリの修正

**オプション1: `inventoryTransfer.lineItems`から取得（最小限の情報）**
```graphql
inventoryTransfer(id: $id) {
  lineItems(first: 250) {
    nodes {
      id
      title
      shippableQuantity
      shippedQuantity
      processableQuantity
      inventoryItem {
        id
        sku
      }
    }
  }
}
```

**オプション2: `shipments`経由で取得（詳細な情報）**
```graphql
inventoryTransfer(id: $id) {
  shipments(first: 10) {
    nodes {
      id
      lineItems(first: 100) {
        nodes {
          id
          quantity
          inventoryItem {
            id
            variant {
              id
              title
              barcode
              selectedOptions {
                name
                value
              }
              product {
                title
              }
            }
          }
        }
      }
    }
  }
}
```

### 2. 404エラーの修正

**確認事項**:
1. ブラウザのコンソールで`History detail loader - params:`のログを確認
2. サーバー側（ターミナル）のログも確認
3. 実際のURLが正しいか確認（`/app/history/:id`）

**修正案**:
- ルーティングの優先順位を確認
- パラメータの取得方法を確認
- エラーハンドリングを改善
