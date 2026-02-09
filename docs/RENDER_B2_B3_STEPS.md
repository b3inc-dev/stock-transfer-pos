# B2・B3 手順（Render で DATABASE_URL と Build Command を設定）

A3 まで完了したあと、Render ダッシュボードで行う作業です。

---

## B2: pos-stock に DATABASE_URL（Internal URL）を設定

1. [Render ダッシュボード](https://dashboard.render.com) にログインする。
2. **pos-stock**（Web サービス）をクリックして開く。
3. 左メニューで **「Environment」** を開く。
4. **「Add Environment Variable」** または **「Add Variable」** をクリックする。
5. **Key**: `DATABASE_URL`
6. **Value**: 作成した Postgres の **Internal Database URL** を貼り付ける。  
   （Postgres の画面 → **Connect** → **Internal Database URL** をコピー）
7. **Save Changes** をクリックする。

※ 既に `DATABASE_URL` がある場合は、値を Internal URL に更新する。

---

## B3: ビルド時にマイグレーションを実行する

Render の UI はバージョンやサービス種別で違うことがあります。次のどれかに当てはまるか確認してください。

### パターン1: Build Command が表示される場合（Node などネイティブビルド）

1. **pos-stock** を開く → 左メニュー **「Settings」**。
2. ページ内をスクロールし、**「Build」** や **「Build & Deploy」** のブロックを探す。
3. **「Build Command」** の入力欄があれば、次のようにする：
   - 現在が `npm install && npm run build` なら、次に**置き換え**：
     ```bash
     npm install && npx prisma generate && npx prisma migrate deploy && npm run build
     ```
   - それ以外のコマンドの場合は、その**前**に `npx prisma generate && npx prisma migrate deploy &&` を付ける。
4. **Save Changes** をクリックする。

### パターン2: Build Command が出てこない場合（Docker でデプロイしている場合）

pos-stock が **Docker** でデプロイされている場合、Render は **Dockerfile** の `RUN` でビルドするため、ダッシュボードに「Build Command」は表示されません。

このプロジェクトの **Dockerfile** では、起動時に `npm run docker-start`（＝ `prisma generate && prisma migrate deploy && npm run start`）が実行されるため、**すでにデプロイ時にマイグレーションが走る**ようになっています。

やること：
- **B2 で `DATABASE_URL` を Environment に設定していれば、そのままデプロイしてよい**です。
- 起動コマンド（Start Command）が `npm run docker-start` や `npm run start` になっていれば、`package.json` の `setup` スクリプトで `prisma migrate deploy` が実行されます。

### パターン3: Settings のどこを探しても Build 関連がない場合

1. **pos-stock** の画面で、左サイドや上部の **「Environment」** のとなりに **「Build」** や **「Deploy」** といったタブやリンクがないか確認する。
2. サービス作成時に「Docker」を選んでいる場合は、**Build Command はなく、Dockerfile の内容が使われている**と考えてよい。上記パターン2のとおり、B2 だけで次回デプロイ時にマイグレーションが実行されます。
3. どうしても Build Command を足したい場合は、**サービスを複製（Duplicate）して作り直す**か、Render サポートに「既存 Web サービスの Build Command を変更したい」と問い合わせる方法があります。

**結論**: Docker デプロイなら **B2（DATABASE_URL の設定）だけ済んでいれば、そのままデプロイして B4 の動作確認に進んで大丈夫**です。

---

## B4: デプロイと動作確認（具体的な手順）

デプロイが成功したあと、次の **3 ステップ** を順にやってください。

---

### ステップ 1: 管理画面にログインできるか

1. ブラウザで **本番アプリの URL**（例: `https://pos-stock.onrender.com` や Render の pos-stock の URL）を開く。
2. Shopify の **ログイン画面** にリダイレクトされたら、**ストアの URL**（例: `your-store.myshopify.com`）を入力する。
3. **「ログイン」** や **「アプリに進む」** をクリックし、**管理画面（アプリの TOP や在庫情報など）が表示される**ことを確認する。
4. エラーや「セッションが見つかりません」などが出ず、普通に画面が見えれば **OK**。

---

### ステップ 2: 在庫変動履歴に 1 件入るか

1. 管理画面の **「在庫情報」**（または在庫変動履歴のタブ）を開く。
2. **在庫変動を 1 件起こす**。どれか一つでよい：
   - **POS** でロス登録を 1 件確定する  
   - **POS** で入庫・出庫を 1 件確定する  
   - **管理画面** で在庫調整をする  
   - または、**テスト注文** を作成して履行し、売上として変動が出るようにする  
3. 再度 **「在庫情報」→ 在庫変動履歴** を開き、**今つけた 1 件が一覧に表示されている**ことを確認する。
4. 表示されていれば **OK**（PostgreSQL に保存されている）。

---

### ステップ 3: 再デプロイ後も履歴が残るか

1. **Render ダッシュボード** で **pos-stock** を開く。
2. **「Manual Deploy」** → **「Deploy latest commit」**（または「Clear build cache & deploy」）をクリックし、**もう一度デプロイ**する。
3. デプロイが **完了** するまで待つ（数分）。
4. 再度、ブラウザで **本番アプリの URL** を開く。
5. 次を確認する：
   - **管理画面に再度ログインできる**こと。
   - **「在庫情報」→ 在庫変動履歴** を開き、**ステップ 2 で入れた 1 件がまだ表示されている**こと（消えていないこと）。
6. 両方とも問題なければ **B4 完了**。G1（デプロイ後も履歴が消えない）の確認ができています。

---

**チェックリスト（B4 用）**

| # | 確認内容 | 結果（✓ or メモ） |
|---|----------|-------------------|
| 1 | デプロイ後、管理画面にログインできる | |
| 2 | 在庫変動を 1 件起こすと、在庫変動履歴に表示される | |
| 3 | 再デプロイ後もログインできる | |
| 4 | 再デプロイ後も、在庫変動履歴の 1 件が消えずに残っている | |

以上で G1（デプロイ後も履歴が消えない）の確認完了です。
