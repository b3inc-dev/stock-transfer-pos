# なぜ「履歴一覧リスト」「商品リスト」「検索リスト」の設定が反映されていないか（完全再現できていない理由）

管理画面（設定画面）で設定した**履歴一覧リスト**・**商品リスト**・**検索リスト**の件数が、入庫・出庫・ロス・棚卸の各 POS 拡張で正しく使われていないため、**完全再現はできていません**。

---

## 1. 管理画面で何を保存しているか

**ファイル**: `app/routes/app.settings.tsx`

管理画面では次の 3 種類の「件数」を保存しています。

| 設定ラベル（画面） | 保存キー | 説明 | デフォルト |
|--------------------|----------|------|------------|
| **履歴一覧リスト** | `outbound.historyInitialLimit`（出庫履歴）<br>`inbound.listInitialLimit`（入庫リスト） | 出庫履歴・入庫リストの初回取得件数 | 100（上限250） |
| **商品リスト** | `productList.initialLimit` | 商品リスト（lineItems 等）の初回表示件数 | 250（上限250） |
| **検索リスト** | `searchList.initialLimit` | 検索結果（productVariants 等）の初回表示件数 | 50（上限50） |

**保存先**: Shopify の **currentAppInstallation の metafield**  
- namespace: `stock_transfer_pos`  
- key: `settings_v1`  
- 上記の outbound / inbound / productList / searchList を含む JSON が 1 つで保存される。

つまり「管理画面で設定した数」は、**POS とは別の Web 管理画面**で metafield に書き込まれており、**POS 拡張側で同じ metafield を読まないと反映されません**。

---

## 2. 完全再現できていない理由（拡張ごと）

### 2.1 入庫（stock-transfer-inbound）

**理由: 設定を metafield から一度も読み込んでいない。**

- 入庫拡張の `Modal.jsx` では、画面用の state に **localStorage の `usePersistentAppState()`** だけを使っている。
- **metafield から設定（settings_v1）を取得する処理が存在しない。**
- そのため `appState.outbound.settings` や `appState.inbound.settings` は**どこにも入ってこない**（tile の bootstrap で入るのは tile 用 appState のみ）。
- コード上は `appState?.outbound?.settings?.inbound?.listInitialLimit ?? 100` を参照しているが、入庫拡張ではこの `settings` が**常に未設定**のため、**常にデフォルト 100** になる。
- 商品リスト・検索リスト用の `productList.initialLimit` / `searchList.initialLimit` も、入庫拡張内では**読み込む仕組みがない**ため、管理画面の設定は一切反映されない。

**まとめ**: 入庫は「履歴一覧リスト」「商品リスト」「検索リスト」の**いずれも管理画面の件数設定に未対応**。そのため、設定を読む実装が無い時点で完全再現できていない。

---

### 2.2 出庫（stock-transfer-tile）

**理由: 履歴・検索は設定を参照しているが、「商品リスト」の件数が設定ではなくハードコードされている。**

- **履歴一覧リスト**: tile の `bootstrap()` で metafield から設定を取得し `outbound.settings` に格納している。`OutboundHistoryScreens.jsx` で `outbound.settings.outbound.historyInitialLimit` を参照しており、**管理画面の「履歴一覧リスト」は反映されている**。
- **検索リスト**: `OutboundListScreen.jsx` で `settings?.searchList?.initialLimit` を参照しており、**管理画面の「検索リスト」は反映されている**。
- **商品リスト**: 出庫リストの lineItems 取得では、`Modal.jsx` や関連コードで **`lineItems(first: 250)` と 250 がハードコード**されている。`settings?.productList?.initialLimit` を参照しておらず、**管理画面の「商品リスト」の件数は反映されていない**。

**まとめ**: 出庫は「履歴一覧」「検索リスト」は設定どおりだが、「商品リスト」だけ設定未対応のため、3 つすべての設定が使われているとは言えず、完全再現できていない。

---

### 2.3 ロス（stock-transfer-loss）

**状況: 検索リストは設定を参照。履歴一覧・商品リストは仕様・実装の確認が必要。**

- **検索リスト**: `LossProductList.jsx` で `fetchSettings()`（lossApi.js）により metafield から設定を取得し、`settings?.searchList?.initialLimit` を参照している。**管理画面の「検索リスト」は反映されている。**
- **履歴一覧**: ロス履歴は metafield から全件取得する実装になっており、`historyInitialLimit` のような「初回 N 件」の設定が使われているかは、現状の仕様・コード次第。
- **商品リスト**: ロス行は手動追加が主で、出庫・入庫のような「lineItems の first」とは用途が異なる。`productList.initialLimit` がロス画面で使われているかは、実装次第。

**まとめ**: 検索リストは設定対応済み。履歴一覧・商品リストが管理画面の「履歴一覧リスト」「商品リスト」の数と完全に一致しているかは、現行仕様の確認が必要。少なくとも「3 つすべてが設定どおり」とまでは言い切れない可能性がある。

---

### 2.4 棚卸（stock-transfer-stocktake）

**状況: 商品リスト・検索リストは設定を参照。履歴一覧（棚卸一覧）は別仕様の可能性。**

- **商品リスト・検索リスト**: `InventoryCountList.jsx` で `fetchSettings()`（stocktake 拡張内の lossApi.js）により metafield から設定を取得し、`settings?.productList?.initialLimit` と `settings?.searchList?.initialLimit` を参照している。**管理画面の「商品リスト」「検索リスト」は反映されている。**
- **履歴一覧（棚卸一覧）**: 棚卸一覧は metafield から全件取得する実装になっており、「初回 N 件」の件数設定がそのまま適用されているかは、仕様・実装次第。

**まとめ**: 商品リスト・検索リストは設定対応済み。履歴一覧リストに相当する部分が、管理画面の「履歴一覧リスト」の数と同一仕様かは要確認。

---

## 3. 一覧まとめ（設定が「使われているか」）

| 拡張 | 履歴一覧リストの件数 | 商品リストの件数 | 検索リストの件数 |
|------|----------------------|------------------|------------------|
| **入庫** | ❌ 未対応（設定を読んでいない → 常にデフォルト） | ❌ 未対応 | ❌ 未対応 |
| **出庫** | ✅ 設定を参照 | ❌ 未対応（250 固定） | ✅ 設定を参照 |
| **ロス** | 要確認（全件取得等） | 要確認 | ✅ 設定を参照 |
| **棚卸** | 要確認（全件取得等） | ✅ 設定を参照 | ✅ 設定を参照 |

---

## 4. なぜこうなっているか（設計・経緯）

1. **設定の保存場所は 1 つ（metafield）**
   - 管理画面は Web アプリ（Remix）で、`currentAppInstallation` の metafield に `settings_v1` として保存している。
   - POS 拡張は別アプリ（別 JS バンドル）なので、**同じ metafield を自分で読む処理**を各拡張に実装しないと、管理画面の設定は届かない。

2. **出庫（tile）だけ bootstrap で設定を読んでいる**
   - tile の `Modal.jsx` の `bootstrap()` で、GraphQL により metafield を取得し、`outbound.settings` に格納している。
   - そのため出庫は「履歴一覧」「検索リスト」では設定を参照できている。ただし商品リストの `first` は昔の実装のまま 250 固定で、`productList.initialLimit` が未導入。

3. **入庫は tile から分離したが「設定を読む処理」を移植していない**
   - 入庫拡張は、tile の入庫フローを別拡張に切り出したもの。
   - しかし **metafield から settings を取得する処理（bootstrap 相当）を入庫拡張に持ってきていない**。
   - さらに、入庫の appState は **localStorage ベースの usePersistentAppState のみ**で、tile の `outbound.settings` とは共有されない。そのため、入庫拡張内では `outbound.settings` が常に空で、**履歴一覧リスト・商品リスト・検索リストのいずれも管理画面の設定が反映されない**。

4. **ロス・棚卸は一部だけ設定を利用**
   - ロス・棚卸は、商品リスト／検索リスト用に `fetchSettings()` で metafield を読んでいる。
   - 一方で、「履歴一覧リスト」に相当する一覧が metafield 全件取得になっているなど、管理画面の 3 項目すべてが同じ意味で使われているかは、現行仕様の確認が必要。

---

## 5. 完全再現するために必要なこと

1. **入庫拡張**
   - 起動時（またはコンディション表示時）に、**metafield（settings_v1）を取得する処理**を追加する。
   - 取得した設定を、入庫用の state（または appState）に格納する。
   - 履歴一覧リストの件数: `inbound.listInitialLimit` を、入庫一覧の `first` に使う。
   - 商品リスト・検索リストを使う画面があれば、`productList.initialLimit` / `searchList.initialLimit` を同様に参照する。

2. **出庫（tile）**
   - 商品リスト（lineItems）の取得で、`lineItems(first: 250)` の 250 をやめ、**`outbound.settings.productList.initialLimit`**（または同等の設定）を参照する。

3. **ロス・棚卸**
   - 履歴一覧に相当する一覧で「初回 N 件」の仕様がある場合、その N に **`outbound.historyInitialLimit` や同等の設定**が使われているか確認し、未使用なら設定を参照するようにする。

上記を満たして初めて、「管理画面で設定した履歴一覧リスト・商品リスト・検索リストの数」が、入庫・出庫・ロス・棚卸のすべてで反映された状態になり、その意味で**完全再現**と言えます。
