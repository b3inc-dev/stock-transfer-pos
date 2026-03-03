# 棚卸完了API と 履歴API の差分一覧（通信で失敗する場合の確認用）

## クライアント（POS 拡張）

| 項目 | 履歴 (logInventoryChangeToApi / sendChunkWithRetry) | 棚卸完了 (reportStocktakeCompleteToApi) | 備考 |
|------|-----------------------------------------------------|----------------------------------------|------|
| **取得** | `globalThis?.shopify?.session` | 同じ | 同一 |
| **トークン** | `session.getSessionToken()` | 同じ | 同一 |
| **appUrl** | `getAppUrl()` 動的 import | 同じ | 同一 |
| **URL** | `${appUrl}/api/log-inventory-change` | `${appUrl}/api/pos-stocktake-complete` | **パスのみ違う** |
| **method** | `POST` | `POST` | 同一 |
| **headers** | `{ Authorization: \`Bearer ${token}\`, "Content-Type": "application/json" }` | **同一に揃えた** | 順序・キーとも同じ |
| **mode** | 指定なし | 指定なし | 同一 |
| **credentials** | 指定なし | 指定なし | 同一 |
| **body** | `JSON.stringify(body)` | `JSON.stringify(body)` | 同一 |

※ ヘッダー順を履歴側（Authorization → Content-Type）に合わせてあり、それ以外の fetch オプションは履歴と同一。

---

## サーバー（Remix ルート）

| 項目 | api.log-inventory-change | api.pos-stocktake-complete | 備考 |
|------|--------------------------|-----------------------------|------|
| **ルートパス** | `/api/log-inventory-change` | `/api/pos-stocktake-complete` | flatRoutes の命名どおり |
| **OPTIONS** | loader で 204 + CORS_HEADERS | loader で 204 + CORS_HEADERS | 同一 |
| **CORS_HEADERS** | Allow-Origin: * 等 | 同じ定義 | 同一 |
| **認証** | Bearer 必須、decodePOSToken → authenticate.pos フォールバック | 同じ流れ | 同一 |
| **shop 取得** | shopFromDest(dest) | 同じ | 同一 |
| **セッション** | findSessionsByShop(shop)、オフライン優先、refreshOfflineSessionIfNeeded | 同じ | 同一 |
| **body 取得** | `await request.json()`（未 try/catch） | `await request.json()` を try/catch、失敗時 400 + CORS | 棚卸側の方が安全 |

---

## 通信が失敗する場合の切り分け

1. **履歴APIは成功し、棚卸完了APIだけ失敗するか**
   - 履歴は成功する → 同じ送信方法なので、**URL（パス）かルートの有無**を疑う。本番で `api.pos-stocktake-complete` がデプロイされているか、パスが `/api/pos-stocktake-complete` で届いているかを確認。
   - 履歴も失敗する → ネットワーク・CORS・appUrl など**共通要因**を疑う。

2. **一時的なデバッグ**
   - `reportStocktakeComplete.js` の `apiUrl` を一時的に  
     `${appUrl}/api/log-inventory-change` にし、body を `{ entries: [{ activity: "inventory_count", ... }] }` のような最小限の1件にして送信。
   - これで 200 や 401 など「レスポンスが返る」なら、**履歴のルートには届いている**ので、パスを元に戻したうえで「pos-stocktake-complete だけ届いていない」と判断できる。

3. **本番でルートが有効か**
   - デプロイ後に `curl -X OPTIONS https://(あなたのドメイン)/api/pos-stocktake-complete` で 204 が返るか確認。
   - 204 が返れば OPTIONS は届いているので、続けて POST（Authorization 付き）で確認。

4. **POS が参照している appUrl とデプロイ先が一致しているか**
   - POS 拡張は `extensions/common/appUrl.js` の `getAppUrl()` でベース URL を取得している。
   - `APP_MODE = "public"` → 本番 URL は `https://pos-stock.onrender.com`
   - `APP_MODE = "inhouse"` → 本番 URL は `https://stock-transfer-pos.onrender.com`
   - **実際にアプリ（Remix）をデプロイしているドメイン** と上記が一致していないと、確定APIは別ホストに送られて届かない。履歴APIも同じ `getAppUrl()` を使うので、履歴が成功しているなら appUrl は合っている。履歴も送れない場合は APP_MODE とデプロイ先の対応を確認する。

---

## まとめ

- クライアントの fetch は **履歴と同一**（ヘッダー順も揃えた）。違うのは **URL のパス** と **body の中身** だけ。
- サーバー側の CORS・認証の流れも履歴APIと揃えてある。
- それでも通信で失敗する場合は、**履歴は成功するか** と **本番のルート・パス** を上記の手順で確認するとよい。
