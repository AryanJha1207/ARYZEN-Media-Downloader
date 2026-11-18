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
  announced: -1,
};

function show(el) {
  if (!el) return;
  if (el.hidden) {
    el.hidden = false;
    // one quiet enter per state change: fade + 4px rise (off under reduced motion)
    el.classList.remove("enter");
    void el.offsetWidth;
    el.classList.add("enter");
  }
}
function hide(el) { if (el) el.hidden = true; }

function status(msg, isErr) {
  const s = $("#status");
  if (!msg) { hide(s); return; }
  s.textContent = msg;
  s.className = isErr ? "status err" : "status";
  s.setAttribute("role", isErr ? "alert" : "status");
  if (!isErr) s.setAttribute("aria-live", "polite"); else s.removeAttribute("aria-live");
  show(s);
}

// Send a command to the bridge; resolves with its "result" message.
function send(cmd, extra, timeoutMs, onWorking) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ to: "bridge", cmd }, extra || {}), (resp) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      if (!resp || !resp.ok) { resolve({ ok: false, error: (resp && resp.error) || "Local helper is not reachable." }); return; }
      const id = resp.id;
      const deadAnswer = () => {
        chrome.runtime.onMessage.removeListener(onMsg);
        resolve({ ok: false, error: "No answer from the local helper. Close and reopen the popup; if it repeats, run the installer again and restart your browser." });
      };
      let timer = setTimeout(deadAnswer, timeoutMs || 15000);
      function onMsg(m) {
        // The helper is alive but still reading the page: extend the wait
        // to its stated cap and update the status line.
        if (m && m.umd && m.umd.id === id && m.umd.type === "probe-working") {
          clearTimeout(timer);
          timer = setTimeout(deadAnswer, ((m.umd.cap || 45) + 10) * 1000);
          if (onWorking) { try { onWorking(m.umd); } catch (e) {} }
          return;
        }
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

function qualityFromLabel(label) {
  const m = /(\d{3,4}p(?:\s?60)?|\b\d{2,3}k\b|\b\d{2,3}\s?kbps\b|mp3)/i.exec(label || "");
  return m ? m[1].replace(/\s+/g, "") : "";
}

function refreshDownloadButton() {
  const btn = $("#download");
  if (state.selected) {
    btn.disabled = false;
    const q = qualityFromLabel(state.selected.label);
    $("#downtext").textContent = q ? "Download " + q : "Download";
  } else {
    btn.disabled = true;
    $("#downtext").textContent = "Choose a format";
  }
}

// The Download button always occupies its slot once options exist: disabled
// ("Choose a format") until a row is selected, so the layout never jumps.
function showActionBar() {
  refreshDownloadButton();
  show($("#actionbar"));
}

// Download progress / completion events.
chrome.runtime.onMessage.addListener((m) => {
  const g = m && m.umd;
  if (!g || !state.job) return;
  if (g.job !== state.job.id) return;
  if (g.type === "progress") {
    const pct = g.pct || 0;
    $("#fill").style.width = pct + "%";
    $("#fill").setAttribute("aria-valuenow", String(Math.round(pct)));
    $("#ppct").textContent = g.pct != null ? g.pct.toFixed(1) + "%" : "";
    $("#pspeed").textContent = g.speed || "\u2014";
    $("#peta").textContent = g.eta || "\u2014";
    const stageText = g.stage
      ? g.stage.charAt(0).toUpperCase() + g.stage.slice(1) + "\u2026"
      : "Downloading\u2026";
    $("#pstage").textContent = stageText;
    // the single glint runs only while the stage is "Downloading..."
    $("#fill").classList.toggle("glint", stageText === "Downloading\u2026");
    // announce progress at about 25% steps, not on every 0.1% tick
    const bucket = Math.floor(pct / 25);
    if (bucket !== state.announced) {
      state.announced = bucket;
      $("#pannounce").textContent = "Download " + Math.round(pct) + " percent";
    }
  } else if (g.type === "done") {
    // one dealt moment: the bar fills to 100%, then the done card strokes in
    $("#fill").style.width = "100%";
    $("#fill").setAttribute("aria-valuenow", "100");
    $("#fill").classList.remove("glint");
    $("#ppct").textContent = "100.0%";
    $("#pannounce").textContent = "Download complete";
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => {
      hide($("#progress"));
      $("#donetext").textContent = g.file || "file";
      $("#donedir").textContent = state.downloadDir || "~/Downloads/UMD";
      const d = $("#done");
      d.classList.remove("checked");
      show(d);
      void d.offsetWidth;
      d.classList.add("checked");
    }, reduced ? 0 : 320);
    state.job = null;
  } else if (g.type === "error") {
    hide($("#progress"));
    status(g.error || "Download failed.", true);
    state.job = null;
    // the Download button is restored as before (selection is kept)
    showActionBar();
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

// Middle-ellipsis for long paths; the full path stays in the title.
function setPath(el, full) {
  el.title = full;
  if (full.length <= 34) { el.textContent = full; return; }
  el.textContent = full.slice(0, 12) + "\u2026" + full.slice(-18);
}

function renderOptions() {
  const box = $("#options");
  box.innerHTML = "";
  box.setAttribute("role", "radiogroup");
  box.setAttribute("aria-label", "Formats");
  let lastKind = null;
  state.options.forEach((o, idx) => {
    if (o.kind !== lastKind) {
      lastKind = o.kind;
      const g = document.createElement("div");
      g.className = "group";
      g.textContent = o.kind === "video" ? "Video" : "Audio only";
      box.appendChild(g);
    }
    const row = document.createElement("div");
    row.className = "opt";
    row.setAttribute("role", "radio");
    row.setAttribute("aria-checked", "false");
    row.tabIndex = idx === 0 ? 0 : -1;
    const radio = document.createElement("span");
    radio.className = "radio";
    radio.setAttribute("aria-hidden", "true");
    const lab = document.createElement("span");
    lab.className = "lab";
    lab.textContent = o.label;
    const sz = document.createElement("span");
    sz.className = "sz";
    sz.textContent = o.size || "";
    row.append(radio, lab, sz);
    row.addEventListener("click", () => selectRow(box, row, o));
    row.addEventListener("keydown", (e) => {
      const rows = Array.from(box.querySelectorAll(".opt"));
      const i = rows.indexOf(row);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        const n = rows[(i + 1) % rows.length];
        n.focus(); selectRow(box, n, n._opt);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        const p = rows[(i - 1 + rows.length) % rows.length];
        p.focus(); selectRow(box, p, p._opt);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        selectRow(box, row, o);
      }
    });
    row._opt = o;
    box.appendChild(row);
  });
}

function selectRow(box, row, o) {
  state.selected = o;
  box.querySelectorAll(".opt").forEach((r) => {
    r.classList.remove("sel");
    r.setAttribute("aria-checked", "false");
    r.tabIndex = -1;
  });
  row.classList.add("sel");
  row.setAttribute("aria-checked", "true");
  row.tabIndex = 0;
  refreshDownloadButton();
}

async function doCheck(url) {
  status("Reading link\u2026", false);
  hide($("#info")); $("#options").innerHTML = ""; hide($("#actionbar")); hide($("#done")); hide($("#progress"));
  show($("#probe-skel"));
  const r = await send("probe", { url }, 13000,
    () => status("Still reading this page - this can take up to 45 seconds.", false));
  hide($("#probe-skel"));
  if (!r.ok) { status(r.error || "Could not read that link.", true); return; }
  state.info = r.info; state.options = r.options; state.url = url;
  state.selected = null;
  status("");
  $("#title").textContent = r.info.title || "Untitled media";
  const dur = fmtDur(r.info.duration);
  if (dur) { $("#durbadge").textContent = dur; show($("#durbadge")); } else hide($("#durbadge"));
  $("#meta").textContent = [r.info.site, r.info.uploader].filter(Boolean).join(" \u00b7 ");
  if (r.info.thumbnail) { $("#thumb").src = r.info.thumbnail; show($("#thumb")); } else { hide($("#thumb")); hide($("#durbadge")); }
  show($("#info"));
  if (!state.options.length) { status("The downloader found no downloadable formats on that page.", true); return; }
  renderOptions();
  showActionBar();
  if (r.info.note) status(r.info.note, false);
}

// While a download runs, the picker controls step back and the progress
// card takes over; the picker returns on error or on "New download".
function setDownloading(on) {
  ["#usetab", ".tabhint", ".or", ".urlgroup", ".saveto", "#info", "#options", "#actionbar"].forEach((s) => { const el = $(s); if (el) el.hidden = on; });
}

async function startDownload() {
  const o = state.selected;
  if (!o || !state.url) return;
  hide($("#actionbar")); hide($("#done"));
  setDownloading(true);
  state.announced = -1;
  $("#ppct").textContent = "0.0%";
  $("#pspeed").textContent = "\u2014"; $("#peta").textContent = "\u2014";
  $("#pstage").textContent = "Starting\u2026";
  $("#pannounce").textContent = "Download started";
  show($("#progress"));
  $("#fill").style.width = "0%";
  $("#fill").setAttribute("aria-valuenow", "0");
  $("#fill").classList.remove("glint");
  const r = await send("download", {
    url: state.url,
    kind: o.kind,
    selector: o.selector || "",
    mp3: o.mp3 || 0,
  });
  if (!r.ok) { hide($("#progress")); setDownloading(false); status(r.error || "Download failed to start.", true); showActionBar(); return; }
  state.job = { id: r.job };
}

function setConn(s) {
  const p = $("#conn");
  if (!p) return;
  p.classList.toggle("on", s === "on");
  p.classList.toggle("off", s === "off");
  p.innerHTML = "<i></i>" + (s === "on" ? "Helper connected" : s === "off" ? "Helper not connected" : "Checking helper\u2026");
}

async function boot() {
  const st = await new Promise((res) =>
    chrome.runtime.sendMessage({ to: "bridge", cmd: "bridge-state" }, res));
  if (!st || !st.connected) {
    setConn("off");
    show($("#setup"));
    $("#setup-err").textContent = (st && st.error) ? ("(" + st.error + ")") : "";
    $("#eng").textContent = "not connected";
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
    $("#eng").textContent = "not responding";
    return;
  }
  setConn("on");
  show($("#main"));
  if (ping.download_dir) {
    state.downloadDir = ping.download_dir;
    setPath($("#saveto"), ping.download_dir);
    $("#pdest").textContent = ping.download_dir;
  }

  // Footer engine info loads lazily; it must never block the UI and stays
  // silent on failure.
  send("versions", null, 20000).then((v) => {
    if (v && v.ok && v.versions && v.versions.ytdlp) {
      $("#eng").textContent = "yt-dlp " + v.versions.ytdlp;
    }
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
    $("#pstage").textContent = "Download in progress";
    show($("#progress"));
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const u = tabs && tabs[0] && tabs[0].url;
    if (u && /^https?:\/\//.test(u)) {
      $("#url").value = u;
      try {
        $("#tabhint").textContent = new URL(u).hostname;
        show($("#tabhint"));
      } catch (e) {}
    }
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
$("#again").onclick = () => {
  hide($("#done")); $("#options").innerHTML = "";
  $("#url").value = ""; state.selected = null; state.announced = -1;
  refreshDownloadButton();
  setDownloading(false);
  // setDownloading(false) restores the whole picker; the empty info card and
  // the action bar stay down until a new probe fills them
  hide($("#info")); hide($("#actionbar"));
  $("#url").focus();
};
$("#update").onclick = async (e) => {
  e.preventDefault();
  $("#eng").textContent = "updating\u2026";
  const r = await send("update-engine");
  if (!r.ok) { $("#eng").textContent = "update failed to start"; return; }
  const jid = r.job;
  const onMsg = (m) => {
    const g = m && m.umd;
    if (!g || g.job !== jid) return;
    if (g.type === "done") {
      chrome.runtime.onMessage.removeListener(onMsg);
      $("#eng").textContent = "yt-dlp " + (g.version || "?") + (g.note === "already latest" ? " (already latest)" : "");
    } else if (g.type === "error") {
      chrome.runtime.onMessage.removeListener(onMsg);
      $("#eng").textContent = "update failed - current version kept";
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);
};
$("#closex").onclick = () => window.close();

// ---- panel silhouette -------------------------------------------------------
// Same shape recipe as the in-page menu's card (raised top-right tab); the
// rim is one static 1px gradient stroke with a small soft glow.
const PANEL_TAB_W = 170, PANEL_RISE = 30, PANEL_SHOULDER = 34, PANEL_R = 20, PANEL_TAB_R = 13;

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

function bakePanel() {
  const p = $("#panel");
  if (!p) return;
  const W = Math.round(p.offsetWidth), H = Math.round(p.offsetHeight);
  if (W < 80 || H < 80) return;
  if (p._baked === W + "x" + H) { return; }
  p._baked = W + "x" + H;
  const shape = panelShape(W, H);
  p.style.clipPath = "polygon(" + shape.clip + ")";
  // one static 1px gradient rim
  $("#glassrim").innerHTML =
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    '<defs><linearGradient id="umdPRimG" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="rgba(255,255,255,.85)"/>' +
    '<stop offset=".25" stop-color="rgba(255,255,255,.22)"/>' +
    '<stop offset=".55" stop-color="rgba(185,212,255,.28)"/>' +
    '<stop offset=".8" stop-color="rgba(255,255,255,.18)"/>' +
    '<stop offset="1" stop-color="rgba(255,255,255,.7)"/></linearGradient></defs>' +
    '<polygon points="' + shape.ptsAttr + '" fill="none" stroke="url(#umdPRimG)" stroke-width="1" stroke-linejoin="round"/>' +
    '</svg>';
}

new ResizeObserver(() => bakePanel()).observe($("#panel"));

boot();
