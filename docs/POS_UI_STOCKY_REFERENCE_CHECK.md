# POS UI：Stocky参照の「タブUI」「リスト右側>」実装可否の確認

**目的**: 画像（Shopify公式アプリ Stocky の在庫転送画面）のような  
「処理中/受領済みの切り替えタブ」と「リスト右側の > マーク」が、  
当プロジェクトの POS UI 拡張で**実装可能か**を事前に確認する。

---

## 1. 画像で参照しているUI

| 項目 | 内容 |
|------|------|
| **タブUI** | 「処理中」「受領済み」の2つが横並びで、**どちらを選択しているかが視覚的にわかる**（選択中は背景が明るい・枠線あり）。**細い1本の領域で、全体に背景があり、選択中セグメントだけ色がついている**ような見た目。 |
| **リストの >** | 各リスト行の**右端に「>」マーク**があり、タップで詳細へ遷移することを示す。 |

---

## 2. 「細い領域・選択だけ色」と s-button の制限（公式情報）

### 2.0 結論（s-button の制限について）

**s-button を2つ並べる方式には、Stocky のような「細い1本の帯のうち選択中だけ背景色」を再現するうえで UI 制限がある、という認識で問題ありません。**

| 観点 | 内容 |
|------|------|
| **s-button の性質** | s-button は「1つ1つが独立したボタン」として描画される。2つ並べても「2つのボタンが横に並んだ」見た目になり、**1本の細い帯のなかで選択セグメントだけ色がつく**という Stocky の見た目にはならない。 |
| **公式の意図** | ボタンは「主操作」「副操作」などの**アクションの強さ**を表すためのコンポーネントであり、「タブ・セグメントの選択状態」を**1本の帯で表現する**用途向けではない。 |
| **どうするか** | 「細い領域＋選択だけ色」に近づけたい場合は、**s-tabs**（Polaris）または **SegmentedControl**（別 API）を使う方が、コンポーネントの目的としても公式の推奨にも沿う。 |

### 公式で「細い帯・選択中だけハイライト」に相当するコンポーネント

| コンポーネント | API 体系 | 公式の説明 | 当プロジェクトでの利用 |
|----------------|----------|------------|------------------------|
| **SegmentedControl** | **React/TS の POS API**（`@shopify/ui-extensions-react/point-of-sale` など） | 「horizontal row of segments」「**compact horizontal layout**」「**visual highlighting of the active segment**」「smooth transition animations」。2〜5セグメントの相互排他選択向け。`pos.home.modal.render` で利用可能。 | 当プロジェクトは **Polaris web components (s-*)** を使用。SegmentedControl は **別 API** のため、そのままでは使えない。使うには該当画面を React POS API で書き換えるか、別拡張で検討する必要がある。 |
| **s-tabs** | **Polaris web components (s-*)** | 「tab list にタブボタン＋対応する panel」。**選択中タブが視覚的に区別される**。`pos.home.modal.render` で利用可能。 | **入庫拡張でそのまま利用可能**。タブリストは「1本の帯＋選択中強調」に近い見た目になることが多い。Stocky に近づけるなら **s-tabs が Polaris での第一の選択肢**。 |
| **s-button 2つ** | Polaris (s-*) | 主操作/副操作の強調用。 | 現状の実装。「細い帯・選択だけ色」には**向いていない**（制限あり）。 |

- **Polaris (s-*) の一覧には SegmentedControl に相当する s-segmented-control はない**。レイアウト系で「選択状態を1本の帯で表現」するのは **Tabs** のみ。
- したがって、**今のスタック（Polaris + s-*）のまま** Stocky に近い見た目にするなら **s-tabs** を使うのが現実的。**SegmentedControl** は公式ドキュメント上は Stocky の見た目に最も近いが、**別の API 体系**なので、採用する場合は実装方式の検討が必要。

---

## 3. 「画像のような見え方」の実装手段はあるか

**結論: ある。**

| 要素 | 画像のような見え方に近づける手段 |
|------|----------------------------------|
| **タブ（処理中/受領済み）** | (1) **現状の s-button 2つ**（primary/secondary）で「どちらを選択しているか」はすでにわかる。(2) さらに見た目を近づけるなら **s-tabs**（`s-tab-list` + `s-tab` + `s-tab-panel`）が使える。Polaris web components の Tabs は `pos.home.modal.render` でサポートされており、タブバーで選択中が視覚的に区別される。 |
| **リスト右側の >** | 各行の右端に **s-text** で `"›"` や `"▸"` を置く。画像のような「行の右端に > がある」見た目になる。 |

- タブ: **s-button のまま**でも「選択中がわかる」見た目は実現済み。**s-tabs** にすると、Stocky に近い「タブで切り替え」の見た目にしやすい。
- リストの >: **s-text で記号を右端に置く**だけで、画像に近い見た目になる。専用の Chevron コンポーネントは不要。

### 3.1 現在「ボタン2つ並んでいるだけで色が変わらない」場合

**結論: 色・見た目で選択中を分かりやすくする方法はある。**

| 手段 | 内容 |
|------|------|
| **s-button のプロパティ** | 公式の Polaris web components（POS）では、ボタンの見た目は **`variant`**（`primary` / `secondary`）で指定する。現状のコードは **`kind`** を使っている。API バージョンによっては **`variant`** にすると primary/secondary の色差が出る場合がある。試す価値あり。 |
| **s-tabs に切り替える** | **s-tabs**（`s-tab-list` + `s-tab` + `s-tab-panel`）は「選択中タブ」を**コンポーネント側で視覚的に区別**するためのもの。Stocky のように「選択中が背景・色でわかる」見た目に近づけられる可能性が高い。`pos.home.modal.render` で利用可能。 |
| **s-button の tone** | s-button には **`tone`**（`neutral` / `caution` / `warning` / `critical`）もある。選択中だけ `tone` を変えると色で区別できるが、タブの「選択状態」には `variant` や s-tabs の方が適している。 |

- **s-button のまま色を出したい場合**: まず **`kind` → `variant`** に変えて、primary/secondary の差が出るか確認する。
- **Stocky のように「選択中がはっきりわかる」見た目にしたい場合**: **s-tabs** に切り替える方法が、コンポーネントの目的としても合っており、方法として確実。

---

## 4. 結論（実装前に確認した結果）

| UI | 方法はあるか | 現状 | 補足 |
|----|----------------|------|------|
| **タブ（処理中/受領済みの切り替え）** | **はい** | **既に同等の実装あり** | 入庫で「未入庫」「入庫済み」を `s-button` の primary/secondary で切り替え済み。より画像に近づけるなら s-tabs も利用可能。 |
| **リスト右側の > マーク** | **はい** | **現状はなし（追加実装で可能）** | POS に Chevron 専用コンポーネントはないが、`s-text` で "›" や "▸" を右端に置けば画像のような見た目にできる。 |

どちらも**実装方法はある**ため、画像のような見え方にしたい場合は追加実装で対応できます。

---

## 5. タブUI（処理中/受領済み）について

### 5.1 現状の実装

- **入庫**（`stock-transfer-inbound`）のコンディション画面で、**「未入庫」「入庫済み」**の2つのボタンで切り替えている。
- **ファイル**: `extensions/stock-transfer-inbound/src/Modal.jsx` のヘッダー部分（299–306行目付近）。
- **実装方法**:
  - 横並びの `s-button` を2つ配置。
  - 選択中: `kind="primary"`（背景が目立つ想定）。
  - 非選択: `kind="secondary"`。
  - `viewMode === "pending"` / `viewMode === "received"` でどちらが選択中か判定。
- **補足**: 公式の Polaris web components（POS）では **`variant`**（`primary` / `secondary`）がプロパティ名。`kind` のままではテーマによって色差が出ない場合がある。色を出したい場合は `variant` を試すか、**s-tabs** への切り替えを検討する。

```jsx
<s-button kind={viewMode === "pending" ? "primary" : "secondary"} onClick={() => setViewMode("pending")}>未入庫 {pendingTransfersAll.length}件</s-button>
<s-button kind={viewMode === "received" ? "primary" : "secondary"} onClick={() => setViewMode("received")}>入庫済み {receivedTransfersAll.length}件</s-button>
```

- 用語の対応:
  - Stocky「処理中」 ≒ 当プロジェクト「未入庫」
  - Stocky「受領済み」 ≒ 当プロジェクト「入庫済み」

### 5.2 方法の有無

- **方法はある。既に同じパターンで実装済み。**
- ラベルを「処理中」「受領済み」に変えたいだけなら、表示文言を変えるだけでよい。
- Shopify POS UI Extensions のドキュメントには **SegmentedControl**（セグメント切り替え）もあるが、当プロジェクトでは Polaris 系の `s-button` で同等の「どちらを選択しているかわかる」UIを実現している。

### 5.3 画像に近い見た目にする場合（s-tabs）

- **s-tabs**（`s-tab-list` + `s-tab` + `s-tab-panel`）を使うと、Stocky に近い「タブで切り替え・選択中がはっきりわかる」見た目にできる。
- `pos.home.modal.render` で Tabs はサポートされている（入庫拡張と同じターゲット）。
- 例: タブリストに「処理中」「受領済み」を並べ、それぞれの TabPanel に同じリストのフィルター結果を表示する、または TabPanel ごとに別内容を出してもよい。

```jsx
<s-tabs value={viewMode} onChange={(e) => setViewMode(e.currentTarget.value)}>
  <s-tab-list>
    <s-tab controls="pending">処理中 {pendingCount}件</s-tab>
    <s-tab controls="received">受領済み {receivedCount}件</s-tab>
  </s-tab-list>
  <s-tab-panel id="pending">{/* 処理中リスト */}</s-tab-panel>
  <s-tab-panel id="received">{/* 受領済みリスト */}</s-tab-panel>
</s-tabs>
```

- 「同じリストをフィルター切り替え」するだけなら、現状の 2 ボタン + 1 リストのままでも十分。見た目を画像に近づけたい場合に s-tabs を検討するとよい。

---

## 6. リスト右側の「>」マークについて

### 6.1 現状の実装

- **入庫リスト**（`Modal.jsx` のリスト行）:
  - シップメントが**2つ以上**のときだけ、行の右端に「**リスト**」という **s-button** がある（処理方法選択用）。
  - シップメントが**1つ**のときは、行全体が `s-clickable` で、右端にアイコンや「>」は**ない**。
- つまり、**「リストの右側に常に > マーク」**という Stocky のような見た目は、現状では**どこにもない**。

### 6.2 実装方法の有無

- **方法はある。**
- POS UI Extensions に「リスト行用の Chevron コンポーネント」はないが、次のように**既存の s-* だけで再現可能**です。
  1. 各行を `s-stack direction="inline"` で「本文」と「右端」に分ける（現在の「リスト」ボタンがあるレイアウトと同様）。
  2. 右端に `s-text` で **">" や "›" (U+203A) や "▸" (U+25B8)** を表示する。
  3. 行全体を `s-clickable` でラップするか、右端の `s-box` も `s-clickable` にして、タップで詳細画面へ遷移させる。

例（右端に「›」を置く場合）:

```jsx
<s-stack direction="inline" alignItems="center" justifyContent="space-between" style={{ width: "100%" }}>
  <s-clickable onClick={() => onTapTransfer(t)} style={{ flex: "1 1 0", minWidth: 0 }}>
    {/* 既存の行内容 */}
  </s-clickable>
  <s-box style={{ flexShrink: 0 }}>
    <s-text tone="subdued">›</s-text>
  </s-box>
</s-stack>
```

- シップメントが1つのときも2つ以上のときも、同じレイアウトで右端に「›」を出せば、Stocky に近い「リストの右側に > マーク」が実現できます。

---

## 7. REQUIREMENTS_FINAL.md との関係

- `REQUIREMENTS_FINAL.md` には、  
  「処理中/受領済みのタブ」や「リスト右側の >」を**明示的な要件**としては書かれていません。
- ただし、
  - **タブUI**は既に「未入庫/入庫済み」で同等の挙動・見た目が実装済み。
  - **リストの >**は、上記のとおり `s-text` 等で追加実装可能。

必要であれば、要件書に「Stocky 参照：タブの表記を処理中/受領済みに揃える」「リスト行右端に > を表示する」といった形で追記し、実装する流れで問題ありません。

---

## 8. 結論：同じ見え方の実装にするには

**現状のスタック（Polaris web components / s-*）のまま、Stocky と同じ見え方に近づけるには、次の2つを行う。**

| やること | 内容 |
|----------|------|
| **① タブを s-tabs に変える** | 「未入庫」「入庫済み」の **s-button 2つをやめ**、**s-tabs**（`s-tab-list` + `s-tab` + `s-tab-panel`）に切り替える。これで「細い1本の帯のうち、選択中タブだけ背景色がつく」見た目になる。 |
| **② リスト行の右端に「›」を出す** | 入庫IDリストの **全行** の右端に、**s-text** で `"›"`（または `"▸"`）を追加する。シップメント数で分岐せず、1行でも2行以上でも同じレイアウトで右端に表示する。 |

### 実装対象ファイル

- **入庫コンディション画面**: `extensions/stock-transfer-inbound/src/Modal.jsx`

### ① タブを s-tabs に変える手順（概要）

1. ヘッダー部分の「未入庫」「入庫済み」の **s-button 2つを削除**する。
2. 代わりに **s-tabs** を置く。
   - `value={viewMode}`（`"pending"` または `"received"`）
   - `onChange`（または `onChange` / `change` イベント）で `setViewMode(e.currentTarget.value)` を呼ぶ。
3. **s-tab-list** の子に **s-tab** を2つ。
   - 例: `<s-tab controls="pending">未入庫 {pendingTransfersAll.length}件</s-tab>`、`<s-tab controls="received">入庫済み {receivedTransfersAll.length}件</s-tab>`。
4. **s-tab-panel** を2つ（`id="pending"` と `id="received"`）。
   - 中身は **同じリスト**（`listToShow`）を表示するだけでよい。`viewMode` でフィルター済みなので、pending 用パネルと received 用パネルで同じリストコンポーネントをそれぞれ描画するか、1つのリストを両パネルで共有する形でよい。
5. 「読込」ボタンや「未読み込み一覧…」のブロックは、s-tabs の外（上または下）にそのまま配置する。

### ② リスト行の右端に「›」を出す手順（概要）

1. **シップメントが1つのとき**の行レイアウトを、**シップメントが2つ以上のとき**と同じ構成にする（左：内容、右：余白＋記号）。
2. 右端に **s-box**（`flexShrink: 0`）を置き、その中に **s-text** で `›` を表示する。
3. シップメントが2つ以上のときは、いまの「リスト」ボタンの左隣（または同じ右端エリア）に **s-text "›"** を追加する。ボタンと「›」の両方がある場合は、レイアウト（順序・余白）を調整する。

### まとめ（同じ見え方にするための結論）

| 質問 | 回答 |
|------|------|
| 同じ見え方の実装にできる？ | **できる。** ① タブを **s-tabs** に変える、② リスト行の右端に **s-text "›"** を追加する。 |
| どこを直す？ | 入庫コンディション画面の **Modal.jsx**（ヘッダーとリスト行）。 |
| s-button のままでは？ | 「細い帯・選択だけ色」にはならない。s-tabs に変える必要がある。 |

---

## 9. s-tabs が表示されなかった場合：s-button で選択中カラー・非選択グレーアウト

**s-tabs が表示されないため s-button を使う場合でも、「選択しているほうをカラー、選択されていない方をグレーアウト」に近づける調整はできる。**

### できること（公式のプロパティの範囲）

| 調整 | 方法 | 備考 |
|------|------|------|
| **選択中をカラー（目立たせる）** | 選択中ボタンに **`variant="primary"`** を付ける。 | 公式: "High visual emphasis for the most important action"。選択中＝主操作として強調される。 |
| **非選択をグレーアウト（控えめに）** | 非選択ボタンに **`variant="secondary"`** を付ける。 | 公式: "Less prominent appearance for supporting actions"。テーマによってグレーに近い見た目になる。 |
| **プロパティ名** | 公式の POS Polaris では **`variant`**（`primary` / `secondary`）。現状のコードは **`kind`** を使っている場合がある。 | **`kind` → `variant`** に変えると、primary/secondary の見た目の差が出る環境がある。まずはここを試す。 |
| **非選択をさらに控えめに** | 非選択側に **`tone="neutral"`** を付けてみる。 | 公式: tone は `auto` / `neutral` / `caution` / `warning` / `critical`。`neutral` で標準トーン。差が出るかは環境次第。 |

### やってはいけないこと

- **非選択側を `disabled={true}` にしない**。disabled にすると**クリックできなく**なり、タブ切り替えができなくなる。

### 実装例（s-button で選択中＝primary・非選択＝secondary）

```jsx
{/* 選択中 = variant="primary"（カラー）、非選択 = variant="secondary"（控えめ・グレーに近い） */}
<s-button variant={viewMode === "pending" ? "primary" : "secondary"} onClick={() => setViewMode("pending")}>
  未入庫 {pendingTransfersAll.length}件
</s-button>
<s-button variant={viewMode === "received" ? "primary" : "secondary"} onClick={() => setViewMode("received")}>
  入庫済み {receivedTransfersAll.length}件
</s-button>
```

- もともと `kind` を使っている場合は、**`variant`** に変更して動作・見た目を確認する。
- まだ差が足りない場合は、非選択側に **`tone="neutral"`** を追加して試す。

### それ以上の調整（背景色・透明度を自分で指定）について

- s-button は Polaris のデザインシステムに従うため、**背景色や透明度をインライン style で上書きできるかは公式に記載がない**。Shadow DOM を使っている場合は外からは効かないことがある。
- 必要なら **`style={{ ... }}`** を s-button に付けて試す価値はあるが、効かない環境では **variant + tone の組み合わせ**が調整の上限になる。

### まとめ（s-button で選択中カラー・非選択グレーアウト）

| 質問 | 回答 |
|------|------|
| 選択中をカラー、非選択をグレーアウトできる？ | **できる（公式の範囲で）。** 選択中 = **variant="primary"**、非選択 = **variant="secondary"**。プロパティは **variant**（`kind` ではなく）。 |
| まず何を変える？ | タブ用の s-button の **`kind` を `variant` に変更**し、primary/secondary の差が出るか確認する。 |
| さらに控えめにしたいときは？ | 非選択側に **tone="neutral"** を付けてみる。 |
| disabled は？ | 非選択側に **使わない**（クリックできなくなる）。 |

### primary の色（ブルーになるか）

- **variant="primary"** の色は、Polaris の**ブランド色（design token）**で決まる。固定の「青」や「緑」ではなく、**環境・テーマ・POS の設定**によって変わる。
- **POS では primary が青で表示される**ことがある（実機で青になった場合はその環境のデフォルト）。Shopify の管理画面などでは緑（Shopify green）が使われることも多い。
- アプリ側で primary の色を「青で固定」する公式プロパティはない。**青で出ているなら、その POS 環境の primary のデフォルトが青**と考えてよい。

このドキュメントは、実装前に「方法があるか」を確認した結果と、「同じ見え方」にするための結論・手順を残すためのものです。
