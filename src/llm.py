"""Unified LLM client factory for Gemini/OpenAI compatibility and Azure OpenAI."""

from __future__ import annotations

import os

from langchain_openai import AzureChatOpenAI, ChatOpenAI


def get_llm(temperature: float = 0.0) -> ChatOpenAI | AzureChatOpenAI:
    """Retrieve the configured LLM client.

    Supports Gemini/OpenAI compatibility endpoints if GEMINI_API_KEY / base_url
    env vars are provided, falling back to AzureChatOpenAI.
    """
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
