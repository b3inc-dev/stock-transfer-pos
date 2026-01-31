# 入庫「処理中（予定超過）」が入庫済みに振り分けられる現象の要因分析

## 1. 現象の整理

- **アプリ**: 入庫処理を実施し確定後、もともと「状態: 処理中（予定超過）」だった入庫IDが**入庫済み**タブに振り分けられている。
- **管理画面**: 同じTransferが**進行中**のステータスで、シップメントが**一部受領済み**と表示されている。
- **※ 今回の事象は単一シップメント**（複数シップメントではない）。

---

## 2. アプリ側のロジック（現状）

### 2.1 「入庫済み」タブに振り分ける条件（`isCompleted`）

- **場所**: `Modal.jsx` 入庫一覧まわり（7528–7532行付近）
- **条件**（2025-01 修正後）:
  - **`status === "TRANSFERRED"` のときだけ入庫済み**。`received >= total` では判定しない（管理画面と揃える方針）。
- **使用している値**: `t.status` のみ。

### 2.2 「処理中（予定超過）」などの表示ラベル

- **場所**: 同じく入庫一覧のリスト表示（7870–7877行付近）
- **使用している値**:
  - `received` = **`t.receivedQuantityDisplay ?? t.receivedQuantity`**
  - `receivedQuantityDisplay` は `mergeInboundOverIntoTransfers_` で計算:
    - `receivedQuantityDisplay = receivedQuantity - rejectedQuantity + extrasQuantity`
    - 予定外（extras）は足す、拒否分は引く。**予定超過（over）は足さない**（GraphQL に含まれる想定）。
- **ラベル**:
  - `received < total` → 「（一部受領）」
  - `received > total` → 「（予定超過）」

### 2.3 確定処理でやっていること

- **入庫確定**（`finalize: true`）: 受領分を `inventoryShipmentReceive` 等で送信し、不足分は REJECTED。Toast「入庫を完了しました」。
- **一部受領（一時保存）**（`finalize: false`）: 受領分のみ送信。Toast「一部受領を確定しました」。
- Transfer を TRANSFERRED にする専用 API は**呼んでいない**。Shipment 単位の receive のみ。

---

## 3. 考えられる要因

### 要因1: タブ判定と表示で「受領数」の基準が違う（二重基準）

- **タブ**: `receivedQuantity` のみで `received >= total` を判定。
- **表示**: `receivedQuantityDisplay ?? receivedQuantity` で「一部受領」「予定超過」を出している。

このため、

- 表示上は `receivedQuantityDisplay > total` で「処理中（予定超過）」に見えるが、
- タブは `receivedQuantity >= total` で判定するので、**入庫済みタブに入る**ことがあります。

例:

- GraphQL: `receivedQuantity = 100`、`totalQuantity = 100`
- 監査ログなどで `extras` が増え、`receivedQuantityDisplay = 110`
- → タブ: `100 >= 100` で **入庫済み**
- → 表示: `110 > 100` で **（予定超過）**

結果として、「処理中（予定超過）」のように見えるものが、入庫済みタブに振り分けられている状態になります。

### 要因2: 管理画面は「進行中・一部受領」なのにアプリは「入庫済み」

**単一シップメント**の場合、ずれが起きうるパターン:

1. **ラインレベルでの「一部受領」**
   - 入庫確定で**不足分を REJECTED** として送っている。＝ 予定品目のうち一部は受領、一部は拒否。
   - 管理画面の「一部受領済み」は、**シップメント内の lineItem 単位**で「全部は受領していない」状態を指している可能性がある（accepted + rejected のうち、rejected がある＝一部受領）。
   - アプリは **Transfer 単位の `receivedQuantity >= total`** で入庫済み判定。`receivedQuantity` は **accepted の合計**であり、rejected は含まない。accepted 合計が total に達している場合、アプリは入庫済みとする。一方、管理画面は「一部を拒否＝一部受領」と解釈している可能性があり、**アプリは入庫済み・管理画面は一部受領**というずれが起こりうる。

2. **`status === "TRANSFERRED"` で入庫済みにしている**
   - 私たちは `status` が TRANSFERRED なら**無条件で入庫済み**にしています。
   - 管理画面の表示が「進行中」のままなのに、API では `status: TRANSFERRED` が返っている、という乖離（UI の遅れや表示バグ）の可能性は低いが、あり得る。

3. **予定超過時の API と GraphQL の扱い**
   - 予定超過分は receive API には「予定まで」しか送らず、超過分は extras（在庫調整＋監査ログ）で扱っています。
   - GraphQL の `receivedQuantity` と管理画面の「受領数」の集計・定義の差が、単一シップメントでもずれの要因になり得る。

### 要因3: 表示とタブで「どの Transfer」を見ているかの認識差

- アプリは **入庫先ロケーション**でフィルタした Transfer 一覧を表示しています。
- 管理画面で見ている Transfer・シップメントと、アプリで操作した対象が同じかどうか、確認するとより原因を特定しやすくなります。

---

## 4. まとめ（何が起きているか）※ 単一シップメント前提

1. **「処理中（予定超過）」なのに入庫済みタブに出る**
   - **タブ**は `receivedQuantity`、**表示**は `receivedQuantityDisplay` を使っており、基準が二重になっている。
   - 予定外・予定超過などで `receivedQuantityDisplay > total` になりつつ、`receivedQuantity >= total` になると、**表示上は予定超過・処理中**でも**タブ上は入庫済み**になる。**単一シップメントでもこの要因はそのまま当てはまる。**

2. **管理画面は「進行中・一部受領」のまま（単一シップメント）**
   - 不足分を REJECTED で送っている場合、**lineItem 単位では「全部受領」ではない**。管理画面の「一部受領済み」がその状態を指している可能性がある。
   - アプリは `receivedQuantity`（accepted 合計）で `>= total` を見て入庫済みにする。accepted が total に達しているケースでも、管理画面は「一部は拒否」として一部受領表示にしている、といった解釈の差があり得る。
   - あるいは、管理画面の「受領数」と GraphQL の `receivedQuantity` の集計・反映タイミングの差。

3. **確定処理の範囲**
   - アプリは **Shipment 単位**の receive のみ行い、Transfer を完了させる API は呼んでいない。単一シップメントでも同様。

---

## 5. 実施した修正（2025-01）

- **入庫済み判定を「TRANSFERRED のみ」に統一（案B）**
  - `isCompleted` を、**`status === "TRANSFERRED"` のときだけ `true`** とするように変更した。
  - `received >= total` では判定しない。管理画面の状態と揃え、二重基準・一部受領ずれを防ぐ。
  - 対象: `Modal.jsx` 入庫一覧の `isCompleted`（タブ振り分け・readOnly 判定）。
- ※ これに伴い、従来の「複数シップメント時は全シップメント完了を要求」するロジックは削除（TRANSFERRED のみで足りるため）。

---

## 6. 追加で検討したい修正（単一シップメント事象への対応）

1. **タブと表示の基準をそろえる**（二重基準の解消）
   - タブ判定でも `receivedQuantityDisplay ?? receivedQuantity` を使う。
   - 表示とタブで「受領数」の定義を一致させ、「処理中（予定超過）」表示なのに入庫済みタブにだけ出る、という状態を防ぐ。

2. **入庫済みを「TRANSFERRED のみ」にする** → 上記の通り実施済み（案B）。

3. **ログ・デバッグ**
   - 該当 Transfer ID について、確定直後の `totalQuantity` / `receivedQuantity` / `receivedQuantityDisplay` / `status` をログに出して確認すると、要因の切り分けがしやすいです。

---

## 7. 関連コード（参照用）

| 処理 | ファイル | 行付近 |
|------|----------|--------|
| 入庫済み判定 `isCompleted` | `extensions/stock-transfer-tile/src/Modal.jsx` | 7528–7532 |
| 一覧の表示（一部受領・予定超過） | 同上 | 7870–7877 |
| `mergeInboundOverIntoTransfers_` | 同上 | 13334–13375 |
| 確定処理 `receiveConfirm` | 同上 | 9537–10241 |
