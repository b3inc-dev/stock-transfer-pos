# Cron Job（クロンジョブ）の意味と設定の仕方

**対象**: 在庫高の「前日分」スナップショットを毎日自動で保存するために、Cron Job を初めて設定する方。

---

## 1. Cron Job って何？

**Cron Job（クロンジョブ）** は、**「毎日○時になったら、この処理を自動で実行してね」とコンピューターに予約しておく仕組み**です。

- **例**: 「毎日 23:59 に、在庫スナップショット用の API を 1 回だけ呼ぶ」
- **人間がやるなら**: 毎日 23:59 にブラウザやツールで API を叩く必要がある。
- **Cron Job に任せると**: 設定しておけば、毎日その時刻に Render が自動で API を呼んでくれる。**管理画面を開かなくても**保存される。

つまり「**時間になったら自動で実行するタイマー**」だと思えば大丈夫です。

---

## 2. 何を設定するの？

在庫高の「前日分」を保存するには、次の 2 つが必要です。

| 役割 | 説明 |
|------|------|
| **API** | すでにあります。`/api/inventory-snapshot-daily` を POST で呼ぶと、その時点の在庫を「前日分」として保存します。 |
| **Cron Job** | **ここで新たに作ります。**「毎日 23:59 に、その API を 1 回呼ぶ」という予約を Render に登録します。 |

Cron Job の「中身」は **「この URL に POST リクエストを送る」という 1 本のコマンド**です。  
そのコマンドが、指定した時刻（例: 毎日 23:59）に自動で実行されます。

---

## 3. 事前に用意するもの

1. **Render にログインできること**（在庫アプリをデプロイしているアカウント）
2. **アプリの URL**  
   例: `https://pos-stock.onrender.com`（ご自身の Web サービスの URL に読み替えてください）
3. **API 用の秘密の文字列（API キー）**  
   - 自分で決めた**ランダムな長い文字列**で OK です（例: 英数字 32 文字）。
   - この値を **Web サービス（pos-stock）** と **Cron Job** の両方で同じにします。

### API キーをまだ作っていない場合

ターミナルで次のコマンドを実行すると、ランダムな文字列が 1 つ出ます。これをコピーして「API キー」として使います。

```bash
openssl rand -hex 32
```

（出てきた文字列をメモしておき、次の「4. Web サービスに API キーを登録」で使います。）

---

## 4. Web サービス（pos-stock）に API キーを登録する

Cron Job から API を呼ぶとき、**「このリクエストは Cron から来た正しいものだ」** と証明するために、同じ API キーをヘッダーに付けます。API 側は「環境変数に入っているキー」と照合します。

1. [Render ダッシュボード](https://dashboard.render.com) を開く。
2. **在庫アプリの Web サービス（例: pos-stock）** をクリック。
3. 左メニューで **「Environment」** を開く。
4. **「Add Environment Variable」** をクリック。
5. 次のように入力する。
   - **Key**: `INVENTORY_SNAPSHOT_API_KEY`
   - **Value**: さきほど用意した API キー（例: `openssl rand -hex 32` の結果）
6. **「Save Changes」** を押す。  
   （必要なら「Manual Deploy」で再デプロイして反映させます。）

これで「API を呼んでよいか」の判定に、このキーが使われます。

---

## 5. Render で Cron Job を 1 つ作る

### ステップ 1: 新規 Cron Job を作成

1. [Render ダッシュボード](https://dashboard.render.com) の **「New +」** をクリック。
2. **「Cron Job」** を選ぶ。

### ステップ 2: どのリポジトリを使うか

- 在庫アプリと同じ **GitHub リポジトリ** を選びます。
- リポジトリが一覧に無い場合は、「Connect account」などで GitHub を連携してから、該当リポジトリを選び直します。
- **Branch**: 通常は `main`（デプロイしているブランチ）で OK です。

（Cron Job は「このリポジトリのコードをビルドした環境でコマンドを実行する」形になりますが、今回のコマンドは `curl` だけなので、中身は「API を呼ぶだけ」で問題ありません。）

### ステップ 3: 名前とリージョン

- **Name**: わかりやすい名前で OK です。例: `inventory-snapshot-daily`
- **Region**: Web サービス（pos-stock）と同じリージョン（例: Oregon）を選ぶとよいです。

### ステップ 4: スケジュール（いつ実行するか）

**Schedule** の欄に、cron 式を入れます。

- **「毎日 23:59（日本時間）」で実行したい場合**  
  - 日本 23:59 = UTC 14:59 なので、次のように入力します。  
  - **`59 14 * * *`**
- 意味: 「毎日、UTC で 14 時 59 分に 1 回実行する」＝日本時間 23:59。

※ すべて **UTC** で指定します。日本時間は UTC+9 なので、日本 23:59 → UTC 14:59 です。

### ステップ 5: コマンド（何を実行するか）

**Command** の欄に、次のどちらかを入れます。  
**`（アプリのURL）`** の部分は、ご自身の Web サービスの URL に置き換えてください（例: `https://pos-stock.onrender.com`）。

```bash
curl -X POST "https://（アプリのURL）/api/inventory-snapshot-daily" -H "Authorization: Bearer $INVENTORY_SNAPSHOT_API_KEY"
```

例（URL が `https://pos-stock.onrender.com` の場合）:

```bash
curl -X POST "https://pos-stock.onrender.com/api/inventory-snapshot-daily" -H "Authorization: Bearer $INVENTORY_SNAPSHOT_API_KEY"
```

- `$INVENTORY_SNAPSHOT_API_KEY` は、次の「環境変数」で設定した値に自動で置き換わります。
- これで「毎日 23:59 に、在庫スナップショット用 API を 1 回 POST で呼ぶ」という意味になります。

### ステップ 6: Cron Job 用の環境変数を 1 つ追加

1. 同じ Cron Job の設定画面で **「Environment」** のセクションを開く。
2. **「Add Environment Variable」** をクリック。
3. 次を入力する。
   - **Key**: `INVENTORY_SNAPSHOT_API_KEY`
   - **Value**: Web サービス（pos-stock）に登録したのと**同じ** API キー
4. 保存する。

これで、コマンド内の `$INVENTORY_SNAPSHOT_API_KEY` が、ここで入れた値に置き換わり、API が正しく認証されます。

### ステップ 7: 作成して保存

- 必要なら **Instance type** はそのままで OK です（最小構成で十分です）。
- **「Create Cron Job」** をクリックして作成します。

---

## 5.5 既存の Cron を直す場合（どこをどう修正するか）

すでに Cron Job を作っているが、スナップショットが残らない・時刻がずれているときは、次の **2 点** を Render で修正してください。

### 修正 1: Command（何を実行するか）

**現在こうなっている場合**（例）:
```bash
npm install && npm run build && node ./src/services/inventory-snapshot-daily/src/index.js
```
→ このリポジトリ（stock-transfer-pos）では **Node スクリプトは使わず、Web サービスの API を curl で呼ぶ** 形にします。

**修正手順**:
1. Render ダッシュボードで **該当の Cron Job**（例: inventory-snapshot-daily）を開く。
2. 左メニューで **「Settings」** をクリック。
3. **「Build & Deploy」** または **「Command」** の欄を探す。
4. **Command** を次の内容に **書き換える**（URL はご自身の Web サービスの URL に合わせる）:
   ```bash
   curl -X POST "https://pos-stock.onrender.com/api/inventory-snapshot-daily" -H "Authorization: Bearer $INVENTORY_SNAPSHOT_API_KEY"
   ```
5. 画面下の **「Save Changes」** をクリック。

※ `pos-stock.onrender.com` の部分は、在庫アプリの **Web サービス** の URL に読み替えてください。

### 修正 2: Schedule（いつ実行するか）

**日本時間 23:59 に実行したいのに**、Schedule が **`59 23 * * *`（23:59 UTC）** になっている場合:
- 23:59 UTC = 日本時間の **翌日 8:59** なので、意図とずれています。

**修正手順**:
1. 同じ Cron Job の **Settings** 画面で **「Schedule」** の欄を探す。
2. cron 式を **`59 14 * * *`** に変更する（毎日 UTC 14:59 = 日本時間 23:59）。
3. Render の UI が「At 02:59 PM UTC」のように表示されていれば正しいです。
4. **「Save Changes」** をクリック。

### あわせて確認すること

| 確認場所 | 内容 |
|----------|------|
| **Cron Job の Environment** | `INVENTORY_SNAPSHOT_API_KEY` が 1 つ設定されているか。 |
| **Web サービス（pos-stock 等）の Environment** | 上と **同じ値** の `INVENTORY_SNAPSHOT_API_KEY` が入っているか。ここに無いと API が 401 を返し、保存されません。 |
| **初回利用** | 最低 1 ショップで、**管理画面でアプリを 1 回開いている**か。開いていないとセッションが無く、API は `processed: 0` で終了します。 |

---

## 6. 動いているか確認する

1. Render ダッシュボードで、今作った **Cron Job** のページを開く。
2. **「Trigger Run」**（手動実行）ボタンがあるので、クリックする。
3. しばらくすると「Run」が実行され、ログに `curl` の結果が出ます。  
   - 成功していれば、在庫情報の「前日」の日付でスナップショットが 1 件保存されているはずです。
4. **本番のスケジュール**では、指定した cron 式（例: `59 14 * * *`）の通り、**毎日 23:59（日本時間）** に 1 回だけ自動実行されます。

---

## 7. よくある質問

**Q. Cron Job は 1 日何回動く？**  
A. 設定したスケジュールの回数だけです。`59 14 * * *` なら **1 日 1 回（毎日 UTC 14:59 = 日本 23:59）** だけ動きます。

**Q. 日本時間の 0:00 に実行したい場合は？**  
A. 日本 0:00 = UTC 前日 15:00 なので、Schedule に **`0 15 * * *`** を入れます。その場合は API が「前日」の日付で保存します（23:59 実行のときは「今日」の日付で保存）。

**Q. Cron Job の料金は？**  
A. Render の Cron Job は実行時間に応じて課金され、1 サービスあたり月額 $1 の最低料金があります。1 日 1 回・数秒で終わる程度なら、ごく少額です。

**Q. API キーはどこで作る？**  
A. 自分で決めたランダムな文字列で OK です。`openssl rand -hex 32` で生成したものを、Web サービスと Cron Job の両方の環境変数 `INVENTORY_SNAPSHOT_API_KEY` に、**同じ値**で入れます。

**Q. ストア数が増えて実行時間が気になる場合は？**  
A. API は複数ショップを**並列**で処理しています（デフォルト 3 店ずつ）。Web サービスの環境変数に **`SNAPSHOT_CONCURRENCY`**（値: 1〜10）を設定すると同時処理数を変更できます。さらにストアが増えた場合は、この値を 5 や 8 に上げると全体の実行時間が短くなります。Shopify の API 制限に余裕がある範囲で調整してください。

---

## 8. まとめ

| やること | どこで |
|----------|--------|
| API キーを 1 つ決める | 自分で（例: `openssl rand -hex 32`） |
| 同じキーを Web サービスに登録 | Render → pos-stock → Environment |
| 「毎日 23:59 に API を呼ぶ」Cron Job を作る | Render → New + → Cron Job |
| Schedule に `59 14 * * *` を入れる | Cron Job の Schedule |
| Command に curl で API を呼ぶコマンドを入れる | Cron Job の Command |
| Cron Job にも同じ API キーを環境変数で入れる | Cron Job の Environment |

ここまで設定すれば、**管理画面を開かなくても、毎日 23:59 に前日分の在庫スナップショットが自動で保存**されます。
