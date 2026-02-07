# 仕入・発注 修正メモ（2026-02）

## 1. 仕入のキャンセル確認モーダルが表示されない要因と対応

### 要因（想定）

- **スタッキングコンテキスト**: 管理画面が iframe やアプリのルートで新しいスタッキングコンテキストを持っている場合、商品リストモーダル（z-index: 1000）と確認モーダル（z-index: 2000）が同じコンテキスト内でも、親要素の `overflow` や `isolation` の影響で確認モーダルがクリップされたり背面に回ることがある。
- **イベントの伝播**: 「キャンセルする」クリックが親の `onClick={closeItemsModal}` に伝播し、先に商品リストモーダルが閉じてから確認モーダルが開く動きになり、一瞬で消えたように見える可能性。
- **レンダー順**: 確認モーダルが商品リストモーダルと兄弟で、かつ後からレンダーされていても、テーマや Shopify Admin のスタイルで上に描画されない場合がある。

### 補足：OKを押す前にキャンセル処理が進む不具合（2026-02 対応）

**要因**  
- **ダブルクリック**: 「キャンセルする」を素早く2回押すと、1回目で確認モーダルが開き、2回目のクリックがモーダル表示後の「OK」の位置に当たり、OK が押されたとみなされて `confirmCallback()` が実行され、その中で `fetcher.submit` が走っていた。  
- **コールバック内で submit**: `setConfirmCallback(() => { fetcher.submit(...); ... })` のように submit をコールバックに閉じ込めていたため、そのコールバックが意図しないタイミングで呼ばれると、OK を押していなくてもキャンセルが送信されていた。

**対応**  
- キャンセル対象の `entryId` を **ref**（`pendingCancelEntryIdRef`）で保持するように変更。  
- **submit は「OK」ボタンの onClick 専用ハンドラ（`handleConfirmOk`）内でのみ実行**する。  
  - 「OK」クリック時: ref から entryId を読み、FormData を組み立てて `fetcher.submit` し、その後 `confirmCallback()` でモーダルを閉じる。  
  - コールバック側では submit を行わず、モーダルを閉じる処理と ref のクリアのみ行う。  
- オーバーレイや「キャンセル」ボタンでモーダルを閉じるときも ref をクリアする。

これにより、**OK を押したときだけ**キャンセルが送信されるようになった。

### 補足2：OKを押してもキャンセルできない（OKが押せない）不具合（2026-02 対応）

**要因**  
- **createPortal で document.body に描画した Portal 内では、ref（pendingCancelEntryIdRef）が期待どおり参照されない場合がある**。とくに Shopify Admin の iframe や React のコミット順の関係で、Portal 内の OK ボタンがクリックされた時点で ref.current が null のままだったり、ref を読むタイミングで古い値になっている可能性がある。  
- その結果、handleConfirmOk 内で `pendingCancelEntryIdRef.current` が null となり、submit がスキップされ、confirmCallback() だけが実行されてモーダルが閉じる。ユーザーからは「OKを押したのにキャンセルされない」「OKが押せない」と見える。

**対応**  
- キャンセル対象の ID を **ref ではなく state（pendingCancelEntryId）で保持**するように変更。  
- OK クリック時は、**その時点の state の値**を使って submit する。Portal 内でも、同じコンポーネントの state は必ずそのレンダーで確定しているため、OK の onClick から正しく entryId を参照できる。

### 補足3：OK ボタンが押せない（Portal 廃止）（2026-02 対応）

**要因**  
- **createPortal で document.body に描画した Portal 内では、Shopify Admin の iframe やアプリのイベント伝播の都合で、OK ボタンのクリックが React に届かない**ことがある。Portal 先の DOM がメインの React ツリーと別扱いになり、イベントが正しく紐づかない・親のオーバーレイに吸収されるなどの可能性がある。  
- その結果、OK を押しても handleConfirmOk が実行されず、キャンセル処理が動かない。

**対応**  
- **Portal（createPortal）をやめ、確認モーダルを通常の JSX として同じツリー内に描画**するように変更。商品リストモーダル（z-index: 1000）の後ろに、確認モーダル（z-index: 10000）を置き、同一 DOM/React ツリーで表示。  
- OK ボタンの onClick で `e.preventDefault()` と `e.stopPropagation()` を実行し、クリックがオーバーレイに伝播してモーダルが閉じないようにする。  
- オーバーレイ・内側の白枠・両ボタンに `pointerEvents: "auto"` を指定し、クリックが確実にボタンに届くようにする。

### 補足4：OK がまだ押せない場合の確実な対応（2026-02 対応）

**要因の整理**  
- 確認モーダルと商品リストモーダルが**両方とも表示された状態**で、z-index で上に出しているつもりでも、**Shopify 管理画面の iframe やカスタム要素（s-page 等）のスタッキングコンテキストの影響**で、実際には商品リスト側が前面にあったり、クリックが商品リストのオーバーレイに取られて「閉じる」扱いになることがある。  
- その結果、OK を押しても反応がない・キャンセル処理が動かない。

**確実に動かすための対応**  
1. **確認モーダルを開くときに、商品リストモーダルをいったん閉じる**  
   - 「キャンセルする」クリック時に `setModalOpen(false)` などで商品リストモーダルを非表示にし、**確認モーダルだけが表示された状態**にする。  
   - これで「上に別モーダルが重なって OK が押せない」状況を防ぐ。  
2. **OK を form の submit で送る**  
   - 確認モーダルの内側を `<form onSubmit={handleConfirmOk}>` で囲み、OK ボタンを `type="submit"` にする。  
   - クリック時は form の `onSubmit` が必ず呼ばれるので、React の onClick が届きにくい環境でも送信処理が走る。  
   - あわせて Enter キーでも送信できる。

---

### 対応内容（モーダルが表示されない件）

1. **createPortal で document.body に描画**  
   確認モーダルを `createPortal(モーダルJSX, document.body)` で body 直下に描画。iframe 内ならその document.body になるため、アプリ内のスタッキングコンテキストの影響を受けにくくする。
2. **z-index を最大に**  
   Portal 側のオーバーレイに `zIndex: 2147483647` を指定し、他の UI より前面に表示されるようにした。
3. **setTimeout(0) で表示**  
   `setConfirmModalOpen(true)` を `setTimeout(() => setConfirmModalOpen(true), 0)` で実行。同じティックで動く親のクリックハンドラの影響を避ける。
4. **type="button" と stopPropagation**  
   「キャンセルする」「キャンセル」「OK」に `type="button"` を付け、必要に応じて `stopPropagation` で伝播を止めている。

---

## 2. 発注→仕入の名称引き継ぎ

- **仕様**: 発注から「仕入に反映」した場合は、発注の表示名（orderName。例: #P0001）をそのまま仕入の purchaseName に使う。
- **同一発注から複数回「仕入に反映」**: 2回目以降は `#P0001-1`, `#P0001-2` のようにサフィックスを付与し、名称の重複を防ぐ。
- **orderName が無い場合**: 従来どおり #P0000 系の連番（既存仕入の #P 最大値+1）をフォールバックとして使用。
- **POS から新規立ち上げ**: 将来の stock-transfer-purchase 拡張では #B0000, #B0001 の連番を使う想定（発注由来とは別採番）。

---

## 3. 発注でキャンセル（承認取り消し）した発注の JAN・オプションが抽出できない要因と対応

### 要因

- 発注の商品リスト（items）は metafield に保存されているが、**POS や過去の保存時に barcode / option1〜3 が含まれていない**、または **承認取り消し後は items を参照するが、その items に barcode/options が入っていない** ケースがある。
- loadItems では `entry.items` をそのまま返しており、欠けている barcode/options を API から補う処理がなかった。

### 対応内容

- **発注（app.order.tsx）**: loadItems 時に ProductVariant の GraphQL で `barcode` と `selectedOptions { name value }` を取得。各 item の variantId に対応する variant の barcode と selectedOptions を option1/2/3 にマッピングし、**既存の item に無い場合だけ** 上書き。必要なら原価・販売価格の更新と同様に、更新があった場合は metafield の items を上書き保存。
- **仕入（app.purchase.tsx）**: loadItems 時に同様に ProductVariant の `barcode` と `selectedOptions` を取得し、items に無い barcode/option1/2/3 を補完してから返す。仕入は保存は行わず、表示・CSV 用の返却のみ補完。

これにより、承認取り消し後や保存データに JAN・オプションが無い場合でも、モーダル表示と CSV で JAN・オプションが表示される。
