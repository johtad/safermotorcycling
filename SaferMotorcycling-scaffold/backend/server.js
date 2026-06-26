// SaferMotorcycling — verification proxy
// Holds API keys (env vars) and exposes /verify/<provider> for the front-end.
// The browser never sees a key. Front-end config.js: set mode "live" and
// backendUrl to this server (e.g. http://localhost:8787).
//
// IMPORTANT: the exact endpoint paths, auth headers and response shapes below are
// best-effort and MUST be confirmed against each provider's current docs once you
// have an account. They're isolated in the adapter functions so only those change.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const store = require("./store");

const app = express();
app.use(cors());
app.use(express.json());

// Serve the front-end so the whole app is ONE origin (page + API together).
// Locally: open http://localhost:8787/SaferMotorcycling.html
app.use(express.static(path.join(__dirname, "..", "..")));

// In-memory incident log — the SOS / dispatch feed for the command centre.
// LIVE NOW: the app's own SOS button posts here. FUTURE: the Police/112 dispatch
// connector posts here too, once an NRSA data-sharing MOU is in place.
function buildIncident(b) {
  b = b || {};
  var now = new Date().toISOString();
  var status = b.status || "open";
  return {
    id: b.id || ("inc-" + Date.now()),
    type: b.type || "sos",                  // sos | crash | breakdown | robbery
    trigger: b.trigger || "manual",         // manual | auto (crash-detected by tracker)
    reported_by: b.reported_by || "rider",  // rider | passenger | device
    rider: b.rider || {},                   // { plate, name, licence_no, union, insurance_status }
    location: b.location || {},             // { name, lat, lng, digital_address }
    region: b.region || "",
    telematics: b.telematics || {},         // { speed_before_kmh, impact_g }
    notes: b.notes || "",
    media: b.media || [],
    status: status,                         // open | acknowledged | dispatched | resolved
    status_history: b.status_history || [{ status: status, ts: now }],
    source: b.source || "app",             // app | 112 | mttd
    ts: b.ts || now
  };
}
store.seedIncident(buildIncident({
  id: "inc-seed1", type: "sos", trigger: "auto", reported_by: "device",
  rider: { plate: "GR 4471-24", name: "Kofi Mensah", licence_no: "481209", union: "Okada Riders Assoc.", insurance_status: "valid" },
  location: { name: "Kwame Nkrumah Circle", lat: 5.5709, lng: -0.1971, digital_address: "GA-145-9302" },
  region: "Accra", telematics: { speed_before_kmh: 54, impact_g: 7.2 }, source: "112", status: "resolved",
  status_history: [
    { status: "open", ts: "2026-06-23T16:00:00Z" },
    { status: "acknowledged", ts: "2026-06-23T16:01:10Z" },
    { status: "dispatched", ts: "2026-06-23T16:02:40Z" },
    { status: "resolved", ts: "2026-06-23T16:14:05Z" }
  ]
}));

// ---------- adapters ----------

// DVLA driver's licence via Kora (https://developers.korapay.com)
async function verifyDVLA(query) {
  const key = process.env.KORA_SECRET_KEY;
  if (!key) return { ok: false, detail: "DVLA/Kora not configured (set KORA_SECRET_KEY)" };
  const base = process.env.KORA_BASE || "https://api.korapay.com/merchant/api/v1";
  const resp = await fetch(base + "/identities/gh/drivers-license", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ id: query, verification_consent: true })
  });
  const data = await resp.json();
  // Confirm response shape in Kora docs; map to { ok, detail }.
  if (data && (data.status === true || data.status === "success") && data.data) {
    const d = data.data;
    const name = [d.first_name, d.last_name].filter(Boolean).join(" ");
    return { ok: true, detail: (name || "licence verified") + (d.license_no ? " · " + d.license_no : "") };
  }
  return { ok: false, detail: (data && data.message) || "not verified" };
}

// Ghana Card / identity via Smile ID (https://docs.usesmileid.com)
// Smile ID authenticates with a signature: base64(HMAC-SHA256(timestamp + partnerId + "sid_request", apiKey)).
// Confirm endpoint / job_type / response fields against the live docs once you have credentials.
function smileSignature(timestamp) {
  return crypto.createHmac("sha256", process.env.SMILE_API_KEY)
    .update(timestamp + process.env.SMILE_PARTNER_ID + "sid_request")
    .digest("base64");
}
async function verifyNIA(query) {
  const partnerId = process.env.SMILE_PARTNER_ID;
  const apiKey = process.env.SMILE_API_KEY;
  if (!partnerId || !apiKey) return { ok: false, detail: "NIA/Smile ID not configured (set SMILE_PARTNER_ID + SMILE_API_KEY)" };
  const env = (process.env.SMILE_ENV || "sandbox").toLowerCase();
  const base = env === "production" ? "https://api.smileidentity.com/v1" : "https://testapi.smileidentity.com/v1";
  const timestamp = new Date().toISOString();
  const body = {
    partner_id: partnerId,
    signature: smileSignature(timestamp),
    timestamp: timestamp,
    country: "GH",
    id_type: "GHANA_CARD",
    id_number: query,
    partner_params: { job_id: "smc-" + Date.now(), user_id: "smc-user", job_type: 5 }
  };
  const resp = await fetch(base + "/id_verification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  // Smile ID success is ResultCode "1012" (ID validated); confirm against docs.
  const actions = (data && data.Actions) || {};
  const verified = (data && data.ResultCode === "1012") || actions.Verify_ID_Number === "Verified";
  if (verified) return { ok: true, detail: data.FullName || "Ghana Card verified" };
  return { ok: false, detail: (data && (data.ResultText || data.error)) || "not verified" };
}

// Identity via Dojah (https://api-docs.dojah.io) — alternative provider.
// Auth headers: AppId + Authorization (secret key). Confirm the Ghana endpoint/response in docs.
async function verifyDojah(query) {
  const appId = process.env.DOJAH_APP_ID;
  const secret = process.env.DOJAH_SECRET_KEY;
  if (!appId || !secret) return { ok: false, detail: "Dojah not configured (set DOJAH_APP_ID + DOJAH_SECRET_KEY)" };
  const base = process.env.DOJAH_BASE || "https://sandbox.dojah.io";
  const path = process.env.DOJAH_ENDPOINT || "/api/v1/ghana/kyc/dl";
  const resp = await fetch(base.replace(/\/$/, "") + path + "?id=" + encodeURIComponent(query), {
    headers: { AppId: appId, Authorization: secret }
  });
  const data = await resp.json();
  const e = (data && data.entity) || null;
  if (e) {
    const name = [e.first_name, e.last_name].filter(Boolean).join(" ") || e.full_name;
    return { ok: true, detail: name || "verified" };
  }
  return { ok: false, detail: (data && (data.error || data.message)) || "not verified" };
}

// Insurance via NIC Motor Insurance Database (https://middoc.nic.gov.gh)
async function verifyMID(query) {
  const key = process.env.MID_API_KEY;
  const base = process.env.MID_BASE;
  if (!key || !base) return { ok: false, detail: "MID not configured (set MID_API_KEY + MID_BASE)" };
  const resp = await fetch(base.replace(/\/$/, "") + "/policies/verify?reg=" + encodeURIComponent(query), {
    headers: { "X-API-Key": key }
  });
  const data = await resp.json();
  // Confirm endpoint + response shape against MID docs; map to { ok, detail }.
  if (data && (data.valid === true || data.status === "valid")) {
    return { ok: true, detail: "insurance valid" + (data.expiry ? " · exp " + data.expiry : "") };
  }
  return { ok: false, detail: "no valid policy found" };
}

// ---------- routes ----------

function handler(fn) {
  return async (req, res) => {
    try {
      const query = (req.body && req.body.query || "").trim();
      if (!query) return res.status(400).json({ ok: false, detail: "missing query" });
      const out = await fn(query);
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, detail: "proxy error: " + e.message });
    }
  };
}

app.post("/verify/dvla", handler(verifyDVLA));
app.post("/verify/nia", handler(verifyNIA));
app.post("/verify/mid", handler(verifyMID));
app.post("/verify/dojah", handler(verifyDojah));
// Incident pipeline — SOS now (app-sourced); 112/MTTD dispatch later (via MOU connector).
app.post("/incidents", async (req, res) => {
  try { const inc = buildIncident(req.body || {}); await store.addIncident(inc); res.json({ ok: true, incident: inc }); }
  catch (e) { res.status(500).json({ ok: false, detail: "store error: " + e.message }); }
});
app.get("/incidents", async (req, res) => {
  try { const list = await store.listIncidents(req.query.region); res.json({ ok: true, incidents: list }); }
  catch (e) { res.status(500).json({ ok: false, detail: "store error: " + e.message }); }
});
app.get("/incidents/:id", async (req, res) => {
  try { const inc = await store.getIncident(req.params.id); if (!inc) return res.status(404).json({ ok: false, detail: "not found" }); res.json({ ok: true, incident: inc }); }
  catch (e) { res.status(500).json({ ok: false, detail: "store error: " + e.message }); }
});
app.patch("/incidents/:id", async (req, res) => {
  try {
    const status = req.body && req.body.status;
    if (!status) return res.status(400).json({ ok: false, detail: "missing status" });
    const inc = await store.updateIncidentStatus(req.params.id, status, { status: status, ts: new Date().toISOString() });
    if (!inc) return res.status(404).json({ ok: false, detail: "not found" });
    res.json({ ok: true, incident: inc });
  } catch (e) { res.status(500).json({ ok: false, detail: "store error: " + e.message }); }
});

// Usage events — anonymous visitor activity (page views, tab switches, key actions).
// No PII captured: just a random session id, the event name, and minimal context.
app.post("/events", async (req, res) => {
  try {
    const b = req.body || {};
    const ua = (req.get && req.get("user-agent")) || "";
    await store.addEvent({ session_id: b.session_id, event_type: b.event_type, event_data: b.event_data, user_agent: ua });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
});
app.get("/events", async (req, res) => {
  try {
    const list = await store.listEvents(req.query.limit);
    const status = store.eventStoreStatus ? store.eventStoreStatus() : {};
    res.json({ ok: true, events: list, fallback_count: status.fallback_count || 0, last_error: status.last_error || null, supabase: !!status.supabase });
  } catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
});

// Registrations — riders onboarded in the field app, so NRSA sees what gets entered.
app.post("/registrations", async (req, res) => {
  try { const r = req.body || {}; await store.addRegistration(r); res.json({ ok: true, registration: r }); }
  catch (e) { res.status(500).json({ ok: false, detail: "store error: " + e.message }); }
});
app.get("/registrations", async (req, res) => {
  try { const list = await store.listRegistrations(); res.json({ ok: true, registrations: list }); }
  catch (e) { res.status(500).json({ ok: false, detail: "store error: " + e.message }); }
});

// Vehicles — telematics-enabled vehicles with current position + cumulative driver-behaviour counters.
app.get("/vehicles", async (req, res) => {
  try { const list = await store.listVehicles(req.query.region, req.query.type); res.json({ ok: true, vehicles: list }); }
  catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
});
app.post("/vehicles", async (req, res) => {
  try {
    const v = req.body || {};
    if (!v.id) return res.status(400).json({ ok: false, detail: "missing id" });
    await store.upsertVehicle(v);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
});

function generateSeedFleet() {
  const accraSpots = [
    { name: "Circle", lat: 5.5705, lng: -0.1969 },
    { name: "Kaneshie", lat: 5.558, lng: -0.234 },
    { name: "Tema", lat: 5.667, lng: -0.017 },
    { name: "Madina", lat: 5.668, lng: -0.166 },
    { name: "Spintex", lat: 5.618, lng: -0.165 },
    { name: "Achimota", lat: 5.618, lng: -0.227 },
    { name: "Kasoa", lat: 5.534, lng: -0.418 },
    { name: "Tetteh Quarshie", lat: 5.620, lng: -0.173 }
  ];
  const tamaleSpots = [
    { name: "Aboabo", lat: 9.398, lng: -0.836 },
    { name: "Central market", lat: 9.407, lng: -0.853 },
    { name: "Education ridge", lat: 9.43, lng: -0.85 },
    { name: "Lamashegu", lat: 9.38, lng: -0.85 },
    { name: "Sagnarigu", lat: 9.412, lng: -0.86 },
    { name: "Kalpohin", lat: 9.39, lng: -0.872 },
    { name: "Vittin", lat: 9.435, lng: -0.815 },
    { name: "Choggu", lat: 9.451, lng: -0.866 }
  ];
  const types = ["motorcycle", "tricycle", "voxy"];
  const unions = ["GPRTU", "Okada Riders Assoc.", "Tricycle Operators Union", "Co-operative Transport Society"];
  const names = ["Kwabena Asante","Ama Owusu","Ibrahim Salifu","Joseph Tetteh","Mavis Adjei","Kwesi Boadu","Akosua Frimpong","Mohammed Awal","Fatima Yakubu","Daniel Mensah","Esi Boateng","Kofi Anane","Yaa Asantewaa","Samuel Antwi","Ophelia Mensah","Issaka Mohammed","Naa Adoley","Kwame Nkrumah","Aboagye Konadu","Aisha Issaka","Kobena Ofori","Comfort Adjei","Ibrahim Tahiru","Yaw Boakye"];
  const out = []; let n = 1;
  function pushAt(region, spots, prefix, idxAdd) {
    for (let i = 0; i < spots.length; i++) {
      for (let k = 0; k < 3; k++) {
        const type = types[(i + k + idxAdd) % types.length];
        const status = k === 0 ? "moving" : (k === 1 ? "parked" : (Math.random() > 0.5 ? "moving" : "idle"));
        const speed = status === "moving" ? Math.floor(20 + Math.random() * 40) : 0;
        out.push({
          id: prefix + "-" + String(n).padStart(4, "0"),
          type, region, plate: (region === "Accra" ? "GR " : "NR ") + (1000 + n * 7).toString() + "-24",
          rider_name: names[(n - 1) % names.length],
          union_name: unions[n % unions.length],
          status,
          lat: spots[i].lat + (Math.random() - 0.5) * 0.012,
          lng: spots[i].lng + (Math.random() - 0.5) * 0.012,
          speed_kmh: speed,
          heading: Math.floor(Math.random() * 360),
          safety_score: 60 + Math.floor(Math.random() * 40),
          harsh_brake_count: Math.floor(Math.random() * 12),
          speeding_count: Math.floor(Math.random() * 8)
        });
        n++;
      }
    }
  }
  pushAt("Accra", accraSpots, "AV", 0);
  pushAt("Tamale", tamaleSpots, "TV", 1);
  return out;
}
store.ensureSeededVehicles(generateSeedFleet);

// ---------- Telematics ----------
// Discrete driving-behaviour events (harsh brake, speeding, harsh corner, night-ride, crash detected).
// One row per event. Denormalized with union/vehicle_type so aggregations are cheap.
app.post("/telematics/events", async (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b)) { const n = await store.addTelEventsBatch(b); res.json({ ok: true, inserted: n }); }
    else { await store.addTelEvent(b); res.json({ ok: true }); }
  } catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
});

// Completed trips with summary stats + computed safety score.
app.post("/telematics/trips", async (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b)) { const n = await store.addTelTripsBatch(b); res.json({ ok: true, inserted: n }); }
    else { await store.addTelTrip(b); res.json({ ok: true }); }
  } catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
});

// Aggregated dashboard metrics: feeds the existing "telematics safety-score inputs" panel with REAL data.
app.get("/telematics/summary", async (req, res) => {
  try {
    const region = req.query.region;
    const sinceISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [events, trips, vehicles] = await Promise.all([
      store.listTelEvents(region, sinceISO),
      store.listTelTrips(region, sinceISO),
      store.listVehicles(region)
    ]);
    const totalKm = trips.reduce((a, t) => a + (parseFloat(t.distance_km) || 0), 0);
    const per100km = (n) => (totalKm > 0 ? Math.round((n * 100) / totalKm * 10) / 10 : 0);
    const byType = {};
    events.forEach((e) => { byType[e.event_type] = (byType[e.event_type] || 0) + 1; });
    const nightEvents = events.filter((e) => e.event_type === "night_ride").length;
    const avgScore = trips.length ? Math.round(trips.reduce((a, t) => a + (parseInt(t.safety_score, 10) || 0), 0) / trips.length) : 0;
    res.json({
      ok: true,
      region: region || "all",
      window_days: 30,
      devices_fitted: vehicles.length,
      trips_30d: trips.length,
      distance_km_30d: Math.round(totalKm),
      avg_safety_score: avgScore,
      harsh_brake_per_100km: per100km(byType.harsh_brake || 0),
      speeding_per_100km: per100km(byType.speeding || 0),
      harsh_corner_per_100km: per100km(byType.harsh_corner || 0),
      night_ride_pct: trips.length ? Math.round((nightEvents / trips.length) * 100) : 0,
      crash_events: byType.crash_detected || 0,
      total_events: events.length,
      events_by_type: byType
    });
  } catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
});

// Policy insights: time-of-day, by-union, top hotspots. The NRSA-grade analytics.
app.get("/telematics/insights", async (req, res) => {
  try {
    const region = req.query.region;
    const sinceISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [events, trips] = await Promise.all([
      store.listTelEvents(region, sinceISO),
      store.listTelTrips(region, sinceISO)
    ]);
    // Time-of-day: 24-hour event distribution
    const byHour = new Array(24).fill(0);
    events.forEach((e) => { const h = new Date(e.ts).getHours(); byHour[h] = (byHour[h] || 0) + 1; });
    // By union: avg safety score from trips + event rate
    const unionAgg = {};
    trips.forEach((t) => {
      const u = t.union_name || "unknown";
      if (!unionAgg[u]) unionAgg[u] = { trips: 0, score_sum: 0, km_sum: 0 };
      unionAgg[u].trips++;
      unionAgg[u].score_sum += parseInt(t.safety_score, 10) || 0;
      unionAgg[u].km_sum += parseFloat(t.distance_km) || 0;
    });
    const eventsByUnion = {};
    events.forEach((e) => { const u = e.union_name || "unknown"; eventsByUnion[u] = (eventsByUnion[u] || 0) + 1; });
    const byUnion = Object.keys(unionAgg).map((u) => ({
      union: u,
      trips: unionAgg[u].trips,
      avg_safety_score: Math.round(unionAgg[u].score_sum / unionAgg[u].trips),
      events_per_100km: unionAgg[u].km_sum > 0 ? Math.round(((eventsByUnion[u] || 0) * 100) / unionAgg[u].km_sum * 10) / 10 : 0
    })).sort((a, b) => b.avg_safety_score - a.avg_safety_score);
    // Top event hotspots: count events per location_label
    const byLocation = {};
    events.forEach((e) => { if (!e.location_label) return; byLocation[e.location_label] = (byLocation[e.location_label] || 0) + 1; });
    const topHotspots = Object.keys(byLocation).map((loc) => ({ location: loc, events: byLocation[loc] }))
      .sort((a, b) => b.events - a.events).slice(0, 6);
    // By vehicle type
    const vtAgg = {};
    trips.forEach((t) => {
      const v = t.vehicle_type || "unknown";
      if (!vtAgg[v]) vtAgg[v] = { trips: 0, score_sum: 0, km_sum: 0 };
      vtAgg[v].trips++; vtAgg[v].score_sum += parseInt(t.safety_score, 10) || 0; vtAgg[v].km_sum += parseFloat(t.distance_km) || 0;
    });
    const eventsByType = {};
    events.forEach((e) => { const v = e.vehicle_type || "unknown"; eventsByType[v] = (eventsByType[v] || 0) + 1; });
    const byVehicleType = Object.keys(vtAgg).map((v) => ({
      vehicle_type: v,
      trips: vtAgg[v].trips,
      km: Math.round(vtAgg[v].km_sum),
      avg_safety_score: Math.round(vtAgg[v].score_sum / vtAgg[v].trips),
      events_per_100km: vtAgg[v].km_sum > 0 ? Math.round(((eventsByType[v] || 0) * 100) / vtAgg[v].km_sum * 10) / 10 : 0
    })).sort((a, b) => b.avg_safety_score - a.avg_safety_score);
    res.json({ ok: true, region: region || "all", window_days: 30, events_by_hour: byHour, by_union: byUnion, top_hotspots: topHotspots, by_vehicle_type: byVehicleType });
  } catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
});

// Generate realistic telematics history for the prototype demo:
//  • ~25 trips per vehicle over the last 30 days (so each region has ~600 trips, ~12K km, ~700-900 events)
//  • Events biased toward known crash hotspots (60%) and rush hours
//  • Trip safety_score derived from event counts + severities (lower = worse driving)
function generateTelematicsSeed(fleet) {
  const accraHotspots = [
    { label: "Kwame Nkrumah Circle", lat: 5.5705, lng: -0.1969 },
    { label: "Kaneshie / Lapaz", lat: 5.558, lng: -0.234 },
    { label: "Tema station", lat: 5.667, lng: -0.017 },
    { label: "Madina", lat: 5.668, lng: -0.166 },
    { label: "Tetteh Quarshie / Spintex", lat: 5.618, lng: -0.165 },
    { label: "Achimota", lat: 5.618, lng: -0.227 },
    { label: "Kasoa road", lat: 5.534, lng: -0.418 }
  ];
  const tamaleHotspots = [
    { label: "Aboabo junction", lat: 9.398, lng: -0.836 },
    { label: "Central market", lat: 9.407, lng: -0.853 },
    { label: "Education ridge", lat: 9.43, lng: -0.85 },
    { label: "Lamashegu junction", lat: 9.38, lng: -0.85 },
    { label: "Kalpohin", lat: 9.39, lng: -0.872 },
    { label: "Sagnarigu road", lat: 9.412, lng: -0.86 }
  ];
  const typeWeights = [
    { type: "harsh_brake", w: 35 },
    { type: "speeding", w: 25 },
    { type: "harsh_corner", w: 20 },
    { type: "night_ride", w: 15 },
    { type: "crash_detected", w: 5 }
  ];
  const wSum = typeWeights.reduce((a, t) => a + t.w, 0);
  function pickType() { let r = Math.random() * wSum, s = 0; for (const t of typeWeights) { s += t.w; if (r < s) return t.type; } return "harsh_brake"; }
  // Weighted hour distribution: peaks at 7-9, 17-19, 22-1
  function pickHour() {
    const r = Math.random();
    if (r < 0.25) return 6 + Math.floor(Math.random() * 4);
    if (r < 0.5) return 16 + Math.floor(Math.random() * 4);
    if (r < 0.65) return (22 + Math.floor(Math.random() * 4)) % 24;
    return Math.floor(Math.random() * 24);
  }
  function nearHotspot(hs) { const p = hs[Math.floor(Math.random() * hs.length)]; return { lat: p.lat + (Math.random() - 0.5) * 0.012, lng: p.lng + (Math.random() - 0.5) * 0.012, label: p.label }; }
  const events = [];
  const trips = [];
  const now = Date.now();
  fleet.forEach((v) => {
    const hotspots = v.region === "Accra" ? accraHotspots : tamaleHotspots;
    const numTrips = 20 + Math.floor(Math.random() * 20);
    // Some "bad rider" vehicles get more events per trip; align with seeded safety_score
    const riskFactor = v.safety_score >= 85 ? 0.25 : (v.safety_score >= 70 ? 0.6 : 1.2);
    for (let t = 0; t < numTrips; t++) {
      const daysAgo = Math.floor(Math.random() * 30);
      const hr = pickHour();
      const start = new Date(now - daysAgo * 86400000); start.setHours(hr, Math.floor(Math.random() * 60), 0, 0);
      const durMin = 8 + Math.floor(Math.random() * 50);
      const end = new Date(start.getTime() + durMin * 60000);
      const distKm = Math.round((1 + Math.random() * 14) * 10) / 10;
      const startSpot = nearHotspot(hotspots), endSpot = nearHotspot(hotspots);
      const eventCounts = { harsh_brake: 0, speeding: 0, harsh_corner: 0, night_ride: 0, crash_detected: 0 };
      const tripEvents = [];
      const numEvents = Math.floor(Math.random() * 4 * riskFactor);
      for (let e = 0; e < numEvents; e++) {
        const useHotspot = Math.random() < 0.6;
        const loc = useHotspot ? nearHotspot(hotspots) : { lat: startSpot.lat + (Math.random() - 0.5) * 0.05, lng: startSpot.lng + (Math.random() - 0.5) * 0.05, label: null };
        const eType = pickType();
        eventCounts[eType] = (eventCounts[eType] || 0) + 1;
        const eTime = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
        tripEvents.push({
          vehicle_id: v.id, region: v.region, union_name: v.union_name, vehicle_type: v.type,
          event_type: eType, severity: 1 + Math.floor(Math.random() * 5),
          lat: loc.lat, lng: loc.lng, speed_kmh: 30 + Math.floor(Math.random() * 50),
          location_label: loc.label, ts: eTime.toISOString(), meta: {}
        });
      }
      // Night-ride event flag if trip overlaps 22:00-05:00
      if (hr >= 22 || hr < 5) {
        eventCounts.night_ride++;
        tripEvents.push({
          vehicle_id: v.id, region: v.region, union_name: v.union_name, vehicle_type: v.type,
          event_type: "night_ride", severity: 2,
          lat: startSpot.lat, lng: startSpot.lng, speed_kmh: 40,
          location_label: startSpot.label, ts: start.toISOString(), meta: {}
        });
      }
      events.push.apply(events, tripEvents);
      // Compute trip safety score: penalize event types differently
      const penalty = (eventCounts.harsh_brake * 3) + (eventCounts.speeding * 4) + (eventCounts.harsh_corner * 2) + (eventCounts.night_ride * 1) + (eventCounts.crash_detected * 25);
      const tripScore = Math.max(0, 100 - penalty);
      trips.push({
        vehicle_id: v.id, region: v.region, union_name: v.union_name, vehicle_type: v.type,
        started_at: start.toISOString(), ended_at: end.toISOString(),
        start_lat: startSpot.lat, start_lng: startSpot.lng, end_lat: endSpot.lat, end_lng: endSpot.lng,
        distance_km: distKm, duration_min: durMin,
        max_speed_kmh: 40 + Math.floor(Math.random() * 40), avg_speed_kmh: Math.round((distKm / (durMin / 60)) || 0),
        event_counts: eventCounts, safety_score: tripScore
      });
    }
  });
  return { events, trips };
}
// Seed telematics from the fleet (must run after vehicles are seeded so we have union/type per vehicle).
setTimeout(async () => {
  try { const fleet = await store.listVehicles(); store.ensureSeededTelematics(() => generateTelematicsSeed(fleet)); }
  catch (e) { console.warn("telematics seed:", e.message); }
}, 4000);

app.get("/", (_req, res) => res.json({ ok: true, service: "SaferMotorcycling verification proxy" }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log("verification proxy listening on http://localhost:" + PORT));
