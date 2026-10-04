# AGENTS.md — stock-transfer-pos

調査→設計→実装→品質確認→独立レビューの順で進めます。既存仕様・共通処理を優先し、本番コード・deploy挙動を初期設定で変更しません。

- [README.md](README.md): 構成と既存開発手順
- [docs/DEPLOY.md](docs/DEPLOY.md): 開発・deploy・共通運用


## 3ツール共通の入口

共通ルールの正本は本書と既存docsです。Cursor・Codex・Claude Codeは開始前に [docs/DEPLOY.md](docs/DEPLOY.md) の共通開発運用・引き継ぎ・リリース境界を確認してください。1 workstreamにつきowner toolは1つ。main直push・force push、本番操作の無承認実行、Backlogへの勝手な着手は禁止です。

作業分離は毎回の指示を待たず自動で行う。編集前にGitHubのowner・進行中PRとローカル変更を確認し、同じworkstreamの自分の専用branch/worktreeがあれば再利用、なければGitHubの適切なbaseから作成する。main/stagingの共有checkoutや他toolのworktreeへ直接編集しない。詳細手順は上記の共通運用docsを参照する。
