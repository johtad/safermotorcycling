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

module.exports = { addIncident, listIncidents, getIncident, updateIncidentStatus, addRegistration, listRegistrations, seedIncident, usingSupabase: () => !!supa };
