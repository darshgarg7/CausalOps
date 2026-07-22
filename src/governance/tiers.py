"""Tiered agent-resource configuration (skeleton).

Opt-in and additive: with NO ``HIVEMIND_TIER_*`` env vars set,
:func:`get_llm_for_tier` reproduces exactly what :func:`llm.get_llm` does today
for that tier — same provider, same model, same temperature, and the same
(global) token budget. Nothing here changes behavior until an operator sets the
corresponding env vars.

Provider/model selection is delegated ENTIRELY to ``get_llm()``. This module
never hardcodes a provider or model name; it only layers tier-specific
overrides (temperature, max output tokens, per-tier budget) on top, and only
when the matching env var is present.

Env vars (all optional; ``<TIER>`` is ORCHESTRATOR | PARENT | CHILD | EVALUATOR):

    HIVEMIND_TIER_<TIER>_MODEL        override model (default: delegate to get_llm)
    HIVEMIND_TIER_<TIER>_TEMPERATURE  override sampling temperature
    HIVEMIND_TIER_<TIER>_MAX_TOKENS   override max output tokens
    HIVEMIND_TIER_<TIER>_BUDGET       per-tier token budget (default: global budget)

Default temperatures match the current call sites exactly:
    orchestrator / parent / evaluator = 0.4   (agents.py get_llm(0.4), evaluator.py)
    child                             = 0.0   (agents.py low_temp_llm)
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

from .budget import BudgetCallbackHandler, BudgetTracker, global_budget

# Canonical tier names.
ORCHESTRATOR = "orchestrator"
PARENT = "parent"
CHILD = "child"
EVALUATOR = "evaluator"
TIERS = (ORCHESTRATOR, PARENT, CHILD, EVALUATOR)

# Parity defaults derived from today's get_llm() call sites. Changing these
# would change behavior, so they are treated as the "no-op" baseline.
_DEFAULT_TEMPERATURE = {
    ORCHESTRATOR: 0.4,
    PARENT: 0.4,
    CHILD: 0.0,
    EVALUATOR: 0.4,
}


@dataclass(frozen=True)
class TierConfig:
    """Resolved resource configuration for a single agent tier.

    ``model``, ``max_output_tokens`` and ``budget`` are ``None`` by default,
    which means "delegate to get_llm() / use the global budget" — i.e. no
    behavior change. They become active only when the operator sets the
    corresponding ``HIVEMIND_TIER_*`` env var.
    """

    tier: str
    model: Optional[str] = None
    temperature: float = 0.0
    max_output_tokens: Optional[int] = None
    budget: Optional[int] = None


def _env(tier: str, suffix: str) -> Optional[str]:
    value = os.getenv(f"HIVEMIND_TIER_{tier.upper()}_{suffix}")
    if value is None:
        return None
    value = value.strip()
    return value or None


def _env_float(tier: str, suffix: str, default: float) -> float:
    raw = _env(tier, suffix)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(tier: str, suffix: str) -> Optional[int]:
    raw = _env(tier, suffix)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def load_tier_config(tier: str) -> TierConfig:
    """Build a :class:`TierConfig` for ``tier`` from the environment.

    Every value falls back to the current-behavior default when its env var is
    unset, so a fresh process with no ``HIVEMIND_TIER_*`` vars yields configs
    that are behavioral no-ops.
    """

    if tier not in TIERS:
        raise ValueError(f"Unknown tier {tier!r}; expected one of {TIERS}.")

    budget = _env_int(tier, "BUDGET")
    if budget is not None and budget <= 0:
        # 0 / negative means "no per-tier enforcement" -> fall back to global.
        budget = None

    return TierConfig(
        tier=tier,
        model=_env(tier, "MODEL"),
        temperature=_env_float(tier, "TEMPERATURE", _DEFAULT_TEMPERATURE[tier]),
        max_output_tokens=_env_int(tier, "MAX_TOKENS"),
        budget=budget,
    )


#: Snapshot of tier configs resolved at import time. With no env vars set this
#: is pure parity with today's behavior.
TIER_CONFIGS: dict[str, TierConfig] = {tier: load_tier_config(tier) for tier in TIERS}

# Per-tier budget trackers, created lazily so tiers with no configured budget
# never allocate one (and keep falling back to the global budget).
_TIER_TRACKERS: dict[str, BudgetTracker] = {}


def _tier_tracker(cfg: TierConfig) -> BudgetTracker:
    tracker = _TIER_TRACKERS.get(cfg.tier)
    if tracker is None or tracker.max_tokens != cfg.budget:
        tracker = BudgetTracker(max_tokens=cfg.budget or 0, name=f"tier:{cfg.tier}")
        _TIER_TRACKERS[cfg.tier] = tracker
    return tracker


def get_llm_for_tier(tier: str) -> Any:
    """Return an LLM client configured for ``tier``.

    No-op by default: delegates provider/model selection to ``get_llm()`` and
    only applies overrides that were explicitly set via ``HIVEMIND_TIER_*``.

    * temperature — always passed through (its default equals the tier's
      current call-site temperature, so behavior is unchanged).
    * model / max_output_tokens — applied via ``.bind()`` only when configured.
      (Bound as ``model`` / ``max_tokens``; provider-specific token-parameter
      normalization, e.g. NVIDIA's ``max_completion_tokens``, is a follow-up.)
    * budget — ``get_llm()`` already attaches a global ``BudgetCallbackHandler``.
      When a tier has no budget we attach nothing (avoids double-counting and
      keeps the global chokepoint intact); a tier-scoped handler is added only
      when ``HIVEMIND_TIER_<TIER>_BUDGET`` is set.
    """

    # Imported lazily to avoid an import cycle (llm.py imports from governance).
    from llm import get_llm

    cfg = TIER_CONFIGS[tier]
    llm = get_llm(temperature=cfg.temperature)

    overrides: dict[str, Any] = {}
    if cfg.model is not None:
        overrides["model"] = cfg.model
    if cfg.max_output_tokens is not None:
        overrides["max_tokens"] = cfg.max_output_tokens
    if overrides:
        llm = llm.bind(**overrides)

    if cfg.budget is not None:
        tracker = _tier_tracker(cfg)
        llm = llm.with_config(callbacks=[BudgetCallbackHandler(tracker)])
    # else: rely on the global BudgetCallbackHandler already attached by get_llm().

    return llm


def tier_budget_tracker(tier: str) -> BudgetTracker:
    """Return the tracker governing ``tier`` (the tier's own, or the global)."""

    cfg = TIER_CONFIGS[tier]
    if cfg.budget is None:
        return global_budget
    return _tier_tracker(cfg)
