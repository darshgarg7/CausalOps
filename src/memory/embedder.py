"""Gemini text embedding client for the CausalOps memory layer.

Azure OpenAI embeddings are unavailable (credits exhausted); this uses
Gemini's OpenAI-compatible endpoint with ``gemini-embedding-001``, truncated
to 1536 dimensions to match the existing ``memory_runs.task_embedding``
pgvector column.
"""

from __future__ import annotations

import logging
import os
import time

from openai import OpenAI

logger = logging.getLogger(__name__)

_MAX_CHARS = 32000
_MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = (1.0, 2.0, 4.0)
_EMBEDDING_MODEL = "gemini-embedding-001"
_EMBEDDING_DIMENSIONS = 1536


def embed_text(text: str) -> list[float]:
    """Embed text using Gemini's gemini-embedding-001 model (1536-dim).

    Synchronous and makes a network call — callers in async contexts must
    wrap with ``await asyncio.to_thread(embed_text, text)``.
    """

    client = OpenAI(
        api_key=os.environ["GEMINI_API_KEY"],
        base_url=os.environ["GEMINI_BASE_URL"],
    )
    truncated = text[:_MAX_CHARS]

    last_exc: Exception = RuntimeError("embed_text: no attempts were made")
    for attempt in range(_MAX_ATTEMPTS):
        try:
            response = client.embeddings.create(
                model=_EMBEDDING_MODEL,
                input=truncated,
                dimensions=_EMBEDDING_DIMENSIONS,
            )
            return response.data[0].embedding
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "embed_text attempt %s/%s failed: %s", attempt + 1, _MAX_ATTEMPTS, exc
            )
            if attempt < _MAX_ATTEMPTS - 1:
                time.sleep(_BACKOFF_SECONDS[attempt])

    raise last_exc
