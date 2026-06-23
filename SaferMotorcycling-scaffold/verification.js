// SaferMotorcycling — verification engine (pluggable provider)
// This is the heart of the scaffold. It exposes one object, `window.Verifier`, with:
//   - setRiders(list)      load the registry dataset
//   - findInRegistry(q)    internal lookup against the loaded list (no external API)
//   - verify(q) -> Promise internal lookup + external checks per the current mode
//
// To wire a real government API, you only change the `_liveCheck` calls below to hit
// YOUR backend proxy. Nothing else in the app needs to change.

(function () {
  var cfg = window.SMC_CONFIG || { mode: "dataset", backendUrl: "" };

  function norm(s) { return (s || "").toString().trim().toLowerCase(); }
  function noSpace(s) { return norm(s).replace(/\s+/g, ""); }

  var Verifier = {
    mode: cfg.mode || "dataset",
    riders: [],

    setRiders: function (list) { this.riders = Array.isArray(list) ? list : []; },

    findInRegistry: function (query) {
      var s = norm(query);
      if (!s) return null;
      var sNoSpace = noSpace(query);
      return this.riders.find(function (r) {
        return norm(r.ghana_card) === s ||
               noSpace(r.plate) === sNoSpace ||
               norm(r.rider_id) === s ||
               norm(r.full_name).indexOf(s) !== -1;
      }) || null;
    },

    verify: function (query) {
      var self = this;
      var record = this.findInRegistry(query);
      if (this.mode === "live") {
        // Route the right field of the matched rider to each authority:
        //   DVLA <- licence number, NIA <- Ghana Card, MID <- plate.
        // Falls back to the raw query when the rider isn't in the registry.
        var dvlaVal = record ? (record.licence_no || record.license_no || "") : query;
        var niaVal = record ? (record.ghana_card || "") : query;
        var midVal = record ? (record.plate || "") : query;
        return Promise.all([
          this._liveField("nia", niaVal, "Ghana Card"),
          this._liveField("mid", midVal, "plate"),
          this._liveField("dvla", dvlaVal, "licence number")
        ]).then(function (checks) {
          return { query: query, mode: self.mode, record: record, checks: checks };
        });
      }
      // mock + dataset both resolve synchronously, wrapped in a Promise for one call signature
      var checks = [
        this._derivedCheck("nia", record),
        this._derivedCheck("mid", record),
        this._derivedCheck("dvla", record)
      ];
      return Promise.resolve({ query: query, mode: this.mode, record: record, checks: checks });
    },

    // dataset mode: derive the answer from the loaded record. mock mode: same shape, generic.
    _derivedCheck: function (kind, record) {
      if (kind === "nia") {
        return { source: "NIA — Ghana Card", ok: !!record,
          detail: record ? ("matches " + record.full_name) : "no match in registry" };
      }
      if (kind === "mid") {
        var ok = !!(record && record.insurance_status === "valid");
        return { source: "NIC — MID (insurance)", ok: ok,
          detail: record ? ("insurance " + record.insurance_status + (record.insurance_expiry ? " · exp " + record.insurance_expiry : "")) : "unknown" };
      }
      if (kind === "dvla") {
        var okL = !!(record && record.license_status === "valid");
        return { source: "DVLA — licence", ok: okL,
          detail: record ? ("licence " + record.license_status) : "unknown" };
      }
      return { source: kind, ok: false, detail: "" };
    },

    // Route a specific field value to a provider; skip cleanly if the record has no such field.
    _liveField: function (kind, value, fieldLabel) {
      var label = ({ nia: "NIA — Ghana Card", mid: "NIC — MID (insurance)", dvla: "DVLA — licence" })[kind] || kind;
      if (!value) return Promise.resolve({ source: label, ok: false, detail: "no " + fieldLabel + " on record" });
      return this._liveCheck(kind, value);
    },

    // live mode: call YOUR backend proxy, which holds the keys and calls the real APIs.
    // The browser never sees an API key. Replace the path/response mapping to match your backend.
    _liveCheck: function (kind, query) {
      var label = ({ nia: "NIA — Ghana Card", mid: "NIC — MID (insurance)", dvla: "DVLA — licence" })[kind] || kind;
      if (!cfg.backendUrl) {
        return Promise.resolve({ source: label, ok: false, detail: "live mode not configured — set backendUrl + run a backend proxy (see README)" });
      }
      return fetch(cfg.backendUrl.replace(/\/$/, "") + "/verify/" + kind, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) { return { source: label, ok: !!data.ok, detail: data.detail || "" }; })
        .catch(function (e) { return { source: label, ok: false, detail: "backend error: " + e.message }; });
    }
  };

  window.Verifier = Verifier;
})();
