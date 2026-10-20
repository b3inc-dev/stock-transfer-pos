# 棚卸の 1 件ずつ保存（db_v2）

棚卸データ（棚卸 ID・状態・グループごとの結果）の保存先を、ショップ全体 1 本の分割メタフィールド
（`inventory_counts_v1` + `_c{N}`）から、PostgreSQL の「棚卸 1 件 = 1 行」「グループ結果 1 件 = 1 行」へ段階的に移す。
商品グループ（`product_groups_v1`）と POS の画面・操作は変えない。

## 保存先モード

| モード | 正 | 書き込み | 読み取り |
|--------|----|----------|----------|
| `legacy`（既定） | メタフィールド | 現行どおり | 現行どおり |
| `dual` | メタフィールド | 現行どおり + 変化した棚卸だけ DB へ新形式で写す。確定の再試行バックアップも棚卸ごとに DB へ | 現行どおり（再試行バックアップは DB を先に見る） |
| `db` | DB | 棚卸 1 行だけ更新（行版番号で競合検出）。応答後にメタフィールドへ書き写し | DB |

- 実効モード = ショップ別 `StocktakeStorageState.modeOverride` → 環境変数 `STOCKTAKE_STORAGE_MODE` → `legacy`
- `db` は移し替え（backfill）済みのショップだけ有効。未完了なら `dual` に落ちる
- モード取得で DB エラーなら `legacy`

## 旧 POS ビルドとの互換

旧 POS はメタフィールドを直接読み書きする（一覧・詳細の読み取り、draft→in_progress の書き込み、番号補完）。

- `db` の間もメタフィールドを DB の内容で書き写し続ける（ショップごとに 1 本、1.5 秒まとめ）
- 書き写しの前にメタフィールドの版番号が変わっていたら、旧 POS の書き込みを保守的に取り込む
  - 状態は上げる方向だけ（completed / cancelled は戻さない）
  - DB に結果があるグループは上書きしない。空欄だけ補う
- 新 POS は `/api/pos-stocktake-counts`（`mode` / `list` / `get` / `start`）を使い、サーバーが `db` 以外・旧サーバー・通信失敗なら従来のメタフィールド経路に戻る（モードは 60 秒キャッシュ）

## 切替手順（ショップごと）

1. `prisma migrate deploy`（追加のみ: `listJson` 列と 3 テーブル）
2. サーバーをデプロイ（この時点では全ショップ `legacy` のまま）
3. POS 拡張をデプロイ（PUBLIC → CIARA）。サーバーが `legacy` の間は従来経路
4. 管理画面 `/app/stocktake-storage` で「並行記録（dual）」→「移し替え」→「照合」
5. 照合で差分が無ければ「DB へ切替（db）」（内部でもう一度移し替え・照合してから切り替える）

## 戻し方

- `/app/stocktake-storage` の「並行記録に戻す」または「現行（legacy）に戻す」
  - `db` から戻すときは、先に DB の最新をメタフィールドへ同期で書き写し、失敗したら切り替えない
  - DB の行は消さない（再切替時に再利用。取り込みは冪等）
- 緊急時は `StocktakeStorageState.modeOverride` を `legacy` にする（DB に届かない場合も `legacy` 動作）
- テーブル追加のみなので、サーバーを前の版へ戻しても DB は互換

## 確認

- 純粋ロジック: `node --experimental-strip-types --test tests/stocktake-count-store-logic.test.mjs tests/stocktake-counts-api-client.test.mjs`
- 実 DB での通し確認（ローカル DB 専用。対象ショップのデータを消す）:
  `DATABASE_URL=postgresql://...localhost.../test SHOPIFY_API_KEY=x SHOPIFY_API_SECRET=x SHOPIFY_APP_URL=https://example.com SCOPES=read_products npx vite-node scripts/verify-stocktake-count-store.db.ts`

## 未対応（別承認）

- メタフィールドへの書き写し停止（旧 POS ビルドが無くなってから）
- 確定のバックグラウンド化（ジョブ表・ワーカー）。本変更の棚卸 1 行更新を前提に載せる
