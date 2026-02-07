# InboundListScreen UI 構造の差分チェック

Modal_REFERENCE.jsx の `InboundList` 関数と `InboundListScreen.jsx` の UI 構造（要素の順序・配置・条件）の比較結果です。

---

## Modal_REFERENCE.jsx の UI 構造

### 全体の構造（return 文）

```javascript
return (
  <s-stack gap="base">
    {/* 1. 検索結果ブロック（最上部） */}
    {String(addQuery || "").trim().length >= 1 ? (
      <s-box padding="base">
        <s-stack gap="extra-tight">
          <s-text>検索リスト 候補： N件</s-text>
          {addCandidates.length > 0 ? (
            <>
              {addCandidates.slice(0, addCandidatesDisplayLimit).map((c, idx) => (
                <InboundCandidateRow key={stableKey} c={c} idx={idx} />
              ))}
              {addCandidates.length > addCandidatesDisplayLimit ? (
                <s-box padding="small">
                  <s-button>さらに表示（残り N件）</s-button>
                </s-box>
              ) : null}
            </>
          ) : addLoading ? (
            <s-text>検索中...</s-text>
          ) : (
            <s-text>該当なし</s-text>
          )}
        </s-stack>
      </s-box>
    ) : null}

    {/* 2. 入庫リスト（shipment がある場合のみ） */}
    {shipment ? (
      <s-box key="shipment_list" padding="small">
        <s-stack gap="small">
          <s-text emphasis="bold">入庫リスト</s-text>
          {/* 未読み込み商品リスト */}
          {lineItemsPageInfo?.hasNextPage ? (
            <s-box padding="base">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                <s-text>未読み込み商品リストがあります。（要読込）</s-text>
                <s-button kind="secondary" onClick={loadMoreLineItems_} disabled={loadingMore}>
                  {loadingMore ? "読み込み中..." : "読込"}
                </s-button>
              </s-stack>
            </s-box>
          ) : null}
          {/* 商品リスト（単一/複数） */}
          {isMultipleMode ? (
            // グループ化 + renderInboundShipmentItems_
          ) : (
            renderInboundShipmentItems_({ rows: visibleRows, ... })
          )}
        </s-stack>
      </s-box>
    ) : (
      <s-box padding="base">
        <s-text>Shipmentを読み込むと、ここに明細が出ます</s-text>
      </s-box>
    )}

    {/* 3. 確定モーダル */}
    <s-modal id={CONFIRM_RECEIVE_MODAL_ID} heading="入庫を確定しますか？">
      {/* モーダル内容 */}
    </s-modal>

    {/* 4. 予定外入荷エリア（shipment がある場合のみ） */}
    {shipment ? (
      <s-box key="extras_area" padding="small">
        <s-stack gap="small">
          <s-text emphasis="bold">予定外入荷（リストにない商品）</s-text>
          {renderExtras_()}
          {renderExtrasHistory_()}
          {renderConfirmMemo_()}
          {/* {renderProcessLog_()} */}
        </s-stack>
      </s-box>
    ) : null}
  </s-stack>
);
```

### 構造の特徴

1. **全体ラッパー**: `<s-stack gap="base">`（padding なし）
2. **検索結果ブロック**: 最上部、検索クエリが1文字以上のとき表示（条件: `addQuery.trim().length >= 1`）
3. **入庫リスト**: `shipment` がある場合のみ表示、`<s-box key="shipment_list" padding="small">` でラップ
4. **未読み込み商品リスト**: 入庫リスト内の最上部（`<s-box padding="base">`、`justifyContent="space-between"`）
5. **確定モーダル**: 入庫リストの後、予定外入荷の前
6. **予定外入荷エリア**: 確定モーダルの後、`shipment` がある場合のみ表示、`<s-box key="extras_area" padding="small">` でラップ
7. **商品検索・バーコードスキャン**: 存在しない
8. **全入庫・リセットボタン**: 存在しない（ヘッダーに配置）

---

## InboundListScreen.jsx の現在の UI 構造

### 全体の構造（return 文）

```javascript
return (
  <s-box padding="base">
    <s-stack gap="base">
      {/* 1. 未読み込み商品リスト（shipment の外） */}
      {lineItemsPageInfo?.hasNextPage && (
        <s-box padding="small">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text>未読み込み商品リストがあります。（要読込）</s-text>
            <s-button kind="secondary" onClick={loadMoreLineItems_} disabled={loadingMore}>
              {loadingMore ? "読み込み中..." : "読込"}
            </s-button>
          </s-stack>
        </s-box>
      )}

      {/* 2. 入庫リスト（shipment の外） */}
      <s-stack gap="small">
        <s-text emphasis="bold">入庫リスト</s-text>
        {isMultipleMode ? (
          // グループ化 + renderInboundShipmentItems_
        ) : (
          renderInboundShipmentItems_({ rows: visibleRows, ... })
        )}
      </s-stack>

      {/* 3. 予定外入荷エリア（shipment の外） */}
      <s-box padding="small">
        <s-stack gap="small">
          <s-text emphasis="bold">予定外入荷（リストにない商品）</s-text>
          {renderExtras_()}
          {renderExtrasHistory_()}
          {renderConfirmMemo_()}
        </s-stack>
      </s-box>

      {/* 4. 検索結果ブロック（!readOnly のときのみ） */}
      {!readOnly && (
        <>
          {String(addQuery || "").trim().length >= 1 ? (
            <s-box padding="base">
              <s-stack gap="extra-tight">
                <s-text>検索リスト 候補： N件</s-text>
                {/* InboundCandidateRow */}
              </s-stack>
            </s-box>
          ) : null}
          {/* 5. 商品検索（REFERENCE には存在しない） */}
          <s-box padding="small">
            <s-stack gap="small">
              <s-text size="small" emphasis="bold">商品検索（予定外追加）</s-text>
              <s-text-field placeholder="SKU・JANで検索" ... />
            </s-stack>
          </s-box>
          {/* 6. バーコードスキャン（REFERENCE には存在しない） */}
          <s-box padding="small">
            <s-stack gap="small">
              <s-text size="small" emphasis="bold">バーコードスキャン</s-text>
              <s-text-field placeholder="スキャンまたは入力" ... />
            </s-stack>
          </s-box>
        </>
      )}

      {/* 7. 全入庫・リセットボタン（REFERENCE には存在しない） */}
      <s-stack direction="inline" gap="base">
        <s-button kind="secondary" size="small" onClick={setAllToPlanned} disabled={readOnly}>全入庫</s-button>
        <s-button kind="secondary" size="small" onClick={resetAllCounts} disabled={readOnly}>リセット</s-button>
      </s-stack>

      {/* 8. 確定モーダル */}
      <s-modal id={CONFIRM_RECEIVE_MODAL_ID} heading="入庫を確定しますか？">
        {/* モーダル内容 */}
      </s-modal>
    </s-stack>
  </s-box>
);
```

### 構造の特徴

1. **全体ラッパー**: `<s-box padding="base"><s-stack gap="base">`（padding あり）
2. **検索結果ブロック**: 予定外入荷の後、`!readOnly` のときのみ表示
3. **入庫リスト**: `shipment` の条件なし、常に表示
4. **未読み込み商品リスト**: 入庫リストの外、最上部
5. **予定外入荷エリア**: 入庫リストの後、確定モーダルの前、`shipment` の条件なし
6. **確定モーダル**: 予定外入荷の後、最下部
7. **商品検索・バーコードスキャン**: 追加されている（REFERENCE には存在しない）
8. **全入庫・リセットボタン**: 追加されている（REFERENCE には存在しない）

---

## 主な差分

### ❌ 1. 全体ラッパー

| 項目 | REFERENCE | 現在 | 差分 |
|------|-----------|------|------|
| ラッパー | `<s-stack gap="base">` | `<s-box padding="base"><s-stack gap="base">` | ⚠️ padding が追加されている |

### ❌ 2. 検索結果ブロックの位置

| 項目 | REFERENCE | 現在 | 差分 |
|------|-----------|------|------|
| 位置 | 最上部（全体の最初） | 予定外入荷の後 | ❌ 位置が異なる |
| 条件 | `addQuery.trim().length >= 1` | `!readOnly && addQuery.trim().length >= 1` | ⚠️ `!readOnly` 条件が追加 |

### ❌ 3. 入庫リスト・予定外入荷の条件

| 項目 | REFERENCE | 現在 | 差分 |
|------|-----------|------|------|
| 入庫リスト | `{shipment ? <s-box key="shipment_list">...</s-box> : <s-box>Shipmentを読み込むと...</s-box>}` | 常に表示（shipment の条件なし） | ❌ shipment の条件がない |
| 予定外入荷 | `{shipment ? <s-box key="extras_area">...</s-box> : null}` | 常に表示（shipment の条件なし） | ❌ shipment の条件がない |

### ❌ 4. 未読み込み商品リストの位置

| 項目 | REFERENCE | 現在 | 差分 |
|------|-----------|------|------|
| 位置 | 入庫リスト内の最上部（`<s-box key="shipment_list">` 内） | 入庫リストの外、全体の最上部 | ❌ 位置が異なる |
| レイアウト | `justifyContent="space-between"` | `alignItems="center"` | ⚠️ レイアウトが異なる |

### ❌ 5. 予定外入荷エリアの位置

| 項目 | REFERENCE | 現在 | 差分 |
|------|-----------|------|------|
| 位置 | 確定モーダルの後 | 入庫リストの後、確定モーダルの前 | ❌ 位置が異なる |
| key | `key="extras_area"` | key なし | ⚠️ key がない |

### ❌ 6. 確定モーダルの位置

| 項目 | REFERENCE | 現在 | 差分 |
|------|-----------|------|------|
| 位置 | 入庫リストの後、予定外入荷の前 | 予定外入荷の後、最下部 | ❌ 位置が異なる |

### ⚠️ 7. 追加されている要素（REFERENCE には存在しない）

| 項目 | 現在の実装 | REFERENCE |
|------|-----------|-----------|
| 商品検索 | `<s-box padding="small">` で「商品検索（予定外追加）」+ `s-text-field` | ❌ 存在しない |
| バーコードスキャン | `<s-box padding="small">` で「バーコードスキャン」+ `s-text-field` | ❌ 存在しない |
| 全入庫・リセットボタン | `<s-stack direction="inline">` で「全入庫」「リセット」ボタン | ❌ 存在しない（ヘッダーに配置） |

---

## まとめ

### ✅ 一致している要素

1. **検索結果ブロックの内容**: InboundCandidateRow、さらに表示ボタン、検索中/該当なしの表示
2. **入庫リストの内容**: renderInboundShipmentItems_、複数シップメント時のグループ化、s-divider
3. **未読み込み商品リストの内容**: 文言「未読み込み商品リストがあります。（要読込）」、読込ボタン
4. **予定外入荷エリアの内容**: renderExtras_、renderExtrasHistory_、renderConfirmMemo_
5. **確定モーダルの内容**: サマリー、明細、warningAreaNode、戻るボタン、アクションボタン

### ❌ 不一致の要素

1. **全体ラッパー**: REFERENCE は `<s-stack gap="base">`、現在は `<s-box padding="base"><s-stack gap="base">`
2. **検索結果ブロックの位置**: REFERENCE は最上部、現在は予定外入荷の後
3. **検索結果ブロックの条件**: REFERENCE は `addQuery.trim().length >= 1`、現在は `!readOnly && addQuery.trim().length >= 1`
4. **入庫リスト・予定外入荷の条件**: REFERENCE は `shipment` がある場合のみ、現在は常に表示
5. **未読み込み商品リストの位置**: REFERENCE は入庫リスト内、現在は入庫リストの外
6. **未読み込み商品リストのレイアウト**: REFERENCE は `justifyContent="space-between"`、現在は `alignItems="center"`
7. **予定外入荷エリアの位置**: REFERENCE は確定モーダルの後、現在は確定モーダルの前
8. **予定外入荷エリアの key**: REFERENCE は `key="extras_area"`、現在は key なし
9. **確定モーダルの位置**: REFERENCE は入庫リストの後、現在は最下部

### ⚠️ 追加されている要素（REFERENCE には存在しない）

1. **商品検索**: 「商品検索（予定外追加）」+ `s-text-field`
2. **バーコードスキャン**: 「バーコードスキャン」+ `s-text-field` + キュー表示
3. **全入庫・リセットボタン**: フッターではなく、本文内に配置

---

## 推奨される修正

REFERENCE に忠実に再現するには、以下の修正が必要です：

1. **全体ラッパー**: `<s-box padding="base">` を削除し、`<s-stack gap="base">` のみにする
2. **検索結果ブロック**: 最上部に移動し、`!readOnly` 条件を削除
3. **入庫リスト・予定外入荷**: `shipment` の条件を追加
4. **未読み込み商品リスト**: 入庫リスト内に移動し、`justifyContent="space-between"` に変更
5. **予定外入荷エリア**: 確定モーダルの後に移動し、`key="extras_area"` を追加
6. **確定モーダル**: 入庫リストの後、予定外入荷の前に移動
7. **商品検索・バーコードスキャン**: 削除（REFERENCE には存在しない）
8. **全入庫・リセットボタン**: 削除（REFERENCE には存在しない、ヘッダーに配置）

ただし、商品検索・バーコードスキャン・全入庫・リセットボタンは、現在の実装で追加された機能の可能性があるため、削除するかどうかは要件次第です。
