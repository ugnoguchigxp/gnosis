
## Mandatory Startup

- **利用方針確認時**: Gnosis の現行ツール方針が不明な場合だけ `initial_instructions` を呼び出してください。
- **非自明な実装・レビュー前**: 過去知識が結果を変え得る場合は `agentic_search` を使用してください。
- **raw候補確認時**: 語句・ベクトル的に近い候補やスコアを確認する場合だけ `search_knowledge` を使用してください。

## Guardrail

- `activate_project` / `start_task` / `finish_task` の lifecycle 導線は使用しないでください。
- フローが不明瞭な場合は、`doctor` を実行して状態を確認してください。
