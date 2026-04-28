
## Mandatory Startup

- **新規セッション開始時**: すべての作業の前に、必ず `initial_instructions` を呼び出してください。
- **レビュー開始時**: レビューフローを開始する前に、必ず `initial_instructions` を再度呼び出し、シナリオガイドを確認してください。

## Guardrail

- `initial_instructions` を呼び出す前に `review_task` を実行しないでください。
- フローが不明瞭な場合は、`doctor` を実行して状態を確認してください。
