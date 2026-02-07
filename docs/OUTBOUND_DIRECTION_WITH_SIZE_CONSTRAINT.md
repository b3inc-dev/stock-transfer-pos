# 出庫 複数シップメント：Modal.jsx サイズ制約を踏まえた方向性

**前提**: Modal.jsx がすでに大きすぎるため、これ以上追加するとビルドが失敗する（64KB 制限等）。  
この制約のうえで、`OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` の要件を満たす方向性を整理しました。

---

## 制約の整理

| 項目 | 内容 |
|------|------|
| **Modal.jsx** | 現状 13,330 行程度。これ以上**増やしてはいけない**。 |
| **ビルド** | 単一ファイルのサイズ制限（例: 64KB）等で、追加すると失敗する。 |
| **方針** | Modal.jsx には**新規ロジックを一切足さない**。可能なら**削って小さくする**。 |

---

## 方向性：Modal.jsx を「減らす」ことで要件を満たす

**「出庫まわりのコードを Modal.jsx から取り除き、別ファイルに寄せる」** ことで、

1. **Modal.jsx を小さくする**（ビルドを通す）
2. **要件は別ファイル側で満たす**（編集/追加モーダル、3モード、movementId、下書きルール、シップメント一覧など）

の両方を満たします。

---

## 具体的な進め方

### 原則

- **Modal.jsx**: 出庫の**実装**は持たない。出庫は「import したコンポーネントを表示するだけ」に限定する。
- **新規・変更ロジック**: すべて **OutboundHistoryScreens.jsx / OutboundListScreen.jsx**（と outboundShipmentApi.js）に書く。Modal.jsx には書かない。

### ステップ1: Modal.jsx から出庫ブロックを「削除」する

Modal.jsx には現在、次の 3 つの**大きなブロック**が含まれています（目安: 合計 3,800 行前後）。

| ブロック | おおよその行範囲 | 行数目安 |
|----------|------------------|----------|
| `OutboundHistoryConditions` | 2894 行付近〜 | 約 360 行 |
| `OutboundHistoryDetail` | 3256 行付近〜 | 約 1,110 行 |
| `OutboundList` | 4369 行付近〜 | 約 2,370 行 |

これらを **Modal.jsx から丸ごと削除**し、代わりに次のようにします。

- `OutboundHistoryConditions` と `OutboundHistoryDetail` は **OutboundHistoryScreens.jsx** から import
- `OutboundList` は **OutboundListScreen.jsx** から import
- 画面上の「どの画面を出すか」と「どの props を渡すか」だけを Modal.jsx に残す（数十行程度の差し替え）

結果として、Modal.jsx は **約 3,800 行減り、import と JSX の差し替えで数十行増える** ため、**トータルで約 3,700 行以上短く**なります。サイズ制約の緩和に直結します。

### ステップ2: 出庫用 state を Modal.jsx に「追加」ではなく「既存の 1 つ」にする

- 要件の `addingShipmentToTransferId` は、**既存の outbound 用 state に 1 プロパティ足すだけ**にする。
- 新しい画面や大きな state ツリーは増やさない。これ以上「出庫のロジック」を Modal.jsx に書かない、という意味で「追加」を最小限にします。

### ステップ3: 要件の実装はすべて「別ファイル」で行う

- **編集/追加モーダル**  
  → OutboundHistoryScreens.jsx にすでにあるので、そのまま利用。
- **3モード（新規・編集・シップメント追加）・movementId**  
  → OutboundListScreen.jsx（と outboundShipmentApi.js）で実装・調整。
- **下書き保存の表示ルール（DRAFT のときのみなど）**  
  → OutboundListScreen.jsx 内で分岐を追加。
- **編集時の「確定する」＝シップメント出庫確定**  
  → OutboundListScreen.jsx 内で API 呼び出しを追加。
- **シップメント一覧・選択・status 表示**  
  → OutboundHistoryScreens.jsx の OutboundHistoryDetail 内で実装。

Modal.jsx には、上記のいずれも**書かない**ようにします。

### ステップ4: OutboundHistoryScreens / OutboundListScreen を「そのまま使える形」にする

- **OutboundHistoryScreens.jsx**  
  - `OutboundHistoryConditions` と `OutboundHistoryDetail` を export。  
  - 共通モジュール（modalHelpers, modalHooks, modalUiParts, outboundShipmentApi）は `../` で参照するように import パスを修正。
- **OutboundListScreen.jsx**  
  - すでに export と `../outboundShipmentApi.js` 参照があるので、足りない要件（編集確定・下書き表示ルール）だけここに追加。
- **outboundShipmentApi.js**  
  - そのまま利用。

---

## まとめ図

```
【今】
Modal.jsx（13,330 行）
├ ルーティング・共通 UI など
├ OutboundHistoryConditions（約 360 行）  ← 削除対象
├ OutboundHistoryDetail（約 1,110 行）    ← 削除対象
├ OutboundList（約 2,370 行）             ← 削除対象
└ 入庫・その他
→ これ以上足すとビルド失敗

【この方向性でやったあと】
Modal.jsx（約 9,500 行）
├ ルーティング・共通 UI など
├ import OutboundHistoryConditions, OutboundHistoryDetail from "./screens/OutboundHistoryScreens.jsx"
├ import OutboundList from "./screens/OutboundListScreen.jsx"
├ 上記を表示するだけの JSX（既存の画面分岐＋props 渡し）
└ 入庫・その他
→ 出庫の「実装」は Modal に残らない

OutboundHistoryScreens.jsx
├ 編集/追加モーダル、履歴一覧、詳細
└ シップメント一覧・選択・status（ここに追加）

OutboundListScreen.jsx
├ 3モード、確定・下書き・配送準備完了
├ 編集時の確定＝シップメント出庫確定（ここに追加）
└ 下書き保存＝DRAFT のときのみ表示（ここに追加）

outboundShipmentApi.js
└ そのまま利用
```

---

## この方向性で満たせること

- **Modal.jsx を増やさず、むしろ減らす** → ビルド制約を守れる。
- **要件はすべて OutboundHistoryScreens / OutboundListScreen 側で実装** → `OUTBOUND_MULTI_SHIPMENT_BEHAVIOR.md` の要件を満たせる。
- **エントリは Modal.jsx のまま** → extension の設定やユーザー体験は変えない。
- **出庫の修正は出庫用ファイルだけ** → 保守しやすい。

「Modal.jsx にはこれ以上足さない」という前提のうえで、**出庫を Modal から切り出してサイズを減らし、要件は別ファイルで満たす**のが、現状の制約を踏まえた方向性です。
