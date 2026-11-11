const $ = (s) => document.querySelector(s);

try {
  const mv = chrome.runtime.getManifest && chrome.runtime.getManifest().version;
  const stamp = () => { const e = $("#extver"); if (e && mv) e.textContent = "v" + mv; };
  if (mv) { if ($("#extver")) stamp(); else document.addEventListener("DOMContentLoaded", stamp); }
} catch (e) {}

const state = {
  url: "",
  info: null,
  options: [],
  selected: null,
  job: null,
};

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

function status(msg, isErr) {
  const s = $("#status");
  if (!msg) { hide(s); return; }
  s.textContent = msg;
  s.className = isErr ? "status err" : "status";
  show(s);
}

// Send a command to the bridge; resolves with its "result" message.
function send(cmd, extra, timeoutMs) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ to: "bridge", cmd }, extra || {}), (resp) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      if (!resp || !resp.ok) { resolve({ ok: false, error: (resp && resp.error) || "Local helper is not reachable." }); return; }
      const id = resp.id;
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onMsg);
        resolve({ ok: false, error: "No answer from the local helper. Close and reopen the popup; if it repeats, run the installer again and restart your browser." });
      }, timeoutMs || 15000);
      function onMsg(m) {
        // Accept both "result" replies and "error" relays (e.g. the helper
        // disconnecting); silently dropping "error" hid real failures
        // behind the full timeout.
        if (m && m.umd && m.umd.id === id && (m.umd.type === "result" || m.umd.type === "error")) {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(onMsg);
          resolve(m.umd.ok === undefined ? Object.assign({ ok: false }, m.umd) : m.umd);
        }
      }
      chrome.runtime.onMessage.addListener(onMsg);
    });
  });
}

// Download progress / completion events.
chrome.runtime.onMessage.addListener((m) => {
  const g = m && m.umd;
  if (!g || !state.job) return;
  if (g.job !== state.job.id) return;
  if (g.type === "progress") {
    $("#fill").style.width = (g.pct || 0) + "%";
    $("#ppct").textContent = g.pct != null ? Math.round(g.pct) + "%" : "";
    $("#ptext").textContent =
      (g.pct != null ? g.pct.toFixed(1) + "%" : "...") +
      (g.speed ? " at " + g.speed : "") +
      (g.eta ? " - ETA " + g.eta : "") +
      (g.stage ? " - " + g.stage : "");
  } else if (g.type === "done") {
    hide($("#progress"));
    $("#donetext").textContent = "Saved: " + (g.file || "file") + "  (Downloads/UMD)";
    show($("#done"));
    state.job = null;
  } else if (g.type === "error") {
    hide($("#progress"));
    status(g.error || "Download failed.", true);
    state.job = null;
    show($("#download"));
  }
});

function fmtDur(sec) {
  if (!sec) return "";
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  const h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`
           : `${m}:${String(s).padStart(2, "0")}`;
}

function renderOptions() {
  const box = $("#options");
  box.innerHTML = "";
  let lastKind = null;
  for (const o of state.options) {
    if (o.kind !== lastKind) {
      lastKind = o.kind;
      const g = document.createElement("div");
      g.className = "group";
      g.textContent = o.kind === "video" ? "Video" : "Audio only";
      box.appendChild(g);
    }
    const row = document.createElement("div");
    row.className = "opt";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "fmt";
    const lab = document.createElement("span");
    lab.className = "lab";
    lab.textContent = o.label;
    const sz = document.createElement("span");
    sz.className = "sz";
    sz.textContent = o.size || "";
    row.append(radio, lab, sz);
    row.onclick = () => {
      state.selected = o;
      radio.checked = true;
      box.querySelectorAll(".opt").forEach((r) => r.classList.remove("sel"));
      row.classList.add("sel");
      show($("#download"));
    };
    box.appendChild(row);
  }
}

async function doCheck(url) {
  status("Reading link...", false);
  hide($("#info")); $("#options").innerHTML = ""; hide($("#download")); hide($("#done")); hide($("#progress"));
  const r = await send("probe", { url }, 13000);
  if (!r.ok) { status(r.error || "Could not read that link.", true); return; }
  state.info = r.info; state.options = r.options; state.url = url;
  status("");
  $("#title").textContent = r.info.title || "Untitled media";
  $("#meta").textContent = [r.info.site, r.info.uploader, fmtDur(r.info.duration)].filter(Boolean).join(" - ");
  if (r.info.thumbnail) { $("#thumb").src = r.info.thumbnail; show($("#thumb")); } else hide($("#thumb"));
  show($("#info"));
  if (!state.options.length) { status("The downloader found no downloadable formats on that page.", true); return; }
  renderOptions();
  if (r.info.note) status(r.info.note, false);
}

// While a download runs, the picker controls step back and the progress
// card takes over; the picker returns on error or on "New download".
function setDownloading(on) {
  ["#usetab", ".or", ".urlrow", "#info", "#options"].forEach((s) => { const el = $(s); if (el) el.hidden = on; });
}

async function startDownload() {
  const o = state.selected;
  if (!o || !state.url) return;
  hide($("#download")); hide($("#done"));
  setDownloading(true);
  $("#ptitle").textContent = (state.info && state.info.title) || "Downloading";
  $("#ppct").textContent = "";
  show($("#progress"));
  $("#fill").style.width = "0%";
  $("#ptext").textContent = "Starting...";
  const r = await send("download", {
    url: state.url,
    kind: o.kind,
    selector: o.selector || "",
    mp3: o.mp3 || 0,
  });
  if (!r.ok) { hide($("#progress")); setDownloading(false); status(r.error || "Download failed to start.", true); show($("#download")); return; }
  state.job = { id: r.job };
}

function setConn(state) {
  const p = $("#conn");
  if (!p) return;
  p.classList.toggle("on", state === "on");
  p.classList.toggle("off", state === "off");
  p.innerHTML = "<i></i>" + (state === "on" ? "helper connected" : state === "off" ? "not connected" : "checking...");
}

async function boot() {
  const st = await new Promise((res) =>
    chrome.runtime.sendMessage({ to: "bridge", cmd: "bridge-state" }, res));
  if (!st || !st.connected) {
    setConn("off");
    show($("#setup"));
    $("#setup-err").textContent = (st && st.error) ? ("(" + st.error + ")") : "";
    $("#eng").textContent = "engine: not connected";
    return;
  }
  // The port connecting is not proof the helper works - require a real ping.
  // The ping answers instantly and never touches the engine binaries, so a
  // slow first-run engine cannot trip this gate.
  const ping = await send("ping", null, 10000);
  if (!ping.ok) {
    setConn("off");
    show($("#setup"));
    const why = ping.error || "helper connected but it did not answer";
    $("#setup-err").textContent = "(" + why + (why.indexOf("restart your browser") === -1 ? " - run the installer again, then restart your browser" : "") + ")";
    $("#eng").textContent = "engine: not responding";
    return;
  }
  setConn("on");
  show($("#main"));

  // Footer engine info loads lazily; it must never block the UI.
  send("versions", null, 20000).then((v) => {
    $("#eng").textContent = (v && v.ok && v.versions && v.versions.ytdlp)
      ? "engine: yt-dlp " + v.versions.ytdlp
      : "engine: connected (version check pending)";
  }).catch(() => {});

  // Re-attach to a running job if the popup was closed mid-download.
  const jobs = await chrome.storage.session.get(null);
  let newest = null;
  for (const [k, v] of Object.entries(jobs)) {
    if (!k.startsWith("job:")) continue;
    if (v.type === "progress" && (!newest || (v.ts || 0) > (newest.ts || 0))) newest = v;
  }
  if (newest) {
    state.job = { id: newest.job };
    setDownloading(true);
    $("#ptitle").textContent = "Download in progress";
    show($("#progress"));
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const u = tabs && tabs[0] && tabs[0].url;
    if (u && /^https?:\/\//.test(u)) $("#url").value = u;
  });
}

$("#check").onclick = () => { const u = $("#url").value.trim(); if (u) doCheck(u); };
$("#url").addEventListener("keydown", (e) => { if (e.key === "Enter") { const u = e.target.value.trim(); if (u) doCheck(u); } });
$("#usetab").onclick = () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const u = tabs && tabs[0] && tabs[0].url;
    if (u && /^https?:\/\//.test(u)) { $("#url").value = u; doCheck(u); }
  });
};
$("#download").onclick = startDownload;
$("#cancel").onclick = () => { if (state.job) send("cancel", { job: state.job.id }); };
$("#openfolder").onclick = () => send("open-downloads");
$("#openfolder2").onclick = () => send("open-downloads");
$("#again").onclick = () => { hide($("#done")); $("#options").innerHTML = ""; hide($("#info")); $("#url").value = ""; state.selected = null; setDownloading(false); $("#url").focus(); };
$("#update").onclick = async (e) => {
  e.preventDefault();
  $("#eng").textContent = "engine: updating...";
  const r = await send("update-engine");
  if (!r.ok) { $("#eng").textContent = "update failed to start"; return; }
  const jid = r.job;
  const onMsg = (m) => {
    const g = m && m.umd;
    if (!g || g.job !== jid) return;
    if (g.type === "done") {
      chrome.runtime.onMessage.removeListener(onMsg);
      $("#eng").textContent = "engine: yt-dlp " + (g.version || "?") + (g.note === "already latest" ? " (already latest)" : "");
    } else if (g.type === "error") {
      chrome.runtime.onMessage.removeListener(onMsg);
      $("#eng").textContent = "update failed - current version kept";
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);
};
$("#closex").onclick = () => window.close();

// ---- panel silhouette + traveling border light ---------------------------
// Same shape recipe as the in-page menu's card (raised top-right tab), and
// the same SVG rim; the blue light is a short dash traveling the outline.
const PANEL_TAB_W = 132, PANEL_RISE = 30, PANEL_SHOULDER = 34, PANEL_R = 20, PANEL_TAB_R = 13;

function panelShape(W, H) {
  const R = PANEL_R, T = PANEL_TAB_R, tw = PANEL_TAB_W, y0 = PANEL_RISE, sh = PANEL_SHOULDER;
  const pts = [];
  function arc(cx, cy, r, a0, a1) {
    const n = 4;
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * i / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  arc(R, y0 + R, R, Math.PI, Math.PI * 1.5);
  pts.push([W - tw - sh, y0]);
  pts.push([W - tw, T]);
  arc(W - tw + T, T, T, Math.PI, Math.PI * 1.5);
  pts.push([W - T, 0]);
  arc(W - T, T, T, Math.PI * 1.5, Math.PI * 2);
  pts.push([W, H - R]);
  arc(W - R, H - R, R, 0, Math.PI / 2);
  pts.push([R, H]);
  arc(R, H - R, R, Math.PI / 2, Math.PI);
  pts.push([0, y0 + R]);
  return {
    clip: pts.map(p => p[0].toFixed(1) + "px " + p[1].toFixed(1) + "px").join(","),
    ptsAttr: pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" "),
  };
}

const LIGHT_SEGS = [
  ["umd-p-glow", 0.16],
  ["umd-p-body", 0.11],
  ["umd-p-head", 0.025],
];
let lightLen = 0;
let lightNow = 0;
const LIGHT_PERIOD = 5200;

function lightFrame(now) {
  lightNow = now;
  if (!lightLen) return;
  const off = ((now % LIGHT_PERIOD) / LIGHT_PERIOD) * lightLen;
  for (const [id] of LIGHT_SEGS) {
    const el = document.getElementById(id);
    if (el) el.setAttribute("stroke-dashoffset", (-off).toFixed(1));
  }
}

function bakePanel() {
  const p = $("#panel");
  if (!p) return;
  const W = Math.round(p.offsetWidth), H = Math.round(p.offsetHeight);
  if (W < 80 || H < 80) return;
  if (p._baked === W + "x" + H) { return; }
  p._baked = W + "x" + H;
  const shape = panelShape(W, H);
  p.style.clipPath = "polygon(" + shape.clip + ")";
  $("#glassrim").innerHTML =
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    '<defs><linearGradient id="umdPRimG" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="rgba(255,255,255,.98)"/>' +
    '<stop offset=".22" stop-color="rgba(255,255,255,.28)"/>' +
    '<stop offset=".5" stop-color="rgba(185,212,255,.40)"/>' +
    '<stop offset=".72" stop-color="rgba(255,255,255,.22)"/>' +
    '<stop offset=".88" stop-color="rgba(198,222,255,.64)"/>' +
    '<stop offset="1" stop-color="rgba(255,255,255,.92)"/></linearGradient></defs>' +
    '<polygon points="' + shape.ptsAttr + '" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="4.5" stroke-linejoin="round"/>' +
    '<polygon points="' + shape.ptsAttr + '" fill="none" stroke="url(#umdPRimG)" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<polygon id="umd-p-glow" points="' + shape.ptsAttr + '" fill="none" stroke="#2f7dff" stroke-width="6" stroke-opacity=".45" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<polygon id="umd-p-body" points="' + shape.ptsAttr + '" fill="none" stroke="#66b3ff" stroke-width="2.2" stroke-opacity=".9" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<polygon id="umd-p-head" points="' + shape.ptsAttr + '" fill="none" stroke="#eaf5ff" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>' +
    '</svg>';
  const glow = document.getElementById("umd-p-glow");
  lightLen = glow.getTotalLength();
  for (const [id, f] of LIGHT_SEGS) {
    const el = document.getElementById(id);
    el.setAttribute("stroke-dasharray", (lightLen * f).toFixed(1) + " " + (lightLen * (1 - f)).toFixed(1));
  }
  // a rebuild drops the animated dashoffset with the old SVG; re-apply it
  lightFrame(lightNow);
}

new ResizeObserver(() => bakePanel()).observe($("#panel"));

if (window.__umdLightFreeze != null) {
  // test hook: render one fixed light position instead of animating
  bakePanel();
  lightFrame(window.__umdLightFreeze);
} else {
  requestAnimationFrame(function loop(now) { lightFrame(now); requestAnimationFrame(loop); });
}

boot();

