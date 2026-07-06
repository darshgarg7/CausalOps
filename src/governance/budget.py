"""Token budget governance for LLM calls.

Instead of wrapping each of the 5 chain.invoke() call sites individually
(src/agents.py x3, src/causal.py, src/evaluator.py), this uses LangChain's
callback system so ALL calls through the LLM are governed at a single
chokepoint — wherever the LLM object is constructed (e.g. a get_llm() helper):

    from src.governance import BudgetCallbackHandler, global_budget

    llm = ChatGoogleGenerativeAI(
        model=...,
        callbacks=[BudgetCallbackHandler(global_budget)],
    )

How it works:
  * ``on_llm_end`` reads token usage from the response and charges the tracker.
    This works even with ``.with_structured_output()`` chains, because the
    callback fires on the underlying model call and sees the raw LLMResult —
    no ``include_raw=True`` changes needed in teammates' files.
  * ``on_chat_model_start`` / ``on_llm_start`` enforce the budget BEFORE the
    next call is made: once the budget is exhausted, the next LLM call raises
    ``BudgetExceeded`` instead of spending more.
  * ``raise_error = True`` ensures LangChain propagates our exception instead
    of swallowing it.

Provider notes (Gemini-first):
  * langchain-google-genai puts usage on the AIMessage as ``usage_metadata``
    with ``input_tokens`` / ``output_tokens`` — handled.
  * langchain-openai additionally reports ``llm_output["token_usage"]`` with
    ``prompt_tokens`` / ``completion_tokens`` — handled as fallback.
  * Raw SDK responses (google-generativeai / openai) are handled by
    :func:`extract_usage` for any code that bypasses LangChain.

Config (matching HIVEMIND_* convention):
  * HIVEMIND_GOVERNANCE_ENABLED=0 disables enforcement (usage still counted).
  * HIVEMIND_TOKEN_BUDGET — total token budget for the process/run
    (default 500000; set 0 for unlimited-but-tracked).
"""

import logging
import os
import threading
from typing import Any, Optional, Tuple

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult

logger = logging.getLogger(__name__)

GOVERNANCE_ENABLED = os.getenv("HIVEMIND_GOVERNANCE_ENABLED", "1") == "1"
DEFAULT_TOKEN_BUDGET = int(os.getenv("HIVEMIND_TOKEN_BUDGET", "500000"))


class BudgetExceeded(RuntimeError):
    """Raised when an LLM call is attempted after the token budget is spent."""


class BudgetTracker:
    """Accumulates token spend against a budget.

    Thread-safe (LangChain callbacks may fire from worker threads).
    A budget of 0 means "track but never enforce".
    """

    def __init__(self, max_tokens: int = DEFAULT_TOKEN_BUDGET, name: str = "global") -> None:
        self.max_tokens = max_tokens
        self.name = name
        self.input_tokens = 0
        self.output_tokens = 0
        self.call_count = 0
        self._lock = threading.Lock()

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def remaining(self) -> Optional[int]:
        if self.max_tokens <= 0:
            return None  # unlimited
        return self.max_tokens - self.total_tokens

    def exhausted(self) -> bool:
        return self.max_tokens > 0 and self.total_tokens >= self.max_tokens

    def charge(self, input_tokens: int, output_tokens: int) -> None:
        with self._lock:
            self.input_tokens += input_tokens
            self.output_tokens += output_tokens
            self.call_count += 1
        logger.info(
            "budget[%s]: +%d in / +%d out (total %d%s, %d calls)",
            self.name,
            input_tokens,
            output_tokens,
            self.total_tokens,
            f" of {self.max_tokens}" if self.max_tokens > 0 else "",
            self.call_count,
        )

    def enforce(self) -> None:
        if GOVERNANCE_ENABLED and self.exhausted():
            raise BudgetExceeded(
                f"Token budget '{self.name}' exhausted: "
                f"{self.total_tokens}/{self.max_tokens} tokens used "
                f"across {self.call_count} LLM calls."
            )

    def reset(self) -> None:
        with self._lock:
            self.input_tokens = 0
            self.output_tokens = 0
            self.call_count = 0

    def snapshot(self) -> dict:
        """For run artifacts / /health-style reporting."""
        return {
            "name": self.name,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "max_tokens": self.max_tokens,
            "call_count": self.call_count,
            "exhausted": self.exhausted(),
        }


#: Process-wide default budget. For per-run budgets, construct a fresh
#: BudgetTracker per run and pass its handler via invoke-time callbacks:
#:     chain.invoke(inputs, config={"callbacks": [BudgetCallbackHandler(run_budget)]})
global_budget = BudgetTracker()


def extract_usage(response: Any) -> Tuple[int, int]:
    """Return (input_tokens, output_tokens) from a raw provider response.

    Utility for any code path NOT going through LangChain callbacks.
    Handles LangChain AIMessage, raw Gemini SDK, and raw OpenAI SDK objects.
    """
    usage_meta = getattr(response, "usage_metadata", None)
    if isinstance(usage_meta, dict):  # LangChain AIMessage
        return usage_meta.get("input_tokens", 0), usage_meta.get("output_tokens", 0)
    if usage_meta is not None:  # raw google-generativeai
        return (
            getattr(usage_meta, "prompt_token_count", 0),
            getattr(usage_meta, "candidates_token_count", 0),
        )
    usage = getattr(response, "usage", None)  # raw openai
    if usage is not None:
        return (
            getattr(usage, "prompt_tokens", 0),
            getattr(usage, "completion_tokens", 0),
        )
    return 0, 0


def _usage_from_llm_result(result: LLMResult) -> Tuple[int, int]:
    """Pull token usage out of a LangChain LLMResult, across providers."""
    input_tokens = 0
    output_tokens = 0
    found = False

    # Path 1: usage_metadata on generation messages (Gemini, newer OpenAI).
    for gen_list in result.generations:
        for gen in gen_list:
            message = getattr(gen, "message", None)
            usage = getattr(message, "usage_metadata", None) if message else None
            if usage:
                input_tokens += usage.get("input_tokens", 0)
                output_tokens += usage.get("output_tokens", 0)
                found = True

    # Path 2: llm_output["token_usage"] (OpenAI-style aggregate).
    if not found and result.llm_output:
        token_usage = result.llm_output.get("token_usage") or result.llm_output.get(
            "usage_metadata"
        )
        if isinstance(token_usage, dict):
            input_tokens = token_usage.get("prompt_tokens", 0) or token_usage.get(
                "input_tokens", 0
            )
            output_tokens = token_usage.get("completion_tokens", 0) or token_usage.get(
                "output_tokens", 0
            )
            found = True

    if not found:
        logger.warning(
            "budget: could not extract token usage from LLMResult; "
            "provider may not report usage_metadata."
        )
    return input_tokens, output_tokens


class BudgetCallbackHandler(BaseCallbackHandler):
    """LangChain callback that meters and enforces a token budget.

    Attach once at LLM construction to govern every chain that uses that LLM
    (including .with_structured_output() chains), or pass per-invoke via
    ``config={"callbacks": [...]}`` for run-scoped budgets.
    """

    # Ensure LangChain propagates exceptions from this handler instead of
    # logging-and-continuing.
    raise_error = True

    def __init__(self, tracker: Optional[BudgetTracker] = None) -> None:
        self.tracker = tracker or global_budget

    # -- enforcement: block the NEXT call once budget is spent ---------------

    def on_chat_model_start(self, serialized, messages, **kwargs) -> None:
        self.tracker.enforce()

    def on_llm_start(self, serialized, prompts, **kwargs) -> None:
        self.tracker.enforce()

    # -- metering: charge actual usage after each call ------------------------

    def on_llm_end(self, response: LLMResult, **kwargs) -> None:
        input_tokens, output_tokens = _usage_from_llm_result(response)
        self.tracker.charge(input_tokens, output_tokens)