-- Inspiration matching: make every element searchable by a text embedding of its `description`
-- (the comma-separated search-keyword field). Retrieval = KNN over this vector, narrowed by
-- element_type + colour + placement zone compatibility (see services/elementIndex.js + the matcher).
--
-- Apply by hand in the Supabase SQL editor (matching the 007/008/009 convention — no runner).

-- 1. pgvector extension (Supabase ships it; enable if not already).
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Embedding column — text-embedding-3-small is 1536-dimensional.
ALTER TABLE cake_elements ADD COLUMN IF NOT EXISTS description_embedding vector(1536);

-- 3. ANN index for cosine KNN. HNSW: good recall, no training step, fine for a growing library.
CREATE INDEX IF NOT EXISTS cake_elements_desc_embed_idx
  ON cake_elements USING hnsw (description_embedding vector_cosine_ops);

-- After applying, run: node scripts/backfill-element-index.mjs
-- (fills any empty descriptions via GPT, then embeds every element).
