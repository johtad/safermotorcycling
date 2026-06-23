# SaferMotorcycling — verification proxy

A tiny server that holds the API keys and exposes `/verify/*` to the front-end, so keys
never live in the browser. The front-end's `live` mode calls these endpoints.

## Run

```
cd backend
npm install
cp .env.example .env      # then paste your real keys into .env
npm start                 # listens on http://localhost:8787
```

Then in the front-end `config.js`: set `mode: "live"` and `backendUrl: "http://localhost:8787"`.

## Endpoints

```
POST /verify/dvla   { "query": "<licence no>" }  -> { ok, detail }   (Kora)
POST /verify/nia    { "query": "<ghana card>" }  -> { ok, detail }   (Smile ID)
POST /verify/mid    { "query": "<plate>" }       -> { ok, detail }   (NIC MID)
GET  /                                            -> health check
```

## Wiring real keys

Paste keys into `.env` only — never into chat, the front-end, or version control. Each adapter
in `server.js` is a single function; confirm the exact endpoint path, auth header and response
shape against the provider's live docs when you get your account:

- Kora — https://developers.korapay.com (Ghana driver's licence)
- Smile ID — https://docs.usesmileid.com (Ghana Card + licence; uses a signed request)
- NIC MID — https://middoc.nic.gov.gh (authorized `X-API-Key`)

Adapters return `{ ok: false, detail: "...not configured" }` until their keys are set, so the
app degrades gracefully.

## Production notes

- Add `.env` to `.gitignore`.
- Put this behind HTTPS and restrict CORS to your real front-end origin.
- Log verifications for audit, but minimise stored personal data (Data Protection Act, Act 843).
- For NIA Ghana Card, the authoritative route is the direct NIA contract, not an aggregator.
