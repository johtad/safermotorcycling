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
  try { const list = await store.listEvents(req.query.limit); res.json({ ok: true, events: list }); }
  catch (e) { res.status(500).json({ ok: false, detail: e.message }); }
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

app.get("/", (_req, res) => res.json({ ok: true, service: "SaferMotorcycling verification proxy" }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log("verification proxy listening on http://localhost:" + PORT));
