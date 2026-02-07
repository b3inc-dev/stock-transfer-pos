# POS UI Extension：モーダルを閉じるボタンについて

**注意**: 検証の結果、**全てのモーダルで「閉じる」ボタンは現状機能していません**。本ドキュメントは実装方針と今後の調査用です。完全再現の検証対象（出庫・入庫・ロス・棚卸の処理が2分割前と同じか）とは別課題です。→ `docs/FAITHFUL_REPRODUCTION_TODO.md` 参照。

---

## 公式仕様

Shopify POS UI Extension では、**モーダルを閉じるボタンは公式にサポート**されています。

- **Navigation API**  
  https://shopify.dev/docs/api/pos-ui-extensions/2025-04/target-apis/platform-apis/navigation-api

- **利用可能なターゲット**  
  `pos.home.modal.render` を含むアクション（モーダル）ターゲットで利用可能です。

- **閉じる処理**  
  - **`dismiss()`** … 拡張モーダルを完全に閉じる  
  - ワークフロー完了・キャンセル時、またはメインの POS 画面に戻りたいときに使用します。

## 実装方法

公式ドキュメントでは次の2通りが示されています。

1. **グローバル `navigation` オブジェクト**  
   「The global `navigation` object provides web-standard navigation functionality」  
   → 拡張内では `globalThis.navigation.dismiss()` で閉じる処理を呼べます。

2. **React の `useApi` / エントリの引数 `api`**  
   `const api = useApi<'pos.home.modal.render'>();` のうえで  
   `api.navigation.dismiss()` を呼ぶ方法です。  
   POS がモーダル表示時にエントリを `(root, api)` で呼ぶ場合、`api.navigation.dismiss` が確実に使えます。

本プロジェクトの拡張（Preact / 非 React のエントリ）では、次の順で試しています。

1. **POS が渡した `api`** … エントリを `export default async (rootArg, apiArg) => { ... }` とし、`apiArg?.navigation?.dismiss` を保持して最優先で呼ぶ。
2. **グローバル `navigation`** … `globalThis.navigation.dismiss` / `globalThis.shopify.navigation.dismiss` / `SHOPIFY.navigation.dismiss`
3. **action API** … `SHOPIFY.action.dismissModal` / `SHOPIFY.action.dismiss`

## 閉じるボタンの確認手順（POS 実機またはシミュレータ）

1. **出庫** … ホームの「在庫処理（出庫）」タイルをタップ → コンディション画面のフッター左「**閉じる**」をタップ → モーダルが閉じてホームに戻ること。
2. **入庫** … 入庫タイルからモーダルを開く → コンディション画面のフッター左「**閉じる**」をタップ → モーダルが閉じること。
3. **ロス** … ロスタイルからモーダルを開く → コンディション画面のフッター左「**閉じる**」をタップ → モーダルが閉じること。
4. **棚卸** … 棚卸タイルからモーダルを開く → コンディション画面のフッター左「**閉じる**」をタップ → モーダルが閉じること。

いずれも「閉じる」でモーダルが閉じない場合は、POS のバージョンや拡張のロード方式により `api` / `globalThis.navigation` が渡されていない可能性があります。その場合は Shopify 公式ドキュメントの「Navigation API」で利用可能な呼び方を再確認してください。

## まとめ

- POS アプリで「閉じる」ボタンからモーダルを閉じる実装は**公式でサポートされている**。
- 本プロジェクトでは、POS 渡しの `api.navigation.dismiss` を最優先にし、続けてグローバル `navigation` と action API をフォールバックとして使用している。
