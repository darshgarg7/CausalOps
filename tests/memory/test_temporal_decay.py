"""Correctness test for the search_similar_runs temporal-decay math.

Deliberately deferred in earlier passes (see CLAUDE.md / vault notes) on the
assumption that verifying it would need a raw-SQL fixture, since
``SupabaseMemoryStore.write_run()`` always lets Postgres default
``created_at`` to ``now()``. That assumption doesn't hold: ``created_at`` is
a plain column with no protecting trigger, so a normal REST ``.update()``
call after the initial write backdates it just fine (confirmed live before
writing this test).

Two rows share the exact same ``task_description`` (so their embeddings, and
therefore their cosine similarity to that same string, are identical) and one
is backdated by exactly one half-life (30 days). If the decay math
(``exp(-0.023 * age_in_days)``) is correct, the backdated row's
``weighted_score`` should be ~50.16% of the fresh row's, and its
``temporal_weight`` alone should match that same ratio.
"""

from __future__ import annotations

import math
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from memory.store import SupabaseMemoryStore

pytestmark = pytest.mark.integration

_SKIP_REASON = "Real Supabase credentials not configured in .env"
_DECAY_LAMBDA = 0.023
_HALF_LIFE_DAYS = 30


def _has_credentials() -> bool:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    return bool(os.getenv("SUPABASE_URL")) and bool(key) and "your-" not in key


requires_credentials = pytest.mark.skipif(not _has_credentials(), reason=_SKIP_REASON)


@pytest.fixture
def tagged_runs():
    tag = f"decay-{uuid.uuid4().hex[:8]}"
    ids = {"tag": tag, "fresh": f"{tag}-fresh", "old": f"{tag}-old"}
    yield ids
    store = SupabaseMemoryStore()
    store._client.table("memory_runs").delete().in_(
        "run_id", [ids["fresh"], ids["old"]]
    ).execute()


@requires_credentials
def test_older_run_decays_to_expected_half_life_ratio(tagged_runs) -> None:
    tag = tagged_runs["tag"]
    task_description = f"Incident {tag}: decay math correctness check"
    store = SupabaseMemoryStore()

    for run_id in (tagged_runs["fresh"], tagged_runs["old"]):
        store.write_run(
            {
                "run_id": run_id,
                "task_description": task_description,
                "memos": [],
                "causal_graph": {},
                "causal_estimate_report": {},
            }
        )

    backdated = (datetime.now(UTC) - timedelta(days=_HALF_LIFE_DAYS)).isoformat()
    store._client.table("memory_runs").update({"created_at": backdated}).eq(
        "run_id", tagged_runs["old"]
    ).execute()

    results = store.search_similar_runs(task_description, k=5)
    by_run_id = {row["run_id"]: row for row in results}
    fresh = by_run_id[tagged_runs["fresh"]]
    old = by_run_id[tagged_runs["old"]]

    expected_ratio = math.exp(-_DECAY_LAMBDA * _HALF_LIFE_DAYS)
    actual_ratio = old["weighted_score"] / fresh["weighted_score"]

    assert fresh["weighted_score"] > old["weighted_score"]
    assert actual_ratio == pytest.approx(expected_ratio, abs=0.01)
    assert old["temporal_weight"] == pytest.approx(expected_ratio, abs=0.01)
