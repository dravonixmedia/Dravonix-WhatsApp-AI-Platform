-- Dravonix WhatsApp AI Platform
-- Baseline extensions required by the schema.

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";    -- fuzzy/full-text search helpers
create extension if not exists "vector";     -- pgvector, ready for optional embeddings
