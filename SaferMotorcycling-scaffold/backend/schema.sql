-- SaferMotorcycling — Supabase schema
-- Run this in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Records are stored as a jsonb `data` blob plus a few columns for querying/sorting.

create table if not exists incidents (
  id      text primary key,
  region  text,
  status  text,
  ts      timestamptz default now(),
  data    jsonb not null
);
create index if not exists incidents_region_idx on incidents (region);
create index if not exists incidents_ts_idx on incidents (ts desc);

create table if not exists registrations (
  id      text primary key,
  region  text,
  ts      timestamptz default now(),
  data    jsonb not null
);
create index if not exists registrations_ts_idx on registrations (ts desc);

-- The backend connects with the service-role key (server-side only), which bypasses
-- row-level security. If you later expose these tables to the browser directly, enable
-- RLS and add policies — but with this architecture the browser never touches Supabase.
