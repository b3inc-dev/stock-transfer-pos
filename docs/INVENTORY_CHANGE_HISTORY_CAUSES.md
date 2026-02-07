# 売上・返品・POS在庫変動が「履歴一覧で管理」に振り分けられる要因

## このドキュメントでいう「履歴」の種類

| 画面 | データソース | 表示されるもの |
|------|--------------|----------------|
| **入出庫**（`/app/history`） | Shopify GraphQL の **inventoryTransfers** | **在庫転送（出庫・入庫）のみ**。売上・返品・POSの単純な在庫調整は含まない。 |
| **在庫情報 → 在庫変動履歴**タブ | DB の **InventoryChangeLog** | **すべての在庫変動**（入庫・出庫・ロス・棚卸・仕入・**売上**・**返品**・**管理**）。 |

売上・返品・POSの在庫変動が「履歴一覧で管理に振り分けられている」というとき、表示されているのは **在庫情報の「在庫変動履歴」** であり、種別が **「管理」**（`admin_webhook`）になっている、という意味と解釈しています。

---

## 想定される種別（activity）と記録元

| 種別（表示名） | activity 値 | 記録する経路 |
|----------------|-------------|--------------|
| 売上 | `order_sales` | **orders/updated** Webhook（注文の fulfillment 時） |
| 返品 | `refund` | **refunds/create** Webhook |
| 入庫・出庫・ロス・棚卸・仕入 | 各々 | POS拡張などから **api/log-inventory-change** を呼んだとき、または **inventory_levels/update** で adjustment group から判定したとき |
| **管理** | `admin_webhook` | **inventory_levels/update** Webhook で、種別を判定できなかったときの**フォールバック** |

---

## 「管理」に振り分けられる要因

### 1. inventory_levels/update Webhook の仕様

- 在庫が変動するたびに Shopify から **inventory_levels/update** が送られます。
- 種別を判定するには、ペイロードの **inventory_adjustment_group_id** を GraphQL で検索し、どの「在庫調整グループ」に属するかで「出庫・入庫・ロス・棚卸」などを決めています。
- **ペイロードに inventory_adjustment_group_id が無い**、または **GraphQL で取得に失敗した** 場合は、種別を決められないため **activity = admin_webhook（管理）** で保存しています。

→ その結果、**売上・返品・POS の変動**のうち、Webhook 側で種別が判定できなかったものが「管理」として記録されます。

### 2. 売上・返品が「管理」になるパターン

- **本来**: 売上は **orders/updated**、返品は **refunds/create** で、それぞれ `order_sales` / `refund` として先に InventoryChangeLog に記録される想定です。
- **重複防止**: inventory_levels/update では「2分以内に同じ item・location・quantityAfter で、既に order_sales / refund 等が記録されていれば保存しない」という処理があります。
- **「管理」になる要因**:
  - **orders/updated や refunds/create が届いていない**（未登録・失敗・遅延）と、inventory_levels/update だけが先に届き、種別が分からないため **admin_webhook** で1件保存される。
  - そのため、売上・返品が「管理」として履歴に出ている場合は、**売上・返品用 Webhook の登録・到達**を確認する必要があります。

### 3. POSアプリでの在庫変動が「管理」になるパターン

- **本来**: POS 拡張（ロス・仕入・出庫など）が **api/log-inventory-change** を呼び、正しい `activity`（loss_entry, purchase_entry, outbound_transfer など）で記録する想定です。
- **上書きロジック**: api/log-inventory-change では「**直近 5分前〜2分後**の、同じ item・location・quantityAfter の **admin_webhook** があれば、そのレコードの activity を呼び出し元の値に**上書き**する」処理があります。
- **「管理」のまま残る要因**:
  - **inventory_levels/update が先に届き**、admin_webhook で保存されたあと、**api/log-inventory-change が呼ばれない**（POS 側の不具合・ネットエラー・アプリURL誤りなど）。
  - または **api の呼び出しが遅い**（2分以上後）で、上書き対象の時間範囲から外れる。
  - または **二重防止**で api 側が「既存ログあり」と判断し新規作成をスキップしたが、その「既存」が別の admin_webhook で、上書き対象のクエリにヒットしていない。

→ 上記のいずれかで、POS で行った操作が「管理」のまま在庫変動履歴に残ります。

---

## まとめ

| 現象 | 主な要因 |
|------|----------|
| 売上・返品が「管理」で出る | orders/updated または refunds/create が届いていない／遅れているため、inventory_levels/update だけが先に届き admin_webhook で保存されている。 |
| POS の在庫変動が「管理」で出る | inventory_levels/update が先に届いて admin_webhook で保存されたあと、api/log-inventory-change が呼ばれていない、または呼ばれても時間範囲外で上書きされていない。 |

**orders/updated と refunds/create を TOML でコメントアウトしている理由（保護された顧客データ）**

- **orders/updated** と **refunds/create** は、Shopify の「保護された顧客データ」を含む Webhook に該当します。
- アプリが **保護された顧客データへのアクセス承認** を受けていない場合、`shopify app deploy` 時に **「This app is not approved to subscribe to webhook topics containing protected customer data」** でバージョン作成に失敗します。
- そのため **shopify.app.public.toml** では両方の subscription をコメントアウトしており、デプロイは通るが売上・返品は「管理」のまま記録されます。
- **承認後**に売上・返品を「売上」「返品」で記録したい場合は、[Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) の手順で承認を取得し、TOML の該当コメントを外してから再度 `shopify app deploy` してください。

**確認するとよいこと**

1. **Webhook 登録**: Dev Dashboard で **orders/updated** と **refunds/create** が有効か、URL が正しいか（※未承認の間は TOML でコメントアウトしているため登録されない）。
2. **POS からの API 呼び出し**: ロス・仕入・出庫実行時に、アプリの **api/log-inventory-change** が確実に呼ばれているか（ネットワークタブやサーバーログで確認）。
3. **アプリの URL**: POS 拡張が参照するアプリ URL（`getAppUrl()`）が、実際に動いている本番 URL になっているか（以前の pos-stock-public 誤りが解消されているか）。

---

## デプロイ後に過去の履歴変動が消える理由

- 在庫変動履歴は **Prisma の InventoryChangeLog** に保存されており、現在 **SQLite**（`file:dev.sqlite`）を使っています。
- **Render** では、デプロイのたびに **新しいコンテナ** が起動します。SQLite のファイルがコンテナ内の一時的な領域にだけある場合、**再デプロイするとそのファイルは引き継がれず、履歴が空の状態からやり直し**になります。
- そのため「デプロイしたら過去の履歴が消えた」ように見えます。**デプロイそのものがデータを削除しているわけではなく、DB がデプロイ間で永続化されていない**ことが原因です。
- **履歴を残したい場合**: Render の **Persistent Disk** をマウントして SQLite をそのパスに置く、または **Supabase（PostgreSQL）など外部 DB** に切り替えて `DATABASE_URL` で接続する必要があります。

---

## アプリ URL（getAppUrl）のコード確認結果

- **ファイル**: `extensions/common/appUrl.js`
- **本番URL**: `APP_MODE = "public"` のとき **`PROD_APP_URL_PUBLIC = "https://pos-stock.onrender.com"`** を参照し、`getAppUrl(false)` は **`https://pos-stock.onrender.com`** を返す。
- **結論**: コード上は POS が叩くアプリ URL は本番の **pos-stock.onrender.com** になっており、pos-stock-public への誤った参照は解消済み。

---

## ロス実行で「変動数が -」「アクティビティが管理のまま」になる要因

### 変動数が「-」になる要因

- 在庫変動履歴の「変動数」は、DB の **delta** を表示している。delta が **null** のとき UI では「-」と表示される。
- **流れ**: (1) ロス実行で在庫が変わると **inventory_levels/update** Webhook が先に届くことがある。(2) Webhook は「直前の在庫」から delta を計算するが、直前ログが無い・取得失敗で **delta = null** のまま保存することがある。(3) その後 **api/log-inventory-change** が届き、同じ変動の **admin_webhook** を「ロス」に上書きするが、**従来は activity などだけを更新して delta を更新していなかった**。
- **対応**: api/log-inventory-change で admin_webhook を上書きするときに **delta**（と quantityAfter）も渡されていれば一緒に更新するように変更した。これで Webhook が delta=null で保存したレコードも、API で delta が入る。

### 変動後数量は合っているのに変動数が「-」のままになる要因

- 表示されている 1 件は、**Webhook（inventory_levels/update）だけが保存したレコード**です。
- **変動後数量（quantityAfter）**: Webhook のペイロードに **available**（変動後の在庫数）が含まれており、それをそのまま **quantityAfter** として保存しています。そのため **変動後数量は常に正しく入ります**。
- **変動数（delta）**: Webhook は「直前の在庫」を DB の直近ログから取得して `delta = available - 直前` を計算します。直前ログが無い・取得失敗で **delta = null** になり、「-」と表示されます。
- **アクティビティが「管理」のまま**: そのレコードを **api/log-inventory-change** が **1度も上書きしていない**ためです。上書きされれば activity=loss_entry かつ delta も入ります。
- **まとめ**: 「変動後数量は合っているが変動数が - でアクティビティが管理」＝**Webhook が作った 1 件だけが残っており、API がそのレコードを見つけて更新できていない**状態です（API が呼ばれていない、または検索条件が一致していない）。

### 以前は変動数が反映されていたのに、今は「-」になる理由

- **変動数（delta）** は Webhook 側で「**直前の在庫**」を DB の **直近ログ**（同じ商品・ロケーション）から取得し、`delta = 今回の available - 直前の quantityAfter` で計算しています。
- **以前**: 履歴が DB に残っていたため、変動のたびに「直前のログ」が存在し、**delta が計算できて反映されていました**（アクティビティだけが「管理」のまま、という状態）。
- **デプロイ後**: Render の再デプロイで **DB が空**（または新規）になると、**その商品・ロケーションの「直前のログ」が存在しません**。そのため Webhook は `prevAvailable = null` → **delta = null** のまま保存し、画面では「-」になります。
- 加えて、**api/log-inventory-change** がそのレコードを上書きできていれば delta は API 側で入りますが、上書きできていない（呼ばれていない／検索にヒットしていない）と、Webhook が保存した **delta=null** のまま残ります。
- **結論**: 「変動数が反映されなくなった」主因は、**デプロイで履歴が消え、Webhook が delta を計算するための「直前ログ」が無くなったこと**と、**そのレコードを API が更新できていないこと**の両方です。
- **方針（変動数）**: 変動数は **拡張から受け取った数量をそのまま相違なく反映**する。API が admin_webhook を上書きするときに、リクエスト body の **delta** をそのまま保存する。Webhook 側の「直前ログから計算」に頼らず、実行した操作の数量を正として記録する。

### アクティビティが「管理」のままになる要因

- **想定**: ロス実行後に **api/log-inventory-change** が呼ばれ、直近で保存された **admin_webhook** が **loss_entry** に上書きされる。
- **「管理」のまま残る主な要因**:
  1. **api/log-inventory-change が呼ばれていない**  
     - POS 拡張から `fetch(apiUrl, { headers: { Authorization: Bearer ${token} } })` で呼ぶが、**認証失敗（401）** で弾かれると更新されない。  
     - 本番 URL（pos-stock.onrender.com）へのリクエストが **CORS やネットで失敗**している、**session.getSessionToken()** が取れていない、など。
  2. **上書き対象の admin_webhook が見つからない**  
     - **対応済み**: API の検索条件を緩和している。**quantityAfter は検索に含めず**、同一 shop・inventoryItemId・locationId・activity=admin_webhook・**直近 10分前〜5分後**の直近 1 件を更新する。これで拡張と Webhook で quantityAfter が微妙にずれてもヒットしやすくなっている。  
     - それでもヒットしない場合は、API が呼ばれていない（1）や時刻ずれが大きい可能性を確認する。
  3. **Webhook が届いていない**  
     - 逆に、inventory_levels/update が届かないと admin_webhook が 1 件もできず、API は「新規作成」 path に入る。その場合は最初から loss_entry で保存されるが、**idempotencyKey** が既存と被ると「Log already exists」でスキップされる。その「既存」が別経路のログだと、結果として「管理」の 1 件だけが見えている可能性もある。

**確認するとよいこと（ロス）**

- ロス実行時に **ブラウザ／POS のネットワーク**で `POST .../api/log-inventory-change` が飛んでいるか、ステータス 200 か 401 かを見る。
- サーバーログで `[api.log-inventory-change] Called: ...` または `Updated admin_webhook to loss_entry` が出ているか確認する。
- 401 の場合は、POS 埋め込みコンテキストで **Bearer トークン** が正しく送れているか、アプリ側の **authenticate.public** がそのトークンを受理しているかを確認する。

**ログの見方（開発環境 vs 本番）**

- **開発環境**: `shopify app dev` でアプリを起動しているとき、**ターミナル**にサーバーログが出ます。ロス実行後に `[api.log-inventory-change] Called: shop=..., activity=loss_entry, ...` や `Updated admin_webhook to loss_entry` が出ていれば API は呼ばれている／上書きできています。出ていなければ API が呼ばれていないか、別のサーバー（本番）に飛んでいる可能性があります。
- **本番（Render）**: ターミナルは使えないため、**Render ダッシュボード → 該当サービス → Logs** で同じメッセージを確認します。アプリの実行（Webhook や API）はサーバー側で処理されるため、**どちらの環境でも「サーバーのログ」を見る**ことになります（開発＝ターミナル、本番＝Render Logs）。
