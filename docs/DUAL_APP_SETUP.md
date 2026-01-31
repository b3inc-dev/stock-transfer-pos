# 自社用カスタムアプリと公開用アプリの2本立て運用

location-stock-indicator と同様に、**同じアプリのコード**を「自社用カスタムアプリ」と「販売用・公開用アプリ」の2つとして運用する手順です。

---

## 構成イメージ

| 種類 | 設定ファイル | 用途 | デプロイ先URL例 |
|------|--------------|------|------------------|
| **自社用** | `shopify.app.toml` | 自社ストアにインストールするカスタムアプリ | stock-transfer-pos.onrender.com |
| **公開用** | `shopify.app.public.toml` | App Store で販売する公開アプリ | pos-stock-public.onrender.com |

- コードベースは **1つ** で共通
- **2つの Shopify アプリ**（パートナーで別々に作成）が、それぞれ別の `client_id` と **別のデプロイ先URL** を持つ形になります

---

## ターミナルで公開用アプリを作る最短手順

1. プロジェクト直下で:
   ```bash
   shopify app config link
   ```
2. 設定名を `public` と入力
3. **新規アプリを作成** を選ぶ（CLI がパートナーに新規アプリを作成し、`shopify.app.public.toml` を自動作成）
4. 公開用のデプロイ先URLを用意したら、`shopify.app.public.toml` の `application_url` と `redirect_urls` をそのURLに合わせて編集
5. 公開用のデプロイ時は:
   ```bash
   shopify app config use public
   shopify app deploy
   ```

---

## 手順（詳細）

### 1. 「公開用」アプリを用意する（ターミナルから作成する方法）

**ターミナルから作成する（推奨）**

既存のプロジェクトのまま、CLI で「公開用」のアプリを新規作成し、設定ファイルだけ追加できます。

1. プロジェクト直下（`stock-transfer-pos` フォルダ内）で次を実行:
   ```bash
   shopify app config link
   ```
   （別のフォルダにいる場合は `cd 〜/stock-transfer-pos` で移動してから実行）
2. プロンプトで **新しい設定の名前** を入力（例: `public`）  
   → 既存の `shopify.app.toml` はそのまま残り、`shopify.app.public.toml` が新規作成されます。
3. **「新規アプリを作成」** または **Create new app** を選ぶ  
   → パートナーに新しいアプリが作成され、その Client ID が自動で `shopify.app.public.toml` に書き込まれます。
4. 必要ならパートナーダッシュボードで、そのアプリを「公開アプリ」にし、名前（例: POS STOCK）を設定します。

※ 既にパートナーで公開用アプリを作ってある場合は、`shopify app config link` 実行時に **既存のアプリを選択** し、設定名を `public` にすると、そのアプリ用の `shopify.app.public.toml` が作られます。

**ブラウザ（パートナーダッシュボード）から作成する方法**

1. [Shopify パートナーダッシュボード](https://partners.shopify.com/) にログイン
2. **アプリ** → **アプリの作成** → **アプリを作成** を選択
3. **公開アプリ**（App Store に出す方）として作成
4. 作成されたアプリの **クライアントID**（Client ID）を控える
5. 必要に応じて **アプリ名**（例: POS STOCK）や説明を設定
6. プロジェクトで `shopify app config link` を実行し、設定名 `public` で **今作成したアプリを選択** すると、`shopify.app.public.toml` が自動作成されます。

※ いま自社で使っている方は「カスタムアプリ」のまま利用し、新しく作った方を「公開用」にします。

---

### 2. 公開用のデプロイ先を1つ用意する

- 自社用と **別URL** にします（例: Render で別サービスを1つ作成）
- 例:
  - 自社用: `https://stock-transfer-pos.onrender.com`
  - 公開用: `https://pos-stock-public.onrender.com`
- 公開用のサービスでは、**公開用アプリの Client ID を環境変数 `SHOPIFY_API_KEY` に設定**します（自社用とは別の値）

---

### 3. 公開用の設定ファイルを編集する

**方法A（手動）**  
`shopify.app.public.toml` を開き、以下を **公開用アプリの値** に書き換えます。

- `client_id` … 公開用アプリの Client ID（パートナーで確認）
- `application_url` … 公開用のデプロイ先URL（例: `https://pos-stock-public.onrender.com`）
- `[auth]` 内の `redirect_urls` … 上記と同じURL

**方法B（CLIでリンク）**  
公開用アプリをパートナーで作成したあと、プロジェクト直下で:

```bash
shopify app config link
```

と実行し、**新しい設定名**（例: `public`）を入力して、作成した「公開用」アプリを選択すると、`shopify.app.public.toml` が自動作成・書き換えされます。そのあと `application_url` と `redirect_urls` だけ公開用のデプロイ先URLに合わせて編集します。

自社用は **そのまま** `shopify.app.toml` を使います（既存の client_id と URL のままでOK）。

---

### 4. CLI で「どちらのアプリ」を触るか切り替える

- **自社用**で開発・デプロイするとき:
  ```bash
  shopify app config use shopify.app.toml
  # または
  shopify app config use default
  ```
- **公開用**で開発・デプロイするとき:
  ```bash
  shopify app config use shopify.app.public.toml
  # または
  shopify app config use public
  ```

`shopify app config link` で追加した名前が `public` の場合は、`shopify app config use public` で切り替えられます。

---

### 5. デプロイ

- **自社用**  
  - 自社用の Render（または既存のデプロイ先）にデプロイ  
  - 使用する設定: `shopify.app.toml`  
  - 例: `shopify app config use shopify.app.toml` のあと `shopify app deploy`

- **公開用**  
  - 公開用の Render（別サービス）にデプロイ  
  - 使用する設定: `shopify.app.public.toml`  
  - 例: `shopify app config use shopify.app.public.toml` のあと `shopify app deploy`  
  - そのサービスでは環境変数 `SHOPIFY_API_KEY` を **公開用の Client ID** にしておく

設定ファイルを指定してデプロイする例:

```bash
shopify app deploy --config=shopify.app.public.toml
```

---

### 6. 開発時（ローカル）

どちらか一方のアプリでプレビューする場合:

```bash
# 自社用で dev
shopify app config use shopify.app.toml
shopify app dev

# 公開用で dev（別ターミナル or 切り替え後）
shopify app config use shopify.app.public.toml
shopify app dev
```

`shopify app dev` は、そのとき選んでいる設定ファイルの `client_id` と URL を使います。

---

## まとめ

- **自社用**: `shopify.app.toml` ＋ 今のデプロイ先（今のカスタムアプリのまま）
- **公開用**: `shopify.app.public.toml` ＋ 新しい Client ID ＋ 新しいデプロイ先URL
- コードは共通で、**設定ファイルとデプロイ先（と環境変数）だけ分ける**形で、location-stock-indicator と同じ2本立て運用ができます。
