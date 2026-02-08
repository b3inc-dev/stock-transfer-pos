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

## B4: デプロイと動作確認

1. 上記を保存したあと、**「Manual Deploy」→「Deploy latest commit」** でデプロイする（または Git に push して自動デプロイを待つ）。
2. デプロイが成功したら、次を確認する：
   - **管理画面**にログインできること。
   - **在庫変動**（POS や管理画面で何か 1 件）を行い、**在庫変動履歴**に表示されること。
   - もう一度 **デプロイ**（または同じコミットで再デプロイ）し、**履歴が消えていないこと**・**再度ログインできること**。

以上で G1（デプロイ後も履歴が消えない）の確認完了です。
