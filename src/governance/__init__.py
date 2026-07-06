"""Resource governance for CausalOps/Hivemind.

Everything here is opt-in and additive: guards are attached at chokepoints
(FastAPI route decorators, LLM construction) without modifying existing logic.
Disable everything with HIVEMIND_GOVERNANCE_ENABLED=0.
"""

from .limits import (
    payload_size_guard,
    run_admission_guard,
    run_slots,
)
from .budget import (
    BudgetExceeded,
    BudgetTracker,
    BudgetCallbackHandler,
    global_budget,
    extract_usage,
)

__all__ = [
    "payload_size_guard",
    "run_admission_guard",
    "run_slots",
    "BudgetExceeded",
    "BudgetTracker",
    "BudgetCallbackHandler",
    "global_budget",
    "extract_usage",
]