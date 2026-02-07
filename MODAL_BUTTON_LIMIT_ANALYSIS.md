# s-modal ボタン制限の分析

## 📋 調査結果

### 公式ドキュメント
- Shopify公式ドキュメントには、`s-modal` の `slot="secondary-actions"` の最大数の明記は見つかりませんでした
- Modalコンポーネントは `primary-action` と `secondary-actions` をサポートしていることは確認できました

### コード内の実装パターン

#### 他のモーダルでの使用例

1. **DRAFTステータスのキャンセル確認モーダル**
   - `secondary-actions`: 2つ（削除、キャンセル）
   - `primary-action`: 1つ（戻る）
   - **合計: 3つ**

2. **READY_TO_SHIPステータスのキャンセル確認モーダル**
   - `secondary-actions`: 1つ（戻る）
   - `primary-action`: 1つ（キャンセルする）
   - **合計: 2つ**

3. **その他のキャンセル確認モーダル**
   - `secondary-actions`: 1つ（戻る）
   - `primary-action`: 1つ（キャンセルする）
   - **合計: 2つ**

### 現在の実装（確定モーダル）

**新規作成時:**
- `secondary-actions`: 3つ（キャンセル、配送準備完了にする、下書き保存）
- `primary-action`: 1つ（確定する）
- **合計: 4つ** ← **表示されていない**

**編集時:**
- `secondary-actions`: 2つ（キャンセル、配送準備完了にする）
- `primary-action`: 1つ（確定する）
- **合計: 3つ** ← **表示されている可能性**

## 🔍 推測される制限

### 仮説1: secondary-actions は最大2つまで
- `secondary-actions`: 最大2つ
- `primary-action`: 1つ
- **合計: 最大3つ**

### 仮説2: 合計で最大3つまで
- `secondary-actions` + `primary-action` = 最大3つ
- `secondary-actions` の数は制限なし（ただし合計3つ以内）

### 仮説3: secondary-actions は最大3つ、合計4つまで
- `secondary-actions`: 最大3つ
- `primary-action`: 1つ
- **合計: 最大4つ**（ただし実際には表示されない）

## 💡 推奨される対応

### 現時点での最適解

**コード内の実装パターンから判断すると、`secondary-actions` は最大2つまで表示される可能性が高いです。**

したがって、以下の構成を推奨します：

1. **キャンセル**（secondary-actions、常に表示）
2. **配送準備完了にする**（secondary-actions、常に表示）
3. **下書き保存**（secondary-actions、新規作成時のみ表示）← **削除または条件表示**
4. **確定する**（primary-action、常に表示）

### 実装案

#### 案1: 下書き保存を削除（推奨）
- キャンセル、配送準備完了にする、確定するの3つに統一
- 下書き保存は別の方法で実現（自動保存など）

#### 案2: 状況に応じてボタンを切り替え
- 新規作成時: キャンセル、下書き保存、確定する（配送準備完了にするは非表示）
- 編集時: キャンセル、配送準備完了にする、確定する（下書き保存は非表示）

#### 案3: モーダル内にボタンを配置（slotを使わない）
- `slot` を使わず、モーダル内に `<s-box>` でボタンを配置
- 制限を回避できる可能性がある

## 📝 次のステップ

1. **実際の動作確認**: 現在の実装でどのボタンが表示されているか確認
2. **公式サポートへの問い合わせ**: Shopifyサポートに制限を確認
3. **実装の調整**: 確認結果に基づいて実装を調整

## 🔗 参考リンク

- [Shopify POS UI Extensions Modal Documentation](https://shopify.dev/docs/api/pos-ui-extensions/latest/polaris-web-components/feedback-and-status-indicators/modal)
