# Contributing to Gnosis

Gnosis へのコントリビュートを歓迎します。大きな変更の前に、まず Issue や Discussion 相当の場で背景と方針を共有してください。

## 開始前に確認すること

- `README.md` と `docs/` 配下の関連ドキュメントを読む
- 既存 Issue や既存 PR と重複していないか確認する
- 変更の目的と影響範囲を短く整理する

## セットアップ

```bash
bun install
bun run monorepo:setup
docker-compose up -d
cp .env.example .env
bun run db:init
```

## 開発フロー

1. 変更用ブランチを作成する
2. 小さく意味のある単位で変更する
3. 必要に応じてテストやドキュメントも更新する
4. `bun run verify` を通す
5. Conventional Commits 形式でコミットする
6. PR を作成し、背景・変更点・確認方法を記載する

## 品質基準

- TypeScript は `strict` を前提にする
- 既存の設計方針に沿って変更する
- 仕様変更を伴う場合は README または `docs/` を更新する
- 不要なリファクタを混ぜず、目的に集中する
- ユーザー影響がある場合は再現手順か確認手順を残す

## テスト

最低限、変更に応じて以下を実行してください。

```bash
bun run verify
```

必要に応じて個別テストも使ってください。

```bash
bun test
bun test --coverage
KNOWFLOW_RUN_INTEGRATION=1 bun test test/knowflow/queuePostgres.integration.test.ts
```

## コミットメッセージ

Conventional Commits を使用します。

```text
feat: add unified knowledge search example
fix: handle embed command timeout correctly
refactor: split guidance service internals
docs: expand README quickstart
test: add config parsing coverage
```

## Pull Request に含めてほしいこと

- 背景と目的
- 主な変更点
- 互換性や移行の有無
- テスト内容
- 未解決事項やフォローアップ

## ドキュメント更新の目安

次の場合はドキュメント更新を推奨します。

- 新しいコマンド、ツール、環境変数を追加した
- README の手順に影響する
- 運用方法や設計判断が変わる
- Monitor / KnowFlow / Guidance の挙動が変わる

## 行動規範

参加者は `CODE_OF_CONDUCT.md` に従ってください。
