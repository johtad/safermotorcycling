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

create table if not exists usage_events (
  id          bigserial primary key,
  session_id  text,
  event_type  text,
  event_data  jsonb,
  user_agent  text,
  ts          timestamptz default now()
);
create index if not exists usage_events_ts_idx on usage_events (ts desc);
create index if not exists usage_events_session_idx on usage_events (session_id);

create table if not exists vehicles (
  id                 text primary key,
  type               text,
  region             text,
  plate              text,
  rider_name         text,
  union_name         text,
  status             text,
  lat                double precision,
  lng                double precision,
  speed_kmh          int,
  heading            int,
  safety_score       int,
  harsh_brake_count  int default 0,
  speeding_count     int default 0,
  last_seen          timestamptz default now(),
  data               jsonb default '{}'::jsonb
);
create index if not exists vehicles_region_idx on vehicles (region);
create index if not exists vehicles_type_idx on vehicles (type);
create index if not exists vehicles_status_idx on vehicles (status);

create table if not exists telematics_events (
  id           bigserial primary key,
  vehicle_id   text,
  region       text,
  union_name   text,
  vehicle_type text,
  event_type   text,
  severity     int,
  lat          double precision,
  lng          double precision,
  speed_kmh    int,
  location_label text,
  ts           timestamptz default now(),
  meta         jsonb default '{}'::jsonb
);
create index if not exists telematics_events_ts_idx on telematics_events (ts desc);
create index if not exists telematics_events_region_idx on telematics_events (region);
create index if not exists telematics_events_vehicle_idx on telematics_events (vehicle_id);
create index if not exists telematics_events_type_idx on telematics_events (event_type);
create index if not exists telematics_events_union_idx on telematics_events (union_name);

create table if not exists telematics_trips (
  id              bigserial primary key,
  vehicle_id      text,
  region          text,
  union_name      text,
  vehicle_type    text,
  started_at      timestamptz,
  ended_at        timestamptz,
  start_lat       double precision,
  start_lng       double precision,
  end_lat         double precision,
  end_lng         double precision,
  distance_km     double precision,
  duration_min    int,
  max_speed_kmh   int,
  avg_speed_kmh   int,
  event_counts    jsonb default '{}'::jsonb,
  safety_score    int
);
create index if not exists telematics_trips_ended_idx on telematics_trips (ended_at desc);
create index if not exists telematics_trips_region_idx on telematics_trips (region);
create index if not exists telematics_trips_vehicle_idx on telematics_trips (vehicle_id);
create index if not exists telematics_trips_union_idx on telematics_trips (union_name);

-- The backend connects with the service-role key (server-side only), which bypasses
-- row-level security. If you later expose these tables to the browser directly, enable
-- RLS and add policies — but with this architecture the browser never touches Supabase.
