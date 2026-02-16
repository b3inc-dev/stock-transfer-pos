# 在庫変動履歴・反映まわりの残存リスク一覧

**作成日**: 2026-02-17  
**目的**: 現在のコードから想定されるリスクを一覧化し、対策済み／要監視／許容を整理する。

---

## 1. 対策済み（2026-02-17）

| リスク | 内容 | 対応 |
|--------|------|------|
| OrderPendingLocation の locationId="" が検索にヒットしない | オンライン受注直後はロケーション不明のため `locationId=""` で登録されるが、検索で `.filter(Boolean)` により `""` が除かれマッチしなかった | `orderLocCands` から `.filter(Boolean)` を削除し、`""` を検索に含めるよう修正。要因: `INVENTORY_ACTIVITY_MANAGEMENT_CAUSE_20260217.md` |

---

## 2. 防御的対応を入れたもの（返品）

| リスク | 内容 | 対応 |
|--------|------|------|
| RefundPendingLocation の locationId="" | 返品では `refunds/create` が `location_id` なしの行を continue するため現状は `locationId=""` で登録されない。ただし API 仕様変更やエッジで空になる可能性はゼロではない | `inventory_levels/update` の RefundPendingLocation 検索で `locCands` に `""` を追加。マッチ時に `locationId` を保持し、deleteMany でその値を使うよう統一（マッチした行と削除条件の整合）。 |

---

## 3. 要監視（発生確率は低いが条件次第で起きうる）

| リスク | 内容 | 備考 |
|--------|------|------|
| 時間窓外 | OrderPendingLocation の検索は `orderCreatedAt` が `updatedAt ± 5分 / +2分`。注文作成から在庫 Webhook までが 5 分以上遅れるとマッチしない | 通常は数秒〜数十秒。長時間遅延はレア。運用で許容。 |
| orders/updated の遅延 | `inventory_levels/update` が先に届いた場合、最大 7.5 秒（2.5秒×3回）待ってから OrderPendingLocation を再検索。それでも orders/updated が遅いと「管理」のまま | 待機をさらに伸ばすとレスポンス悪化。現状 7.5 秒でバランス。 |
| 初回管理画面未オープン | インストール直後などでオフラインセッションが無いと、POS からの `api/log-inventory-change` が 401。後から届く Webhook のみで「管理」として記録される | 利用手順で「初回は管理画面でアプリを開く」を案内済み。 |

---

## 4. その他（現状は問題にしない）

| 項目 | 内容 |
|------|------|
| 並列 Webhook | 同一 (item, location, timestamp) で複数 `inventory_levels/update` が来た場合、P2002 をキャッチして 200 を返す対応済み。 |
| ID 形式 | GID / 数値の両方を候補にした検索で整合。 |
| 救済時の idempotencyKey | 救済時の update に idempotencyKey を含めず P2002 を防止済み。 |

---

## 5. 今後の変更時の注意

- **locationId / inventoryItemId の候補配列**で「空文字や null を意図的に含める」場合は、**`.filter(Boolean)` を使わない**。JavaScript では `Boolean("")` が false のため、空文字が除かれてしまう。
- **Pending 系（OrderPendingLocation / RefundPendingLocation）** をマッチしたあと deleteMany するときは、**マッチした行の locationId をそのまま削除条件に使う**。Webhook の location_id だけに頼ると、`locationId=""` で登録された行が削除されない。
