"""Always-ready embedding daemon for local multilingual-e5-small."""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from e5embed import cli as core
try:
    from services.shared.daemon_queue import (
        PRIORITIES,
        QueueItem,
        SingleWorkerPriorityQueue,
    )
except ModuleNotFoundError:  # pragma: no cover - supports running tests from services/embedding
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from services.shared.daemon_queue import (
        PRIORITIES,
        QueueItem,
        SingleWorkerPriorityQueue,
    )


@dataclass
class EmbedPayload:
    texts: list[str]
    embed_type: str
    normalize: bool


class EmbeddingDaemon:
    def __init__(
        self,
        model_dir: str | Path,
        model_class: Callable[[str], Any] | None = None,
    ) -> None:
        model_path = Path(model_dir)
        if not model_path.exists():
            raise FileNotFoundError(
                f"Model not found: {model_path}\nRun: python scripts/download_model.py"
            )

        resolved_model_class = model_class or core.get_model_class()
        self.model_dir = model_path
        self.model = resolved_model_class(str(model_path))
        self._queue: SingleWorkerPriorityQueue[EmbedPayload, dict[str, Any]] = (
            SingleWorkerPriorityQueue("embedding", self._handle_embed)
        )

    def embed(
        self,
        texts: list[str],
        embed_type: str = "passage",
        normalize: bool = True,
        priority: str = "normal",
        timeout: float | None = None,
    ) -> dict[str, Any]:
        if embed_type not in {"query", "passage"}:
            raise ValueError("type must be 'query' or 'passage'")
        clean_texts: list[str] = []
        for index, text in enumerate(texts):
            if not isinstance(text, str):
                raise ValueError(f"texts[{index}] must be a string")
            clean_text = text.strip()
            if not clean_text:
                raise ValueError(f"texts[{index}] must be a non-empty string")
            clean_texts.append(clean_text)

        payload = EmbedPayload(texts=clean_texts, embed_type=embed_type, normalize=normalize)
        return self._queue.submit(payload, priority=priority, timeout=timeout)

    def health(self) -> dict[str, Any]:
        return {
            "ready": True,
            "modelDir": str(self.model_dir),
            **self._queue.health(),
        }

    def shutdown(self) -> None:
        self._queue.shutdown()

    def _handle_embed(self, item: QueueItem[EmbedPayload, dict[str, Any]]) -> dict[str, Any]:
        request = item.payload
        prefixed = [f"{request.embed_type}: {text}" for text in request.texts]
        encode_start = time.perf_counter()
        vectors = self.model.encode(
            prefixed,
            normalize_embeddings=request.normalize,
        )
        encode_ms = (time.perf_counter() - encode_start) * 1000
        embeddings = [vector.tolist() for vector in vectors]
        return {
            "embeddings": embeddings,
            "dimension": len(embeddings[0]) if embeddings else 0,
            "count": len(embeddings),
            "type": request.embed_type,
            "normalize": request.normalize,
            "queueWaitMs": round((encode_start - item.queued_at) * 1000, 3),
            "encodeMs": round(encode_ms, 3),
        }


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("request body must be a JSON object")
    return parsed


def _write_json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def build_handler(daemon: EmbeddingDaemon, request_timeout: float):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib hook
            if self.path != "/health":
                _write_json(self, 404, {"error": "not_found"})
                return
            _write_json(self, 200, daemon.health())

        def do_POST(self) -> None:  # noqa: N802 - stdlib hook
            if self.path != "/embed":
                _write_json(self, 404, {"error": "not_found"})
                return
            try:
                body = _read_json(self)
                texts = body.get("texts")
                if not isinstance(texts, list):
                    raise ValueError("texts must be an array")
                result = daemon.embed(
                    texts,
                    embed_type=str(body.get("type", "passage")),
                    normalize=bool(body.get("normalize", True)),
                    priority=str(body.get("priority", "normal")),
                    timeout=request_timeout,
                )
                _write_json(self, 200, result)
            except TimeoutError as exc:
                _write_json(self, 503, {"error": str(exc)})
            except Exception as exc:
                _write_json(self, 400, {"error": str(exc)})

        def log_message(self, format: str, *args: Any) -> None:
            return

    return Handler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="e5embed-daemon")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=44512)
    parser.add_argument(
        "--model-dir",
        default=str(core.DEFAULT_MODEL_DIR),
        help="Local model directory (default: models/multilingual-e5-small)",
    )
    parser.add_argument("--request-timeout", type=float, default=30.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    daemon = EmbeddingDaemon(args.model_dir)
    server = ThreadingHTTPServer((args.host, args.port), build_handler(daemon, args.request_timeout))
    print(
        json.dumps(
            {
                "event": "embedding_daemon.ready",
                "host": args.host,
                "port": args.port,
                "modelDir": str(daemon.model_dir),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        daemon.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
