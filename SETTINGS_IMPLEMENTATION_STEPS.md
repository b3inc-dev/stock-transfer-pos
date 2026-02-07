# 設定画面の実装手順（順番に進行）

## ✅ 実装可能性の確認結果

### 全て実装可能です

1. **Shopify Polaris Web Components**: 管理画面側で使用可能（制約なし）
2. **データ保存**: Metafield方式（既に実装済み、拡張可能）
3. **UIコンポーネント**: 全て使用可能
   - `<s-section>`: セクション区切り ✅
   - `<s-divider>`: 区切り線 ✅
   - `<s-checkbox>`: チェックボックス ✅
   - `<s-text-field>`: テキスト入力 ✅
   - `<s-button>`: ボタン ✅

---

## 📋 実装手順（順番に進行）

### Step 1: SettingsV1型の拡張

**ファイル**: `/app/routes/app.settings.tsx`

**変更内容**:
- `SettingsV1` 型に新しい設定項目を追加

**実装コード**:
```typescript
type SettingsV1 = {
  version: 1;
  destinationGroups: DestinationGroup[];
  carriers: CarrierOption[];
  // 追加
  visibleLocationIds?: string[]; // 表示ロケーション選択設定
  outbound?: {
    allowForceCancel?: boolean; // 強制キャンセル処理許可
  };
  inbound?: {
    allowOverReceive?: boolean; // 過剰入庫許可
    allowExtraReceive?: boolean; // 予定外入庫許可
  };
};
```

**確認事項**:
- [ ] 型定義が正しく追加されたか
- [ ] `defaultSettings()` 関数にデフォルト値を追加
- [ ] `sanitizeSettings()` 関数に新しい項目の処理を追加

---

### Step 2: 基本設定セクションの追加

**ファイル**: `/app/routes/app.settings.tsx`

**変更内容**:
- 「基本設定」セクションを追加
- 表示ロケーション選択設定のUIを実装

**実装位置**:
- 既存の「店舗グループ設定」セクションの前に追加

**実装コード（抜粋）**:
```tsx
{/* 基本設定 */}
<s-section heading="基本設定">
  <s-text tone="subdued" size="small">
    POS側で表示するロケーションを選択します。
    <br />
    何も選択しない場合は全ロケーションが表示されます。
  </s-text>

  <s-divider />

  <s-text emphasis="bold">表示するロケーション</s-text>
  {locations.length === 0 ? (
    <s-text tone="critical">ロケーションが取得できませんでした</s-text>
  ) : (
    <s-stack gap="base">
      {locations.map((l) => {
        const isSelected = settings.visibleLocationIds?.includes(l.id) ?? false;
        return (
          <s-button
            key={l.id}
            tone={isSelected ? "success" : undefined}
            onClick={() => {
              const current = settings.visibleLocationIds ?? [];
              const newIds = isSelected
                ? current.filter((id) => id !== l.id)
                : [...current, l.id];
              setSettings((s) => ({ ...s, visibleLocationIds: newIds }));
            }}
          >
            {l.name}
            {isSelected ? " ✅" : ""}
          </s-button>
        );
      })}
    </s-stack>
  )}
</s-section>

<s-divider />
```

**確認事項**:
- [ ] UIが正しく表示されるか
- [ ] ロケーションの選択・解除が動作するか
- [ ] 状態が正しく保存されるか

---

### Step 3: 出庫設定セクションの追加

**ファイル**: `/app/routes/app.settings.tsx`

**変更内容**:
- 「出庫設定」セクションを追加
- 強制キャンセル処理許可設定のUIを実装

**実装位置**:
- 「配送設定」セクションの後

**実装コード（抜粋）**:
```tsx
{/* 出庫設定 */}
<s-section heading="出庫設定">
  <s-text tone="subdued" size="small">
    出庫処理に関する設定です。
  </s-text>

  <s-divider />

  <s-box padding="base">
    <s-stack gap="base">
      <s-text emphasis="bold">強制キャンセル処理許可</s-text>
      <s-text tone="subdued" size="small">
        出庫処理で強制キャンセル（在庫を戻す処理）を許可するかどうかを設定します。
      </s-text>
      <s-checkbox
        checked={settings.outbound?.allowForceCancel ?? true}
        onChange={(e: any) => {
          const checked = e?.target?.checked ?? true;
          setSettings((s) => ({
            ...s,
            outbound: { ...s.outbound, allowForceCancel: checked },
          }));
        }}
      >
        強制キャンセル処理を許可する
      </s-checkbox>
    </s-stack>
  </s-box>
</s-section>

<s-divider />
```

**確認事項**:
- [ ] チェックボックスが正しく動作するか
- [ ] デフォルト値（true）が正しく設定されるか
- [ ] 状態が正しく保存されるか

---

### Step 4: 入庫設定セクションの追加

**ファイル**: `/app/routes/app.settings.tsx`

**変更内容**:
- 「入庫設定」セクションを追加
- 過剰入庫許可設定と予定外入庫許可設定のUIを実装

**実装位置**:
- 「出庫設定」セクションの後

**実装コード（抜粋）**:
```tsx
{/* 入庫設定 */}
<s-section heading="入庫設定">
  <s-text tone="subdued" size="small">
    入庫処理に関する設定です。
  </s-text>

  <s-divider />

  <s-box padding="base">
    <s-stack gap="base">
      <s-text emphasis="bold">過剰入庫許可</s-text>
      <s-text tone="subdued" size="small">
        予定数量を超える入庫を許可するかどうかを設定します。
      </s-text>
      <s-checkbox
        checked={settings.inbound?.allowOverReceive ?? true}
        onChange={(e: any) => {
          const checked = e?.target?.checked ?? true;
          setSettings((s) => ({
            ...s,
            inbound: { ...s.inbound, allowOverReceive: checked },
          }));
        }}
      >
        過剰入庫を許可する
      </s-checkbox>
    </s-stack>
  </s-box>

  <s-divider />

  <s-box padding="base">
    <s-stack gap="base">
      <s-text emphasis="bold">予定外入庫許可</s-text>
      <s-text tone="subdued" size="small">
        予定にない商品の入庫を許可するかどうかを設定します。
      </s-text>
      <s-checkbox
        checked={settings.inbound?.allowExtraReceive ?? true}
        onChange={(e: any) => {
          const checked = e?.target?.checked ?? true;
          setSettings((s) => ({
            ...s,
            inbound: { ...s.inbound, allowExtraReceive: checked },
          }));
        }}
      >
        予定外入庫を許可する
      </s-checkbox>
    </s-stack>
  </s-box>
</s-section>

<s-divider />
```

**確認事項**:
- [ ] 2つのチェックボックスが正しく動作するか
- [ ] デフォルト値（true）が正しく設定されるか
- [ ] 状態が正しく保存されるか

---

### Step 5: 既存セクションの見出しを更新

**ファイル**: `/app/routes/app.settings.tsx`

**変更内容**:
- 「店舗グループ設定」セクションの見出しを更新
- 「配送設定」セクションの見出しを更新

**実装コード（変更箇所）**:
```tsx
{/* 変更前 */}
<s-section heading="店舗グループ（宛先ロケーションの絞り込み）">

{/* 変更後 */}
<s-section heading="店舗グループ設定">
  <s-text tone="subdued" size="small">
    宛先ロケーションの絞り込み設定です。
    <br />
    POS側ではグループ選択UIは出しません。
    <br />
    「現在の店舗（origin）が所属するグループ」を自動判定し、そのグループ内のロケーションだけを宛先候補にします。
    <br />
    ✅ ただし origin がどのグループにも入っていない場合は <b>全ロケーション表示（制限なし）</b> にフォールバックします。
  </s-text>
```

```tsx
{/* 変更前 */}
<s-section heading="配送会社（選択式：POS側で表記ゆれ防止）">

{/* 変更後 */}
<s-section heading="配送設定">
  <s-text tone="subdued" size="small">
    配送会社の設定です。POS側で表記ゆれを防止するため、ここで登録した配送会社を選ぶだけにします。
    <br />
    company は Shopify が認識できる文字列を入れてください（例：Yamato (JA)）。
    <br />
    ※「国→配送会社一覧をShopify公式からAPI取得」は、一般公開APIでの取得口が無い想定のため、まずはプリセット＋手動追加方式にします。
  </s-text>
```

**確認事項**:
- [ ] 見出しが統一されているか
- [ ] 説明文が適切に配置されているか

---

### Step 6: 動作確認とテスト

**確認項目**:
- [ ] 各設定項目が正しく表示されるか
- [ ] 各設定項目の変更が正しく保存されるか
- [ ] ページをリロードしても設定が保持されるか
- [ ] デフォルト値が正しく適用されるか
- [ ] エラーハンドリングが適切か

---

## 🎯 実装の優先順位

1. **Step 1**: 型定義の拡張（必須）
2. **Step 2**: 基本設定セクション（簡単なので最初に実装）
3. **Step 3**: 出庫設定セクション（1つの設定項目のみ）
4. **Step 4**: 入庫設定セクション（2つの設定項目）
5. **Step 5**: 既存セクションの見出し更新（整理）
6. **Step 6**: 動作確認とテスト

---

## 💡 実装時の注意事項

### 1. デフォルト値の設定
- 既存の設定を壊さないように、デフォルト値を適切に設定
- `??` 演算子を使用してデフォルト値を設定

### 2. 状態管理
- `useState` で設定状態を管理
- 保存時に `sanitizeSettings` でサニタイズ

### 3. エラーハンドリング
- 保存エラー時の表示
- バリデーション（必要に応じて）

### 4. UIの一貫性
- 既存のUIパターンに合わせる
- セクション間の間隔を統一

---

## 📝 次のステップ

各Stepを順番に実装し、動作確認しながら進めます。
1つずつ実装して、動作確認してから次のStepに進むことをお勧めします。
