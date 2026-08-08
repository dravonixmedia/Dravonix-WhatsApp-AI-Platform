-- Dravonix WhatsApp AI Platform
-- Voice pipeline reliability: media_files/transcriptions idempotency.
--
-- Fixes the root cause of duplicate media_files rows created by retried
-- voice-consumer queue jobs (application-level fix already shipped on
-- claude/voice-pipeline-idempotency-dlq): the schema itself had no unique
-- constraint capable of rejecting a concurrent duplicate insert. This
-- migration consolidates the known duplicate rows left behind by that bug
-- on staging, then adds the two constraints that make future duplication
-- structurally impossible -- for BOTH sequential retries (already handled
-- in application code) AND genuinely concurrent redeliveries (which no
-- amount of application-level "check then insert" can fully close without
-- a database-level guarantee).
--
-- Explicit transaction (unlike most migrations in this repo, which don't
-- need one): the LOCK TABLE below must remain held across the ambiguity
-- guard, the cleanup DELETE, and both ALTER TABLE statements as a single
-- atomic unit -- under psql's default autocommit behavior each statement
-- would otherwise be its own transaction, releasing the lock immediately
-- and defeating the point of taking it. Do not remove this BEGIN/COMMIT
-- wrapper to "match" other migrations' style.
begin;

-- Blocks concurrent INSERT/UPDATE/DELETE on these two tables (which could
-- otherwise recreate a duplicate between this migration's audit query and
-- its cleanup DELETE) without blocking concurrent SELECT -- SHARE mode
-- conflicts with ROW EXCLUSIVE (what INSERT/UPDATE/DELETE take) but not
-- with ACCESS SHARE (what SELECT takes). This transaction's own later
-- DELETE/ALTER TABLE statements still work: a transaction can always
-- escalate its own already-held lock without conflicting with itself.
lock table media_files in share mode;
lock table transcriptions in share mode;

-- ---------------------------------------------------------------------------
-- Ambiguity guard. A duplicate group is safe to auto-consolidate only when
-- there is a deterministic way to pick which row's transcript survives:
--   SAFE  -- no transcriptions in the group at all
--   SAFE  -- every non-null transcript in the group has identical text
--   SAFE  -- multiple distinct transcript texts exist, but the message's
--           current (live, already-displayed) body matches exactly one
--           of them
--   UNSAFE -- multiple distinct transcript texts exist and none of them
--            (or messages.body itself is null) matches the live body --
--            there is no deterministic signal left to pick a winner
-- Any UNSAFE group aborts the entire migration before anything is
-- deleted. The exception message is deliberately generic -- it must never
-- include transcript text, customer content, phone numbers, or any other
-- sensitive data.
-- ---------------------------------------------------------------------------
do $$
declare
  unsafe_group_count int;
begin
  select count(*) into unsafe_group_count
  from (
    select
      mf.company_id,
      mf.message_id,
      mf.kind,
      count(distinct t.raw_text) filter (where t.raw_text is not null) as distinct_transcript_count,
      bool_or(t.raw_text is not null and t.raw_text = m.body) as a_transcript_matches_live_body
    from media_files mf
    left join transcriptions t on t.media_file_id = mf.id
    left join messages m on m.id = mf.message_id
    where mf.message_id is not null
    group by mf.company_id, mf.message_id, mf.kind
    having count(*) > 1
  ) duplicate_groups
  where distinct_transcript_count > 1
    and not a_transcript_matches_live_body;

  if unsafe_group_count > 0 then
    raise exception 'media_files duplicate consolidation contains unresolved divergent transcripts';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Canonical-row consolidation. For every duplicate (company_id, message_id,
-- kind) group, keep exactly one row, ranked:
--   1. its own transcript's raw_text equals the message's current body
--   2. it has a transcript at all
--   3. earliest created_at
--   4. lowest id (deterministic final tie-breaker -- avoids
--      implementation-defined ordering when created_at ties)
-- No dependent-row repointing is needed: transcriptions.media_file_id was
-- never itself duplicated (verified during the staging audit), so the
-- canonical media_files row already owns whichever transcript it should
-- keep. Deleting the non-canonical rows cascades away only their own
-- (non-canonical, redundant) transcriptions/generated_audio rows.
-- ---------------------------------------------------------------------------
with dup_groups as (
  select company_id, message_id, kind
  from media_files
  where message_id is not null
  group by company_id, message_id, kind
  having count(*) > 1
),
candidates as (
  select
    mf.id,
    mf.company_id,
    mf.message_id,
    mf.kind,
    mf.created_at,
    (t.raw_text is not null and m.body is not null and t.raw_text = m.body) as matches_live_body,
    (t.id is not null) as has_transcript
  from media_files mf
  join dup_groups dg
    on dg.company_id = mf.company_id
   and dg.message_id = mf.message_id
   and dg.kind = mf.kind
  left join transcriptions t on t.media_file_id = mf.id
  left join messages m on m.id = mf.message_id
),
ranked as (
  select
    *,
    row_number() over (
      partition by company_id, message_id, kind
      order by matches_live_body desc, has_transcript desc, created_at asc, id asc
    ) as rnk
  from candidates
),
canonical as (
  select company_id, message_id, kind, id as canonical_media_file_id
  from ranked
  where rnk = 1
)
delete from media_files mf
using canonical c
where mf.company_id = c.company_id
  and mf.message_id = c.message_id
  and mf.kind = c.kind
  and mf.id <> c.canonical_media_file_id;

-- Belt-and-suspenders: fail loudly with a clear message rather than let the
-- unique constraint below raise a generic violation error if any group
-- somehow still has more than one row.
do $$
declare
  remaining_group_count int;
begin
  select count(*) into remaining_group_count
  from (
    select company_id, message_id, kind
    from media_files
    where message_id is not null
    group by company_id, message_id, kind
    having count(*) > 1
  ) still_duplicated;

  if remaining_group_count > 0 then
    raise exception 'media_files duplicate consolidation left % unresolved group(s) after cleanup', remaining_group_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Uniqueness guarantees. message_id is nullable (only kind = 'knowledge_document'
-- rows currently ever leave it null, and no code path sets it for that kind
-- today) -- ordinary Postgres NULL semantics are intentional here, NOT
-- "nulls not distinct": multiple knowledge_document rows with message_id
-- null must remain unconstrained, since they don't represent the same
-- logical inbound/outbound voice note at all.
-- ---------------------------------------------------------------------------
alter table media_files
  add constraint media_files_company_message_kind_key
  unique (company_id, message_id, kind);

comment on constraint media_files_company_message_kind_key on media_files is
  'Voice pipeline reliability: at most one media_files row per company+inbound/outbound message+kind. NULL message_id (currently only unused kind=knowledge_document) is never constrained by this, per standard SQL NULL-distinctness.';

-- Zero duplicate media_file_id transcription rows existed on staging prior
-- to this migration (verified during the audit) -- no cleanup is required
-- for this constraint, only the guarantee itself. Corrections continue to
-- be applied in place via the existing corrected_text/corrected_by_member_id
-- columns on this same row (migration 4), not a second row.
alter table transcriptions
  add constraint transcriptions_media_file_id_key
  unique (media_file_id);

comment on constraint transcriptions_media_file_id_key on transcriptions is
  'Voice pipeline reliability: exactly one transcription row per media file. Corrections are applied in place (corrected_text/corrected_by_member_id), never as a second row.';

commit;
