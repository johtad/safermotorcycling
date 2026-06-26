// store.js — persistence for incidents & registrations.
// Dual-mode: uses Supabase when SUPABASE_URL + SUPABASE_SERVICE_KEY are set,
// otherwise an in-memory store (so local dev and a first Render deploy work with no DB).
// Records are stored as a jsonb `data` blob plus a few top-level columns for querying,
// so there's no column-by-column mapping to maintain. See schema.sql.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
let supa = null;

if (url && key) {
  try {
    supa = require("@supabase/supabase-js").createClient(url, key, { auth: { persistSession: false } });
    console.log("store: Supabase persistence enabled");
  } catch (e) {
    console.warn("store: @supabase/supabase-js not installed — falling back to memory:", e.message);
  }
} else {
  console.log("store: in-memory (set SUPABASE_URL + SUPABASE_SERVICE_KEY to persist)");
}

let memInc = [];
let memReg = [];

async function addIncident(inc) {
  if (supa) {
    const { error } = await supa.from("incidents").insert({ id: inc.id, region: inc.region, status: inc.status, ts: inc.ts, data: inc });
    if (error) throw error;
    return inc;
  }
  memInc.unshift(inc);
  return inc;
}

async function listIncidents(region) {
  if (supa) {
    let q = supa.from("incidents").select("data").order("ts", { ascending: false }).limit(500);
    if (region) q = q.eq("region", region);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map((r) => r.data);
  }
  return region ? memInc.filter((i) => i.region === region) : memInc.slice(0, 500);
}

async function getIncident(id) {
  if (supa) {
    const { data, error } = await supa.from("incidents").select("data").eq("id", id).single();
    if (error) return null;
    return data ? data.data : null;
  }
  return memInc.find((i) => i.id === id) || null;
}

async function updateIncidentStatus(id, status, entry) {
  const cur = await getIncident(id);
  if (!cur) return null;
  cur.status = status;
  cur.status_history = (cur.status_history || []).concat([entry]);
  if (supa) {
    const { error } = await supa.from("incidents").update({ status: status, data: cur }).eq("id", id);
    if (error) throw error;
  }
  return cur;
}

async function addRegistration(r) {
  const rec = { id: r.id || ("reg-" + Date.now()), region: r.region || "", ts: new Date().toISOString(), data: r };
  if (supa) {
    const { error } = await supa.from("registrations").insert(rec);
    if (error) throw error;
    return r;
  }
  memReg.unshift(r);
  return r;
}

async function listRegistrations() {
  if (supa) {
    const { data, error } = await supa.from("registrations").select("data").order("ts", { ascending: false }).limit(1000);
    if (error) throw error;
    return (data || []).map((r) => r.data);
  }
  return memReg.slice(0, 1000);
}

function seedIncident(inc) {
  if (!supa) memInc.unshift(inc); // only seed the in-memory store; real DB holds real data
}

let memEvents = [];
let memFallback = [];
let lastEventError = null;

async function addEvent(e) {
  const rec = { session_id: e.session_id || null, event_type: e.event_type || "unknown", event_data: e.event_data || {}, user_agent: e.user_agent || null };
  if (supa) {
    try {
      const { error } = await supa.from("usage_events").insert(rec);
      if (error) throw error;
      lastEventError = null;
      return rec;
    } catch (err) {
      // Don't silently drop: buffer to memory so events are still visible until table is created / Supabase recovers.
      lastEventError = err.message || String(err);
      memFallback.unshift({ ...rec, ts: new Date().toISOString(), _fallback: true });
      if (memFallback.length > 500) memFallback.length = 500;
      console.warn("store: supabase write failed, buffered in memory:", lastEventError);
      return rec;
    }
  }
  memEvents.unshift({ ...rec, ts: new Date().toISOString() });
  if (memEvents.length > 1000) memEvents.length = 1000;
  return rec;
}

async function listEvents(limit) {
  const n = Math.min(parseInt(limit, 10) || 100, 500);
  if (supa) {
    try {
      const { data, error } = await supa.from("usage_events").select("*").order("ts", { ascending: false }).limit(n);
      if (error) throw error;
      lastEventError = null;
      // Merge any in-memory fallback so user sees everything in one feed.
      const combined = memFallback.concat(data || []);
      combined.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
      return combined.slice(0, n);
    } catch (err) {
      lastEventError = err.message || String(err);
      return memFallback.slice(0, n);
    }
  }
  return memEvents.slice(0, n);
}

function eventStoreStatus() {
  return { supabase: !!supa, fallback_count: memFallback.length, last_error: lastEventError };
}

let memVehicles = [];

async function listVehicles(region, type) {
  if (supa) {
    try {
      let q = supa.from("vehicles").select("*");
      if (region) q = q.eq("region", region);
      if (type) q = q.eq("type", type);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    } catch (err) {
      return memVehicles.filter((v) => (!region || v.region === region) && (!type || v.type === type));
    }
  }
  return memVehicles.filter((v) => (!region || v.region === region) && (!type || v.type === type));
}

async function upsertVehicle(v) {
  v.last_seen = new Date().toISOString();
  if (supa) {
    try {
      const { error } = await supa.from("vehicles").upsert(v);
      if (error) throw error;
      return v;
    } catch (err) { /* fall through to memory */ }
  }
  const i = memVehicles.findIndex((x) => x.id === v.id);
  if (i >= 0) memVehicles[i] = v;
  else memVehicles.push(v);
  return v;
}

async function ensureSeededVehicles(seedFn) {
  try {
    const fleet = seedFn();
    if (supa) {
      try {
        const { error } = await supa.from("vehicles").upsert(fleet);
        if (error) throw error;
        console.log("store: upserted", fleet.length, "seed vehicles");
      } catch (e) {
        console.warn("vehicle seed (supabase):", e.message);
        const byId = {}; memVehicles.forEach((v) => (byId[v.id] = v)); fleet.forEach((v) => (byId[v.id] = v));
        memVehicles = Object.values(byId);
      }
    } else {
      const byId = {}; memVehicles.forEach((v) => (byId[v.id] = v)); fleet.forEach((v) => (byId[v.id] = v));
      memVehicles = Object.values(byId);
    }
  } catch (e) { console.warn("ensureSeededVehicles:", e.message); }
}

let memTelEvents = [];
let memTelTrips = [];

async function addTelEvent(e) {
  e.ts = e.ts || new Date().toISOString();
  if (supa) {
    try { const { error } = await supa.from("telematics_events").insert(e); if (error) throw error; return e; }
    catch (err) { memTelEvents.push(e); return e; }
  }
  memTelEvents.push(e); return e;
}
async function addTelEventsBatch(arr) {
  if (!arr.length) return 0;
  if (supa) {
    try { const { error } = await supa.from("telematics_events").insert(arr); if (error) throw error; return arr.length; }
    catch (err) { memTelEvents = memTelEvents.concat(arr); return arr.length; }
  }
  memTelEvents = memTelEvents.concat(arr); return arr.length;
}
async function addTelTrip(t) {
  if (supa) {
    try { const { error } = await supa.from("telematics_trips").insert(t); if (error) throw error; return t; }
    catch (err) { memTelTrips.push(t); return t; }
  }
  memTelTrips.push(t); return t;
}
async function addTelTripsBatch(arr) {
  if (!arr.length) return 0;
  if (supa) {
    try { const { error } = await supa.from("telematics_trips").insert(arr); if (error) throw error; return arr.length; }
    catch (err) { memTelTrips = memTelTrips.concat(arr); return arr.length; }
  }
  memTelTrips = memTelTrips.concat(arr); return arr.length;
}

async function listTelEvents(region, sinceISO) {
  if (supa) {
    try {
      let q = supa.from("telematics_events").select("*").order("ts", { ascending: false }).limit(5000);
      if (region) q = q.eq("region", region);
      if (sinceISO) q = q.gte("ts", sinceISO);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    } catch (err) {
      return memTelEvents.filter((e) => (!region || e.region === region) && (!sinceISO || e.ts >= sinceISO));
    }
  }
  return memTelEvents.filter((e) => (!region || e.region === region) && (!sinceISO || e.ts >= sinceISO));
}

async function listTelTrips(region, sinceISO) {
  if (supa) {
    try {
      let q = supa.from("telematics_trips").select("*").order("ended_at", { ascending: false }).limit(5000);
      if (region) q = q.eq("region", region);
      if (sinceISO) q = q.gte("ended_at", sinceISO);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    } catch (err) {
      return memTelTrips.filter((t) => (!region || t.region === region) && (!sinceISO || (t.ended_at || "") >= sinceISO));
    }
  }
  return memTelTrips.filter((t) => (!region || t.region === region) && (!sinceISO || (t.ended_at || "") >= sinceISO));
}

async function telematicsCounts() {
  if (supa) {
    try {
      const a = await supa.from("telematics_events").select("id", { count: "exact", head: true });
      const b = await supa.from("telematics_trips").select("id", { count: "exact", head: true });
      return { events: a.count || 0, trips: b.count || 0 };
    } catch (err) { /* fall through */ }
  }
  return { events: memTelEvents.length, trips: memTelTrips.length };
}

async function ensureSeededTelematics(seedFn) {
  try {
    const c = await telematicsCounts();
    if (c.events > 0 || c.trips > 0) { console.log("store: telematics already seeded (events=" + c.events + ", trips=" + c.trips + ")"); return; }
    const seed = seedFn();
    if (seed.events && seed.events.length) await addTelEventsBatch(seed.events);
    if (seed.trips && seed.trips.length) await addTelTripsBatch(seed.trips);
    console.log("store: seeded telematics", seed.events.length, "events,", seed.trips.length, "trips");
  } catch (e) { console.warn("ensureSeededTelematics:", e.message); }
}

module.exports = { addIncident, listIncidents, getIncident, updateIncidentStatus, addRegistration, listRegistrations, addEvent, listEvents, eventStoreStatus, listVehicles, upsertVehicle, ensureSeededVehicles, addTelEvent, addTelEventsBatch, addTelTrip, addTelTripsBatch, listTelEvents, listTelTrips, telematicsCounts, ensureSeededTelematics, seedIncident, usingSupabase: () => !!supa };
