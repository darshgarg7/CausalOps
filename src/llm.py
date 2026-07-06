"""Unified LLM client factory for NVIDIA, OpenAI-compatible, and Azure models."""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from langchain_openai import AzureChatOpenAI, ChatOpenAI

DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b"
NVIDIA_PROFILES = {
    "fast": {
        "reasoning_effort": "none",
        "max_tokens": 1024,
        "reasoning_budget": 0,
    },
    "balanced": {
        "reasoning_effort": "medium",
        "max_tokens": 1536,
        "reasoning_budget": 1024,
    },
    "deep": {
        "reasoning_effort": "high",
        "max_tokens": 4096,
        "reasoning_budget": 4096,
    },
}
REASONING_BUDGET_BY_EFFORT = {
    "none": 0,
    "medium": 1024,
    "high": 4096,
}


@lru_cache(maxsize=4)
def get_llm(temperature: float = 0.0) -> Any:
    """Retrieve the configured LLM client.

    Provider priority:
    1. NVIDIA API Catalog / NIM via ChatNVIDIA.
    2. Generic OpenAI-compatible endpoints, including Gemini compatibility.
    3. Azure OpenAI fallback.
    """
    nvidia_key = os.getenv("NVIDIA_API_KEY")
    if nvidia_key:
        return _get_nvidia_llm(temperature=temperature, api_key=nvidia_key)

    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("GEMINI_BASE_URL") or os.getenv("OPENAI_BASE_URL")
    model = os.getenv("GEMINI_MODEL") or os.getenv("OPENAI_MODEL") or "gemini-2.5-flash"

    if api_key and base_url:
        return ChatOpenAI(
            api_key=api_key,
            base_url=base_url,
            model=model,
            temperature=temperature,
        )

    # Fallback to Azure OpenAI
    return AzureChatOpenAI(
        azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
        api_key=os.getenv("AZURE_OPENAI_API_KEY"),
        azure_deployment=os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
        api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2025-01-01-preview"),
        temperature=temperature,
    )


def _get_nvidia_llm(*, temperature: float, api_key: str) -> Any:
    """Return a ChatNVIDIA client configured for Nemotron/NIM endpoints."""

    try:
        from langchain_nvidia_ai_endpoints import ChatNVIDIA
    except ImportError as exc:
        raise RuntimeError(
            "NVIDIA_API_KEY is set, but langchain-nvidia-ai-endpoints is not "
            "installed. Run `pip install -r requirements.txt`."
        ) from exc

    profile = _env_choice(
        "NVIDIA_PROFILE",
        default="balanced",
        allowed=set(NVIDIA_PROFILES),
    )
    profile_defaults = NVIDIA_PROFILES[profile]
    reasoning_effort = _env_choice(
        "NVIDIA_REASONING_EFFORT",
        default=str(profile_defaults["reasoning_effort"]),
        allowed={"none", "medium", "high"},
    )
    enable_thinking = reasoning_effort != "none"
    if "NVIDIA_ENABLE_THINKING" in os.environ:
        enable_thinking = _env_bool("NVIDIA_ENABLE_THINKING", enable_thinking)

    kwargs: dict[str, Any] = {
        "model": os.getenv("NVIDIA_MODEL", DEFAULT_NVIDIA_MODEL),
        "api_key": api_key,
        "temperature": _env_float("NVIDIA_TEMPERATURE", temperature),
        "top_p": _env_float("NVIDIA_TOP_P", 0.95),
        "max_completion_tokens": _env_int(
            "NVIDIA_MAX_TOKENS",
            int(profile_defaults["max_tokens"]),
        ),
        "timeout": _env_float("NVIDIA_TIMEOUT", 240.0),
    }

    base_url = os.getenv("NVIDIA_BASE_URL")
    if base_url:
        kwargs["base_url"] = base_url

    kwargs["chat_template_kwargs"] = {"enable_thinking": enable_thinking}
    if enable_thinking:
        default_budget = int(
            profile_defaults["reasoning_budget"]
            or REASONING_BUDGET_BY_EFFORT[reasoning_effort]
        )
        kwargs["reasoning_budget"] = _env_int(
            "NVIDIA_REASONING_BUDGET",
            default_budget,
        )

    seed = _env_int_optional("NVIDIA_SEED")
    if seed is not None:
        kwargs["seed"] = seed

    stop = _env_stop("NVIDIA_STOP")
    if stop is not None:
        kwargs["stop"] = stop

    return ChatNVIDIA(**kwargs)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _env_int_optional(name: str) -> int | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _env_choice(name: str, *, default: str, allowed: set[str]) -> str:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in allowed:
        return normalized
    return default


def _env_stop(name: str) -> str | list[str] | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return parts
