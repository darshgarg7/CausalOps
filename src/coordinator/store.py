"""SQLite-backed durable run state for the Phase 2 coordinator."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from paths import data_dir
from schema import AgentConfig, ChildConfig, DecisionMemo, GraphState

DEFAULT_DB_PATH = data_dir() / "runs.db"

_DEFAULT_STORE: RunStore | None = None


def get_run_store() -> RunStore:
    """Return the process-default run store."""

    global _DEFAULT_STORE
    if _DEFAULT_STORE is None:
        _DEFAULT_STORE = RunStore()
    return _DEFAULT_STORE


def set_run_store(store: RunStore | None) -> None:
    """Override the process-default run store (tests)."""

    global _DEFAULT_STORE
    _DEFAULT_STORE = store


@dataclass
class RunRecord:
    """In-memory view of one investigation run."""

    run_id: str
    correlation_id: str
    task_description: str
    phase: str = "created"
    status: str = "running"
    error_detail: str | None = None
    evidence_records: list[dict[str, Any]] = field(default_factory=list)
    parent_configs: list[AgentConfig] = field(default_factory=list)
    child_configs: list[ChildConfig] = field(default_factory=list)
    memos: list[DecisionMemo] = field(default_factory=list)
    ranked_strategies: list[dict[str, Any]] = field(default_factory=list)
    final_recommendation: str | None = None
    evaluator_error: str | None = None
    causal_payload: dict[str, Any] | None = None
    causal_refutation_passed: bool = False
    causal_refutation_attempts: int = 0
    dowhy_results: dict[str, Any] | None = None
    causal_dataset_profile: dict[str, Any] | None = None
    causal_estimate_report: dict[str, Any] | None = None
    reasoning_report: dict[str, Any] | None = None
    agent_evolution_report: dict[str, Any] | None = None
    policy_optimization_report: dict[str, Any] | None = None
    expected_parent_count: int = 0
    completed_parent_count: int = 0
    expected_child_count: int = 0
    completed_child_count: int = 0
    processed_idempotency_keys: list[str] = field(default_factory=list)

    def to_graph_state(self) -> GraphState:
        """Build a GraphState dict for existing node functions."""

        return {
            "task_description": self.task_description,
            "run_id": self.run_id,
            "correlation_id": self.correlation_id,
            "parent_configs": self.parent_configs,
            "child_configs": self.child_configs,
            "memos": self.memos,
            "ranked_strategies": self.ranked_strategies,
            "final_recommendation": self.final_recommendation,
            "evaluator_error": self.evaluator_error,
            "causal_payload": self.causal_payload,
            "causal_refutation_passed": self.causal_refutation_passed,
            "causal_refutation_attempts": self.causal_refutation_attempts,
            "dowhy_results": self.dowhy_results,
            "evidence_records": self.evidence_records,
            "causal_dataset_profile": self.causal_dataset_profile,
            "causal_estimate_report": self.causal_estimate_report,
            "reasoning_report": self.reasoning_report,
            "agent_evolution_report": self.agent_evolution_report,
            "policy_optimization_report": self.policy_optimization_report,
        }

    def apply_node_update(self, update: dict[str, Any]) -> None:
        """Merge a node return dict into this record."""

        if "parent_configs" in update:
            self.parent_configs = list(update["parent_configs"])
            self.expected_parent_count = len(self.parent_configs)
        if "child_configs" in update:
            self.child_configs.extend(update["child_configs"])
        if "memos" in update:
            self.memos.extend(update["memos"])
        for key in (
            "ranked_strategies",
            "final_recommendation",
            "evaluator_error",
            "causal_payload",
            "causal_refutation_passed",
            "causal_refutation_attempts",
            "dowhy_results",
            "causal_dataset_profile",
            "causal_estimate_report",
            "reasoning_report",
            "agent_evolution_report",
            "policy_optimization_report",
        ):
            if key in update:
                setattr(self, key, update[key])

    def parents_barrier_met(self) -> bool:
        """True when all parent agents have finished."""

        if self.expected_parent_count == 0:
            return False
        return self.completed_parent_count >= self.expected_parent_count

    def children_barrier_met(self) -> bool:
        """True when all child agents have finished."""

        if self.expected_child_count == 0:
            return False
        return self.completed_child_count >= self.expected_child_count

    def idempotency_seen(self, key: str) -> bool:
        """Return True when a spawn command was already processed."""

        return key in self.processed_idempotency_keys


class RunStore:
    """Persist coordinator run state in SQLite."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path or DEFAULT_DB_PATH)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            # Rollback-journal (not WAL): WAL needs shared-memory mmap of a -shm
            # file, which is unreliable on Docker bind-mounted volumes (virtiofs/
            # gRPC-FUSE behave like a network FS) and surfaces as "disk I/O
            # error" / "locking protocol". DELETE mode uses only POSIX locks; a
            # generous busy_timeout lets concurrent api/worker access queue
            # instead of failing.
            conn.execute("PRAGMA journal_mode=DELETE;")
            conn.execute("PRAGMA busy_timeout=30000;")
            conn.execute("PRAGMA synchronous=NORMAL;")
        except sqlite3.OperationalError:
            pass
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        try:
            with conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS runs (
                        run_id TEXT PRIMARY KEY,
                        correlation_id TEXT NOT NULL,
                        task_description TEXT NOT NULL,
                        phase TEXT NOT NULL DEFAULT 'created',
                        status TEXT NOT NULL DEFAULT 'running',
                        state_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS idempotency_claims (
                        run_id TEXT NOT NULL,
                        idempotency_key TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'claimed',
                        claimed_at TEXT NOT NULL,
                        PRIMARY KEY (run_id, idempotency_key)
                    )
                    """
                )
        finally:
            conn.close()

    def get_5d_graph(self, run_id: str) -> dict[str, Any]:
        """Fetch the compiled 5D spatiotemporal graph nodes and edges.

        Reads from the dedicated graph DB (written by the worker's stream
        consumer), not runs.db.
        """

        from graph_5d import connect_graph_db
        from graph_5d import get_5d_graph as fetch_5d

        conn = connect_graph_db()
        try:
            with conn:
                return fetch_5d(conn, run_id)
        finally:
            conn.close()

    def create_run(
        self,
        *,
        run_id: str,
        correlation_id: str,
        task_description: str,
        evidence_records: list[dict[str, Any]] | None = None,
        status: str = "running",
    ) -> RunRecord:
        """Insert a new run record."""

        record = RunRecord(
            run_id=run_id,
            correlation_id=correlation_id,
            task_description=task_description,
            evidence_records=evidence_records or [],
            phase="created",
            status=status,
        )
        self.save(record)
        return record

    def enqueue_run(
        self,
        *,
        run_id: str,
        correlation_id: str,
        task_description: str,
        evidence_records: list[dict[str, Any]] | None = None,
    ) -> RunRecord:
        """Create a queued run awaiting background execution."""

        record = RunRecord(
            run_id=run_id,
            correlation_id=correlation_id,
            task_description=task_description,
            evidence_records=evidence_records or [],
            phase="queued",
            status="queued",
        )
        self.save(record)
        return record

    def set_status(
        self,
        record: RunRecord,
        status: str,
        *,
        error_detail: str | None = None,
    ) -> None:
        """Update run lifecycle status."""

        record.status = status
        if error_detail is not None:
            record.error_detail = error_detail
        self.save(record)

    def get_run(self, run_id: str) -> RunRecord:
        """Load a run record by id."""

        with self._connect() as conn:
            row = conn.execute(
                "SELECT state_json FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"Run not found: {run_id}")
        return _record_from_json(json.loads(row["state_json"]))

    def save(self, record: RunRecord) -> None:
        """Upsert run record."""

        now = datetime.now(UTC).isoformat()
        payload = _record_to_json(record)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO runs (
                    run_id, correlation_id, task_description, phase, status,
                    state_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    phase = excluded.phase,
                    status = excluded.status,
                    state_json = excluded.state_json,
                    updated_at = excluded.updated_at
                """,
                (
                    record.run_id,
                    record.correlation_id,
                    record.task_description,
                    record.phase,
                    record.status,
                    json.dumps(payload),
                    now,
                    now,
                ),
            )

    def set_phase(self, record: RunRecord, phase: str) -> None:
        """Update run phase and persist."""

        record.phase = phase
        self.save(record)

    def mark_parent_complete(self, record: RunRecord) -> int:
        """Increment completed parent count; return new total."""

        record.completed_parent_count += 1
        self.save(record)
        return record.completed_parent_count

    def mark_child_complete(self, record: RunRecord) -> int:
        """Increment completed child count; return new total."""

        record.completed_child_count += 1
        self.save(record)
        return record.completed_child_count

    def append_child_configs(
        self,
        record: RunRecord,
        configs: list[ChildConfig],
    ) -> int:
        """Append child configs from a parent agent."""

        record.child_configs.extend(configs)
        self.save(record)
        return len(record.child_configs)

    def append_memo(self, record: RunRecord, memo: DecisionMemo) -> int:
        """Append one decision memo."""

        record.memos.append(memo)
        self.save(record)
        return len(record.memos)

    def mark_idempotent(self, record: RunRecord, key: str) -> None:
        """Record a processed spawn idempotency key (legacy helper)."""

        self.complete_idempotency_claim(record.run_id, key, record)

    def try_claim_idempotency(self, run_id: str, key: str) -> bool:
        """Atomically claim a spawn command.

        Returns False if the command was already claimed or completed.
        """

        if not key:
            return True

        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            existing = conn.execute(
                """
                SELECT status FROM idempotency_claims
                WHERE run_id = ? AND idempotency_key = ?
                """,
                (run_id, key),
            ).fetchone()
            if existing is not None:
                return False
            conn.execute(
                """
                INSERT INTO idempotency_claims (
                    run_id, idempotency_key, status, claimed_at
                )
                VALUES (?, ?, 'claimed', ?)
                """,
                (run_id, key, now),
            )
            return True

    def complete_idempotency_claim(
        self,
        run_id: str,
        key: str,
        record: RunRecord,
    ) -> None:
        """Mark a claimed spawn command as successfully processed."""

        if not key:
            return

        with self._connect() as conn:
            conn.execute(
                """
                UPDATE idempotency_claims
                SET status = 'completed'
                WHERE run_id = ? AND idempotency_key = ?
                """,
                (run_id, key),
            )
        if key not in record.processed_idempotency_keys:
            record.processed_idempotency_keys.append(key)
        self.save(record)

    def release_idempotency_claim(self, run_id: str, key: str) -> None:
        """Release an in-flight claim so a retriable failure can be redelivered."""

        if not key:
            return

        with self._connect() as conn:
            conn.execute(
                """
                DELETE FROM idempotency_claims
                WHERE run_id = ? AND idempotency_key = ? AND status = 'claimed'
                """,
                (run_id, key),
            )


def _record_to_json(record: RunRecord) -> dict[str, Any]:
    return {
        "run_id": record.run_id,
        "correlation_id": record.correlation_id,
        "task_description": record.task_description,
        "phase": record.phase,
        "status": record.status,
        "error_detail": record.error_detail,
        "evidence_records": record.evidence_records,
        "parent_configs": [c.model_dump() for c in record.parent_configs],
        "child_configs": [c.model_dump() for c in record.child_configs],
        "memos": [m.model_dump() for m in record.memos],
        "ranked_strategies": record.ranked_strategies,
        "final_recommendation": record.final_recommendation,
        "evaluator_error": record.evaluator_error,
        "causal_payload": record.causal_payload,
        "causal_refutation_passed": record.causal_refutation_passed,
        "causal_refutation_attempts": record.causal_refutation_attempts,
        "dowhy_results": record.dowhy_results,
        "causal_dataset_profile": record.causal_dataset_profile,
        "causal_estimate_report": record.causal_estimate_report,
        "reasoning_report": record.reasoning_report,
        "agent_evolution_report": record.agent_evolution_report,
        "policy_optimization_report": record.policy_optimization_report,
        "expected_parent_count": record.expected_parent_count,
        "completed_parent_count": record.completed_parent_count,
        "expected_child_count": record.expected_child_count,
        "completed_child_count": record.completed_child_count,
        "processed_idempotency_keys": record.processed_idempotency_keys,
    }


def _record_from_json(data: dict[str, Any]) -> RunRecord:
    return RunRecord(
        run_id=data["run_id"],
        correlation_id=data["correlation_id"],
        task_description=data["task_description"],
        phase=data.get("phase", "created"),
        status=data.get("status", "running"),
        error_detail=data.get("error_detail"),
        evidence_records=data.get("evidence_records") or [],
        parent_configs=[
            AgentConfig.model_validate(c) for c in data.get("parent_configs", [])
        ],
        child_configs=[
            ChildConfig.model_validate(c) for c in data.get("child_configs", [])
        ],
        memos=[DecisionMemo.model_validate(m) for m in data.get("memos", [])],
        ranked_strategies=data.get("ranked_strategies") or [],
        final_recommendation=data.get("final_recommendation"),
        evaluator_error=data.get("evaluator_error"),
        causal_payload=data.get("causal_payload"),
        causal_refutation_passed=bool(data.get("causal_refutation_passed", False)),
        causal_refutation_attempts=int(data.get("causal_refutation_attempts", 0)),
        dowhy_results=data.get("dowhy_results"),
        causal_dataset_profile=data.get("causal_dataset_profile"),
        causal_estimate_report=data.get("causal_estimate_report"),
        reasoning_report=data.get("reasoning_report"),
        agent_evolution_report=data.get("agent_evolution_report"),
        policy_optimization_report=data.get("policy_optimization_report"),
        expected_parent_count=int(data.get("expected_parent_count", 0)),
        completed_parent_count=int(data.get("completed_parent_count", 0)),
        expected_child_count=int(data.get("expected_child_count", 0)),
        completed_child_count=int(data.get("completed_child_count", 0)),
        processed_idempotency_keys=list(data.get("processed_idempotency_keys") or []),
    )
