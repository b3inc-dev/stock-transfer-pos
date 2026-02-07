# 64KB 超過後の容量削減オプション

ビルドは通るが「Your script size is 65 KB which exceeds the 64 KB limit」となった場合の、**この後の作業で容量が減る要素**と**今すぐできる対策**を整理しました。

---

## 残り TODO で減る要素

| 作業 | Modal.jsx から削除する行数目安 | バンドルへの影響 |
|------|--------------------------------|------------------|
| **ステップ4**: OutboundHistoryDetail を import に差し替え | **約 1,112 行**（2906〜4018 行付近） | 削除分だけ Modal が減る。OutboundHistoryDetail は既に OutboundHistoryScreens.jsx に入っているので、**バンドル全体は減る**。 |
| **ステップ5**: OutboundList を import に差し替え | **約 2,370 行**（4019〜6389 行付近） | Modal から大きく削除。OutboundListScreen.jsx は新たにバンドルに含まれるが、Modal の削減の方が大きいので、**トータルでは減る可能性が高い**。 |

→ **ステップ4・5を進めれば、容量は減る要素が大きい**（特にステップ4で約 1,100 行削減）。

---

## 今すぐできる対策（ステップ4・5の前に実施可能）

### 1. Modal.jsx の重複フックを modalHooks に寄せる（推奨）

**内容**: Modal.jsx 内の次の 4 つを削除し、`modalHooks.js` から import する。

- `useSessionLocationId`（約 40 行）
- `useOriginLocationGid`（約 18 行）
- `useLocationsIndex`（約 70 行）
- `getLocationName_`（約 5 行）

**効果**: Modal.jsx が **約 130 行減**。`modalHooks.js` は既にバンドルに含まれているので、**バンドル全体で約 130 行分（数 KB）減る**。65 KB → 64 KB 以下に収まる可能性あり。

### 2. strip-comments.mjs でコメント削除

**内容**: 既存の `strip-comments.mjs` を実行し、Modal.jsx のコメントを削除する。

**効果**: コメント分だけバイト数が減り、数 KB 削減できる場合がある。ビルド前の前処理として組み込む運用なら有効。

### 3. ステップ4を優先して実施

**内容**: OutboundHistoryDetail を import に差し替え、Modal.jsx から約 1,112 行削除する。

**効果**: 削減量が最も大きい。65 KB をかなり下回る可能性が高い。

---

## 実施順の目安

1. **まず「1. 重複フックを modalHooks に寄せる」**で 1 KB 前後削減し、64 KB を切れるか確認。
2. まだ超える場合は **「3. ステップ4」** を実施して OutboundHistoryDetail を差し替え、大きく削減。
3. 必要なら **「2. strip-comments」** をビルド前スクリプトに組み込む。
