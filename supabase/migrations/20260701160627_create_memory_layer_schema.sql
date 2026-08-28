CREATE TABLE IF NOT EXISTS memory_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              TEXT NOT NULL UNIQUE,
  task_description    TEXT NOT NULL,
  task_embedding      extensions.vector(1536) NOT NULL,
  memos               JSONB NOT NULL DEFAULT '[]'::jsonb,
  causal_graph        JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimate_report     JSONB NOT NULL DEFAULT '{}'::jsonb,
  agent_tier_metrics  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_runs_embedding_idx
  ON memory_runs
  USING hnsw (task_embedding extensions.vector_cosine_ops);

CREATE TABLE IF NOT EXISTS memory_entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL,
  entity_value  TEXT NOT NULL,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_value)
);

CREATE TABLE IF NOT EXISTS memory_entity_edges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id  UUID NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  target_entity_id  UUID NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  relationship      TEXT NOT NULL,
  source_run_id     TEXT NOT NULL REFERENCES memory_runs(run_id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_entity_edges_source_idx
  ON memory_entity_edges (source_entity_id);

CREATE INDEX IF NOT EXISTS memory_entity_edges_run_idx
  ON memory_entity_edges (source_run_id);

CREATE OR REPLACE FUNCTION search_similar_runs(
  query_embedding   extensions.vector(1536),
  match_count       INT DEFAULT 5,
  decay_lambda      FLOAT DEFAULT 0.023
)
RETURNS TABLE (
  run_id            TEXT,
  task_description  TEXT,
  similarity        FLOAT,
  temporal_weight   FLOAT,
  weighted_score    FLOAT,
  created_at        TIMESTAMPTZ,
  causal_graph      JSONB,
  estimate_report   JSONB,
  memos             JSONB
)
LANGUAGE sql STABLE
AS $$
  SELECT
    r.run_id,
    r.task_description,
    1 - (r.task_embedding <=> query_embedding)                       AS similarity,
    EXP(-decay_lambda * EXTRACT(EPOCH FROM (now() - r.created_at)) / 86400.0) AS temporal_weight,
    (1 - (r.task_embedding <=> query_embedding))
      * EXP(-decay_lambda * EXTRACT(EPOCH FROM (now() - r.created_at)) / 86400.0) AS weighted_score,
    r.created_at,
    r.causal_graph,
    r.estimate_report,
    r.memos
  FROM memory_runs r
  ORDER BY weighted_score DESC
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION get_entity_neighborhood(
  p_entity_value  TEXT,
  p_entity_type   TEXT
)
RETURNS TABLE (
  source_type   TEXT,
  source_value  TEXT,
  relationship  TEXT,
  target_type   TEXT,
  target_value  TEXT,
  run_id        TEXT,
  created_at    TIMESTAMPTZ
)
LANGUAGE sql STABLE
AS $$
  SELECT
    s.entity_type   AS source_type,
    s.entity_value  AS source_value,
    e.relationship,
    t.entity_type   AS target_type,
    t.entity_value  AS target_value,
    e.source_run_id AS run_id,
    e.created_at
  FROM memory_entity_edges e
  JOIN memory_entities s ON e.source_entity_id = s.id
  JOIN memory_entities t ON e.target_entity_id = t.id
  WHERE s.entity_value = p_entity_value
    AND s.entity_type  = p_entity_type
  ORDER BY e.created_at DESC;
$$;
