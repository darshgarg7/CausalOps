"""Unit tests for deterministic entity extraction — no LLM, no network."""

from __future__ import annotations

from memory.extractor import build_edges, extract_entities


def _run_artifact() -> dict:
    return {
        "run_id": "run-test-0001",
        "evidence_records": [
            {
                "asset_id": "host-01",
                "technique_id": "T1021.001",
                "cve_id": "CVE-2024-12345",
            },
            {
                "asset_id": "host-01",
                "technique_id": "T1021.001",
                "cve_id": None,
            },
            {
                "asset_id": "host-02",
                "technique_id": "not-a-technique",
                "cve_id": "garbage",
            },
        ],
        "causal_graph": {
            "nodes": [
                {"id": "Patch_Applied"},
                {"id": "Lateral_Movement"},
            ],
            "edges": [
                {
                    "source": "Patch_Applied",
                    "target": "Lateral_Movement",
                    "relationship": "reduces likelihood of",
                }
            ],
        },
    }


def test_extract_entities_returns_expected_types() -> None:
    entities = extract_entities(_run_artifact())

    assert ("asset", "host-01") in entities
    assert ("asset", "host-02") in entities
    assert ("technique", "T1021.001") in entities
    assert ("cve", "CVE-2024-12345") in entities
    assert ("graph_node", "Patch_Applied") in entities
    assert ("graph_node", "Lateral_Movement") in entities


def test_extract_entities_rejects_malformed_ids() -> None:
    entities = extract_entities(_run_artifact())

    assert ("technique", "not-a-technique") not in entities
    assert not any(t == "cve" and v.lower() == "garbage" for t, v in entities)


def test_extract_entities_deduplicates_and_sorts() -> None:
    entities = extract_entities(_run_artifact())

    assert len(entities) == len(set(entities))
    assert entities == sorted(entities)


def test_build_edges_returns_causal_graph_edges() -> None:
    artifact = _run_artifact()
    entities = extract_entities(artifact)
    edges = build_edges(artifact, entities)

    assert (
        "graph_node",
        "Patch_Applied",
        "reduces likelihood of",
        "graph_node",
        "Lateral_Movement",
    ) in edges


def test_build_edges_includes_asset_technique_cooccurrence() -> None:
    artifact = _run_artifact()
    entities = extract_entities(artifact)
    edges = build_edges(artifact, entities)

    assert ("asset", "host-01", "observed_with", "technique", "T1021.001") in edges


def test_build_edges_skips_endpoints_not_in_entity_pairs() -> None:
    artifact = _run_artifact()
    entities = [pair for pair in extract_entities(artifact) if pair[0] != "graph_node"]
    edges = build_edges(artifact, entities)

    assert all(edge[0] != "graph_node" and edge[3] != "graph_node" for edge in edges)
