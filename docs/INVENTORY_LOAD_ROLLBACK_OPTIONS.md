# 棚卸ページ「読み込みに問題なかった時」のコミットとロールバック案

**※ 案A を実装済み**: loader はチャンクを読まず、list/main の単一キーのみ読み。getNextCountNumber は next → backup → list/main 単一キーの順で「名称＋1」を算出。

## 結論：読み込みがシンプルだったコミット

| コミット | 内容 | loader の棚卸取得 |
|----------|------|-------------------|
| **c3af977** | 棚卸: 管理画面・アプリタイルの明細/在庫一致・グループ読込… | **1本の GraphQL のみ**。`inventoryCountsMetafield` 1キーで取得。チャンク分割・list 一覧なし。 |
| f4b3820 | アプリ表示件数統一・**メタフィールド分割取得**で読込スピード統一 | `readInventoryCountsChunked(admin)` が loader に登場。チャンク読み・`.json()` が増加。 |
| 3f45b5b | 棚卸実装の専門監査と管理画面の空上書き防止 | list 優先 + チャンク読み。`locResp.json()` / `appResp.json()` / `settingsResp.json()` は **raw**（safe 化なし）。 |

- **「読み込みに問題なかった」可能性が高いのは c3af977 より前〜 c3af977**  
  - loader は「loc + app + settings」の 3 本だけ  
  - 棚卸一覧は **1 つのメタフィールド**からだけ取得しており、チャンクのパース失敗が起きない構成。

---

## c3af977 の loader の特徴（要約）

- `Promise.all([ locResp, appResp, settingsResp ])` の 3 本だけ。
- 棚卸一覧は `appData?.data?.currentAppInstallation?.inventoryCountsMetafield?.value` を `JSON.parse` するだけ（チャンクなし）。
- そのため「チャンク中身の JSON が壊れている」による syntax error は loader 経路では発生しない。
- 代わりに、**棚卸データが大きい場合は 1 キー制限**に戻る（分割保存・list 一覧なし）。

---

## ロールバックの選択肢

### 案 A: 棚卸IDまわりを c3af977 に近づける（ loader だけシンプル化）

- **やること**: loader の「棚卸一覧」取得を、**チャンク/list を使わず 1 メタキーだけ**読む形に戻す。
- **メリット**: 読み込み経路が単純になり、syntax error の原因をほぼ排除できる。
- **デメリット**: データ量が多いショップでは 1 キー制限・502 やサイズ制限に当たる可能性。list 一覧やチャンク分割は使わない前提になる。

### 案 B: 現行の「list 優先 + チャンク」のまま、loader を「絶対に落とさない」ようにする

- **やること**: loader 全体を try/catch で囲む。  
  - どこで例外が出てもキャッチし、`loadError: true` とメッセージだけ返す。  
  - 「原因: syntax error, unexpected end of file」は出さず、「データの読み込みに失敗しました。ページを再読み込みしてください。」のみ表示。
- **メリット**: 既存の list/チャンク機能を維持したまま、画面だけは必ず表示される。
- **デメリット**: 根本の「空応答・不正 JSON」は残る。再読み込みで直ることもあれば、環境によっては繰り返す可能性。

### 案 C: リポジトリごと c3af977 に戻す

- **やること**: `git reset --hard c3af977`（必要なら `git push --force-with-lease`）。
- **メリット**: 読み込みが確実にシンプルな状態に戻る。
- **デメリット**: c3af977 以降の**すべての変更**が消える（棚卸の list/チャンク、確定API、履歴、その他機能追加・修正すべて）。

---

## おすすめの進め方

1. **まず「読み込みに問題なかった時」の参照として c3af977 の内容を確認する**  
   - 上記のとおり「loader は 3 本だけ・棚卸は 1 メタキー」だった時点。
2. **棚卸IDの「処理方法」を元に戻すなら**  
   - **案 A**: loader だけ 1 メタキー読みに戻し、list/チャンクは action や別 API 専用にする。  
   - **案 B**: 現行構成のまま、loader を try/catch で囲んで syntax error を画面に出さないようにする。
3. **リポジトリ全体を戻すかどうか**  
   - 他機能も含めて「c3af977 の状態でよい」なら **案 C**。  
   - それ以外なら、**案 A か B で棚卸IDまわりだけ戻す／守る**方が安全。

---

## 参照用コマンド

```bash
# c3af977 の loader 周辺を確認
git show c3af977:app/routes/app.inventory-count.tsx | head -350 | tail -250

# c3af977 と現在の diff（app.inventory-count のみ）
git diff c3af977 -- app/routes/app.inventory-count.tsx | head -200
```
