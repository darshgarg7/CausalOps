"""Deterministic entity extraction from CausalOps run artifacts.

No LLM calls. Mirrors the normalization style of ``evidence_adapters.py``:
regex-gated field extraction over plain dicts.
"""

from __future__ import annotations

import re
from typing import Any

EntityPair = tuple[str, str]
EdgeTuple = tuple[str, str, str, str, str]

_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
_CVE_RE = re.compile(r"^CVE-\d{4}-\d+$", re.IGNORECASE)


def extract_entities(run_artifact: dict[str, Any]) -> list[EntityPair]:
    """Return deduplicated, sorted (entity_type, entity_value) pairs."""

    pairs: set[EntityPair] = set()

    for record in run_artifact.get("evidence_records") or []:
        asset_id = record.get("asset_id")
        if asset_id:
            pairs.add(("asset", str(asset_id)))

        technique_id = record.get("technique_id")
        if technique_id and _TECHNIQUE_RE.match(str(technique_id)):
            pairs.add(("technique", str(technique_id)))

        cve_id = record.get("cve_id")
        if cve_id and _CVE_RE.match(str(cve_id)):
            pairs.add(("cve", str(cve_id).upper()))

    causal_graph = run_artifact.get("causal_graph") or {}
    for node in causal_graph.get("nodes") or []:
        node_id = node.get("id")
        if node_id:
            pairs.add(("graph_node", str(node_id)))

    return sorted(pairs)


def build_edges(
    run_artifact: dict[str, Any],
    entity_pairs: list[EntityPair],
) -> list[EdgeTuple]:
    """Return (src_type, src_val, relationship, tgt_type, tgt_val) tuples.

    Only emits edges between entities already present in ``entity_pairs`` —
    entities not extracted by ``extract_entities`` won't exist as rows in
    ``memory_entities`` yet, and the edges table has FK constraints on both
    endpoints.
    """

    known = set(entity_pairs)
    edges: list[EdgeTuple] = []

    causal_graph = run_artifact.get("causal_graph") or {}
    for edge in causal_graph.get("edges") or []:
        source, target = edge.get("source"), edge.get("target")
        if not source or not target:
            continue
        src_pair, tgt_pair = ("graph_node", str(source)), ("graph_node", str(target))
        if src_pair not in known or tgt_pair not in known:
            continue
        relationship = str(edge.get("relationship") or "causes")
        edges.append((src_pair[0], src_pair[1], relationship, tgt_pair[0], tgt_pair[1]))

    for record in run_artifact.get("evidence_records") or []:
        asset_id = record.get("asset_id")
        technique_id = record.get("technique_id")
        valid_technique = technique_id and _TECHNIQUE_RE.match(str(technique_id))
        if not asset_id or not valid_technique:
            continue
        asset_pair = ("asset", str(asset_id))
        technique_pair = ("technique", str(technique_id))
        if asset_pair in known and technique_pair in known:
            edges.append(
                (
                    asset_pair[0],
                    asset_pair[1],
                    "observed_with",
                    technique_pair[0],
                    technique_pair[1],
                )
            )

    return edges
