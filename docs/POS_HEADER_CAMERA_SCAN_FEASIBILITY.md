# POS：タイルモーダル上部のカメラスキャン設置・実装可否

**目的**: 画像（Stocky の在庫転送画面）のように、タイルモーダルの上部（×ボタン付近）に「カメラスキャン」を設置し、カメラでバーコードを読んで表示中の画面に反映できるかを確認する。

---

## 1. 結論（実装可否）

| 質問 | 回答 | 補足 |
|------|------|------|
| **×と同じ1本のタイトルバー内**に「カメラスキャン」を置けるか | **可能** | **s-page**（POS Polaris Page）の **`secondary-actions`** スロットで、**アクションバー（タイトルバー）にボタン1つ**を表示できる。公式: "Button element to display in the **action bar**. Only a single button is supported." 出庫・入庫・ロス・棚卸の全タイルで実装済み。 |
| 表示画面のスキャン対象に反映できるか | **可能（既存実装で対応済み）** | Scanner API の subscribe で受信したデータをキューに積み、現在の画面（出庫コンディション・商品リスト・入庫・ロス・棚卸）に応じて処理している。カメラ由来のスキャンも同じ API で届く。 |
| カメラスキャンをバーコードで実装できるか | **可能** | ① ハード／端末のカメラUIで読んだデータは Scanner API 経由で同じ subscribe に流れる。② 拡張内でカメラUIを出したい場合は **CameraScanner**（React POS API）の利用を検討（当プロジェクトは Preact + Polaris のため、該当画面だけ React 化するか、サブ画面を React で追加する必要あり）。 |

---

## 2. ×と同じタイトルバー内にボタンを置く方法（公式API）

### 2.1 s-page の secondary-actions スロット

- **POS Polaris の Page コンポーネント**（`s-page`）には、**アクションバー（タイトル・見出しと同一バー）** にボタンを1つ表示する **`secondary-actions`** スロットがある。
- 公式ドキュメント（[Page - POS UI Extensions](https://shopify.dev/docs/api/pos-ui-extensions/latest/polaris-web-components/structure/page)）:
  - **Slots** → **secondary-actions**: "Button element to display in the **action bar**. Only a single button is supported."
  - つまり **×（閉じる）と同じ1本のバー内** に、拡張から「スキャンする」などのボタンを配置可能。
- 実装例（出庫・入庫・ロス・棚卸の全タイルで採用済み）:
  ```jsx
  <s-page heading="出庫">
    <s-button slot="secondary-actions" kind="secondary" onClick={() => toast("バーコードをスキャンしてください")}>
      カメラスキャン
    </s-button>
    <s-stack>...</s-stack>
  </s-page>
  ```
- **制限**: 1画面あたり **1ボタンのみ**。複数アクションをタイトルバーに並べたい場合は、どれか1つを選ぶか、それ以外はコンテンツ側のヘッダー（setHeader）に配置する。

### 2.2 コンテンツ最上部のヘッダー行（補足）

- タイトルバー以外に、**コンテンツ最上部**のヘッダー（`setHeader` で出している「在庫更新」「配送情報」など）にも「スキャンする」を追加する方法がある。タイトルバーは1ボタンだけなので、追加の導線が必要ならこちらを利用する。

---

## 3. 表示画面のスキャン対象への反映

- 既に **Scanner API**（`SHOPIFY?.scanner?.scannerData?.current?.subscribe`）でスキャンイベントを購読している。
- 公式仕様では、スキャン元は **`camera` / `external` / `embedded`** のいずれかで、**カメラで読んだバーコードも同じ subscribe に `data` として届く**。
- 受信した値はキューに積み、現在の画面に応じて:
  - 出庫コンディション／商品リスト → 商品追加・数量更新
  - 入庫リスト → 入庫数反映
  - ロス・棚卸 → 各リストに反映
- したがって **「表示画面のスキャン対象に同様に反映」は、追加実装なしでカメラ由来のデータにも対応可能**（既存の subscribe とキュー処理のまま）。

---

## 4. カメラスキャンをバーコードで実装する方法

### 4.1 端末・POS 側のカメラUIを利用する場合

- 端末や POS が「スキャンする」などでカメラを起動し、読んだバーコードを Scanner API で渡す仕組みであれば、拡張は **既存の subscribe のまま** 受け取れる。
- バーコードは `result.data` で string として取得でき、既存の JAN/SKU 検索・商品追加ロジックにそのまま流せる。

### 4.2 拡張内でカメラUI（CameraScanner）を出す場合

- Shopify は **CameraScanner** コンポーネントを提供している（`pos.home.modal.render` 対応）。
- **CameraScanner** は **React POS API**（`@shopify/ui-extensions-react/point-of-sale`）のコンポーネント。
- 当プロジェクトは **Preact + Polaris (s-*)** のため、**CameraScanner をそのまま使うには**:
  - スキャン用のサブ画面だけ React で書き、スキャン結果を Scanner API または callback で既存のキュー処理に渡す、または
  - 「スキャンする」押下で CameraScanner を表示する別エントリ（React）を用意し、結果をストレージ／API で Preact 側に渡す
- いずれにせよ、**スキャン結果はバーコード文字列として扱え、既存の「表示画面のスキャン対象に反映」と同じフローに載せられる**。

---

## 5. まとめ

| 項目 | 可否 | 対応方針 |
|------|------|----------|
| **×と同じタイトルバー内**にスキャンボタンを置く | ✅ 可能（公式API） | **s-page** の **slot="secondary-actions"** でアクションバーにボタン1つ表示。出庫タイル（ModalOutbound.jsx）で実装済み。 |
| モーダル上部（コンテンツ側）にスキャン導線を追加 | ✅ 可能 | 既存のヘッダー行（setHeader）に「スキャンする」を追加する方法もある。 |
| 表示画面のスキャン対象に反映 | ✅ 可能（既存で対応） | Scanner API subscribe ＋ キュー処理のまま。カメラ由来も同じ data で受信。 |
| カメラスキャンをバーコードで実装 | ✅ 可能 | 端末のカメラUIなら subscribe のみ。拡張内でカメラUIを出す場合は CameraScanner（React）の検討。 |

出庫・出庫・入庫・ロス・棚卸の全タイルで **s-page** の **slot="secondary-actions"** に「カメラスキャン」ボタンを実装済み。Stocky と同様のタイトルバー内スキャン導線を実現している。

**カメラを閉じる想定・連続スキャン（2026-02）**: カメラ表示中はタイトルバーの同じスロットを **「カメラを閉じる」** に切り替え、タップで `hideCameraScanner()` を呼ぶ。これによりモーダルを閉じずにカメラだけ終了できる。**連続スキャン**は、カメラを開いたまま複数回スキャンし、終了したいときだけ「カメラを閉じる」をタップする運用を想定している（スキャンごとにカメラを閉じない）。

**カメラの表示領域を指定できるか（2026-02）**:  
- **`showCameraScanner()`（現在の実装）**: **指定できない**。API は `() => void` で引数がなく、表示領域・レイアウトはすべてホスト（POS アプリ）側で決まる。  
- **CameraScanner コンポーネント**（React POS API）を使う場合: 画面レイアウト内にコンポーネントを配置するため、**そのコンポーネントを囲む領域（例: 上半分にカメラ、下半分にリスト）で表示範囲を実質コントロールできる**。公式ベストプラクティスにも「カメラを画面の一部に、残りを他コンポーネントに」とある。ただし当プロジェクトは Polaris (s-*) + Preact のため、表示領域を制御したい場合は該当画面を React POS API（Screen / Stack / CameraScanner）で書き換える必要がある。

---

## 6. カメラが起動しない場合の要因と対応（2026-02 追記）

**要因**: 当初はボタンタップでトーストのみ表示しており、**カメラを起動する API を呼んでいなかった**。Scanner API には **`showCameraScanner()`**（カメラスキャンUIを表示）と **`hideCameraScanner()`**（非表示）が用意されている。

**対応**: 「カメラスキャン」ボタンの `onClick` で **`shopify.scanner.showCameraScanner()`** を呼ぶように変更。API が利用できない端末では従来どおりトースト「バーコードをスキャンしてください」を表示するフォールバックを残している。

**トーストのみ表示される要因（2026-02 追記）**:

1. **API バージョン**: `showCameraScanner()` は **2026-01 で追加**。2025-10 には存在しないため、api_version を 2026-01 に変更済み。
2. **API の参照先**: POS では **ホストが拡張を呼ぶときに渡す第2引数 `api`** に `scanner.showCameraScanner` が含まれる。**`globalThis.shopify` は未設定または別の形のことがあり**、渡された `api` を使わないと showCameraScanner が参照できずトーストのみになる。  
   → **対応**: 全拡張でエントリを `(rootArg, apiArg) => { ... }` とし、`apiArg` をモジュール変数（出庫は `posModalApi`、他は既存の `posModalApi`）に保存。「カメラスキャン」タップ時は **`(posModalApi ?? SHOPIFY)?.scanner?.showCameraScanner?.()`** で、渡された api を優先して呼ぶように変更した。
