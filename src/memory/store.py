"""Supabase-backed persistence for the CausalOps memory layer.

Pure Python, no HTTP framework here. Always uses the service_role key —
never the anon/publishable key, which is blocked from writing by RLS.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Any

from memory.embedder import embed_text
from memory.extractor import build_edges, extract_entities
from supabase import Client, create_client

logger = logging.getLogger(__name__)


def _as_rows(data: Any) -> list[dict[str, Any]]:
    """Narrow the Supabase client's loosely-typed response payload."""

    if not isinstance(data, list):
        return []
    return [row for row in data if isinstance(row, dict)]


class SupabaseMemoryStore:
    """Read/write interface for the memory_runs/memory_entities/edges tables."""

    def __init__(self) -> None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self._client: Client = create_client(url, key)

    def write_run(self, run_artifact: dict[str, Any]) -> dict[str, Any]:
        """Embed the task, upsert the run, then index its entities and edges.

        Raises on failure — unlike the read methods, callers need to know
        when a write did not happen.
        """

        run_id = run_artifact["run_id"]
        task_description = run_artifact.get("task_description") or ""
        embedding = embed_text(task_description)

        self._client.table("memory_runs").upsert(
            {
                "run_id": run_id,
                "task_description": task_description,
                "task_embedding": embedding,
                "memos": run_artifact.get("memos") or [],
                "causal_graph": run_artifact.get("causal_graph") or {},
                "estimate_report": run_artifact.get("causal_estimate_report") or {},
            },
            on_conflict="run_id",
        ).execute()

        entity_pairs = extract_entities(run_artifact)
        entity_ids = self._upsert_entities(entity_pairs)

        edge_rows = []
        for src_type, src_val, relationship, tgt_type, tgt_val in build_edges(
            run_artifact, entity_pairs
        ):
            source_id = entity_ids.get((src_type, src_val))
            target_id = entity_ids.get((tgt_type, tgt_val))
            if not source_id or not target_id:
                continue
            edge_rows.append(
                {
                    "source_entity_id": source_id,
                    "target_entity_id": target_id,
                    "relationship": relationship,
                    "source_run_id": run_id,
                }
            )
        if edge_rows:
            self._client.table("memory_entity_edges").insert(edge_rows).execute()

        return {"run_id": run_id, "entities_indexed": len(entity_pairs)}

    def search_similar_runs(
        self, task_description: str, k: int = 5
    ) -> list[dict[str, Any]]:
        """Vector-similarity + temporal-decay search over past runs."""

        try:
            embedding = embed_text(task_description)
            response = self._client.rpc(
                "search_similar_runs",
                {"query_embedding": embedding, "match_count": k},
            ).execute()
            return _as_rows(response.data)
        except Exception:
            logger.exception("search_similar_runs failed; returning empty results")
            return []

    def get_entity_relationships(
        self, entity_value: str, entity_type: str
    ) -> list[dict[str, Any]]:
        """Graph traversal for one entity's known relationships."""

        try:
            response = self._client.rpc(
                "get_entity_neighborhood",
                {"p_entity_value": entity_value, "p_entity_type": entity_type},
            ).execute()
            return _as_rows(response.data)
        except Exception:
            logger.exception(
                "get_entity_relationships failed for %s/%s", entity_type, entity_value
            )
            return []

    def get_asset_timeline(
        self, asset_id: str, since_days: int = 90
    ) -> list[dict[str, Any]]:
        """Chronological edges touching one asset over the trailing window."""

        try:
            cutoff = (datetime.now(UTC) - timedelta(days=since_days)).isoformat()
            response = (
                self._client.table("memory_entity_edges")
                .select(
                    "*, source_entity:source_entity_id(*), "
                    "target_entity:target_entity_id(*)"
                )
                .gte("created_at", cutoff)
                .order("created_at")
                .execute()
            )
            rows = _as_rows(response.data)
            return [row for row in rows if _touches_asset(row, asset_id)]
        except Exception:
            logger.exception("get_asset_timeline failed for asset %s", asset_id)
            return []

    def _upsert_entities(
        self, entity_pairs: list[tuple[str, str]]
    ) -> dict[tuple[str, str], str]:
        if not entity_pairs:
            return {}
        now = datetime.now(UTC).isoformat()
        rows = [
            {"entity_type": entity_type, "entity_value": entity_value, "last_seen": now}
            for entity_type, entity_value in entity_pairs
        ]
        response = (
            self._client.table("memory_entities")
            .upsert(rows, on_conflict="entity_type,entity_value")
            .execute()
        )
        entity_ids: dict[tuple[str, str], str] = {}
        for row in _as_rows(response.data):
            entity_type = row.get("entity_type")
            entity_value = row.get("entity_value")
            entity_id = row.get("id")
            if entity_type and entity_value and entity_id:
                entity_ids[(entity_type, entity_value)] = str(entity_id)
        return entity_ids


def _touches_asset(row: dict[str, Any], asset_id: str) -> bool:
    for key in ("source_entity", "target_entity"):
        entity = row.get(key) or {}
        matches_asset = (
            entity.get("entity_type") == "asset"
            and entity.get("entity_value") == asset_id
        )
        if matches_asset:
            return True
    return False
