-- Dravonix WhatsApp AI Platform
-- Ranked full-text search over knowledge_chunks, used by the message-consumer
-- worker's KnowledgeRetriever (packages/knowledge). The company_id filter is
-- applied here, inside the query itself, before ranking or limiting -- Master
-- Prompt section 13/36 requires this can never be a post-filter.

create or replace function search_knowledge_chunks(
  p_company_id uuid,
  p_query text,
  p_limit integer
)
returns table (
  source_id uuid,
  title text,
  content text,
  rank real
)
language sql
stable
as $$
  select
    kc.knowledge_source_id as source_id,
    ks.title,
    kc.content,
    ts_rank(kc.content_tsv, plainto_tsquery('simple', p_query)) as rank
  from knowledge_chunks kc
  join knowledge_sources ks on ks.id = kc.knowledge_source_id
  where kc.company_id = p_company_id
    and ks.is_enabled = true
    and kc.content_tsv @@ plainto_tsquery('simple', p_query)
  order by rank desc
  limit p_limit;
$$;

comment on function search_knowledge_chunks(uuid, text, integer) is
  'Ranked full-text search over one company''s enabled knowledge chunks. Only ever called with the service-role client (which already bypasses RLS), so the p_company_id filter is the sole isolation guarantee here -- callers must never pass a company_id the caller does not control.';
