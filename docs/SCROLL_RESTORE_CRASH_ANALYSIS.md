# モーダル閉じ後の拡張機能クラッシュ要因分析

**現象**: 数量入力モーダルで入力して閉じた後、「拡張機能を読み込む際に問題が発生しました」エラーが発生

**発生日時**: スクロール復元機能（useScrollRestore）追加後

---

## 1. POS UI の制限・前提（公式情報）

| 項目 | 内容 |
|------|------|
| **コンポーネント** | Polaris web components (s-*) を使用。直接 DOM 操作は公式の想定外 |
| **スクロール** | ScrollView は**コールバック**でスクロール位置を管理。`scrollTop` の直接代入は非推奨 |
| **サンドボックス** | 拡張は iframe 等の分離環境で実行。未処理の例外で拡張がアンロードされる |
| **メモリ** | デバイスメモリ上限に近づくと DevTools が自動で一時停止する |

---

## 2. 想定される要因（useScrollRestore）

### 2.1 requestAnimationFrame 内での DOM 操作

```javascript
requestAnimationFrame(() => { el.scrollTop = top; });
```

- **タイミング**: モーダル閉じ時に `hide` イベント → `restore()` → rAF で `scrollTop` を設定
- **問題**: rAF 実行時点で `el` が DOM から外れている、または `s-scroll-box` の内部状態が遷移中
- **結果**: `scrollTop` の代入で例外 → 拡張クラッシュ

### 2.2 getScrollEl での不正な要素参照

- `box.shadowRoot?.querySelector` や `box.scrollHeight` へのアクセス
- モーダル閉鎖・再レンダリング中に、`s-scroll-box` や内部ノードが一時的に不正な状態になる可能性
- その状態でプロパティ参照すると例外が発生しうる

### 2.3 イベントリスナーのタイミング

- `document` に `hide` / `focusin` を登録
- モーダル閉じ時に POS 側のフォーカス移動や DOM 更新と競合
- 競合によって不正な参照や操作が行われ、クラッシュにつながる可能性

---

## 3. 対応方針

### 方針A: スクロール復元を削除（推奨）

- クラッシュ防止を最優先する場合の選択肢
- POS UI では公式に提供されていない DOM 直接操作であり、運用リスクを避けられる

### 方針B: 防御的実装に変更

- `save` / `restore` / `getScrollEl` 全体を try-catch で囲む
- rAF 内で `el.isConnected` を確認し、接続されていない場合は何もしない
- `el` の null/undefined チェックを強化
- モーダル完全クローズ後に復元するため、`setTimeout` で短時間遅延させる（例: 100ms）

---

## 4. 参照

- [POS UI Extensions - Troubleshooting](https://shopify.dev/docs/api/pos-ui-extensions/2025-04/troubleshooting)
- [POS UI Extensions - Debugging](https://shopify.dev/docs/api/pos-ui-extensions/2025-04/debugging)
- ScrollView: スクロール位置はコンポーネントのコールバックで管理する想定
