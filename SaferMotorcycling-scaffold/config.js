// SaferMotorcycling — configuration
// Switch the verification engine between three modes without touching the rest of the code.
//
//   "mock"    — everything is simulated (no data, no APIs). Good for pure UI demos.
//   "dataset" — verify against a real list loaded into the app (NRSA's collected riders,
//               via the sample data or an imported CSV). No external APIs. (DEFAULT)
//   "live"    — internal lookup against the loaded list PLUS real external checks
//               (NIA / NIC-MID / DVLA) made THROUGH YOUR OWN BACKEND PROXY.
//
// SECURITY: never put NIA / MID / aggregator API keys in this file or anywhere in the
// browser. In "live" mode the app calls `backendUrl + /verify/<provider>` — a small server
// you control that holds the keys and talks to the government APIs. See README.md.

window.SMC_CONFIG = {
  mode: "live",
  backendUrl: "http://localhost:8787", // local proxy (SaferMotorcycling-scaffold/backend)
  providers: {
    nia:  { enabled: true, label: "NIA — Ghana Card" },
    mid:  { enabled: true, label: "NIC — Motor Insurance Database" },
    dvla: { enabled: true, label: "DVLA — driver licence" }
  }
};
