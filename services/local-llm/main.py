#!/usr/bin/env python3
import warnings
import os
import json
import re
from datetime import datetime, timezone
from pathlib import Path
import uuid

# 全ての警告を抑制（特に multiprocessing の resource_tracker 対策）
warnings.filterwarnings("ignore")
os.environ["PYTHONWARNINGS"] = "ignore"

import argparse
import sys
import asyncio
from core.chat_engine import ChatEngine


SESSION_ID_RE = r"^[A-Za-z0-9_-]{6,64}$"


class FileSessionStore:
    def __init__(self, session_dir: str | None = None):
        default_dir = Path.home() / ".localLlm" / "sessions"
        self.session_dir = Path(session_dir) if session_dir else default_dir
        self.session_dir.mkdir(parents=True, exist_ok=True)

    def _session_path(self, session_id: str) -> Path:
        return self.session_dir / f"{session_id}.json"

    def load(self, session_id: str) -> dict | None:
        path = self._session_path(session_id)
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)

    def save(
        self,
        session_id: str,
        messages: list[dict],
        backend: str,
        model: str,
        system_instruction: str,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        path = self._session_path(session_id)
        existing = None
        if path.exists():
            with path.open("r", encoding="utf-8") as f:
                existing = json.load(f)

        payload = {
            "session_id": session_id,
            "created_at": existing.get("created_at", now) if existing else now,
            "updated_at": now,
            "backend": backend,
            "model": model,
            "system_instruction": system_instruction,
            "messages": messages,
        }
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)


def _generate_session_id() -> str:
    return f"sess_{uuid.uuid4().hex[:12]}"


def _validate_session_id(session_id: str) -> bool:
    return re.match(SESSION_ID_RE, session_id) is not None

def _is_truthy_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}

async def main():
    parser = argparse.ArgumentParser(description="Multi-Backend AI Chat Agent (Local Direct Tooling)")
    parser.add_argument("--backend", choices=["mlx", "ollama", "bonsai", "mock"], default="mlx", help="Inference backend")
    parser.add_argument("--model", type=str, help="Model path or name")
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--temp", type=float, default=0.0)
    parser.add_argument("--verbose", "-v", action="store_true", help="Display debug logs and raw model output")
    parser.add_argument("prompt", nargs="?", help="Single-turn prompt (non-interactive mode)")
    parser.add_argument("--prompt", dest="prompt_opt", type=str, help="Single-turn prompt (non-interactive mode)")
    parser.add_argument("--session-id", type=str, help="Session ID to resume/save chat history")
    parser.add_argument("--session-dir", type=str, help="Directory to store session files")
    parser.add_argument("--no-session", action="store_true", help="Disable session persistence in single-turn mode")
    parser.add_argument("--output", choices=["json", "text"], default="json", help="Output format in single-turn mode")
    args = parser.parse_args()

    # NOTE:
    # In seatbelt/headless sandboxed sessions, MLX may abort the process during
    # Metal device discovery before Python can catch exceptions
    # (see ml-explore/mlx#3148). To avoid repeated crash dialogs and make
    # failure recoverable for callers, block MLX backends by default in that context.
    if (
        args.backend in {"mlx", "bonsai"}
        and os.getenv("CODEX_SANDBOX") == "seatbelt"
        and not _is_truthy_env("LOCAL_LLM_ALLOW_MLX_IN_SEATBELT")
    ):
        print(
            "[Startup Error] MLX backends are disabled in CODEX_SANDBOX=seatbelt to avoid"
            " native aborts during Metal initialization."
            " Use --backend ollama or set LOCAL_LLM_ALLOW_MLX_IN_SEATBELT=1 to override.",
            file=sys.stderr,
        )
        sys.exit(78)

    # バックエンドの動的インポート
    if args.backend == "mlx":
        from backends.mlx import MLXBackend
        backend = MLXBackend(verbose=args.verbose)
        model_path = args.model or "mlx-community/gemma-4-e4b-it-4bit"
    elif args.backend == "ollama":
        from backends.ollama import OllamaBackend
        backend = OllamaBackend(verbose=args.verbose)
        model_path = args.model or "llama3"
    elif args.backend == "bonsai":
        from backends.bonsai import BonsaiBackend
        backend = BonsaiBackend(verbose=args.verbose)
        model_path = args.model or "prism-ml/Bonsai-8B-mlx-1bit"
    elif args.backend == "mock":
        from backends.mock_backend import MockBackend
        backend = MockBackend(verbose=args.verbose)
        model_path = args.model or "test-mock-model"

    # モデルのロード
    try:
        if args.verbose:
            print(f"[Debug] Loading backend: {args.backend} with model: {model_path}")
        backend.load_model(model_path)
    except Exception as e:
        print(f"Failed to load model: {e}")
        sys.exit(1)

    # Engineの初期化
    engine = ChatEngine(backend, verbose=args.verbose)
    
    # バックエンドに応じたコンテキスト設定
    current_date = datetime.now().strftime("%Y年%m月%d日")
    if args.backend == "bonsai":
        sys_instr = (
            f"あなたは有能な助手です。本日は {current_date} です。必ず日本語で答えてください。\n"
            "【最短最速で回答せよ】情報の不足がある場合は、前置きや解説（「調べます」「わかりません」等）を一切行わず、即座にツールを呼び出してください。\n"
            "検索が必要な場合は、第一声で必ず以下のタグを出力してください。\n\n"
            "- 検索: <|tool_call|>call:search_web{query:\"検索ワード\"}<tool_call|>\n\n"
            "例: 「今日の東京の天気」→ 即座に以下を出力:\n"
            "<|tool_call|>call:search_web{query:\"今日の東京の天気\"}<tool_call|>"
        )
    elif args.backend == "mlx":
        sys_instr = (
            f"あなたは有能なアシスタントです。本日は {current_date} です。日本語で回答してください。\n"
            "【思考と実行】最新情報が必要な場合は、まず `<|channel>thought` で思考のプロセスを記述し、その直後に必ず以下のツールを呼び出してください。\n"
            "1. search_web(query): ウェブ検索。形式: <|tool_call|>call:search_web{query:\"検索語\"}<tool_call|>\n"
            "2. fetch_content(url): サイト内容取得。形式: <|tool_call|>call:fetch_content{url:\"URL\"}<tool_call|>\n\n"
            "検索結果を受け取るまでは回答を捏造せず、「検索結果によると」と事実に基づいて答えてください。"
        )
    else:
        sys_instr = "優秀なAI助手。日本語で答えて。<|tool_call|>形式で検索ツールを使用可能。"

    prompt = args.prompt_opt if args.prompt_opt is not None else args.prompt
    use_single_turn = bool(prompt)
    session_store: FileSessionStore | None = None

    session_id: str | None = args.session_id
    session_created = False
    if session_id:
        if not _validate_session_id(session_id):
            print("Invalid --session-id. Use 6-64 chars: A-Z a-z 0-9 _ -")
            sys.exit(2)
    elif use_single_turn and not args.no_session:
        session_id = _generate_session_id()
        session_created = True

    if session_id and not args.no_session:
        session_store = FileSessionStore(args.session_dir)
        record = session_store.load(session_id)
        if record and isinstance(record.get("messages"), list):
            engine.messages = record["messages"]
            if args.verbose:
                print(f"[Debug] Loaded session: {session_id} ({len(engine.messages)} messages)")
        else:
            engine.reset(sys_instr)
    else:
        engine.reset(sys_instr)

    if use_single_turn:
        response_text = engine.run_turn(
            prompt,
            max_tokens=args.max_tokens,
            temperature=args.temp,
        )

        if session_store and session_id and not args.no_session:
            session_store.save(
                session_id=session_id,
                messages=engine.messages,
                backend=args.backend,
                model=model_path,
                system_instruction=sys_instr,
            )

        if args.output == "json":
            result = {
                "session_id": session_id,
                "session_created": session_created,
                "backend": args.backend,
                "model": model_path,
                "message_count": len(engine.messages),
                "response": response_text,
            }
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(response_text)
        return

    backend_labels = {
        "mlx": "Gemma 4",
        "bonsai": "Bonsai",
        "ollama": "Ollama",
        "mock": "Mock",
    }
    model_label = f"{backend_labels.get(args.backend, args.backend)} ({model_path})"
    print(f"\n=== Chat session started ===")
    print(f"  Model   : {model_label}")
    if session_id:
        print(f"  Session : {session_id}")
    print(f"  Commands: exit · reset · Ctrl+C to quit\n")

    # メインループ
    try:
        while True:
            try:
                loop = asyncio.get_event_loop()
                u_inp = await loop.run_in_executor(None, lambda: input("You: "))
                u_inp = u_inp.strip()
            except EOFError:
                break
            
            if not u_inp: continue
            if u_inp.lower() == "exit": break
            if u_inp.lower() == "reset":
                engine.reset(sys_instr)
                if session_store and session_id and not args.no_session:
                    session_store.save(
                        session_id=session_id,
                        messages=engine.messages,
                        backend=args.backend,
                        model=model_path,
                        system_instruction=sys_instr,
                    )
                print("Chat history reset.")
                continue

            # チャット実行
            await engine.chat_loop(u_inp, max_tokens=args.max_tokens, temperature=args.temp)
            if session_store and session_id and not args.no_session:
                session_store.save(
                    session_id=session_id,
                    messages=engine.messages,
                    backend=args.backend,
                    model=model_path,
                    system_instruction=sys_instr,
                )
            
    finally:
        # 終了時にリソースを適切に解放
        pass

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBye.")
        try:
            sys.exit(0)
        except SystemExit:
            os._exit(0)
    except Exception as e:
        print(f"\n[Fatal Error] {e}")
        sys.exit(1)
