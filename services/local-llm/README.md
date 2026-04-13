# Gemma 4 Local Runtime (MLX + Ollama + Bonsai)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)

このプロジェクトは、Apple Silicon (MLX) や Ollama を活用して、高性能な LLM ローカル実行環境および自律型エージェント機能を提供します。

## ✨ 特徴

- **マルチバックエンド対応**: MLX (Gemma 4, Bonsai) と Ollama をシームレスに切り替え。
- **自律型エージェント**: Web検索 (`Brave Search`) やウェブスクレイピング機能を搭載したツール実行機能。
- **OpenAI 互換 API**: `/v1/chat/completions` エンドポイントを提供し、Zed, VSCode (Continue) 等の IDE から利用可能。
- **MCP (Model Context Protocol)**: 外部ツールを標準化されたプロトコルで呼び出し可能。
- **高速な CLI**: ターミナルから直接モデルと対話できる専用スクリプト群。

---

## 🚀 クイックスタート

### 1. プロジェクトの準備

```bash
git clone https://github.com/YOUR_USERNAME/localLlm.git
cd localLlm

# 仮想環境の作成とライブラリのインストール
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 環境設定
cp .env.example .env
```

`.env` 内の `BRAVE_SEARCH_API_KEY` を設定すると、Web検索ツールが有効になります。

### 2. インストール手順 (バックエンド別)

#### 🦙 Ollama
[Ollama 公式サイト](https://ollama.com/) からアプリをダウンロードしてインストールしてください。

```bash
# 推奨モデルのプル
ollama pull llama3
```

#### 💎 Gemma 4 (MLX)
Apple Silicon Mac を使用している場合、MLX バックエンドを推奨します。

```bash
# MLX 版 Gemma 4 のセットアップ（初回実行時に自動ダウンロードされます）
./scripts/gemma4 "Hello, who are you?"
```

#### 🌳 Bonsai (MLX)
Bonsai は MLX 最適化された高性能 8B モデルです。

```bash
# Bonsai の実行（初回実行時に自動ダウンロードされます）
./scripts/bonsai "複雑なアルゴリズムについて解説して"
```

### 3. PATH の設定 (推奨)

以下のスクリプトを実行することで、どこからでも `gemma4` などのコマンドを実行できるようになります。

```bash
bash scripts/install_path.sh
# 実行後、指示に従って shell を再起動または source してください
```

### 4. CLI セッション維持モード (サーバー不要)

`main.py` / `scripts/gemma4` は単発実行モードをサポートしています。  
`--prompt` を付けると1回だけ推論し、`session_id` を含むJSONを返します。

```bash
./scripts/gemma4 --prompt "Rustの所有権を一言で説明して"
```

レスポンス例:

```json
{"session_id":"sess_xxxxx","session_created":true,"backend":"mlx","model":"mlx-community/gemma-4-e4b-it-4bit","message_count":3,"response":"..."}
```

同じセッションを継続するには `--session-id` を再指定します。

```bash
./scripts/gemma4 --session-id sess_xxxxx --prompt "もう少し詳しく"
```

主なオプション:

- `--prompt`: 単発実行モード
- `--session-id`: 既存セッションの継続
- `--no-session`: セッションを保存しない
- `--session-dir`: セッション保存先ディレクトリを指定
- `--output text`: JSONではなく回答テキストのみ出力

セッション保存先のデフォルトは `~/.localLlm/sessions` です。

### 5. 他プロジェクトからの利用 (CLI連携)

別プロジェクトからサブプロセスとしてこのCLIを呼び出す場合は、`--prompt` + JSON出力を前提にすると扱いやすくなります。

連携フロー（推奨）:

1. 初回リクエストは `--prompt` のみで実行
2. 返ってきた `session_id` を呼び出し元で保持
3. 2回目以降は `--session-id <取得したID>` を付けて実行

```bash
# 初回
./scripts/gemma4 --prompt "設計方針を3点で"

# 継続
./scripts/gemma4 --session-id sess_xxxxx --prompt "2点目を詳しく"
```

返却JSONの主な項目:

- `session_id`: 継続会話に使うセッションID
- `session_created`: 初回作成かどうか (`true/false`)
- `backend`: 使用バックエンド (`mlx` / `ollama` / `bonsai` など)
- `model`: 実際に使用したモデル名
- `message_count`: 現在セッションに保持されているメッセージ数
- `response`: アシスタントの回答本文

テキスト本文だけ必要な場合は `--output text` を指定してください。

---

## 🛠️ ディレクトリ構成

```text
.
├── scripts/            # 実行用ショートカットスクリプト (gemma4, bonsai, ollama-v4)
├── core/               # モデル制御・チャットエンジンのコアロジック
├── api/                # OpenAI 互換 FastAPI 実装
├── backends/           # MLX, Ollama などのバックエンド抽象化
├── mcp/                # MCP Server 実装
├── tools.py            # Web検索・スクレイピングツールの実装
└── main.py             # メインエントリポイント
```

---

## 🌐 OpenAI 互換 API の利用

API サーバーを起動することで、既存の OpenAI クライアントや IDE 拡張からローカル LLM を利用できます。

```bash
./scripts/run_openai_api.sh
```

### IDE 設定例 (Zed)

```json
{
  "language_models": {
    "gemma4-local": {
      "provider": "openai",
      "api_url": "http://localhost:44448/v1",
      "model": "gemma-4-e4b-it"
    }
  }
}
```

---

## 🔌 MCP Tools Server

MCP 対応クライアントからツールを利用する場合：

```bash
python mcp/tools_server.py
```

---

## 📜 ライセンス

[MIT License](LICENSE)
