# 目的

**Gemma 4 (MLX) を OpenAI互換API として外部から利用可能にする**

IDE等で動作するAgent（Claude Desktop, Zed, VSCode等）から、Gemma 4を標準的なLLM APIとして利用できるようにする。

以下の2つのエントリーポイントで Gemma 4 を提供：

1. **OpenAI互換 REST API** - Zed/VSCode等のLLM設定で利用可能
   - `/v1/chat/completions` - OpenAI Chat Completions API互換
   - `/v1/models` - 利用可能モデル一覧
2. **MCP Server** (stdio) - Claude Desktop等が Gemma 4 を呼び出せるツールとして公開

**既存機能の維持：**
- `mcp_server.py` (Web検索・スクレイピング) - Gemma 4 が使うツールとして継続稼働
- `mlx_chat.py` / `mlx_chat_mcp.py` - CLI チャットとして継続稼働

---

# 基本設計方針

## 最重要原則

* **OpenAI互換APIを実装** - Zed/VSCode等で標準LLMとして利用可能に
* **MCP Serverも提供** - Claude Desktop等のMCPクライアント対応
* **既存の Web検索 MCP Server を維持** - Gemma 4 が内部で使用
* **既存CLI機能を壊さない** - 段階的な拡張のみ実施
* **軽量設計** - 過度な抽象化を避け、実用的なシンプルさを保つ

---

# システム構成（簡略版）

以下のコンポーネントを実装する：

## Phase 1: 基盤整備（1日）
* **Core Layer** - MLX モデル管理の共通化
* **Chat Engine** - チャットロジック（Gemma 4のツール呼び出し構文解析）
* **Tools Integration** - `tools.py`を直接呼び出し（MCPサーバー不要）
  - **注**: OpenAI APIは既存MCP Tools Serverを使わず、`tools.py`の関数を直接実行

## Phase 2: OpenAI互換 REST API（1-2日）
* **FastAPI アプリケーション**
  - `POST /v1/chat/completions` - OpenAI Chat Completions API互換
  - `GET /v1/models` - 利用可能モデル一覧
  - ストリーミング対応（`stream=true`）
  - ツール呼び出し対応（`tools` パラメータ）
* **既存 MCP Server の維持** - `mcp_server.py` (web_search, fetch_content)

## Phase 3: Gemma 4 MCP Server（1日）
* **MCP Gateway for Gemma 4** - Claude Desktop が Gemma 4 を呼び出せる MCP Server
  - ツール: `gemma4_chat` - Gemma 4 にメッセージを送信
  - ツール: `gemma4_search_and_answer` - Web検索付きで回答生成

## Phase 4: 統合テスト（0.5日）
* **OpenAI API互換性検証** - curl / Python OpenAI SDK でテスト
* **IDE統合テスト** - Zed/VSCode での動作確認
* **ドキュメント整備**

---

# アーキテクチャ設計

## ディレクトリ構成

```
gemma4/
├── core/
│   ├── __init__.py
│   ├── model.py          # MLXモデル管理（Gemma 4ロード・推論）
│   └── chat_engine.py    # チャットロジック（tools.py直接呼び出し）
├── api/
│   ├── __init__.py
│   ├── main.py           # FastAPI アプリケーション
│   ├── routes/
│   │   ├── chat.py       # /v1/chat/completions
│   │   └── models.py     # /v1/models
│   └── schemas.py        # OpenAI互換Pydanticスキーマ
├── mcp/
│   ├── tools_server.py   # 既存: Web検索ツールサーバー（Gemma 4が使用）
│   └── gemma4_server.py  # 新規（オプション）: Gemma 4をツールとして公開
├── tools.py              # 既存: Web検索・スクレイピング実装
├── mlx_chat.py           # 既存CLIクライアント（維持）
├── mlx_chat_mcp.py       # 既存MCPクライアント（維持）
└── requirements.txt
```

**重要な構成：**
- `api/main.py` - **OpenAI互換REST API** - Zed/VSCode等で利用
- `mcp/tools_server.py` - **既存の `mcp_server.py` をリネーム** - Gemma 4 が使うツール群
- `mcp/gemma4_server.py` - **新規（オプション）** - Claude Desktop用
- **`db/` ディレクトリは不要** - OpenAI APIはステートレス

---

# エントリーポイント仕様

## 1. OpenAI互換 REST API

FastAPI を使用し、以下のエンドポイントを実装する。

### `POST /v1/chat/completions`
OpenAI Chat Completions API 互換のエンドポイント。

**Request:**
```json
{
  "model": "gemma-4-e4b-it",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "最新のPython情報を教えて"}
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1024,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "Search the web",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {"type": "string"}
          }
        }
      }
    }
  ]
}
```

**Response (stream=false):**
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "gemma-4-e4b-it",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Python 3.12が2023年10月にリリースされました..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 50,
    "total_tokens": 70
  }
}
```

**Response (stream=true):**
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gemma-4-e4b-it","choices":[{"index":0,"delta":{"role":"assistant","content":"Python"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gemma-4-e4b-it","choices":[{"index":0,"delta":{"content":" 3.12"},"finish_reason":null}]}

data: [DONE]
```

### `GET /v1/models`
利用可能なモデル一覧を返す。

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gemma-4-e4b-it",
      "object": "model",
      "created": 1677652288,
      "owned_by": "local-mlx"
    }
  ]
}
```

**Zed/VSCodeでの設定例:**
```json
{
  "language_models": {
    "gemma4": {
      "provider": "openai",
      "api_url": "http://localhost:8000/v1",
      "model": "gemma-4-e4b-it"
    }
  }
}
```

---

## 2. MCP Server (Gemma 4) - オプション

**Phase 1-2で実装しない。Phase 3で検討。**

Claude Desktop等のMCPクライアントは、OpenAI互換APIを直接利用可能。
ただし、特殊なユースケース（プロンプトテンプレート、コンテキスト管理等）がある場合は以下を実装：

### `gemma4_chat`
Gemma 4 にメッセージを送信して回答を得る。

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "送信するメッセージ"
    },
    "enable_tools": {
      "type": "boolean",
      "description": "Web検索ツールを有効化するか（デフォルト: true）"
    }
  },
  "required": ["message"]
}
```

**代替案**: Claude Desktopで直接OpenAI互換APIを設定する方が簡単
```json
{
  "mcpServers": {
    "gemma4": {
      "command": "npx",
      "args": ["-y", "openai-mcp-server"],
      "env": {
        "OPENAI_API_BASE": "http://localhost:8000/v1"
      }
    }
  }
}
```

---

## 3. MCP Server (Tools) - 既存維持

Gemma 4 が内部で使用するツール群。**既存の `mcp_server.py` をそのまま維持。**

**ツール:**
- `web_search` - Web検索（Brave Search API）
- `fetch_content` - URLコンテンツ取得

---

# モデル管理

現時点では **MLX ローカルモデル (Gemma 4)** のみをサポートする。

将来的な拡張として以下のモードを検討：

* `local`: MLXローカルモデル（現在実装済み）
* `session`: クライアント提供のAPI認証（将来実装）

セキュリティ原則：

* **APIキーをデータベースに永続化しない**
* `session` モードでは、API キーをインメモリでのみ保持（30分TTL）
* セッション期限切れ時に即座に破棄

---

# 実装優先順位

以下の順序で実装する：

## Phase 1: 基盤整備（1日）
1. ディレクトリリファクタリング（`core/`, `api/`, `mcp/`）
2. `core/model.py` - MLXモデル管理
3. `core/chat_engine.py` - チャットロジックの共通化

## Phase 2: OpenAI互換 REST API（1-2日）
4. FastAPI基本構造
5. `/v1/chat/completions` - OpenAI互換エンドポイント
6. `/v1/models` - モデル一覧
7. ストリーミング対応（Server-Sent Events）
8. ツール呼び出し統合（Gemma 4 → `tools.py`直接実行）

## Phase 3: テスト・ドキュメント（0.5日）
9. OpenAI API互換性検証（curl / Python OpenAI SDK）
10. IDE統合テスト（Zed/VSCodeでの設定・動作確認）
11. README更新（設定方法・使用例）

## Phase 4: MCP Server for Gemma 4（オプション・1日）
12. `mcp/gemma4_server.py` - 特殊ユースケース向け
13. Claude Desktopでの動作確認

---

# 成功条件

以下を満たすこと：

* ✅ Zed/VSCodeで Gemma 4 がOpenAI互換APIとして動作
* ✅ ストリーミング応答が正しく動作
* ✅ ツール呼び出し（Web検索）が正しく機能（`tools.py`直接実行）
* ✅ 既存のCLIチャット機能が引き続き動作
* ✅ 既存のWeb検索MCPサーバー（`mcp_server.py`）が正常稼働

**オプション:**
* Claude DesktopからMCP経由で Gemma 4 を呼び出せる（Phase 4実装時）

---

# 使用例

## Zed での利用

`.config/zed/settings.json`:
```json
{
  "language_models": {
    "gemma4-local": {
      "provider": "openai",
      "api_url": "http://localhost:8000/v1",
      "model": "gemma-4-e4b-it"
    }
  }
}
```

## VSCode での利用

`settings.json`:
```json
{
  "continue.models": [
    {
      "title": "Gemma 4 Local",
      "provider": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "model": "gemma-4-e4b-it"
    }
  ]
}
```

## curl での利用

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma-4-e4b-it",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

---

# 出力要求

* ✅ ディレクトリ構成
* ✅ 主要モジュールコード
* ✅ API仕様（OpenAPI）
* ✅ MCPツール定義
* ✅ サンプル実行手順

**除外:**
* ❌ データベース設計 - 不要（OpenAI APIはステートレス）
* ❌ 会話履歴機能 - 別プロジェクトで実装（メモリーMCPサーバー）
