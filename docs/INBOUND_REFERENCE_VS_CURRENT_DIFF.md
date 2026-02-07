# 入庫処理：Modal_REFERENCE.jsx と現在実装（InboundListScreen）の差分

**目的**: 入庫処理を Modal_REFERENCE.jsx から分割した際に発生する「Cannot access 'jt' before initialization」等の TDZ エラーの原因と、REFERENCE と現在実装の**差がある箇所**をまとめる。

---

## 1. エラーの原因（TDZ：Temporal Dead Zone）

### 現象
- 本番ビルド（minify 有効）で **「Cannot access 'jt' before initialization」** や **「Cannot access 'Jt' before initialization」** が発生する。
- 開発ビルドでは出ないことが多い。

### 原因
- **Modal_REFERENCE.jsx** では、入庫リスト（`InboundList`）が**同じファイル内**にあり、次の関数が**コンポーネント内**で定義されている：
  - `denyEdit_`（8449–8453行）
  - `safeSet`（8502–8506行）
  - `clampReceiveQty_`（8975–8979行）
  - **`setRowQty`**（8999–9010行）
  - **`incRow`**（9013–9021行）
  - **`setExtraQty`**（9024–9032行）
  - **`incExtra`**（9034–9041行）
- Minify するとこれらの名前が **jt, Jt** などの短い名前に圧縮される。
- 分割後は **useCallback（addOrIncrementByResolved 等）が、これらの関数より「先に」参照される**ように並び替えられることがあり、実行順で「参照が先・代入が後」になり **TDZ** になる。

### REFERENCE で問題が出にくかった理由
- 1 ファイルに全部入りで、minify 時の「塊」の順序やスコープの取り方の違いで、REFERENCE では TDZ が表面化しなかった可能性が高い。
- 分割して別ファイル（InboundListScreen.jsx）にすると、バンドル順や圧縮の影響で TDZ が発生する。

---

## 2. 現在実装で行っている TDZ 対策（REQUIREMENTS 12.24）

**InboundListScreen.jsx** では、以下を**モジュールレベル**（コンポーネントの外）に移動している：

| REFERENCE（コンポーネント内） | 現在実装（モジュールレベル） | 備考 |
|------------------------------|------------------------------|------|
| `denyEdit_`                  | `denyEdit_(toastReadOnlyOnceRef, toastFn)` | 呼び出し時に ref と toast を渡す |
| `clampReceiveQty_`           | `clampReceiveQty_(r, n)`      | 同じシグネチャ |
| `safeSet`                    | `safeSet(mountedRef, fn, signal)` | 呼び出し時に mountedRef を渡す |
| `formatShipmentLabelLocal`   | `formatShipmentLabelLocal(transferName, index)` | useCallback を廃止 |
| **`setRowQty`**              | **`setRowQty_(readOnlyRef, toastReadOnlyOnceRef, toastFn, rowsRef, setRows, key, qty)`** | 引数で ref/setter を渡す |
| **`incRow`**                 | **`incRow_(...)`**           | 同上 |
| **`setExtraQty`**            | **`setExtraQty_(...)`**      | 同上 |
| **`incExtra`**               | **`incExtra_(...)`**         | 同上 |

- JSX では、REFERENCE の `setRowQty` に相当するものを  
  `(key, qty) => setRowQty_(readOnlyRef, toastReadOnlyOnceRef, toast, rowsRef, setRows, key, qty)` のように**インラインで渡す**（コンポーネント内に `const setRowQty = ...` を置かない）。
- これにより、minify 後もコンポーネント内に「jt / Jt」が残らず、TDZ を防ぐ。

**結論**: 「REFERENCE のコードをそのまま（コンポーネント内で incRow/setRowQty 等を定義する形）で使う」と、分割・minify で再び TDZ が出る。**現在の「モジュールレベルに出す」実装が正しい対応**。

---

## 3. ロジック・仕様の差がある箇所

REFERENCE の「動き」を再現しつつ TDZ を避けるには、以下の差分を揃える必要がある。

### 3.1 setRowQty のキー比較

| 項目 | Modal_REFERENCE.jsx | InboundListScreen.jsx（現在） |
|------|----------------------|--------------------------------|
| キー比較 | `String(r.key) === k \|\| String(r.shipmentLineItemId) === k` の**両方**を判定 | `r.key === key` のみ（shipmentLineItemId は未使用） |

- **REFERENCE**（8999–9010行）: `key` と `shipmentLineItemId` の両方でマッチさせる。
- **現在**: `setRowQty_` は `r.key === key` のみ。  
→ 行によっては `key` と `shipmentLineItemId` が別のことがある場合、REFERENCE に合わせるなら `setRowQty_` 内で `String(r.key) === String(key) || String(r.shipmentLineItemId) === String(key)` のようにする必要がある。

### 3.2 incRow の下限（最小値）

| 項目 | Modal_REFERENCE.jsx | InboundListScreen.jsx（現在） |
|------|----------------------|--------------------------------|
| incRow | 下限なし。`receiveQty + delta` をそのままセット | `alreadyAcceptedTotalQty` を下限に使用。`Math.max(min, receiveQty + delta)` |

- **REFERENCE**（9013–9021行）: `clampReceiveQty_(r, Number(r.receiveQty || 0) + delta)` を使っているが、`clampReceiveQty_` の定義は「下限 = alreadyAcceptedTotalQty / 上限なし」なので、結果的には「現在値 + delta」をクランプした値。
- **現在**の `incRow_`: 明示的に `min = alreadyAcceptedTotalQty` を取って `Math.max(min, ...)` している。  
→ 挙動はほぼ同じだが、REFERENCE は「行の alreadyAcceptedTotalQty」を clampReceiveQty_ 内で参照している点は一致させるとよい。

### 3.3 addOrIncrementByResolved：予定外（extras）の既存行への加算

| 項目 | Modal_REFERENCE.jsx | InboundListScreen.jsx（現在） |
|------|----------------------|--------------------------------|
| 予定外の既存行にヒットしたとき | `incExtra(hitExtra.key, delta)` を呼ぶ | `setExtras` を直接書き、`incExtra_` は使っていない |

- **REFERENCE**（9060–9062行）: 予定外の既存行には `incExtra(hitExtra.key, delta)`。
- **現在**（741–746行付近）: 予定外の既存行には `setExtras((prev) => prev.map(...))` で加算。  
→ 動作は同等だが、REFERENCE に揃えるなら「予定外の既存行」の分は `incExtra_(readOnlyRef, toastReadOnlyOnceRef, toast, extrasRef, setExtras, cur.key, delta)` のように `incExtra_` を呼ぶと、処理の一貫性と TDZ 対策の一元化になる。

### 3.4 addOrIncrementByResolved：新規予定外追加時のトースト

| 項目 | Modal_REFERENCE.jsx | InboundListScreen.jsx（現在） |
|------|----------------------|--------------------------------|
| 新規予定外を 1 件追加したとき | `toast(\`予定外入荷に追加：${title}（+${delta}）\`)` | `toast("予定外に追加しました")` のみ（タイトル・数量なし） |

- REFERENCE の方が情報量が多い。必要なら現在側でも `title` と `delta` を含めたメッセージに変更可能。

### 3.5 clampReceiveQty_ の定義

| 項目 | Modal_REFERENCE.jsx | InboundListScreen.jsx（現在） |
|------|----------------------|--------------------------------|
| 下限の算出 | `alreadyAcceptedTotalQty ?? (alreadyAcceptedQty + overAcceptedQty)` | `alreadyAcceptedTotalQty ?? (alreadyAcceptedQty + overAcceptedQty)` と同等 |

- REFERENCE は `overAcceptedQty` を含む表記。現在は `alreadyAcceptedTotalQty` をそのまま使っている。  
→ データの持ち方が同じなら結果は一致。REFERENCE のコメント（過剰分は加算しない）と整合しているかだけ確認すればよい。

### 3.6 formatShipmentLabelLocal

- **REFERENCE**: コンポーネント内の `useCallback`。
- **現在**: モジュールレベルの通常関数（TDZ 対策）。  
→ 仕様上の差はなし。

---

## 4. まとめ：REFERENCE の入庫処理を「使う」ときの進め方

1. **TDZ 対策は維持する**  
   - `denyEdit_`, `clampReceiveQty_`, `safeSet`, `formatShipmentLabelLocal`, **`incRow_` / `setRowQty_` / `setExtraQty_` / `incExtra_`** に加え、**`setAllToPlanned_` / `resetAllCounts_`** および **`clearAddSearch_` / `handleShowMoreAddCandidates_` / `loadExtrasHistory_`**（**Ot** TDZ 対策）も**モジュールレベル**に配置済み。  
   - REFERENCE の「コンポーネント内で incRow/setRowQty 等を const で定義する」形に戻すと、分割ビルドで再度 jt/Jt/Ot の TDZ が出る。

2. **REFERENCE の「ロジック」に揃える（反映済み）**  
   - **setRowQty_**  
     - 行のマッチ条件を REFERENCE と同一にした：  
       `String(r.key) === String(key) || String(r.shipmentLineItemId) === String(key)`。
   - **addOrIncrementByResolved**  
     - 予定外の既存行への加算は `incExtra_` を呼ぶ形に変更。新規予定外追加時のトーストを「予定外入荷に追加：${title}（+${delta}）」に統一。
   - **ヘッダー検索表示**  
     - 「検索リスト 候補：」→「検索結果：」に変更（REFERENCE と同一）。

3. **参照ドキュメント**  
   - 実装の完全性チェック: `docs/INBOUND_LIST_SCREEN_COMPLETE_CHECK.md`  
   - TDZ 対策の詳細: 同上「0. Minify 時の TDZ エラー対策」  
   - 要件上の対応: `REQUIREMENTS_FINAL.md` の「12.24 POS入庫リストの Jt TDZ エラー対策」

---

## 5. ファイル対応表

| 役割 | Modal_REFERENCE.jsx | 現在実装（入庫拡張） |
|------|----------------------|----------------------|
| 入庫リスト画面本体 | `InboundList`（8269行～） | `InboundListScreen.jsx` の `InboundListScreen` |
| 行・予定外の増減 | コンポーネント内の `setRowQty` / `incRow` / `setExtraQty` / `incExtra` | モジュールレベルの `setRowQty_` / `incRow_` / `setExtraQty_` / `incExtra_` |
| 行描画 | 同一ファイル内の `renderInboundShipmentItems_`（13742行～） | `InboundUiParts.jsx` の `renderInboundShipmentItems_` |
| 予定外・確定メモ等 | 同一ファイル内の `renderExtras_` / `renderConfirmMemo_` 等 | `InboundUiParts.jsx` の `renderExtras_` / `renderConfirmMemo_` 等 |
| API・ヘルパー | 同一ファイル内または共通 | `inboundApi.js` / `inboundHelpers.js` 等 |

この対応関係を押さえたうえで、上記「3. ロジック・仕様の差がある箇所」を REFERENCE に合わせれば、「REFERENCE の入庫処理のコードを使って」かつ TDZ を出さない形で実装できます。
