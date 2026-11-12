# BACKLOG — 継続開発の候補

2026-10-04。[DECISIONS.md](DECISIONS.md) と [監査](CODEX_INVENTORY_AUDIT.md) に基づく未実装候補。一覧への記載は着手許可ではない。ユーザーがIDまたは機能を指定したらCodexが調査・設計・実装・mock検証・レビュー・PRまで進める。通常ownerはCodex。個々の着手状態・担当・base/HEADはGitHub Issue/PRで管理し、本書へ並行して別の進捗正本を作らない。

| ID | 優先度 | 課題・入口 | 完了条件（実装時に具体化） |
|---|---|---|---|
| INV-01 | P0 | 出庫Transfer作成の成功不明・二重作成（ModalOutbound） | 同一操作再送・別端末・timeout後照合・250分割途中停止/再開をmockで検証。作成済みTransfer/Shipmentを追跡し、未確認の再発行をしない |
| INV-02 | P0 | apply-changeの冪等境界・停止イベント（apply-change API/Prisma） | shop/操作/payload対応、同時要求、pending/applying復旧、DB保存失敗を検証。既存イベントとの互換・migration案を明記 |
| INV-03 | P0 | 数量取得失敗・GraphQL欠落成功扱い・CAS/補償（server helper） | 欠落/errorで数量0や成功にしない。売上との競合、成功不明chunk、補償失敗の状態を検証 |
| INV-04 | P1 | 成功後の履歴失敗・partial記録（API/出庫） | completed後ログ修復、複数Transfer ID、実適用subsetを検証 |
| INV-05 | P1 | ロス/仕入の再確定・Admin仕入・棚卸完了順序 | UI再起動/メタデータ保存失敗/同時実行で在庫だけ重複せず状態も一致することを検証 |
| DEV-01 | P1 | server/DB adapter mockとfixture拡充 | success/error/timeout/duplicate/partial/location・250境界を実API/本番DBなしで検証 |
| DEV-02 | P1 | lint/typecheck baselineとCI | 既存失敗の範囲を分けて解消し、Node/lockfileで再現可能にする。greenになったcheckのみrequired候補にする |
| DEV-03 | P1 | 開発store/DB/URLの隔離 | 接続先を確認し、devのURL更新/migration・本番credentials継承を防ぐ。Cursor所有PR #3はhandoffなしに編集しない |
| DOC-01 | P2 | location/SKU対応と取得pagination | 確定時originの選択優先順位を仕様化し、取得上限/同一SKU/別locationをfixtureで検証 |
| DOC-02 | P3 | 古い調査文書整理と大型ファイル整理 | 有効な仕様リンクを保持し、現行仕様と過去仮説を区別。リファクタ前後で状態遷移を維持 |

INV-01の設計で進捗を永続化する場合も、Shopify Transfer/Shipmentを業務状態の正とする既存判断は維持する。Cronによる自動再発行や「0に戻して再実行」は採用済み手順ではない。優先度は調査上の提案で、実装の選択は依頼範囲で判断する。
