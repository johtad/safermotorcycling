# SaferMotorcycling — verification scaffold

A small, dependency-free codebase for the MVP wedge: **verify a rider against NRSA's own
collected data**, with a pluggable engine that can later check that data against the real
government APIs (NIA, NIC/MID, DVLA).

This is the developer-facing sibling of the pitch demo (`SaferMotorcycling-prototype.html`).
The prototype is for *showing*; this scaffold is for *building*.

## Run it

Just open `index.html` in any browser (double-click). No install, no build step, works offline.

- For `mock` and `dataset` modes, opening the file directly is enough.
- For `live` mode (real API calls via your backend), serve the folder over HTTP so browser
  security doesn't block requests, e.g. from this folder:
  - `python3 -m http.server 8000` then visit `http://localhost:8000`

## The three modes (set in `config.js`)

| Mode | Internal lookup | External checks (NIA/MID/DVLA) | Use it for |
|------|-----------------|-------------------------------|------------|
| `mock` | generic | simulated | pure UI demos |
| `dataset` (default) | against the loaded list | derived from the loaded record | **demoing with NRSA's real collected names — no API needed** |
| `live` | against the loaded list | real calls via your backend proxy | production / a live verification proof |

## Load NRSA's real data

Click **import CSV** in the app and choose a file with the same columns as
`riders.sample.csv`:

```
rider_id, full_name, ghana_card, phone, plate, vehicle_type, district,
insurance_status, insurance_expiry, license_status, safety_score, status
```

Imported data is saved in the browser (localStorage) until you click **reset to sample**.
This is the fastest way to make the demo real: ask NRSA to export their collected riders to
CSV in this shape and import it.

> The internal lookup needs no external API — it searches the list you load. That alone lets
> Denis verify against names NRSA already has.

## Wire the real government APIs (`live` mode)

Do **not** put API keys in the browser. Stand up a small backend that holds the keys and
exposes one endpoint per provider; the app calls it:

```
POST {backendUrl}/verify/nia    body: { query }   ->  { ok: boolean, detail: string }
POST {backendUrl}/verify/mid    body: { query }   ->  { ok, detail }
POST {backendUrl}/verify/dvla   body: { query }   ->  { ok, detail }
```

Set `backendUrl` in `config.js` and switch mode to `live`. The only code that changes is
`_liveCheck` in `verification.js` (response mapping). Behind those endpoints:

- **NIA — Ghana Card:** the Identity Verification System. Formal contract + accreditation
  (longest lead time). Start this procurement early.
- **NIC — Motor Insurance Database (MID):** MID II API, `X-API-Key` (server-side). Request an
  authorized key from NIC. The quickest real win.
- **DVLA — driver licence:** available via commercial identity providers (e.g. Kora, Smile ID,
  Dojah, Prembly) with fast onboarding and sandbox keys. Direct DVLA + vehicle-register access
  is the one item to confirm.

## Compliance note

Verifying real people's data — especially Ghana Card numbers — is regulated by the
**Data Protection Act, 2012 (Act 843)**. For demos: run the internal lookup on NRSA's own data
(NRSA is the data controller), and only run live external checks on test/sandbox or consented
records. Don't push the whole real list through a third-party service.

## Files

- `index.html` — page structure
- `styles.css` — styling
- `config.js` — mode + backend URL
- `data.js` — fictional sample riders
- `verification.js` — the pluggable engine (`window.Verifier`)
- `app.js` — UI wiring, CSV import
- `riders.sample.csv` — the expected import format
