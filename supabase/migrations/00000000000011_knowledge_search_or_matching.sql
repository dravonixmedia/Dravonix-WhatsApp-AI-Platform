-- Dravonix WhatsApp AI Platform
-- Fixes search_knowledge_chunks to match on ANY meaningful word in the query
-- (OR semantics) instead of ALL words (plainto_tsquery's AND semantics).
--
-- A real customer message is a natural sentence full of filler words ("what",
-- "the", "for") that never appear verbatim in a short knowledge chunk.
-- plainto_tsquery ANDs every lexeme together, so a single filler word absent
-- from the chunk caused zero matches for almost any real question -- observed
-- in production via a query that should have matched seeded pricing content
-- but returned nothing. Ranking (ts_rank) still rewards chunks that match
-- more of the query's meaningful words, so this stays a *ranked* search, not
-- an unranked keyword dump.

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
  with words as (
    select distinct lower(regexp_replace(w, '[^a-zA-Z0-9]', '', 'g')) as w
    from regexp_split_to_table(p_query, '\s+') as w
  ),
  filtered as (
    select w from words where length(w) > 0
  ),
  query as (
    select to_tsquery('simple', string_agg(w, ' | ')) as tsq
    from filtered
  )
  select
    kc.knowledge_source_id as source_id,
    ks.title,
    kc.content,
    ts_rank(kc.content_tsv, query.tsq) as rank
  from knowledge_chunks kc
  join knowledge_sources ks on ks.id = kc.knowledge_source_id
  cross join query
  where kc.company_id = p_company_id
    and ks.is_enabled = true
    and query.tsq is not null
    and kc.content_tsv @@ query.tsq
  order by rank desc
  limit p_limit;
$$;
