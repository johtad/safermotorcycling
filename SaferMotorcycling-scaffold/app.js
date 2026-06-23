// SaferMotorcycling — UI wiring
// Renders the registry table, runs verification, and imports NRSA's real list from CSV.
// Plain DOM, no build step. Loads after config.js, data.js, verification.js.

(function () {
  var V = window.Verifier;
  var LS_KEY = "smc_riders_v1";
  var sourceLabel = "sample data";

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  // ---- data load ----
  function loadInitial() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) {}
    if (saved && saved.length) { V.setRiders(saved); sourceLabel = "imported CSV (saved)"; }
    else { V.setRiders(window.SMC_SAMPLE_RIDERS || []); sourceLabel = "sample data"; }
  }

  // ---- CSV ----
  function splitLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else { q = !q; } }
      else if (c === "," && !q) { out.push(cur); cur = ""; }
      else { cur += c; }
    }
    out.push(cur);
    return out;
  }
  function parseCSV(text) {
    var lines = text.replace(/\r/g, "").split("\n").filter(function (l) { return l.trim().length; });
    if (!lines.length) return [];
    var headers = splitLine(lines[0]).map(function (h) { return h.trim(); });
    return lines.slice(1).map(function (line) {
      var cells = splitLine(line), obj = {};
      headers.forEach(function (h, i) { obj[h] = (cells[i] || "").trim(); });
      if (obj.safety_score) obj.safety_score = parseInt(obj.safety_score, 10) || 0;
      return obj;
    });
  }

  // ---- rendering ----
  function badge(status) {
    var cls = status === "active" ? "ok" : (status === "suspended" ? "bad" : "warn");
    return '<span class="badge ' + cls + '">' + esc(status) + "</span>";
  }
  function renderMeta() {
    $("count").textContent = V.riders.length.toLocaleString();
    $("dataSource").textContent = sourceLabel;
  }
  function renderTable(filter) {
    var f = (filter || "").trim().toLowerCase();
    var rows = V.riders.filter(function (r) {
      if (!f) return true;
      return (r.full_name || "").toLowerCase().indexOf(f) !== -1 ||
             (r.plate || "").toLowerCase().indexOf(f) !== -1 ||
             (r.licence_no || "").toLowerCase().indexOf(f) !== -1 ||
             (r.union || "").toLowerCase().indexOf(f) !== -1 ||
             (r.ghana_card || "").toLowerCase().indexOf(f) !== -1 ||
             (r.district || "").toLowerCase().indexOf(f) !== -1;
    });
    $("tableBody").innerHTML = rows.map(function (r) {
      return "<tr>" +
        "<td>" + esc(r.full_name) + "</td>" +
        '<td class="mono">' + esc(r.plate) + "</td>" +
        '<td class="mono">' + esc(r.licence_no || "—") + "</td>" +
        "<td>" + esc(r.union || "—") + "</td>" +
        "<td>" + esc(r.district) + "</td>" +
        "<td>" + esc(r.insurance_status) + "</td>" +
        "<td>" + esc(r.safety_score) + "</td>" +
        "<td>" + badge(r.status) + "</td>" +
        "</tr>";
    }).join("") || '<tr><td colspan="8" class="muted" style="padding:16px;text-align:center">no matches</td></tr>';
  }

  function checkRow(c) {
    var icon = c.ok
      ? '<svg viewBox="0 0 24 24" class="i ok"><polyline points="5 12 10 17 19 7"/></svg>'
      : '<svg viewBox="0 0 24 24" class="i bad"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    return '<div class="crow">' + icon +
      '<span class="src">' + esc(c.source) + "</span>" +
      '<span class="det ' + (c.ok ? "" : "muted") + '">' + esc(c.detail) + "</span></div>";
  }
  function renderResult(out) {
    var box = $("verifyResult");
    var r = out.record;
    var head;
    if (r) {
      var initials = (r.full_name || "?").split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase();
      head = '<div class="rhead"><div class="avatar">' + esc(initials) + "</div>" +
        "<div><div class=\"name\">" + esc(r.full_name) + "</div>" +
        '<div class="muted small mono">' + esc(r.plate) + " · " + esc(r.vehicle_type) + " · " + esc(r.district) + "</div></div>" +
        '<span class="reg-badge ok">in registry</span></div>';
    } else {
      head = '<div class="rhead"><div class="avatar none">?</div>' +
        '<div><div class="name">No registry match</div>' +
        '<div class="muted small">"' + esc(out.query) + '" is not in the loaded list</div></div>' +
        '<span class="reg-badge bad">not found</span></div>';
    }
    var checks = out.checks.map(checkRow).join("");
    box.innerHTML = head +
      '<div class="checks-label">external checks <span class="muted">· mode: ' + esc(out.mode) + "</span></div>" +
      checks;
    box.style.display = "block";
  }

  // ---- events ----
  function doVerify() {
    var q = $("verifyInput").value;
    if (!q.trim()) { $("verifyResult").style.display = "none"; return; }
    V.verify(q).then(renderResult);
  }
  function onImport(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var rows = parseCSV(reader.result);
        if (!rows.length) { alert("No rows found in CSV."); return; }
        V.setRiders(rows);
        sourceLabel = "imported: " + file.name;
        try { localStorage.setItem(LS_KEY, JSON.stringify(rows)); } catch (e) {}
        renderMeta(); renderTable($("search").value);
        alert("Loaded " + rows.length + " riders from " + file.name);
      } catch (e) { alert("Could not parse CSV: " + e.message); }
    };
    reader.readAsText(file);
  }
  function resetData() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    V.setRiders(window.SMC_SAMPLE_RIDERS || []);
    sourceLabel = "sample data";
    renderMeta(); renderTable($("search").value);
  }

  // ---- init ----
  function init() {
    loadInitial();
    renderMeta();
    renderTable("");
    var modeSel = $("modeSelect");
    modeSel.value = V.mode;
    modeSel.addEventListener("change", function () { V.mode = modeSel.value; $("modeNote").style.display = (V.mode === "live") ? "block" : "none"; });
    $("verifyBtn").addEventListener("click", doVerify);
    $("verifyInput").addEventListener("keydown", function (e) { if (e.key === "Enter") doVerify(); });
    $("search").addEventListener("input", function () { renderTable($("search").value); });
    $("importInput").addEventListener("change", onImport);
    $("resetBtn").addEventListener("click", resetData);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
