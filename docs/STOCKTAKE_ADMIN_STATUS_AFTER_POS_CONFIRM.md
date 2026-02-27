# 棚卸：POS 確定後に管理画面のステータスが反映されない要因の有無

**目的**: 差異なし確定の「アプリタイル上で待たせずバックグラウンドで write」にした結果、管理画面のステータスが反映されない要因がコードに残っていないかを確認する。

**確認日**: 2026-02-28

---

## 1. データの流れ（差異なし確定）

1. POS で「確定する」→ モーダル即閉じ、`setTimeout(0)` でバックグラウンド処理開始。
2. `readInventoryCountsRaw()` で**同じメタフィールド**（`inventory_counts_v1` またはチャンク）を読む。
3. `mergeCountWithStorage(fromStorage, locallyBuilt)` でマージし、`writeInventoryCounts(merged)` で**全件**を書き戻す。
4. POS の `writeInventoryCounts` は以下を更新する（stocktakeApi.js 同一実装）:
   - **フルデータ**: `inventory_counts_v1` のディスクリプタ ＋ `inventory_counts_v1_c*` チャンク
   - **一覧用**: `inventory_counts_list_v1` のディスクリプタ ＋ `inventory_counts_list_v1_c*` チャンク ＋ `inventory_count_index_v1`
5. 管理画面の loader は **同じキー**（`readInventoryCountsListChunked` で list、必要なら `readInventoryCountsChunked` でフル）を読む（app.inventory-count.tsx）。

→ **POS と管理画面は同じ namespace/key のメタフィールドを共有しており、POS の write で list も更新されるため、データ経路として「管理画面に反映されない」要因はない。**

---

## 2. ステータスが list に含まれるか

- POS の `writeInventoryCounts` は、渡された `counts` 配列を `toMinimalCountForList(c)` で一覧用に変換して list メタに書いている。
- `toMinimalCountForList` は **`status: c.status`** を含む（stocktakeApi.js L348–360）。
- 差異なし確定では `mergeCountWithStorage` で **status をマージ後の groupItems から再計算**しているため、`toWrite.status` は「完了」等の正しい値になる。
- その `merged` を `writeInventoryCounts(merged)` に渡しているので、**list に書かれる status も更新後の値**になる。

→ **管理画面が list を読んでいる限り、ステータスが反映されない要因はここにはない。**

---

## 3. 反映のタイミング・失敗時

| 要因 | 有無 | 説明 |
|------|------|------|
| **管理画面の再読み込み** | あり（仕様） | 管理画面は loader 実行時（初回表示・リロード・画面戻り等）にメタを読むだけ。POS が write した「後」に loader が走れば反映される。**POS 確定直後に管理画面を開きっぱなしで何もしないと、そのままでは更新されない。** リロードや再遷移で反映される。 |
| **バックグラウンド write の失敗** | あり（既存の扱い） | `readInventoryCountsRaw().then(...).catch(...)` で失敗時は `toast("保存に失敗しました")` と `onAfterConfirm(null)`。メタは更新されないので**管理画面も更新されない**。ユーザーにはトーストで分かる。 |
| **write 前に画面を閉じた** | なし | 確定処理は `setTimeout(0)` で開始済み。モーダルを閉じても、その中で `readInventoryCountsRaw` → merge → `writeInventoryCounts` は別タスクとして実行される。アプリを終了するなどしない限り、write は完了する想定。 |

---

## 4. 結論

- **「差異なしのアプリタイル上の確定処理の修正」によって、管理画面用のメタ（list / フル）が書かれなくなる経路はない。**  
  - 同じ `writeInventoryCounts(merged)` が呼ばれ、list とフル両方が更新され、`status` もマージ結果で正しく入る。
- 管理画面のステータスが「更新された際には合った」のであれば、**データ経路・キー・status の含め方に残っている不具合はない**と判断できる。
- 反映されないように見える場合は、次のいずれかになる:
  - **管理画面をリロード／再表示していない**（loader が再実行されていない）。
  - **バックグラウンド write が失敗している**（その場合は「保存に失敗しました」のトーストが出る）。

追加で確実にしたい場合は、**確定成功後にバックグラウンド write が成功するまで待ってから遷移する**実装に戻すか、**write 失敗時に遷移せず「再試行」を促す**などの UX を検討するとよい。
