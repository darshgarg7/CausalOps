# CausalOps — Claude Code Project Instructions

## What This Project Is

CausalOps is an evidence-backed causal reasoning engine for cyber SOC operations. The core design principle: **the LLM proposes hypotheses, deterministic code falsifies them**. The LLM designs a causal DAG. A separate evidence compiler ingests real SIEM/CVE/incident data, gates it statistically, and only then runs DoWhy estimation. If evidence is too weak, ATE is withheld. This is not a bug — it is the point.

## The Task in Progress

Implementing the **Persistent Semantic Memory and Retrieval Layer** from the roadmap.

Five components:
1. **Vector store** — every completed run is embedded (`gemini-embedding-001` via Gemini's OpenAI-compatible endpoint, truncated to 1536-dim — Azure OpenAI embeddings are unavailable, credits exhausted) and stored in Supabase pgvector. New incidents retrieve the 3 most similar past runs before the orchestrator decomposes them.
2. **Knowledge graph** — entities (assets, MITRE techniques, CVEs, graph nodes) extracted from evidence records and causal graphs are persisted as nodes and edges across runs.
3. **Temporal indexing** — cosine similarity is multiplied by `exp(-0.023 * age_in_days)` (30-day half-life decay).
4. **MCP server** — Standalone FastMCP process — runs as `python -m memory.mcp_server` on port 8001. api.py is NOT modified. See docker-compose.yml mcp service. Tools: `search_similar_incidents`, `get_entity_relationships`, `get_asset_timeline`, `write_run_to_memory`.
5. **Agent integration** — `memory_retrieve` node before orchestrator, `memory_write` node after policy_learning completes (i.e. after reasoning and RL, not immediately after estimation), orchestrator prompt extended with past context.

**Status:** Complete. All src/memory/ files written, coordinator phases wired,
RunRecord serialization updated, agents.py memory_context injection done,
10 unit tests passing. Supabase project provisioned (ID: glbmdbwqmuttykhicasq).
SQL migration applied (enable_pgvector, create_memory_layer_schema, enable_rls_memory_tables).
Integration tests verified live with real Supabase credentials: `pytest tests/memory/ -v` passes 21/21 with zero skips, including a real `fastmcp.Client` round trip through the MCP protocol layer (`test_mcp_bridge.py`) and the coordinator-level round trip (`test_end_to_end.py`).

## Real Execution Path (Phase 2b)

graph.py is NOT executed in production. Its own docstring says "Deprecated for execution
in Phase 2b+." The real execution path is:

    src/coordinator/runner.py::execute_run()

This is an async state machine that calls phases sequentially, persisting state to
SQLite (data/runs.db) via RunRecord (src/coordinator/store.py) between each phase.

Phase sequence:
  memory_retrieve → orchestrator → parent_evolution → parents (Kafka barrier)
  → gather_children → child_evolution → children (Kafka barrier) → evaluator
  → causal_loop (synthesis + dowhy, retries) → reasoner → policy_learning
  → memory_write → completed

Memory phases are awaited directly (already async). All other phases use asyncio.to_thread.
Memory phase exceptions are swallowed — a Supabase outage must never fail a run.

## Repository Structure

```
src/
  schema.py           ← All Pydantic models + GraphState TypedDict (THE contract)
  graph.py            ← LangGraph StateGraph assembly
  agents.py           ← Orchestrator, parent, child agent nodes
  evaluator.py        ← Memo ranking node
  causal.py           ← Causal synthesis + DoWhy engine nodes
  dataset_compiler.py ← Evidence → DataFrame compiler  !! DO NOT TOUCH !!
  estimators.py       ← DoWhy + statsmodels            !! DO NOT TOUCH !!
  evidence_adapters.py← SIEM/CVE/incident normalization
  benchmarking.py     ← Deterministic tier scoring
  engine.py           ← run_causalops() + artifact persistence
  api.py              ← FastAPI: /run /estimate /demo/estimate normalizers
  demo_fixtures.py    ← Deterministic smoke-test evidence
  main.py             ← Legacy Streamlit UI
  memory/             ← NEW — entire memory layer
    __init__.py
    embedder.py       ← embed_text(str) -> list[float]  Gemini gemini-embedding-001 (1536-dim)
    extractor.py      ← Deterministic entity extraction from run artifacts
    store.py          ← SupabaseMemoryStore (4 methods)
    nodes.py          ← memory_retrieve_node, memory_write_node
    mcp_server.py     ← FastMCP instance + 4 tools, standalone process, not imported by api.py

app/src/integrations/supabase/
  client.ts           ← Supabase JS client (frontend, anon key)
  types.ts            ← Auto-generated — regenerate after schema changes
```

## Environment Variables

```bash
# Chat LLM AND embeddings — Gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash          # or gemini-2.5-pro for complex reasoning tasks
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/

# Azure OpenAI — chat fallback only, NOT used for embeddings (credits exhausted;
# memory/embedder.py uses Gemini's gemini-embedding-001, truncated to 1536-dim)
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2024-08-01-preview

# Supabase — client (VITE_ prefix, safe in browser)
VITE_SUPABASE_URL=https://<new-project-ref>.supabase.co   # set after provisioning
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_SUPABASE_PROJECT_ID=<new-project-ref>

# Supabase — server (secrets — never use anon key in Python backend)
SUPABASE_URL=https://<new-project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=             # REQUIRED for all Python backend writes (RLS)

# CausalOps runtime
CAUSALOPS_ENABLE_SPAWN_WORKER=0         # "1" → in-process spawn worker (api container only)
KAFKA_BOOTSTRAP=localhost:19092        # only needed outside compose
```

## Python Conventions

- Python 3.12. Pydantic v2. `from __future__ import annotations` on every new file.
- LangGraph nodes return **only changed fields** as a dict. LangGraph merges.
- `asyncio.to_thread()` wraps all blocking I/O (Supabase client, embedding API).
- Type hints everywhere. No bare `Any` unless unavoidable.
- Ruff (linting) + Pyright (types). Line length 88.

## Critical Rules

1. **Never pass memory retrieval results as `EvidenceRecord` objects.** Memory context goes into the orchestrator prompt only — not the evidence pipeline.
2. **Never let the LLM generate data rows.** The `source_type: "synthetic"` guard in `dataset_compiler.py` exists for this reason. Do not route around it.
3. **Never use the Supabase anon key in Python backend.** It will fail silently on writes due to RLS. Always use `SUPABASE_SERVICE_ROLE_KEY`.
4. **Never modify `dataset_compiler.py` or `estimators.py`** as part of the memory work. They are the core statistical safeguards.
5. **Never call `embed_text()` directly in async context** — always use `await asyncio.to_thread(embed_text, text)`.
6. **Never commit `.env` or `settings.local.json`.**

## How to Run

```bash
# Full stack
docker-compose up --build

# Backend only (from src/)
cd src && uvicorn api:app --reload --host 0.0.0.0 --port 8000

# Smoke test (zero LLM tokens)
curl http://localhost:8000/demo/estimate

# Health check
curl http://localhost:8000/health

# Memory MCP server (standalone)
docker-compose up mcp        # starts on port 8001
# or directly:
cd src && python -m memory.mcp_server
```

## Supabase Schema (after migration)

Project ID: `glbmdbwqmuttykhicasq`

Tables: `memory_runs`, `memory_entities`, `memory_entity_edges`
RPC functions: `search_similar_runs(query_embedding, match_count, decay_lambda)`, `get_entity_neighborhood(p_entity_value, p_entity_type)`

Regenerate TypeScript types after schema changes:
```bash
npx supabase gen types typescript \
  --project-id glbmdbwqmuttykhicasq \
  --schema public \
  > app/src/integrations/supabase/types.ts
```

Migrations are tracked locally in `supabase/migrations/` (source of truth for
what's actually applied to the live project — apply new ones with
`mcp__supabase__apply_migration` or the Supabase CLI, then add the matching
`.sql` file here).

### Memory Retention (manual, no automation)

There is no automated deletion of old `memory_runs`/`memory_entities` rows —
deliberately deferred, revisit once real usage data shows what retention
period actually makes sense. To manually prune runs older than N days
(entities are left alone; they're a shared cross-run knowledge graph, not
scoped to one run's lifetime):

```sql
delete from memory_runs where created_at < now() - interval '90 days';
```

`memory_entity_edges` rows for those runs cascade-delete automatically
(`source_run_id ... ON DELETE CASCADE`). Orphaned `memory_entities` (no
edges left pointing at them) are harmless to leave in place; if you want to
also prune those:

```sql
delete from memory_entities e
where not exists (
  select 1 from memory_entity_edges g
  where g.source_entity_id = e.id or g.target_entity_id = e.id
);
```

## LangGraph Graph Topology (post-implementation)

```
START → memory_retrieve → orchestrator → [parallel parent_agents]
      → gather_children → [parallel child_agents] → evaluate_memos
      → causal_synthesis → dowhy_engine
      → (retry → causal_synthesis | end → memory_write) → END
```

## Tests

```
pytest tests/              # full suite (integration tests skip without credentials)
pytest tests/ -m "not integration and not kafka"   # unit tests only, zero credentials
pytest tests/memory/       # memory layer tests only
pytest tests/memory/ -m integration -v             # needs SUPABASE_* + AZURE_OPENAI_* in .env
```

Unit tests (no credentials): test_extractor.py, test_mcp_tools.py
Integration tests (`@pytest.mark.integration`): test_store.py, test_nodes.py
