from __future__ import annotations

from fastapi import FastAPI

from api.routes.chat import router as chat_router
from api.routes.models import router as models_router

app = FastAPI(
    title="Gemma 4 OpenAI-Compatible API",
    description="Local MLX Gemma 4 served with OpenAI-compatible endpoints.",
    version="0.1.0",
)

app.include_router(models_router)
app.include_router(chat_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    import os
    import uvicorn

    host = os.getenv("GEMMA4_API_HOST", "0.0.0.0")
    port = int(os.getenv("GEMMA4_API_PORT", "44448"))
    uvicorn.run("api.main:app", host=host, port=port, reload=False)
