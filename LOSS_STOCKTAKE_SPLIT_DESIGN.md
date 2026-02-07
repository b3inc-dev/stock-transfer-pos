# ロス登録・棚卸の分割実装設計（Modal 容量限界時）

Modal が容量限界に達した場合の、**ロス登録**と**棚卸**の実装のあり方をまとめた設計メモです。

---

## 1. 現状

- **Modal.jsx**: 約 1.4 万行。出庫・入庫・ロス・棚卸のルーティングと、出庫・入庫のほぼ全ロジックを保有。
- **ロス・棚卸**: 既に `screens/LossScreen.jsx` と `screens/StocktakeScreen.jsx` に分割済み。  
  - 現状はプレースホルダーのみ。  
  - Modal は `import` して `screen === LOSS | STOCKTAKE` のときこれらのコンポーネントを描画するだけ。

**方針**: ロス・棚卸の**本実装も Modal には書かず、`screens/` 以下に閉じる**。

---

## 2. 分割の基本方針

### 2.1 Modal の役割（極力スリムに保つ）

Modal は **「入り口」と「ルーティング」** に専念する。

| 役割 | 内容 |
|------|------|
| エントリ | `render`, `ErrorBoundary`、Extension ルート |
| ナビ | `SCREENS`、`useNavStack`、`goBack` / `goMenu` |
| ルーティング | `screen` に応じて `body` を切り替え（Menu / Outbound / Inbound / **Loss** / **Stocktake**） |
| 共有の土台 | 必要なら `appState` / `setAppState`、`prefs`、`setHeader` / `setFooter`、ロケーション一覧など（渡すだけ） |
| Menu | `MenuScreen`（軽量なので Modal 内のままでも可） |

**Modal に持たせないもの**:

- ロス登録の画面・API・状態
- 棚卸の画面・API・状態  
→ これらはすべて **`screens/` 以下** に実装する。

---

## 3. ディレクトリ構成案

```
extensions/stock-transfer-tile/src/
├── Modal.jsx              # オーケストレーター（上記の範囲のみ）
├── Tile.jsx
├── lib/                   # 共有ユーティリティ（必要に応じて Modal から抽出）
│   ├── graphql.js         # adminGraphql、タイムアウト処理など
│   ├── inventory.js       # inventoryAdjustQuantity のラッパーなど
│   └── storage.js         # metafield 読書（loss_entries, inventory_counts 等）
├── screens/
│   ├── LossScreen.jsx     # ロス登録のルート（サブ画面の切り替え）
│   ├── StocktakeScreen.jsx # 棚卸のルート
│   ├── loss/              # ロス専用（さらに分割する場合）
│   │   ├── LossConditions.jsx   # ① コンディション
│   │   ├── LossProductList.jsx  # ② 商品リスト
│   │   ├── LossHistoryList.jsx  # ③ ロス登録リスト
│   │   └── lossApi.js           # metafield / inventoryAdjust 等
│   └── stocktake/
│       ├── StocktakeIdInput.jsx     # ① 棚卸ID入力
│       ├── StocktakeProductList.jsx # ② 商品スキャン・実数入力
│       ├── StocktakeComplete.jsx    # ③ 完了処理（必要なら）
│       └── stocktakeApi.js          # 棚卸用 API
```

- **まずは `LossScreen.jsx` / `StocktakeScreen.jsx` のまま実装**し、  
  どちらかが大きくなりすぎたら `loss/` や `stocktake/` に細かく分割する、という段階でよい。

---

## 4. ロス登録の実装イメージ

### 4.1 画面フロー

1. **コンディション** → ロケーション・日付・理由を入力 → 「ロス登録開始」
2. **商品リスト** → スキャン/手動で商品追加・数量入力 → 「確定」で在庫調整
3. **ロス登録リスト** → 履歴一覧・フィルター・詳細・キャンセル

`LossScreen` 内で **サブ画面を state で切り替え**（例: `'conditions' | 'productList' | 'historyList'`）。  
Modal の `useNavStack` は「ロス」と「メニュー」の行き来だけに使い、ロス内部の ①〜③ は Loss 側の state で制御する。

### 4.2 データ・API

- **保存**: `currentAppInstallation.metafield`  
  - namespace: `stock_transfer_pos`  
  - key: `loss_entries_v1`  
  - 値: `LossEntry[]` の JSON。
- **在庫調整**: `inventoryAdjustQuantity`（数量はマイナスで渡す）。
- **ロケーション一覧**: Modal から `locations` などを props で渡すか、  
  あるいは `lib` 経由で取得するかは、既存の Outbound/Inbound のやり方に合わせる。

### 4.3 LossScreen が受け取る props 例

```js
// Modal から渡すもの
{
  onBack: () => void;
  appState: object;
  setAppState: (fn) => void;
  setHeader: (node) => void;
  setFooter: (node) => void;
  prefs?: { liteMode?, showImages? };
  locations?: { id, name }[];
  // 必要なら adminGraphql や inventoryAdjust の関数を渡す
}
```

ロジックはすべて `LossScreen`（および `loss/`）内に閉じ、Modal には**ロス固有の処理を書かない**。

---

## 5. 棚卸の実装イメージ

### 5.1 画面フロー

1. **棚卸ID入力** → ID スキャン/手入力 → 存在・状態チェック
2. **商品スキャン・実数入力** → グループ内商品の実数入力 → 「確定」で在庫調整
3. **棚卸完了** → 全件入力後「棚卸完了」で `inventory_counts` の該当 ID を `completed` に更新

こちらも `StocktakeScreen` 内で `'idInput' | 'productList' | 'complete'` のようなサブ画面を切り替える想定。

### 5.2 データ・API

- **商品グループ**: metafield `product_groups_v1`
- **棚卸ID**: metafield `inventory_counts_v1`
- **在庫調整**: `inventoryAdjustQuantity`（現在在庫と実数の差分）。
- 対象商品の取得は、商品グループ（コレクション等）に基づいて GraphQL で取得。

### 5.3 StocktakeScreen が受け取る props 例

ロスと同様、`onBack` / `appState` / `setAppState` / `setHeader` / `setFooter` / `prefs` / `locations` など。  
棚卸専用の読み書きはすべて `StocktakeScreen`（および `stocktake/`）内で行う。

---

## 6. 共有コードの扱い（Modal 容量削減のため）

出庫・入庫・ロス・棚卸で共通で使うものは、**Modal から `lib/` に切り出す**と、Modal の行数削減と再利用の両方がしやすい。

| 候補 | 説明 |
|------|------|
| `adminGraphql` | GraphQL 呼び出し・タイムアウト処理 |
| `inventoryAdjustQuantity` | 在庫調整 mutation のラッパー |
| `searchVariants` | 商品検索（ロス商品リストで利用可能） |
| metafield 読書 | `loss_entries_v1` / `inventory_counts_v1` / `product_groups_v1` など |
| ダイアログ | `useUnifiedDialog` やブロッキングアラート系 |

これらを `lib/graphql.js` ・ `lib/inventory.js` ・ `lib/storage.js` などに分け、  
**Modal と各 Screen の両方が `lib` を import する**形にすると、Modal は「呼び出すだけ」にでき、容量限界を迎えにくくなる。

---

## 7. 実装の進め方（容量限界をにらんだ場合）

1. **現状のまま実装**
   - `LossScreen.jsx` / `StocktakeScreen.jsx` に、コンディション〜リスト〜API をすべて実装。
   - Modal は `import` と `body` の切り替えのみ。ロス・棚卸の行数は Modal に足さない。

2. **ロス or 棚卸が 1 ファイルで大きくなったら**
   - `screens/loss/` や `screens/stocktake/` を作り、  
     `LossConditions` / `LossProductList` / `LossHistoryList` などに分割。
   - `LossScreen` は「ルート＋サブ画面切り替え」に専念する薄い層にする。

3. **Modal がまだ重い場合**
   - 上記 `lib/` への抽出を実施。
   - 余裕があれば、Outbound / Inbound も `screens/outbound/` ・ `screens/inbound/` に分割することを検討。

---

## 8. まとめ

- **ロス登録・棚卸の本実装は Modal に書かず、`screens/LossScreen` と `screens/StocktakeScreen`（およびその配下）に閉じる。**
- Modal は **エントリ・ナビ・ルーティング・共有 props の受け渡し** に専念し、ロス・棚卸の UI/API は一切持たない。
- 必要に応じて **`lib/` に GraphQL・在庫・metafield などの共通処理を抽出**し、Modal の肥大化を防ぐ。
- ロス・棚卸それぞれがさらに肥大化したら、`screens/loss/` ・ `screens/stocktake/` でサブコンポーネントに分割する。

この形にしておけば、**Modal の容量限界に達した場合でも、ロス・棚卸は `screens/` 以下の追加・修正だけで拡張できる**実装になります。
