-- KNN retrieval for inspiration matching: nearest elements by cosine distance over the
-- description_embedding (added in 010). The matcher (services/inspirationMatch.js) then scores
-- the shortlist by zone/mode/colour/type in JS. Until this is applied, the matcher falls back
-- to in-JS cosine over all embeddings, so it works either way — this just makes it scale.
--
-- Apply by hand in the Supabase SQL editor (007/008/009/010 convention).

create or replace function match_elements(query_embedding vector(1536), match_count int default 20)
returns table (id uuid, similarity float)
language sql stable as $$
  select e.id, 1 - (e.description_embedding <=> query_embedding) as similarity
  from cake_elements e
  where e.description_embedding is not null
    and e.is_active = true
    and e.baker_id is null
  order by e.description_embedding <=> query_embedding
  limit match_count;
$$;
