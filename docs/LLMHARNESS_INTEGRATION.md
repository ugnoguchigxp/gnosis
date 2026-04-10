# llmharness Integration

このドキュメントは、`llmharness` の `localLlm` adapter を Gnosis と連携させる手順です。

## 仕組み

`llmharness` から CLI 経由で `gnosis` のラッパーを呼び出します。

1. `llmharness` がプロンプトを渡す
2. ラッパーが Gnosis の `searchMemory` で関連メモリを検索
3. 取得コンテキストをプロンプトに前置してローカル LLM API に送信
4. 生成結果を `llmharness` が読み取れる JSON で返す

実体: `src/integrations/llmharness-local-llm.ts`

## 事前準備

1. Gnosis DB が起動していること
2. `DATABASE_URL` が設定されていること（未設定時は `postgres://postgres:postgres@localhost:7888/gnosis`）
3. ローカル LLM が OpenAI 互換 API で待ち受けていること

## 主要な環境変数

- `LOCAL_LLM_API_BASE_URL` (default: `http://localhost:8000`)
- `LOCAL_LLM_API_PATH` (default: `/v1/chat/completions`)
- `LOCAL_LLM_API_KEY_ENV` (default: `LOCAL_LLM_API_KEY`)
- `LOCAL_LLM_API_KEY` (APIキーが必要な場合)
- `LOCAL_LLM_MODEL` (default: `gemma4-default`)
- `GNOSIS_SESSION_ID` (default: `llmharness`)
- `GNOSIS_CONTEXT_LIMIT` (default: `5`)
- `GNOSIS_LLMHARNESS_STORE=true` にすると入出力を `saveMemory` で保存

## llmharness 側設定例

`llmharness` の `configs/harness.config.json` で `adapters.localLlm` を `cli` モードにして以下を指定します。

```json
{
  "adapters": {
    "localLlm": {
      "mode": "cli",
      "command": "bun run llmharness:local-llm -- --prompt {{prompt}}",
      "commandPromptMode": "arg",
      "commandPromptPlaceholder": "{{prompt}}",
      "model": "gemma4-default",
      "timeoutMs": 180000,
      "temperature": 0
    }
  }
}
```

`llmharness` と `gnosis` が別ディレクトリの場合は、`command` を絶対パスで指定してください。

例:

```bash
bun --cwd /Users/y.noguchi/Code/gnosis run llmharness:local-llm -- --prompt {{prompt}}
```

## 単体疎通確認

```bash
cd /Users/y.noguchi/Code/gnosis
LOCAL_LLM_API_BASE_URL=http://localhost:8000 \
GNOSIS_SESSION_ID=llmharness-demo \
bun run llmharness:local-llm -- --prompt "TypeScriptでfetchのエラーハンドリングを追加するパッチを返して"
```

JSON で `response` が返れば接続成功です。
