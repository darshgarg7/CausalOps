"""Event envelope schema and artifact type registry."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field

Tier = Literal[
    "orchestrator",
    "parent",
    "child",
    "evaluator",
    "causal",
    "estimator",
    "reasoning",
    "optimizer",
    "control",
]


class ArtifactType(str, Enum):
    """Semantic artifact kinds published on the CausalOps bus."""

    AGENT_CONFIG = "agent_config"
    CHILD_CONFIG = "child_config"
    RUN_PARENT = "run_parent"
    RUN_CHILD = "run_child"
    TASK_COMPLETED = "task_completed"
    DECISION_MEMO = "decision_memo"
    RANKED_STRATEGIES = "ranked_strategies"
    CAUSAL_PAYLOAD = "causal_payload"
    CAUSAL_ESTIMATE_REPORT = "causal_estimate_report"
    REASONING_REPORT = "reasoning_report"
    AGENT_EVOLUTION_REPORT = "agent_evolution_report"
    POLICY_OPTIMIZATION_REPORT = "policy_optimization_report"
    RUN_STARTED = "run_started"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"
    EXECUTION_PHASE = "execution_phase"


class EventEnvelope(BaseModel):
    """Canonical Kafka message wrapper for all CausalOps events."""

    run_id: str
    correlation_id: str
    agent_id: str
    tier: Tier
    artifact_type: ArtifactType
    payload: dict[str, Any] = Field(default_factory=dict)
    sequence: int = 0
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
    )

    def model_post_init(self, __context: Any) -> None:
        if self.timestamp.tzinfo is None:
            self.timestamp = self.timestamp.replace(tzinfo=UTC)
