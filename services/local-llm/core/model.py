from __future__ import annotations

import os
import threading
import time
from typing import Any, Generator

DEFAULT_MODEL_PATH = os.getenv("GEMMA4_MODEL", "mlx-community/gemma-4-e4b-it-4bit")
DEFAULT_MODEL_ID = os.getenv("GEMMA4_API_MODEL_ID", "gemma-4-e4b-it")


class MLXModelManager:
    """Thread-safe manager for a single MLX model instance."""

    def __init__(
        self,
        default_model_path: str = DEFAULT_MODEL_PATH,
        model_id: str = DEFAULT_MODEL_ID,
    ) -> None:
        self.default_model_path = default_model_path
        self.model_id = model_id
        self.created = int(time.time())

        self._lock = threading.Lock()
        self._model: Any | None = None
        self._tokenizer: Any | None = None
        self._model_path: str | None = None

    def _import_mlx(self):
        try:
            from mlx_lm import generate, load
            from mlx_lm.sample_utils import make_sampler
        except ImportError as exc:
            raise RuntimeError(
                "mlx-lm is not installed. Install dependencies with `pip install -r requirements.txt`."
            ) from exc
        return load, generate, make_sampler

    def validate_model(self, requested_model: str | None) -> str:
        if not requested_model:
            return self.default_model_path

        if requested_model in {self.model_id, self.default_model_path}:
            return self.default_model_path

        raise ValueError(f"Unsupported model: {requested_model}")

    def ensure_loaded(self, model_path: str | None = None) -> None:
        target_model = model_path or self.default_model_path
        with self._lock:
            if self._model is not None and self._tokenizer is not None and self._model_path == target_model:
                return

            load, _, _ = self._import_mlx()
            self._model, self._tokenizer = load(target_model)
            self._model_path = target_model

    def generate_stream(
        self,
        messages: list[dict[str, str]],
        model: str | None = None,
        max_tokens: int = 1024,
        temperature: float = 0.0,
    ) -> Generator[str, None, None]:
        target_model = self.validate_model(model)
        self.ensure_loaded(target_model)

        _, generate, make_sampler = self._import_mlx()

        with self._lock:
            if self._model is None or self._tokenizer is None:
                raise RuntimeError("Model is not loaded")

            prompt = self._tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=True,
                tokenize=False,
            )

            for chunk in generate(
                self._model,
                self._tokenizer,
                prompt=prompt,
                sampler=make_sampler(temperature),
                max_tokens=max_tokens,
            ):
                yield chunk

    def list_models(self) -> list[dict[str, Any]]:
        return [
            {
                "id": self.model_id,
                "object": "model",
                "created": self.created,
                "owned_by": "local-mlx",
            }
        ]


_MODEL_MANAGER: MLXModelManager | None = None


def get_model_manager() -> MLXModelManager:
    global _MODEL_MANAGER
    if _MODEL_MANAGER is None:
        _MODEL_MANAGER = MLXModelManager()
    return _MODEL_MANAGER
