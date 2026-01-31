# 自社用アプリ（POS Stock - Ciara）でメニューが表示されないときの確認

管理画面でアプリを開いても、左サイドバーに「設定・入出庫履歴・ロス履歴・棚卸」が表示されない場合の確認手順です。

---

## 1. アプリURLと環境変数が一致しているか

**「POS Stock - Ciara」は、どのアプリ設定（どの client_id）に対応していますか？**

- **自社用**（従来のカスタムアプリ）→ `shopify.app.toml` の client_id
- **公開用**（新規作成した POS Stock）→ `shopify.app.pos-stock.toml` の client_id

**確認手順:**

1. [パートナーダッシュボード](https://partners.shopify.com/) で **「POS Stock - Ciara」** のアプリを開く
2. **アプリの設定**（または App setup）→ **URL** を確認  
   - ここに書かれている **アプリURL**（例: `https://stock-transfer-pos.onrender.com`）に、実際に自社用のアプリがデプロイされているか確認する
3. そのデプロイ先（例: Render）の **環境変数** を確認  
   - **SHOPIFY_API_KEY** が、**「POS Stock - Ciara」のクライアントID**（パートナーで表示される Client ID）と **同じ** か確認する

**一致していないと起きること:**

- アプリURLが別のサービスを指している → 別アプリの画面が開き、メニューが違う・出ないことがある
- SHOPIFY_API_KEY が別アプリの Client ID → 認証や App Bridge が正しく動かず、メニュー（s-app-nav）が表示されないことがある

---

## 2. ブラウザのキャッシュとコンソール

1. **キャッシュを無効にして開き直す**  
   - シークレットウィンドウでストアの管理画面にログインし、もう一度「POS Stock - Ciara」を開く  
   - またはブラウザのキャッシュを削除してから開き直す
2. **開発者ツールのコンソールを開く**  
   - アプリを開いた状態で F12（または右クリック → 検証）→ **Console** タブ  
   - **赤いエラー** が出ていないか確認する  
   - App Bridge やスクリプトのエラーがあると、s-app-nav が表示されないことがあります

---

## 3. 開いているURLを確認する

アプリを開いたとき、ブラウザのアドレスバー（または iframe の URL）は次のどちらに近いですか？

- `https://（あなたのアプリのURL）/app` または `/app/settings`
- `https://（あなたのアプリのURL）/` のみで、`/app` にリダイレクトされていない

メニュー（s-app-nav）は **/app 以降のルート**（例: /app, /app/settings）で表示されます。  
`/` のままログイン画面や別ページで止まっていると、メニューは出ません。  
その場合は、認証後きちんと `/app` または `/app/settings` にリダイレクトされているか確認してください。

---

## 4. 自社用と公開用を両方使っている場合

- **自社用** と **公開用** で **別々のアプリURL**（別デプロイ）を使っている場合  
  - 「POS Stock - Ciara」の **アプリURL** が、**自社用のデプロイ先** を指しているか  
  - そのデプロイ先の **SHOPIFY_API_KEY** が **自社用アプリの Client ID** になっているか  
  の両方を満たしている必要があります。
- 同じコードベースを **1つのURL** で両方のアプリに使っている場合（非推奨）  
  - 1つのサーバーで 2 つの Client ID を扱う設定が必要で、多くのテンプレートは 1 アプリ前提のため、メニューが出ない原因になりがちです。  
  - 自社用・公開用は **別URL・別デプロイ** に分けると原因を切り分けしやすくなります。

---

## 5. パッケージのバージョン（location-stock-indicator に合わせる）

メニューが表示される **Location stock indicator** と同じバージョンに揃えると、表示が安定することがあります。

**揃えたバージョン（stock-transfer-pos）:**

- `@shopify/shopify-app-react-router`: **^1.0.0**（1.1.0 から変更済み）

**Location stock indicator の主なバージョン:**

- `@shopify/shopify-app-react-router`: ^1.0.0
- `@shopify/app-bridge-react`: ^4.2.4
- Polaris は使っていない（app.jsx では AppProvider と s-app-nav のみ）

バージョンを変えたあとは、必ず `npm install` → `npm run build` を実行し、デプロイし直してください。

---

## 6. まとめ

- メニューは **app.tsx** の **s-app-nav** で出力しており、**/app 以降** で表示される想定です。
- **@shopify/shopify-app-react-router** は location-stock-indicator に合わせて **^1.0.0** にしています。
- 「POS Stock - Ciara」でメニューが出ないときは、  
  **「そのアプリのアプリURL」と「そのURLにデプロイしているアプリの SHOPIFY_API_KEY（= Client ID）」が一致しているか** を最優先で確認してください。
- 上記が一致していれば、キャッシュ削除・コンソール確認・開いているURLの確認で、多くの不具合は切り分けできます。
