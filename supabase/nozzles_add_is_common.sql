-- Migration: flag the genuinely go-to tips. Lets the GPT craft-guide suggester
-- prefer canonical tips over obscure equivalents, and lets the future baker
-- learning screen feature the essentials instead of the whole list.
-- (For fresh installs this column is already in nozzles_table.sql.)

alter table nozzles
  add column if not exists is_common boolean not null default false;

create index if not exists nozzles_is_common_idx on nozzles (is_common);
