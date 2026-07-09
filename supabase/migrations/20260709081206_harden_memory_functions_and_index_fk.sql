ALTER FUNCTION public.search_similar_runs(extensions.vector, integer, double precision)
  SET search_path = public, extensions;

ALTER FUNCTION public.get_entity_neighborhood(text, text)
  SET search_path = public, extensions;

CREATE INDEX IF NOT EXISTS memory_entity_edges_target_idx
  ON public.memory_entity_edges (target_entity_id);
