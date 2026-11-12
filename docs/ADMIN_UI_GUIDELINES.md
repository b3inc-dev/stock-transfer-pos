# 管理画面UIの実装指針（POS Stock基準）

Shopify埋め込み管理画面の文字・色・余白・操作は、既存のホーム・設定・入出庫履歴に揃える。業務ごとの項目順、一覧の密度、絞り込み、詳細やプレビューの位置は画面側で調整してよい。新しい画面は、ここに書いた部品を再利用し、同じ見た目をその場で書き直さない。

基準にした実装（`main` の `94ada87`）:

| 役割 | ファイル |
|------|----------|
| 文字（Inter の読み込み） | `app/root.tsx` |
| ナビの選択強調 | `app/components/AppNavBar.tsx` |
| ホームの白カードと主操作 | `app/routes/app._index.tsx` |
| 設定のタブ、入力、保存、エラー | `app/routes/app.settings.tsx` |
| 履歴の白カード、絞り込み、明細表 | `app/routes/app.history.tsx` |

トークンは `app/components/adminUi.ts`、クラスは `app/admin-ui.css`、繰り返し部品は `app/components/AdminChrome.tsx`。

## 文字

- `app/root.tsx` が Shopify の Inter スタイルシートを読み込む。本文の指定は `Inter` のあと、`-apple-system`、`BlinkMacSystemFont`、`Segoe UI`、`Hiragino Sans`、`Hiragino Kaku Gothic ProN`、`Yu Gothic UI`、`Yu Gothic`、`Meiryo`、`sans-serif`。日本語の字形は Inter に無いので、この順のシステムフォントへ落ちる。
- 文書言語は `ja`。本文とナビは 14px、行間 1.4、文字色 `#202223`。
- ページ見出しは各画面の `<s-page heading="...">` を使う。見出しを別の `h1` で重ねない。
- カード内の節見出しは `.admin-section-label`（14px、太さ 600、`#6d7175`）。補足は `.admin-subdued` か `<s-text color="subdued">`。
- 数値の強調（プラン名、ロケーション数）は `.admin-emphasis`（18px、太さ 700）。料金プランのセクション見出しは既存どおり 18px まで使ってよい。

## 色と余白

| 用途 | 値 | クラス |
|------|----|--------|
| 本文 | `#202223` | `body` |
| 補足 | `#6d7175` | `.admin-subdued` |
| 選択中ナビ・主操作・選択枠 | `#2c6ecb` | `.admin-nav-link.is-active`、`.admin-primary`、`.admin-choice[aria-checked="true"]` |
| 選択行の背景 | `#eff6ff` | 同上 |
| ナビ背景 / 区切り | `#f6f6f7` / `#e1e3e5` | `.admin-nav` |
| ホーム・プランの白カード | 白、角 8px、薄い影 | `.admin-elevated-card` |
| 設定・履歴の作業カード | 白、角 12px、1px の枠 | `.admin-outline-card` |
| 警告 | 背景 `#fff4e5`、枠 `#e0b252` | `.admin-notice--warning` |
| 成功の補足 | 背景 `#e3f1df`、左線 `#008060` | `.admin-notice--success` |
| 重大 | `#d72c0d` | `<s-text tone="critical">`、`.admin-notice--critical` |

画面の左右余白は 16px を目安にする。カード同士の間隔は 16px。ナビは左右 20px、上下 12px、項目間隔は横 16px、狭い幅では折返す。

## 再利用する部品

| 用途 | 使うもの | 使わないもの |
|------|----------|----------------|
| ページ見出し | `<s-page heading>` | 画面ごとの独自 `h1` |
| 節見出し・補足 | `.admin-section-label`、`.admin-subdued`、`<s-text color="subdued">` | 別のグレーや別のサイズ |
| 選択中ナビ | `AppNavBar` の `.admin-nav-link.is-active`（色 `#2c6ecb`、太さ 600、`aria-current="page"`） | 下線だけの別表現 |
| 白カード | `.admin-elevated-card`（案内・プラン）か `.admin-outline-card`（作業・一覧） | 画面ごとに影や角を変えた複製 |
| 主操作 | `.admin-primary`（保存、設定を開く、プランを選択、CSV出力） | `#007bff` や `#2563eb` の別ボタン |
| 副操作 | `.admin-secondary`（破棄、閉じる、戻る） | 塗りつぶしのグレーボタン |
| 文字リンク | `.admin-text-link` | 別の青 |
| 絞り込み・並べ替え | `AdminChoiceRow` | `div` の `onClick` だけ |
| ページ内タブ | `.admin-tab` と `role="tab"` / `aria-selected` | ナビと同じ青の選択 |
| 入力 | 設定画面と同じ `<s-text-field>`。ラベルはコンポーネントの `label` | 素の `input` を画面ごとに装飾 |
| フィールドエラー | `<s-text tone="critical">` | 赤の独自バナーを項目ごとに増やす |
| ページの警告・読み込み失敗 | `AdminNotice` | 別の黄背景 |
| 保存 | `AdminSaveBar`（状態文、破棄、保存） | 画面下に別の固定バー |
| 数量の比較表 | `.admin-qty-table` と `.admin-qty-num` | 1商品ずつ縦に積むだけの明細 |

ページ内タブの選択は、アプリナビと違い背景 `#e5e7eb` と太さ 600 のままにする。設定画面の既存の区別を保つ。

## 在庫明細の密度

数量の比較と差異確認に使う表は、セル余白 8px、文字 14px を維持する。これより行を高くしない。

- 数量列は右寄せ、`tabular-nums`、折り返さない（`.admin-qty-num`）。
- 商品名・SKU・JAN・オプションは折り返す。見切れで隠さない。
- 表が画面幅を超えるときは `.admin-qty-scroll` で表だけ横に送る。ページ全体は横に広げない。
- 予定数と入庫数は隣り合う列のままにする。履歴モーダルの配送単位の塊（未入庫・入庫済み・予定外）も残す。

入出庫履歴の詳細（`app.history.$id.tsx`）は、1行に商品名と数量が離れていた積み上げを、この表に合わせた。行の高さはモーダルの明細と同じ 8px である。

## 画面ごとに変えてよいこと

- 項目の並び（ホームの導入順、設定タブの中身、履歴のフィルター順）
- 一覧の列と、フィルターを左に置くか上に置くか
- 詳細・プレビューをモーダルにするか別ルートにするか
- 公開版とカスタム版で出す項目（下の配布別表示）

変えても、主操作・副操作・カード・エラー・保存の部品は共通のままにする。

## キーボードと見切れ

- ナビ、タブ、主操作、副操作、`AdminChoiceRow`、履歴行は Tab で到達し、Enter または Space で実行する。フォーカスは 2px の `#2c6ecb`。
- 履歴の商品リストは `role="dialog"`。Escape と「閉じる」で閉じる。
- 長い店舗名・履歴名・商品名は折り返す。数量と日付だけ1行のままにする。
- 狭い幅ではナビと設定タブを折り返し、ホームは要約カードを上、手順を下にする（768px 未満）。保存バーはボタンが折り返せる。

## 権限と配布

表示の分岐は `app/routes/app.tsx` の `ShopPlan` がすでに持っている。UI 部品の中でプランを再判定しない。

| 条件 | 表示 |
|------|------|
| `distribution === "inhouse"` または開発ストア | 全機能。料金プランの選択手順は出さない。カスタムは「全機能をご利用いただけます」 |
| `distribution === "public"` | ナビ末尾に料金プラン。未契約・Lite・Pro でホームの手順と機能リンクを変える |
| `features.*` が false | その業務のナビ項目を出さない |
| `locationPlanMismatch` | 警告を出し、設定・在庫・入出庫などの利用を止める案内を出す |

## 今回の画面と、触っていない画面

今回の作業ブランチで部品を接続した画面:

- 文字と本文: `app/root.tsx`
- ナビ: `app/components/AppNavBar.tsx`
- ホーム: `app/routes/app._index.tsx`
- 設定: 読み込み失敗、タブ、表示ロケーションの選択、保存バー
- 入出庫履歴: 絞り込み、並べ替え、一覧の折り返し、明細表、モーダルの主操作・副操作
- 履歴詳細: 数量比較の表
- 料金プランと、ロケーション不一致の警告

調整した点:

- 設定と履歴の選択枠を `#2563eb` から、ナビと保存と同じ `#2c6ecb` にした。
- ホームの主操作の太さを、保存ボタンと同じ 600 にした。
- 履歴モーダルの CSV を主操作、閉じるを副操作にした。Bootstrap 由来の `#007bff` / `#6c757d` は使わない。
- 履歴一覧の名称・店舗名は、1行で省略せず折り返す。

進行中の機能修正とファイルが重なるため、次の画面のマークアップは変更していない。見た目の差分（選択色 `#2563eb`、主操作の別色、明細の余白）が残っている。機能側の PR をマージしたあと、この指針の部品へ寄せる。このブランチへそれらの機能修正を混ぜない。

| 画面 | ファイル | 開いている PR |
|------|----------|----------------|
| 仕入 | `app/routes/app.purchase.tsx` | #13、#15 |
| 発注 | `app/routes/app.order.tsx` | #15 |
| ロス | `app/routes/app.loss.tsx` | #15 |
| 調整 | `app/routes/app.adjustment.tsx` | #15 |
| 在庫情報 | `app/routes/app.inventory-info.tsx` | #15 |
| 棚卸 | `app/routes/app.inventory-count.tsx` | #15、#18、#19、#40 |
