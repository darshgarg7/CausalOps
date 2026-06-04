"""Per-run Kafka publish counters for Phase 1b metrics."""

from __future__ import annotations

from dataclasses import dataclass, field

from bus.events import ArtifactType


@dataclass
class RunBusSummary:
    """Counts semantic artifacts published during one run."""

    parent_config_count: int = 0
    child_config_count: int = 0
    memo_count: int = 0
    has_ranked_strategies: bool = False
    has_causal_payload: bool = False
    has_estimate_report: bool = False
    telemetry_count: int = field(default=0, repr=False)

    def record(self, artifact_type: ArtifactType) -> None:
        """Increment counters for a published artifact type."""

        if artifact_type == ArtifactType.AGENT_CONFIG:
            self.parent_config_count += 1
        elif artifact_type == ArtifactType.CHILD_CONFIG:
            self.child_config_count += 1
        elif artifact_type == ArtifactType.DECISION_MEMO:
            self.memo_count += 1
        elif artifact_type == ArtifactType.RANKED_STRATEGIES:
            self.has_ranked_strategies = True
        elif artifact_type == ArtifactType.CAUSAL_PAYLOAD:
            self.has_causal_payload = True
        elif artifact_type == ArtifactType.CAUSAL_ESTIMATE_REPORT:
            self.has_estimate_report = True
        elif artifact_type == ArtifactType.EXECUTION_PHASE:
            self.telemetry_count += 1

    def to_dict(self) -> dict[str, int | bool]:
        return {
            "parent_config_count": self.parent_config_count,
            "child_config_count": self.child_config_count,
            "memo_count": self.memo_count,
            "has_ranked_strategies": self.has_ranked_strategies,
            "has_causal_payload": self.has_causal_payload,
            "has_estimate_report": self.has_estimate_report,
        }
