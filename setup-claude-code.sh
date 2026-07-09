#!/usr/bin/env bash
# setup-claude-code.sh
# Run once from the repo root to create the full .claude/ folder structure.
# Usage: bash setup-claude-code.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$REPO_ROOT/.claude"

echo "Creating .claude/ structure in $REPO_ROOT..."
mkdir -p "$CLAUDE_DIR/commands"
mkdir -p "$CLAUDE_DIR/agents"
mkdir -p "$CLAUDE_DIR/hooks"

# ─── settings.json ────────────────────────────────────────────────────────────
cat > "$CLAUDE_DIR/settings.json" << 'SETTINGS'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Bash(uvicorn:*)",
      "Bash(python:*)",
      "Bash(pip:*)",
      "Bash(pip3:*)",
      "Bash(ruff:*)",
      "Bash(pyright:*)",
      "Bash(curl:*)",
      "Bash(docker:*)",
      "Bash(docker-compose:*)",
      "Bash(npx supabase:*)",
      "Bash(cat:*)",
      "Bash(echo:*)",
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(ls:*)",
      "Bash(mkdir:*)",
      "Bash(cp:*)",
      "Bash(mv:*)"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(git push --force:*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "if": "Write(src/**.py)|Edit(src/**.py)",
            "command": "bash -c 'ruff check --quiet \"$CLAUDE_TOOL_OUTPUT_FILE\" 2>&1 || true'"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm -rf *)",
            "command": "bash .claude/hooks/block-destructive.sh"
          }
        ]
      }
    ]
  }
}
SETTINGS

echo "  ✓ settings.json"

# ─── .mcp.json at repo root ───────────────────────────────────────────────────
cat > "$REPO_ROOT/.mcp.json" << 'MCP'
{
  "mcpServers": {
    "causalops-memory": {
      "type": "http",
      "url": "http://localhost:8000/mcp",
      "description": "CausalOps persistent memory layer — vector search, entity graph, asset timeline. Start the API server first: cd src && uvicorn api:app --port 8000"
    }
  }
}
MCP

echo "  ✓ .mcp.json"

# ─── commands/lint.md ─────────────────────────────────────────────────────────
cat > "$CLAUDE_DIR/commands/lint.md" << 'CMD'
Run ruff linting and pyright type checking on the entire src/ directory.

```bash
cd $CLAUDE_PROJECT_DIR && ruff check src/ && echo "Lint passed" || echo "Lint failed"
cd $CLAUDE_PROJECT_DIR && pyright src/ && echo "Types passed" || echo "Types failed"
```

Report every error found. Do not auto-fix unless I ask. Show the output verbatim.
CMD

echo "  ✓ commands/lint.md"

# ─── commands/typecheck.md ────────────────────────────────────────────────────
cat > "$CLAUDE_DIR/commands/typecheck.md" << 'CMD'
Run pyright type checking on src/ and report all errors with file and line numbers.

```bash
cd $CLAUDE_PROJECT_DIR && pyright src/ 2>&1
```

Do not fix anything. Just show the output.
CMD

echo "  ✓ commands/typecheck.md"

# ─── commands/run-demo.md ─────────────────────────────────────────────────────
cat > "$CLAUDE_DIR/commands/run-demo.md" << 'CMD'
Run the built-in deterministic evidence demo against the local API.
This uses the patch_lateral_movement fixture and requires zero LLM tokens.
Expects the API to be running at http://localhost:8000.

```bash
curl -s http://localhost:8000/demo/estimate | python3 -m json.tool
```

Parse and explain the output: what the ATE means, whether refuters passed, and what the dataset profile says about data quality.
CMD

echo "  ✓ commands/run-demo.md"

# ─── commands/test-memory.md ──────────────────────────────────────────────────
cat > "$CLAUDE_DIR/commands/test-memory.md" << 'CMD'
Test the memory layer end-to-end once the API is running.

Step 1 — Write a demo run to memory:
```bash
curl -s -X POST http://localhost:8000/mcp/call-tool \
  -H "Content-Type: application/json" \
  -d '{"name": "write_run_to_memory", "arguments": {"run_artifact": {"run_id": "test-run-001", "task_description": "Suspected FIN7 lateral movement via RDP in finance segment", "memos": [], "causal_graph": {"nodes": [], "edges": [], "treatment_variable": "patch_applied", "outcome_variable": "lateral_movement", "candidate_confounders": []}, "estimate_report": {}, "evidence_records": [{"source_type": "siem", "source_name": "test", "asset_id": "host-001", "technique_id": "T1021", "cve_id": null}], "agent_tier_metrics": {}}}}' | python3 -m json.tool
```

Step 2 — Search for similar incidents:
```bash
curl -s -X POST http://localhost:8000/mcp/call-tool \
  -H "Content-Type: application/json" \
  -d '{"name": "search_similar_incidents", "arguments": {"description": "lateral movement RDP finance", "k": 3}}' | python3 -m json.tool
```

Step 3 — Check entity relationships:
```bash
curl -s -X POST http://localhost:8000/mcp/call-tool \
  -H "Content-Type: application/json" \
  -d '{"name": "get_entity_relationships", "arguments": {"entity_value": "T1021", "entity_type": "technique"}}' | python3 -m json.tool
```

Report whether each step succeeded, what was returned, and flag any errors.
CMD

echo "  ✓ commands/test-memory.md"

# ─── commands/check-env.md ────────────────────────────────────────────────────
cat > "$CLAUDE_DIR/commands/check-env.md" << 'CMD'
Check that all required environment variables are set before starting implementation.

```bash
cd $CLAUDE_PROJECT_DIR && python3 -c "
import os
from dotenv import load_dotenv
load_dotenv()

required = {
    'AZURE_OPENAI_ENDPOINT': 'Azure OpenAI chat endpoint',
    'AZURE_OPENAI_API_KEY': 'Azure OpenAI API key',
    'AZURE_OPENAI_DEPLOYMENT': 'Azure chat model deployment name',
    'AZURE_OPENAI_API_VERSION': 'Azure API version',
    'AZURE_OPENAI_EMBEDDING_DEPLOYMENT': 'Azure embedding deployment (text-embedding-3-small)',
    'SUPABASE_URL': 'Supabase project URL',
    'SUPABASE_SERVICE_ROLE_KEY': 'Supabase service role key (NOT anon key)',
}

missing = []
for key, desc in required.items():
    val = os.getenv(key)
    status = '✓' if val else '✗ MISSING'
    display = (val[:20] + '...') if val and len(val) > 20 else (val or '')
    print(f'{status}  {key}: {desc}  [{display}]')
    if not val:
        missing.append(key)

if missing:
    print(f'\n{len(missing)} variable(s) missing. Do not start implementation.')
else:
    print('\nAll required variables present. Ready to implement.')
"
```
CMD

echo "  ✓ commands/check-env.md"

# ─── commands/supabase-migrate.md ────────────────────────────────────────────
cat > "$CLAUDE_DIR/commands/supabase-migrate.md" << 'CMD'
Check the current state of the Supabase memory tables and report what exists vs. what's missing.

```bash
cd $CLAUDE_PROJECT_DIR && python3 -c "
import os
from dotenv import load_dotenv
load_dotenv()
from supabase import create_client

url = os.getenv('SUPABASE_URL')
key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
if not url or not key:
    print('ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
    exit(1)

client = create_client(url, key)

tables = ['memory_runs', 'memory_entities', 'memory_entity_edges']
for table in tables:
    try:
        resp = client.table(table).select('id').limit(1).execute()
        print(f'✓  {table} exists ({len(resp.data)} rows sampled)')
    except Exception as e:
        print(f'✗  {table} MISSING or error: {e}')
"
```

If any tables are missing, run the migration SQL from the implementation plan in the Supabase SQL editor.
CMD

echo "  ✓ commands/supabase-migrate.md"

# ─── agents/memory-specialist.md ─────────────────────────────────────────────
cat > "$CLAUDE_DIR/agents/memory-specialist.md" << 'AGENT'
---
name: memory-specialist
description: Expert subagent for implementing and debugging the CausalOps memory layer (src/memory/). Use this agent for tasks involving embedder.py, store.py, extractor.py, nodes.py, or mcp_server.py. Also use for Supabase pgvector schema work and FastMCP configuration.
tools: Read, Write, Edit, Bash, Grep, Glob
---

You are a specialist in the CausalOps memory layer implementation.

## Your scope

You work exclusively on:
- `src/memory/embedder.py` — Azure OpenAI text-embedding-3-small wrapper
- `src/memory/extractor.py` — deterministic entity extraction
- `src/memory/store.py` — SupabaseMemoryStore
- `src/memory/nodes.py` — memory_retrieve_node and memory_write_node LangGraph nodes
- `src/memory/mcp_server.py` — FastMCP server definition
- Supabase migration SQL for memory_runs, memory_entities, memory_entity_edges
- Modifications to schema.py (memory fields only), graph.py (memory nodes only), engine.py (run_id threading only), api.py (MCP mount only)

## What you must never do

- Touch `dataset_compiler.py`, `estimators.py`, or `evidence_adapters.py`
- Pass memory retrieval results as EvidenceRecord objects
- Use the Supabase anon key — always use SUPABASE_SERVICE_ROLE_KEY
- Call `embed_text()` directly in async context — always use `asyncio.to_thread`
- Generate synthetic data rows

## Key interfaces you depend on

From schema.py:
- `GraphState` TypedDict — you add `run_id: str` and `memory_context: list[dict] | None`
- `EvidenceRecord` — read-only, used only for entity extraction in extractor.py
- `DecisionMemo` — read-only, serialized for storage

FastMCP mounting pattern (from gofastmcp.com docs):
```python
mcp_app = mcp.http_app(path="/")
app = FastAPI(..., lifespan=mcp_app.lifespan)
app.mount("/mcp", mcp_app)
```

Supabase RPC call pattern:
```python
response = client.rpc("search_similar_runs", {
    "query_embedding": embedding_list,
    "match_count": k,
    "decay_lambda": 0.023
}).execute()
return response.data
```

Azure embeddings call pattern:
```python
from openai import AzureOpenAI
client = AzureOpenAI(
    azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
    api_key=os.getenv("AZURE_OPENAI_API_KEY"),
    api_version=os.getenv("AZURE_OPENAI_API_VERSION"),
)
response = client.embeddings.create(
    model=os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT"),
    input=text,
)
return response.data[0].embedding
```
AGENT

echo "  ✓ agents/memory-specialist.md"

# ─── agents/schema-validator.md ───────────────────────────────────────────────
cat > "$CLAUDE_DIR/agents/schema-validator.md" << 'AGENT'
---
name: schema-validator
description: Subagent for verifying that schema.py changes, Supabase table definitions, and TypeScript types stay in sync. Use when adding fields to GraphState, after running Supabase migrations, or when TypeScript type errors appear related to the database schema.
tools: Read, Bash, Grep
---

You are a validation specialist. Your job is read-only analysis and reporting.

When invoked, check:
1. Every field added to `GraphState` in `schema.py` has a corresponding default in `engine.py`'s `initial_state` dict.
2. `memory_runs`, `memory_entities`, `memory_entity_edges` tables exist in Supabase (use the check-env command to verify).
3. The TypeScript types in `app/src/integrations/supabase/types.ts` reflect the current schema.
4. `requirements.txt` includes `supabase==2.15.2`, `openai==1.91.0`, `fastmcp==3.2.4`, `httpx==0.28.1`.

Report pass/fail for each check. Do not modify anything.
AGENT

echo "  ✓ agents/schema-validator.md"

# ─── hooks/block-destructive.sh ───────────────────────────────────────────────
cat > "$CLAUDE_DIR/hooks/block-destructive.sh" << 'HOOK'
#!/usr/bin/env bash
# PreToolUse hook: blocks destructive rm -rf patterns.
# Receives JSON on stdin with tool_name and tool_input.
COMMAND=$(echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

if echo "$COMMAND" | grep -qE 'rm\s+-rf\s+(/|~|\$HOME|\.git)'; then
  python3 -c "
import json
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'deny',
    'permissionDecisionReason': 'Destructive rm -rf on root/home/git blocked by hook'
  }
}))
"
  exit 0
fi
exit 0
HOOK
chmod +x "$CLAUDE_DIR/hooks/block-destructive.sh"

echo "  ✓ hooks/block-destructive.sh"

# ─── hooks/post-write-lint.sh ─────────────────────────────────────────────────
cat > "$CLAUDE_DIR/hooks/post-write-lint.sh" << 'HOOK'
#!/usr/bin/env bash
# PostToolUse hook: runs ruff on any Python file that was just written or edited.
# The file path is available in CLAUDE_TOOL_OUTPUT_FILE env var.
FILE="${CLAUDE_TOOL_OUTPUT_FILE:-}"
if [[ "$FILE" == *.py ]]; then
  ruff check --quiet "$FILE" 2>&1 || true
fi
exit 0
HOOK
chmod +x "$CLAUDE_DIR/hooks/post-write-lint.sh"

echo "  ✓ hooks/post-write-lint.sh"

echo ""
echo "Done. .claude/ structure created:"
find "$CLAUDE_DIR" -type f | sort
echo ""
echo ".mcp.json created at repo root."
echo ""
echo "Next steps:"
echo "  1. Run: bash setup-claude-code.sh  (you just did this)"
echo "  2. Add your Azure embedding deployment and Supabase service role key to .env"
echo "  3. Run: /check-env  in Claude Code to verify all variables are set"
echo "  4. Run the SQL migration in the Supabase SQL editor"
echo "  5. Run: /supabase-migrate  to verify tables exist"
echo "  6. Begin implementation with: /memory-specialist"
