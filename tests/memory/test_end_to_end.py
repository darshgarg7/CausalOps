"""Full round-trip test: two sequential ``execute_run()`` calls through the
real coordinator, proving a completed run reaches Supabase via
``memory_write_node`` and comes back out through ``memory_retrieve_node`` as
``GraphState.memory_context`` on the next run.

Every other memory test calls ``store.write_run()`` / ``memory_retrieve_node()``
/ ``memory_write_node()`` in isolation. This is the only test that drives the
loop through ``coordinator.runner.execute_run()`` end to end. Skipped
automatically unless real Supabase credentials are configured (see
``tests/memory/test_store.py`` for the same pattern). Run with:

    pytest tests/memory/test_end_to_end.py -v -m integration
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from agents import _format_memory_context
from coordinator.runner import execute_run
from coordinator.store import RunStore, set_run_store
from memory.store import SupabaseMemoryStore
from schema import AgentConfig, ChildConfig, DecisionMemo

pytestmark = pytest.mark.integration

_SKIP_REASON = "Real Supabase credentials not configured in .env"

_ESTIMATE_REPORT = {
    "ate": -0.31,
    "method": "backdoor.linear_regression",
    "n_rows": 80,
}


def _has_credentials() -> bool:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    return bool(os.getenv("SUPABASE_URL")) and bool(key) and "your-" not in key


requires_credentials = pytest.mark.skipif(not _has_credentials(), reason=_SKIP_REASON)


@pytest.fixture
def store(tmp_path: Path) -> RunStore:
    run_store = RunStore(db_path=tmp_path / "runs.db")
    set_run_store(run_store)
    yield run_store
    set_run_store(None)


@pytest.fixture
def tagged_ids():
    tag = f"e2e-{uuid.uuid4().hex[:8]}"
    ids = {
        "tag": tag,
        "run_id_1": f"{tag}-run-1",
        "run_id_2": f"{tag}-run-2",
        "asset_id": f"{tag}-host-01",
        "technique_id": "T1021.001",
        "node_patched": f"{tag}-patched-host",
        "node_lateral": f"{tag}-lateral-movement",
    }
    yield ids
    _cleanup(ids)


def _cleanup(ids: dict[str, str]) -> None:
    memory_store = SupabaseMemoryStore()
    run_ids = [ids["run_id_1"], ids["run_id_2"]]
    memory_store._client.table("memory_entity_edges").delete().in_(
        "source_run_id", run_ids
    ).execute()
    memory_store._client.table("memory_runs").delete().in_(
        "run_id", run_ids
    ).execute()
    memory_store._client.table("memory_entities").delete().like(
        "entity_value", f"{ids['tag']}%"
    ).execute()


def _install_fake_nodes(ids: dict[str, str]) -> None:
    agents_mod = ModuleType("agents")
    agents_mod.grand_orchestrator_node = lambda _state: {
        "parent_configs": [
            AgentConfig(persona="Network", focus_objective="Trace lateral movement")
        ]
    }
    agents_mod.parent_agent_node = lambda _state: {
        "child_configs": [
            ChildConfig(
                parent_persona="Network",
                persona="EDR",
                focus_objective="Inspect host telemetry",
            )
        ]
    }
    agents_mod.child_agent_node = lambda _state: {
        "memos": [
            DecisionMemo(
                perspective="Containment",
                strategy="Isolate affected host segment",
                risks=["Downtime"],
            )
        ]
    }

    evaluator_mod = ModuleType("evaluator")
    evaluator_mod.evaluate_memos_node = lambda _state: {
        "ranked_strategies": [{"ranked_perspectives": ["Containment"]}],
        "final_recommendation": "Isolate affected host segment",
        "evaluator_error": None,
    }

    def fake_causal(_state: dict[str, Any]) -> dict[str, Any]:
        return {
            "causal_payload": {
                "graph": {
                    "nodes": [
                        {"id": ids["node_patched"]},
                        {"id": ids["node_lateral"]},
                    ],
                    "edges": [
                        {
                            "source": ids["node_patched"],
                            "target": ids["node_lateral"],
                            "relationship": "reduces likelihood of",
                        }
                    ],
                    "treatment_variable": "treatment",
                    "outcome_variable": "outcome",
                    "candidate_confounders": [],
                }
            },
        }

    def fake_estimator(_state: dict[str, Any]) -> dict[str, Any]:
        return {
            "dowhy_results": {
                "ate_estimate": _ESTIMATE_REPORT["ate"],
                "method": _ESTIMATE_REPORT["method"],
            },
            "causal_estimate_report": dict(_ESTIMATE_REPORT),
            "causal_dataset_profile": {},
            "causal_refutation_passed": True,
            "causal_refutation_attempts": 1,
        }

    causal_mod = ModuleType("causal")
    causal_mod.causal_synthesis_node = fake_causal
    causal_mod.dowhy_engine_node = fake_estimator

    sys.modules["agents"] = agents_mod
    sys.modules["evaluator"] = evaluator_mod
    sys.modules["causal"] = causal_mod


@requires_credentials
def test_memory_round_trips_through_real_coordinator(
    store: RunStore, tagged_ids: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_nodes(tagged_ids)
    monkeypatch.setattr("coordinator.runner.publish_telemetry", lambda **_: None)
    monkeypatch.setattr("coordinator.runner.bind_from_state", lambda _: None)

    tag = tagged_ids["tag"]
    evidence_records = [
        {
            "asset_id": tagged_ids["asset_id"],
            "technique_id": tagged_ids["technique_id"],
            "cve_id": None,
        }
    ]
    task_1 = (
        f"Incident {tag}: SOC lateral movement — attacker pivoted from patched "
        f"host {tagged_ids['asset_id']} via RDP using "
        f"{tagged_ids['technique_id']}, contained by isolating the host segment"
    )
    task_2 = (
        f"Incident {tag}: SOC lateral movement — attacker pivoted from patched "
        f"host {tagged_ids['asset_id']} via RDP using "
        f"{tagged_ids['technique_id']}, isolate the affected host segment now"
    )

    asyncio.run(
        execute_run(
            task_description=task_1,
            evidence_records=evidence_records,
            run_id=tagged_ids["run_id_1"],
            correlation_id=tagged_ids["run_id_1"],
            store=store,
        )
    )

    memory_store = SupabaseMemoryStore()
    written = memory_store.search_similar_runs(task_1, k=5)
    assert any(row.get("run_id") == tagged_ids["run_id_1"] for row in written)

    final_state_2 = asyncio.run(
        execute_run(
            task_description=task_2,
            evidence_records=evidence_records,
            run_id=tagged_ids["run_id_2"],
            correlation_id=tagged_ids["run_id_2"],
            store=store,
        )
    )

    memory_context = final_state_2["memory_context"]
    assert memory_context
    run_id_1 = tagged_ids["run_id_1"]
    matches = [entry for entry in memory_context if entry.get("run_id") == run_id_1]
    assert matches, f"run 1 not found in run 2's memory_context: {memory_context}"
    match = matches[0]
    assert match["ate"] == _ESTIMATE_REPORT["ate"]
    assert match["method"] == _ESTIMATE_REPORT["method"]
    assert match["n_rows"] == _ESTIMATE_REPORT["n_rows"]

    persisted_2 = store.get_run(tagged_ids["run_id_2"])
    assert persisted_2.memory_context == memory_context

    formatted = _format_memory_context(memory_context)
    assert tagged_ids["run_id_1"] in formatted
