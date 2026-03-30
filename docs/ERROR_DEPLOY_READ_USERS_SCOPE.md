# デプロイエラー: read_users スコープ（app_access validation）

## 発生するエラー

`npm run deploy:inhouse` または `shopify app deploy` 実行時に、次のエラーでバージョン作成に失敗することがあります。

```
Version couldn't be created.
app_access
Validation errors
  • scopes: read_users
```

## 原因

- **`read_users`** は Shopify 側で**制限付きスコープ**として扱われています。
- **Partner 開発アプリ**（`shopify app deploy` でデプロイするアプリ）では、このスコープを必須スコープに含めると、**審査・許可なしではデプロイが通らない**場合があります。
- カスタムアプリ（ストア管理画面で作成するアプリ）では、**Shopify Plus** ストアに限り、Shopify サポートへの申請で `read_users` を付与してもらえることがありますが、Partner アプリの「必須スコープ」としての利用は検証で弾かれることがあります。

そのため、**必須スコープに `read_users` が入っていると「Version couldn't be created」の原因**になります。

## 対応方針（本プロジェクトで採用している対応）

1. **必須スコープから `read_users` を削除する**  
   - `shopify.app.toml` / `shopify.app.public.toml` の `[access_scopes]` の `scopes` から `read_users` を外す。
   - `app/shopify.server.ts` の `DEFAULT_SCOPES` からも `read_users` を外す。
   - これで **デプロイは通る**ようになります。

2. **スタッフ一覧 API（`api.staff-members`）の挙動**  
   - `read_users` を付けていない場合、Admin API の `staffMembers` クエリは権限不足でエラーになります。
   - そのため、**スコープ不足と判断できるエラー時は「エラー」ではなく「空のスタッフ一覧」を返す**ようにしています。
   - POS 側（発注・ロス・棚卸など）では、スタッフ一覧が空でも動作し、スタッフ選択は「未選択」や「利用不可」として扱えます。

3. **将来 `read_users` を使いたい場合**  
   - Partner Dashboard でアプリの権限設定を確認し、`read_users` を許可する申請が可能かどうか Shopify のドキュメントまたはサポートに確認してください。
   - 許可された場合は、再度 toml と `DEFAULT_SCOPES` に `read_users` を追加してデプロイできます。

## 変更したファイル（参考）

| ファイル | 変更内容 |
|----------|----------|
| `shopify.app.toml` | `scopes` から `,read_users` を削除 |
| `shopify.app.public.toml` | 同上 |
| `app/shopify.server.ts` | `DEFAULT_SCOPES` から `read_users` を削除 |
| `app/routes/api.staff-members.tsx` | GraphQL エラーが「アクセス権限」系の場合、500 ではなく 200 で `staffMembers: []` を返す |

## 参考リンク

- [Shopify API access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [Manage access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes)
- コミュニティ: 「read_users permission」「Custom App」「Partner app」で検索すると同様の制限に関する議論があります。
