// ARYZEN Media Downloader - in-page button and overlay.
// Injected on supported sites (see manifest content_scripts). Adds a
// "Download" button to the page (anchored in YouTube's action row on watch
// pages, a floating pill elsewhere). Clicking it opens a compact overlay on
// top of the current tab - no new tab, no redirect - that talks to the same
// local helper as the toolbar popup, through the background service worker.
// The overlay only sends the current page URL; it reads no page data beyond
// the favicon used for the completion badge.

(function () {
  "use strict";
  if (window.__umdContentLoaded) return;
  window.__umdContentLoaded = true;

  // ---------------------------------------------------------------- sites
  const SITES = [
    { re: /(^|\.)youtube\.com$/, name: "YouTube", accent: "#ff4e45" },
    { re: /(^|\.)instagram\.com$/, name: "Instagram", accent: "#d62976" },
    { re: /(^|\.)reddit\.com$/, name: "Reddit", accent: "#ff4500" },
    { re: /(^|\.)twitch\.tv$/, name: "Twitch", accent: "#9146ff" },
    { re: /(^|\.)soundcloud\.com$/, name: "SoundCloud", accent: "#ff5500" },
    { re: /(^|\.)streamable\.com$/, name: "Streamable", accent: "#0f90fa" },
    { re: /(^|\.)ted\.com$/, name: "TED", accent: "#e62b1e" },
    { re: /^open\.spotify\.com$/, name: "Spotify", accent: "#1db954" },
  ];
  const host = (location.hostname || "").toLowerCase();
  const site = SITES.find((s) => s.re.test(host)) ||
    { name: host.replace(/^www\./, ""), accent: "#4f8cff" };
  const SPOTIFY = host === "open.spotify.com";
  const isYTWatch = /(^|\.)youtube\.com$/.test(host) && location.pathname === "/watch";

  // ------------------------------------------------------- bridge messaging
  // Same request/response contract as the toolbar popup: a command gets an
  // immediate ack {ok, id}; the real answer arrives later as {umd: {...}}
  // with a matching id. Events (progress/done/error) carry the job id.
  function send(cmd, extra, timeoutMs, onWorking) {
    return new Promise((resolve) => {
      let resp;
      try {
        chrome.runtime.sendMessage(Object.assign({ to: "bridge", cmd }, extra || {}), (r) => {
          resp = r;
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (!resp || !resp.ok) {
            resolve({ ok: false, error: (resp && resp.error) || "Local helper is not reachable." });
            return;
          }
          const id = resp.id;
          const deadAnswer = () => {
            chrome.runtime.onMessage.removeListener(onMsg);
            resolve({ ok: false, error: "No answer from the local helper. Open the extension popup and click Check; if it repeats, run the installer again and restart your browser." });
          };
          let timer = setTimeout(deadAnswer, timeoutMs || 15000);
          function onMsg(m) {
            // The helper is alive but still reading the page: extend the
            // wait to its stated cap and update the loading note.
            if (m && m.umd && m.umd.id === id && m.umd.type === "probe-working") {
              clearTimeout(timer);
              timer = setTimeout(deadAnswer, ((m.umd.cap || 45) + 10) * 1000);
              if (onWorking) { try { onWorking(m.umd); } catch (e) {} }
              return;
            }
            if (m && m.umd && m.umd.id === id && (m.umd.type === "result" || m.umd.type === "error")) {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(onMsg);
              resolve(m.umd.ok === undefined ? Object.assign({ ok: false }, m.umd) : m.umd);
            }
          }
          chrome.runtime.onMessage.addListener(onMsg);
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });
  }

  // Job-scoped events (progress / done / error) for the active download.
  // Toolbar button: the service worker asks us to open the menu in-page
  // (liquid-glass card) instead of a browser-owned popup window.
  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (m && m.umdMenu === "open") { openOverlay(true); sendResponse({ ok: true }); }
    return false;
  });

  const jobListeners = new Set();
  chrome.runtime.onMessage.addListener((m) => {
    const g = m && m.umd;
    if (!g || !g.job) return;
    jobListeners.forEach((fn) => { try { fn(g); } catch (e) {} });
  });

  // ------------------------------------------------------------- the button
  const BTN_ID = "umd-dl-btn";
  const ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ------------------------------------------------- liquid glass refraction
  // Copyright (c) 2024-2026 Sebastian Degenaar (pixel-innovations.com)
  // Copyright 2025 Tim Lehmann for whynotmake.it
  // SPDX-License-Identifier: MIT
  // Geometry/render port of liquid_glass_widgets:
  // https://github.com/sdegenaar/liquid_glass_widgets
  // (revision 62cca4691fee15c8a61c546e5888c6407cd03c23; shaders/sdf.glsl,
  // shaders/liquid_glass_geometry_blended.frag, shaders/liquid_glass_render.frag),
  // built on liquid_glass_renderer by Tim Lehmann (whynotmake.it).
  // Full license texts: ../THIRD_PARTY_NOTICES.
  // The pill's rounded-rect SDF yields a spherical-cap surface normal; Snell
  // refraction of the view ray through that surface gives a per-pixel
  // displacement vector, baked here into an feDisplacementMap (R = x, G = y).
  // The SVG filter then replays the shader's render pass against the page
  // behind the pill: frost blur, then three displaced copies recombined per
  // channel - the shader's chromatic aberration (RGB split on the refraction
  // vector). Verified visually in Chrome 157 (the extension's Brave/Chrome
  // target); other engines untested.
  // Bevel depth in px. Their GlassSettings default is 10 on tall pills,
  // leaving a flat face; here the pill is shallow, so half its height makes a
  // full-dome lens - the whole face refracts and the background visibly
  // stretches, per the user's target look.
  const LG_IOR = 1.2;         // refractive index (their standard preset)
  const LG_ABERRATION = 0.06; // RGB dispersion on the refraction vector
  const LG_SCALE = 48;        // px of displacement per full channel swing
  const lgFilterCache = {};   // "WxH" -> filter id
  let lgFilterSeq = 0;

  function umdGlassMapURL(W, H, sdfOverride, thickness, reachCap, sample) {
    const cx = W / 2, cy = H / 2;
    const LG_THICKNESS = thickness || H / 2;
    const eta = 1 / LG_IOR;
    const maxReach = Math.min(0.5 * Math.min(W, H), reachCap || 1e9);
    const step = 0.5;
    const ss = sample || 1; // bake scale: the card bakes at 0.5 (4x cheaper)
    const MW = Math.max(2, Math.round(W * ss)), MH = Math.max(2, Math.round(H * ss));
    const sdf = sdfOverride || function (px, py) { // rounded-rect SDF, same form as their sdfRRect
      const bx = W / 2, by = H / 2, r = H / 2;
      const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
      return Math.min(Math.max(qx, qy), 0) +
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
    };
    const canvas = document.createElement("canvas");
    canvas.width = MW; canvas.height = MH;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(MW, MH);
    const d = img.data;
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        const px = (x + 0.5) / ss - cx, py = (y + 0.5) / ss - cy;
        const sd = sdf(px, py);
        const dx = (sdf(px + step, py) - sdf(px - step, py)) / (2 * step);
        const dy = (sdf(px, py + step) - sdf(px, py - step)) / (2 * step);
        const gm = Math.hypot(dx, dy);
        const sdN = gm > 0.1 ? sd / gm : sd; // normalized Euclidean distance
        let dispX = 0, dispY = 0;
        if (sdN < 0) { // inside the glass
          // spherical-cap surface normal (their geometry pass)
          const ncos = Math.max(LG_THICKNESS + sdN, 0) / LG_THICKNESS;
          const nsin = Math.sqrt(Math.max(0, 1 - ncos * ncos));
          const nl = Math.hypot(dx * ncos, dy * ncos, nsin) || 1;
          const nx = dx * ncos / nl, ny = dy * ncos / nl, nz = nsin / nl;
          // GLSL refract(I=(0,0,-1), N, 1/ior) - exact Snell, not a lookup
          const dotNI = -nz;
          const k = 1 - eta * eta * (1 - dotNI * dotNI);
          let rx = 0, ry = 0, rz = -eta;
          if (k >= 0) {
            const f = eta * dotNI + Math.sqrt(k);
            rx = -f * nx; ry = -f * ny; rz = -eta - f * nz;
          }
          const xx = LG_THICKNESS + sdN;
          const sqrtTerm = Math.sqrt(Math.max(0, LG_THICKNESS * LG_THICKNESS - xx * xx));
          const height = sdN < -LG_THICKNESS ? LG_THICKNESS : sqrtTerm;
          const len = (height + LG_THICKNESS * 8) / Math.max(1e-3, Math.abs(rz));
          dispX = rx * len; dispY = ry * len;
          const reach = Math.hypot(dispX, dispY);
          if (reach > maxReach) { dispX *= maxReach / reach; dispY *= maxReach / reach; }
        }
        const i = (y * W + x) * 4;
        d[i] = Math.max(0, Math.min(255, Math.round((0.5 + dispX / LG_SCALE) * 255)));
        d[i + 1] = Math.max(0, Math.min(255, Math.round((0.5 + dispY / LG_SCALE) * 255)));
        d[i + 2] = 128; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  // Build (once per pill size) the SVG filter: frost, then per-channel
  // displaced copies at slightly different scales = chromatic aberration.
  // opts.frost overrides the blur strength (the button keeps the 1.5 default;
  // the menu card wants a heavier frost since it replaces its own backdrop blur).
  function ensureLiquidGlassFilter(W, H, opts) {
    opts = opts || {};
    const key = opts.cacheKey || (W + "x" + H);
    const frost = opts.frost || 1.5;
    if (lgFilterCache[key]) return lgFilterCache[key];
    const id = "umd-lg-filter-" + (++lgFilterSeq);
    const map = umdGlassMapURL(W, H, opts.sdf, opts.thickness, opts.reach, opts.sample);
    const half = LG_ABERRATION / 2;
    const S = opts.scale || LG_SCALE; // card can ask for a stronger warp; button stays at LG_SCALE
    const sR = S * (1 + half), sB = S * (1 - half);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.id = "umd-lg-svg-" + lgFilterSeq;
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
    // opts.mapSmooth blurs the displacement map before use: it softens the
    // hard displacement discontinuity along the silhouette edge (visible as
    // stair steps on the card's angled shoulder). Off by default so the
    // button's approved render is byte-identical.
    const smooth = opts.mapSmooth || 0;
    // All three dispersion channels read the SAME (smoothed when requested)
    // map: routing only one channel through mapS left the G/B channels
    // tearing along the SDF corner-bisector ridges.
    const mapRef = smooth ? "mapS" : "map";
    svg.innerHTML =
      '<filter id="' + id + '" filterUnits="userSpaceOnUse" x="-16" y="-16" width="' + (W + 32) + '" height="' + (H + 32) + '">' +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="' + frost + '" result="frost"/>' +
      '<feImage href="' + map + '" x="0" y="0" width="' + W + '" height="' + H + '" preserveAspectRatio="none" result="map"/>' +
      (smooth ? '<feGaussianBlur in="map" stdDeviation="' + smooth + '" result="mapS"/>' : '') +
      '<feDisplacementMap in="frost" in2="' + mapRef + '" scale="' + sR + '" xChannelSelector="R" yChannelSelector="G" result="dispR"/>' +
      '<feColorMatrix in="dispR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="chR"/>' +
      '<feDisplacementMap in="frost" in2="' + mapRef + '" scale="' + S + '" xChannelSelector="R" yChannelSelector="G" result="dispG"/>' +
      '<feColorMatrix in="dispG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="chG"/>' +
      '<feDisplacementMap in="frost" in2="' + mapRef + '" scale="' + sB + '" xChannelSelector="R" yChannelSelector="G" result="dispB"/>' +
      '<feColorMatrix in="dispB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="chB"/>' +
      '<feComposite in="chR" in2="chG" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rg"/>' +
      '<feComposite in="rg" in2="chB" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>' +
      "</filter>";
    (opts.svgParent || document.body || document.documentElement).appendChild(svg);
    lgFilterCache[key] = id;
    return id;
  }

  // ------------------------------------------- card silhouette (the menu)
  // The overlay card is NOT a plain rounded rect: the top-right rises into a
  // raised tab with an angled shoulder, per the user's reference. One vertex
  // list drives BOTH the CSS clip-path and the glass displacement SDF, so the
  // refraction follows the exact silhouette, shoulder included.
  // The tab rises from the card edge on a smoothstep S-curve (flat tangents at
  // both ends), the way the liquid swirls in the ARYZEN mark lift off its body.
  const CARD_TAB_W = 204, CARD_RISE = 34, CARD_SHOULDER = 46, CARD_R = 26, CARD_TAB_R = 15;
  function umdCardShape(W, H) {
    const R = CARD_R, T = CARD_TAB_R, y0 = CARD_RISE, sh = CARD_SHOULDER;
    // keep the shoulder clear of the top-left corner on very narrow cards
    const tw = Math.min(CARD_TAB_W, Math.max(120, W - R - sh - 10));
    const pts = [];
    function arc(cx, cy, r, a0, a1) {
      const n = 8;
      for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * i / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
    arc(R, y0 + R, R, Math.PI, Math.PI * 1.5);         // main top-left corner
    const xa = W - tw - sh, xb = W - tw + 16, steps = 14;
    for (let i = 0; i <= steps; i++) {                 // liquid shoulder, card edge up to tab
      const u = i / steps, s = u * u * (3 - 2 * u);
      pts.push([xa + (xb - xa) * u, y0 * (1 - s)]);
    }
    pts.push([W - T, 0]);                              // tab top edge
    arc(W - T, T, T, Math.PI * 1.5, Math.PI * 2);      // tab top-right corner
    pts.push([W, H - R]);                              // right edge down
    arc(W - R, H - R, R, 0, Math.PI / 2);              // bottom-right corner
    pts.push([R, H]);                                  // bottom edge
    arc(R, H - R, R, Math.PI / 2, Math.PI);            // bottom-left corner
    pts.push([0, y0 + R]);                             // left edge up
    const clip = pts.map(p => p[0].toFixed(1) + "px " + p[1].toFixed(1) + "px").join(",");
    const ptsAttr = pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const centered = pts.map(p => [p[0] - W / 2, p[1] - H / 2]);
    return { clip: clip, ptsAttr: ptsAttr, centered: centered };
  }

  // Signed distance to a closed polygon (even-odd inside test + min segment
  // distance) - lets the same Snell refraction math run on the card shape.
  function umdPolySDF(centeredPts) {
    const p = centeredPts, n = p.length;
    return function (px, py) {
      let d2 = Infinity, inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
        const dx = xj - xi, dy = yj - yi;
        const L2 = dx * dx + dy * dy;
        let t = L2 ? ((px - xi) * dx + (py - yi) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = xi + t * dx - px, ey = yi + t * dy - py;
        const dd = ex * ex + ey * ey;
        if (dd < d2) d2 = dd;
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
      }
      const d = Math.sqrt(d2);
      return inside ? -d : d;
    };
  }

  // ---------------- ybouane/liquidglass WebGL pill (approved 2026-11-17) ---
  // The floating pill's material is the ybouane/liquidglass WebGL library
  // (extension/lib/liquidglass-content.js, MIT;
  // https://github.com/ybouane/liquidglass): the page is rasterized once and
  // the pill renders as a true refractive lens over it - frost blur, Snell
  // refraction, chromatic aberration, Fresnel edge light - the exact style
  // the user approved in the preview. The SVG-displacement build above stays
  // as the fallback when the library/WebGL is unavailable, and the download
  // card keeps using it regardless (the card's look is unchanged by this).
  let umdLGInstance = null;

  async function umdGlassifyPill(b) {
    const lib = window.UMDLiquidGlass;
    if (!lib || !lib.LiquidGlass || !document.body) return;
    let inst = null;
    try {
      b.dataset.config = JSON.stringify({
        floating: false,   // our own drag (with position memory) stays in charge
        button: true,      // library hover/press shading + crisp content
        blurAmount: 0.3,
        brightness: -0.25, // keeps the white label readable (approved preview)
        cornerRadius: 22,
        zRadius: 40,
      });
      inst = await lib.LiquidGlass.init({ root: document.body, glassElements: [b] });
    } catch (e) {
      return; // keep the SVG-filter fallback look
    }
    // The library pins user-select:none on its root; the root is the page's
    // body here, so restore it or the whole page loses text selection.
    document.body.style.userSelect = "";
    // A SPA navigation may have swapped the pill while init was running.
    if (document.getElementById(BTN_ID) !== b || !document.body.contains(b)) {
      try { inst.destroy(); } catch (e) {}
      return;
    }
    if (umdLGInstance) { try { umdLGInstance.destroy(); } catch (e) {} }
    umdLGInstance = inst;
    // The shader canvas now supplies the material: drop the hand-layered
    // parts (refraction backdrop, prismatic rim, light cap, sheen) and the
    // manual border/shadow - the shader draws its own edge light and shadow.
    if (b._umdLayers) for (const l of b._umdLayers) l.remove();
    b.style.border = "0";
    b.style.boxShadow = "none";
    b._umdLG = true;
    // No manual hover lift in library mode: transforming the glass element
    // forces a full lens re-render on every transition frame, and the
    // button:true config already supplies the approved hover/press shading.
    b.onmouseenter = null;
    b.onmouseleave = null;
  }

  // Measure the rendered pill, then swap the initial plain blur for the real
  // refraction filter. Runs once per button instance, after insertion.
  function applyLiquidGlass(b) {
    const layer = b && b._umdGlass;
    if (!layer || layer.dataset.umdGlass === "1") return;
    const W = Math.round(b.offsetWidth), H = Math.round(b.offsetHeight);
    if (W < 24 || H < 16) return;
    layer.dataset.umdGlass = "1";
    const id = ensureLiquidGlassFilter(W, H);
    layer.style.webkitBackdropFilter = "url(#" + id + ")";
    layer.style.backdropFilter = "url(#" + id + ")";
  }

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "rgba(120,140,255," + a + ")";
    const v = parseInt(m[1], 16);
    return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")";
  }

  // ---------------- drag-to-move (floating pill only) ----------------
  // Hold and drag the floating button anywhere on the page; a plain click
  // still opens the menu. Position is remembered across page loads
  // (chrome.storage.local, key umdBtnPos).
  function umdClampPos(x, y, w, h) {
    const m = 4;
    return [Math.min(Math.max(m, x), window.innerWidth - w - m),
            Math.min(Math.max(m, y), window.innerHeight - h - m)];
  }
  function umdApplyPos(b, x, y) {
    const r = b.getBoundingClientRect();
    const c = umdClampPos(x, y, r.width, r.height);
    b.style.left = c[0] + "px"; b.style.top = c[1] + "px";
    b.style.right = "auto"; b.style.bottom = "auto";
  }
  function umdSavePos(b) {
    const r = b.getBoundingClientRect();
    try { chrome.storage.local.set({ umdBtnPos: { x: r.left, y: r.top } }); } catch (e) {}
  }
  function umdRestorePos(b) {
    try {
      chrome.storage.local.get("umdBtnPos", (v) => {
        const p = v && v.umdBtnPos;
        if (p && typeof p.x === "number" && typeof p.y === "number" &&
            document.getElementById(BTN_ID) === b) {
          umdApplyPos(b, p.x, p.y);
        }
      });
    } catch (e) {}
  }
  function umdAttachDrag(b) {
    b.style.touchAction = "none";
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, pid = null;
    b.addEventListener("pointerdown", (e) => {
      pid = e.pointerId; sx = e.clientX; sy = e.clientY;
      const r = b.getBoundingClientRect(); ox = r.left; oy = r.top;
      dragging = false;
    });
    b.addEventListener("pointermove", (e) => {
      if (pid === null || e.pointerId !== pid) return;
      if (!dragging && Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
      if (!dragging) {
        dragging = true;
        b._umdDragMoved = true;
        try { b.setPointerCapture(pid); } catch (err) {}
        if (!b._umdLG) b.style.transform = "none"; // drop the hover lift while dragging (SVG fallback only)
        b.style.cursor = "grabbing";
      }
      e.preventDefault();
      umdApplyPos(b, ox + (e.clientX - sx), oy + (e.clientY - sy));
    });
    const end = (e) => {
      if (pid === null || e.pointerId !== pid) return;
      pid = null;
      b.style.cursor = "";
      if (dragging) {
        dragging = false;
        umdSavePos(b);
        umdUpdateTarget(b); // dropped over a player? target it; elsewhere: clear
        if (!b._umdLG) b.style.transform = b.matches(":hover") ? "translateY(-2px) scale(1.04)" : "";
      }
    };
    b.addEventListener("pointerup", end);
    b.addEventListener("pointercancel", end);
  }

  function makeButton(anchored) {
    const b = document.createElement("button");
    b.id = BTN_ID;
    b.type = "button";
    b.setAttribute("aria-label", "Download this media with ARYZEN Media Downloader");
    b.addEventListener("pointerenter", () => prefetchProbe());
    if (!document.getElementById("umd-target-style")) {
      const st = document.createElement("style");
      st.id = "umd-target-style";
      st.textContent = ".umd-targeting{outline:2px solid #7ec8ff !important;outline-offset:2px !important}";
      (document.head || document.documentElement).appendChild(st);
    }
    // The floating pill carries the user's ARYZEN vector art (the same A
    // artwork as the menu's raised tab); the anchored YouTube-row button
    // keeps the plain download arrow that matches that row's own icons.
    b.innerHTML = (anchored ? ICON_SVG : '<img src="' + chrome.runtime.getURL("icons/tab-mark.png") + '" alt="" aria-hidden="true" style="height:20px;width:auto;display:block;filter:brightness(0) invert(1)">') + "<span>Download</span>";
    b.style.position = b.style.position || "relative";
    for (const child of [b.querySelector("svg"), b.querySelector("img"), b.querySelector("span")]) {
      if (child) { child.style.position = "relative"; child.style.zIndex = "1"; }
    }
    const base =
      "display:inline-flex;align-items:center;gap:7px;cursor:pointer;" +
      "font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      "letter-spacing:.01em;border:0;border-radius:999px;";
    if (anchored) {
      // Sits in YouTube's action row: pill shaped like its neighbours, using
      // YouTube's own theme variables so it reads correctly in light AND dark.
      const rest = "background:var(--yt-spec-badge-chip-background,rgba(0,0,0,.06));" +
        "color:var(--yt-spec-text-primary,#0f0f0f);";
      b.style.cssText = base +
        "height:36px;padding:0 16px;margin:0 4px;" + rest +
        "transition:background .15s ease,color .15s ease,transform .1s ease;";
      b.onmouseenter = () => { b.style.background = site.accent; b.style.color = "#fff"; };
      b.onmouseleave = () => { b.style.cssText = base +
        "height:36px;padding:0 16px;margin:0 4px;" + rest +
        "transition:background .15s ease,color .15s ease,transform .1s ease;"; };
      b.onmousedown = () => { b.style.transform = "scale(.96)"; };
      b.onmouseup = () => { b.style.transform = "scale(1)"; };
    } else {
      // The UA focus ring reads as a black outline around the glass pill
      // (visible after a drag, which focuses the button). Kill it and give
      // keyboard users the menu's white rim instead.
      if (!document.getElementById("umd-btn-focus-style")) {
        const fst = document.createElement("style");
        fst.id = "umd-btn-focus-style";
        fst.textContent =
          "#umd-dl-btn:focus{outline:none}" +
          "#umd-dl-btn:focus-visible{outline:2px solid rgba(255,255,255,.95);outline-offset:2px}";
        (document.head || document.documentElement).appendChild(fst);
      }
      // Floating liquid-glass pill, bottom-right, above page content.
      // Layered build (back to front): refraction filter layer, accent tint,
      // top light cap, animated diagonal sheen - text/icon sit above, undistorted.
      const glassShadow =
        "inset 0 0 0 1px rgba(255,255,255,.55)," +
        "inset 1px 1px 1px rgba(255,255,255,.5)," +
        "inset -1px -1px 1px rgba(0,0,0,.10)," +
        "0 4px 12px rgba(0,0,0,.18),0 10px 32px rgba(0,0,0,.22)";
      const glassShadowHover =
        "inset 0 0 0 1px rgba(255,255,255,.75)," +
        "inset 1px 1px 1px rgba(255,255,255,.6)," +
        "inset -1px -1px 1px rgba(0,0,0,.10)," +
        "0 4px 12px rgba(0,0,0,.18),0 16px 44px rgba(255,255,255,.18),0 10px 32px rgba(0,0,0,.25)";
      b.style.cssText = base +
        "position:fixed;right:18px;bottom:18px;z-index:2147483646;overflow:hidden;" +
        "height:44px;padding:0 20px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.55),0 0 10px rgba(0,0,0,.35);" +
        "background:transparent;border:1px solid rgba(255,255,255,.3);" +
        "box-shadow:" + glassShadow + ";" +
        // NOTE: in our Chrome 157 testing, opacity < 1 on this element made
        // the backdrop-filter url() stop rendering (the refraction went
        // flat). Observed in that test, not proven for every version -
        // keep the button fully opaque regardless.
        "opacity:1;transition:transform .18s ease,box-shadow .18s ease;";
      const layer = "position:absolute;inset:0;border-radius:inherit;pointer-events:none;";
      // 1. Refraction layer: the page behind the pill, warped by the
      //    liquid_glass_widgets displacement port (see the filter section).
      //    The initial blur below shows only until applyLiquidGlass swaps in
      //    the filter after the button is measured.
      const glassBg = document.createElement("i");
      glassBg.setAttribute("aria-hidden", "true");
      glassBg.style.cssText = layer +
        // Neutral mid-opacity scrim: keeps the white label readable without
        // tinting the glass.
        "background:rgba(20,20,26,.28);" +
        "-webkit-backdrop-filter:blur(4px) saturate(1.4);backdrop-filter:blur(4px) saturate(1.4);";
      b._umdGlass = glassBg;
      // 2. Chromatic rim: a whisper of prismatic fringe confined to the edge
      //    (gradient masked to the border ring), like the reference capsule.
      const tint = document.createElement("i");
      tint.setAttribute("aria-hidden", "true");
      tint.style.cssText = layer + "padding:1.5px;" +
        // Subtle now that the filter supplies real dispersion at the rim.
        "background:linear-gradient(135deg,rgba(255,120,120,.28),rgba(255,255,255,.10) 30%,rgba(120,255,190,.22) 55%,rgba(120,170,255,.28) 80%,rgba(255,255,255,.10));" +
        "-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);" +
        "-webkit-mask-composite:xor;mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);" +
        "mask-composite:exclude;";
      // 3. Glass cap: soft light pooling at the top edge.
      const cap = document.createElement("i");
      cap.setAttribute("aria-hidden", "true");
      cap.style.cssText = "position:absolute;left:0;right:0;top:0;height:52%;pointer-events:none;" +
        "border-radius:inherit;" +
        "background:linear-gradient(180deg,rgba(255,255,255,.15),rgba(255,255,255,.02) 70%,transparent);";
      // 4. Sheen: diagonal highlight that sweeps across on hover.
      const sheen = document.createElement("i");
      sheen.setAttribute("aria-hidden", "true");
      sheen.style.cssText = "position:absolute;top:0;bottom:0;left:-70%;width:45%;pointer-events:none;" +
        "background:linear-gradient(105deg,transparent,rgba(255,255,255,.5),transparent);" +
        "transform:skewX(-18deg);transition:left .55s ease;";
      b.appendChild(glassBg);
      b.appendChild(tint);
      b.appendChild(cap);
      b.appendChild(sheen);
      // Hand-layered glass parts, kept together so the WebGL upgrade
      // (umdGlassifyPill) can remove them when it takes over.
      b._umdLayers = [glassBg, tint, cap, sheen];
      b.onmouseenter = () => {
        b.style.transform = "translateY(-2px) scale(1.04)";
        b.style.boxShadow = glassShadowHover;
        sheen.style.left = "130%";
      };
      b.onmouseleave = () => {
        b.style.transform = "translateY(0)";
        b.style.boxShadow = glassShadow;
        sheen.style.transition = "none"; sheen.style.left = "-70%";
        requestAnimationFrame(() => { sheen.style.transition = "left .55s ease"; });
      };
    }
    b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    // The click that lands right after a drag must not open the menu.
    if (b._umdDragMoved) { b._umdDragMoved = false; return; }
    // "Drag it over the video and click": a pill parked over a player targets
    // that media on click; parked anywhere else, the click reads the page.
    umdUpdateTarget(b);
    openOverlay();
  };
    return b;
  }

  function ensureButton() {
    // Injected by the toolbar click onto an ordinary page: the menu only,
    // never the floating Download pill (that belongs to the supported sites
    // declared in the manifest).
    if (window.__umdMenuOnly) return;
    if (!document.body) return;
    const existing = document.getElementById(BTN_ID);
    if (isYTWatch) {
      const row = document.querySelector("#top-level-buttons-computed") ||
                  document.querySelector("ytd-watch-metadata #actions #actions-inner") ||
                  document.querySelector("#actions-inner");
      if (row) {
        if (existing && existing.parentElement !== row) existing.remove();
        if (!document.getElementById(BTN_ID)) {
          const btn = makeButton(true);
          const likeGroup = row.firstElementChild;
          if (likeGroup && likeGroup.nextSibling) row.insertBefore(btn, likeGroup.nextSibling);
          else row.appendChild(btn);
        }
        return;
      }
      // Actions row not rendered yet; wait for the next tick.
      if (existing) existing.remove();
      return;
    }
    // Every other supported page: floating pill.
    if (existing && existing.parentElement !== document.body) existing.remove();
    if (!document.getElementById(BTN_ID)) {
      // Insert only after the vector art has decoded. If the image paints
      // after the refraction filter's first backdrop capture, Chrome's
      // url() backdrop raster picks up the late-painted pixels and the
      // displacement smears a coloured ghost of them onto the pill's rim.
      umdArtReady.then(() => {
        if (document.getElementById(BTN_ID)) return;
        const nb = makeButton(false);
        document.body.appendChild(nb);
        umdAttachDrag(nb);
        umdRestorePos(nb);
        requestAnimationFrame(() => applyLiquidGlass(nb));
        // Progressive upgrade: swap the pill's material to the WebGL
        // library once it has initialized; the SVG build is the fallback.
        umdGlassifyPill(nb);
      });
    }
  }

  const umdArtReady = (() => {
    try {
      const i = new Image();
      i.src = chrome.runtime.getURL("icons/tab-mark.png");
      return (i.decode ? i.decode() : Promise.resolve()).catch(() => {});
    } catch (e) { return Promise.resolve(); }
  })();

  ensureButton();
  setInterval(ensureButton, 1500); // SPA re-renders can drop injected nodes

  // Cold-start pre-warm: the first launch of the local helper and the first
  // engine run can take many seconds on a cold machine. Start the helper as
  // soon as this supported page loads, so the first button click is warm.
  // Fire-and-forget, once per page load; the bridge-side ping is instant.
  (function prewarm() {
    try {
      chrome.runtime.sendMessage({ to: "bridge", cmd: "ping" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  })();
  const onNav = () => setTimeout(() => {
    pageProbeSent = false; targetOverride = null; probeCache.clear(); ensureButton();
    if (isMediaPage(location.href)) prefetchProbe(); // warm the new page early
  }, 400);
  window.addEventListener("yt-navigate-finish", onNav);
  window.addEventListener("spfdone", onNav);
  // Other SPAs (Twitch etc.) change the URL without events the page exposes;
  // watch it so a probe cache entry never outlives the video it belongs to.
  let lastNavKey = mediaKey(location.href);
  setInterval(() => {
    const k = mediaKey(location.href);
    if (k !== lastNavKey) {
      lastNavKey = k; pageProbeSent = false; probeCache.clear();
      if (isMediaPage(location.href)) prefetchProbe();
    }
  }, 1000);
  // First-open warmth: on a media page, start the probe shortly after load
  // instead of waiting for the first hover.
  setTimeout(() => { if (isMediaPage(location.href)) prefetchProbe(); }, 900);

  // -------------------------------------------------------------- the overlay
  const OVERLAY_CSS = `
    @font-face {
      font-family: "UMD Plex";
      src: url("FONT_WOFF2") format("woff2");
      font-weight: 100 900; font-style: italic; font-display: swap;
    }
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .umd-backdrop {
      /* Palette taken from the ARYZEN mark: ink-navy body, electric blue and
         cyan on the lit faces, violet on the shadow side. The site accent is
         only used to say where the media came from. */
      --blue: #1f8bff; --sky: #52c8ff; --violet: #7a5cff; --lilac: #c2b6ff;
      --text: #f2f6ff; --text2: #bdc9e3; --text3: #97a6c8;
      --edge: rgba(150,196,255,.20); --edge-hi: rgba(150,215,255,.55);
      --well: rgba(4,7,22,.46);
      --well-inset: inset 0 1px 3px rgba(0,0,0,.38), 0 1px 0 rgba(190,220,255,.07);
      --ring: 0 0 0 3px rgba(60,160,255,.30);
      position: fixed; inset: 0; z-index: 2147483647;
      /* no tint, no page blur: the page stays clear and the menu floats
         centered above it; the glass material lives inside the card only */
      background: transparent;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity .22s ease;
      font-family: "UMD Plex", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-style: italic;
    }
    .umd-backdrop.umd-in { opacity: 1; }
    .umd-cardwrap {
      position: relative;
      width: 660px; max-width: calc(100vw - 48px); max-height: calc(100vh - 64px);
      transform: scale(.96) translateY(8px); opacity: 0;
      transition: transform .24s cubic-bezier(.2,.9,.25,1.1), opacity .2s ease;
    }
    .umd-card {
      position: relative;
      width: 100%; max-height: inherit;
      color: var(--text);
      /* NO filter or transform on the card or any glass ancestor: either one
         makes the card its own backdrop root, and the glass layers would then
         sample an empty backdrop (no refraction, no frost). The soft shadow
         is a blurred silhouette sibling below the card instead. */
    }
    .umd-cardshadow {
      position: absolute; inset: 0; pointer-events: none;
      /* filter on the wrapper, clip-path on the child: clipping the blurred
         element itself would cut the blur off at a hard silhouette edge */
      filter: blur(40px); transform: translateY(20px) scale(.965);
    }
    .umd-cardshadowshape { position: absolute; inset: 0; display: block; background: rgba(4,6,10,.34); }
    /* Material, back to front: the frost + refraction sibling (docGlass, outside
       this shadow root), then in-card tint, top light, one entrance sweep and
       the silhouette rim. The card's clip-path cuts all of it to the tab shape. */
    .umd-cardlayer { position: absolute; inset: 0; display: block; pointer-events: none; }
    /* Old liquid-glass body (same material as the floating button): light
       neutral washes over the refracted page, no navy ink, no colour pools. */
    .umd-cardtint {
      background:
        linear-gradient(155deg, rgba(255,255,255,.16), rgba(255,255,255,.02) 32%, rgba(96,140,255,.08) 70%, rgba(160,190,255,.05)),
        /* the button's neutral scrim: white text stays readable over bright
           pages without tinting the glass */
        linear-gradient(rgba(20,20,26,.34), rgba(20,20,26,.34));
    }
    .umd-cardcap {
      background: linear-gradient(180deg, rgba(255,255,255,.20), rgba(255,255,255,.03) 30%, transparent 55%);
    }
    .umd-cardsheen { overflow: hidden; }
    .umd-cardsheen::before {
      content: ""; position: absolute; top: -10%; bottom: -10%; left: -40%; width: 38%;
      background: linear-gradient(100deg, transparent, rgba(255,255,255,.22) 45%, rgba(255,255,255,.14) 55%, transparent);
      transform: skewX(-16deg);
      animation: umd-sweep 1.2s .28s cubic-bezier(.3,.6,.2,1) 1 both;
    }
    @keyframes umd-sweep {
      from { transform: translateX(0) skewX(-16deg); }
      to { transform: translateX(420%) skewX(-16deg); }
    }
    .umd-cardrim { position: absolute; inset: 0; display: block; pointer-events: none; filter: drop-shadow(0 0 7px rgba(255,255,255,.38)); }
    .umd-content { position: relative; z-index: 1; display: flex; flex-direction: column; max-height: inherit; }
    .umd-backdrop.umd-in .umd-cardwrap { transform: scale(1) translateY(0); opacity: 1; }

    /* ---- raised tab: brand at its start, close at its end ---- */
    .umd-brand {
      position: absolute; top: 5px; left: calc(100% - 168px); z-index: 2;
      display: flex; align-items: center; gap: 8px; height: 24px;
    }
    .umd-brand img { height: 20px; width: auto; display: block; }
    .umd-brandname { font-size: 12.5px; font-weight: 700; letter-spacing: .2em; color: var(--text); }
    .umd-x {
      position: absolute; top: 6px; right: 18px; z-index: 2;
      width: 22px; height: 22px; padding: 0; border-radius: 50%; cursor: pointer;
      display: grid; place-items: center; color: var(--text);
      border: 1px solid rgba(180,215,255,.34);
      background: radial-gradient(circle at 35% 25%, rgba(255,255,255,.26), rgba(255,255,255,.05) 72%);
      transition: background .15s ease, border-color .15s ease, transform .12s ease;
    }
    .umd-x::before { content: ""; position: absolute; inset: -6px; border-radius: 50%; }
    .umd-x svg { width: 10px; height: 10px; transition: transform .22s cubic-bezier(.3,.7,.2,1); }
    .umd-x:hover { border-color: var(--edge-hi); background: radial-gradient(circle at 35% 25%, rgba(255,255,255,.40), rgba(82,200,255,.12) 72%); }
    .umd-x:hover svg { transform: rotate(90deg); }
    .umd-x:active { transform: scale(.92); }

    /* ---- header, paste row, body ---- */
    .umd-head {
      display: flex; align-items: center; gap: 10px;
      /* the 34px top margin keeps this row below the card's raised tab (CARD_RISE) */
      margin-top: 34px; padding: 16px 22px 8px; flex: none;
    }
    .umd-headtitle { font-size: 18px; font-weight: 650; letter-spacing: -.005em; color: var(--text); flex: 1; }
    .umd-body { padding: 10px 22px 22px; overflow-y: auto; min-height: 0; }
    /* toolbar-opened menu: the popup's paste-a-link control, on the same card */
    .umd-pasterow { display: flex; gap: 10px; padding: 4px 22px 4px; flex: none; }
    .umd-pasterow .umd-pasteinput {
      flex: 1; min-width: 0; height: 42px; background: var(--well); color: var(--text);
      border: 1px solid var(--edge); border-radius: 12px; box-shadow: var(--well-inset);
      padding: 0 14px; font-size: 14px; font-weight: 550; font-family: inherit;
      outline: none; transition: border-color .15s ease, box-shadow .15s ease;
    }
    .umd-pasterow .umd-pasteinput::placeholder { color: var(--text3); }
    .umd-pasterow .umd-pasteinput:hover { border-color: rgba(120,190,255,.50); }
    .umd-pasterow .umd-pasteinput:focus { border-color: var(--sky); box-shadow: var(--well-inset), var(--ring); }
    .umd-pasterow .umd-pastebtn { flex: none; height: 42px; padding: 0 18px; font-size: 13.5px; }
    .umd-pasterow .umd-pasteinput:disabled, .umd-pasterow .umd-pastebtn:disabled { opacity: .55; pointer-events: none; }

    /* ---- ready: media on the left, choices on the right ---- */
    .umd-main { display: flex; gap: 20px; }
    .umd-left { width: 254px; flex: none; }
    .umd-thumbwrap {
      position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 16px; overflow: hidden;
      background: linear-gradient(135deg, rgba(40,140,255,.16), rgba(122,92,255,.10));
      border: 1px solid var(--edge);
      display: flex; align-items: center; justify-content: center;
    }
    .umd-thumbwrap::after {
      content: ""; position: absolute; inset: 0; pointer-events: none; border-radius: inherit;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.08), inset 0 -34px 36px -30px rgba(3,5,20,.55);
    }
    .umd-thumbwrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .umd-thumbph {
      width: 52px; height: 52px; border-radius: 16px;
      background: linear-gradient(145deg, ACCENT88, ACCENT33); border: 1px solid ACCENT88;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; font-weight: 800; color: #fff;
    }
    .umd-dur {
      position: absolute; right: 8px; bottom: 8px; z-index: 1;
      background: rgba(6,9,28,.66); color: #fff; font-size: 11.5px; font-weight: 600;
      font-variant-numeric: tabular-nums; padding: 3px 8px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,.14);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    }
    .umd-title {
      margin-top: 12px; font-size: 15px; font-weight: 650; letter-spacing: -.005em; line-height: 1.35; color: var(--text);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .umd-uploader { margin-top: 4px; font-size: 13px; font-weight: 500; color: var(--text2); }
    /* same height as the 16:9 thumbnail (254px wide) so the save row lands on its bottom edge */
    .umd-right { flex: 1; display: flex; flex-direction: column; min-width: 0; height: calc(254px * 9 / 16); }
    .umd-label { font-size: 12.5px; font-weight: 600; letter-spacing: .01em; color: var(--text2); margin-bottom: 8px; }
    .umd-selectwrap { position: relative; margin-bottom: 14px; }
    .umd-selectwrap::after {
      content: ""; position: absolute; right: 16px; top: 50%; width: 7px; height: 7px;
      border-right: 2px solid var(--text2); border-bottom: 2px solid var(--text2);
      transform: translateY(-70%) rotate(45deg); pointer-events: none;
    }
    select.umd-quality {
      width: 100%; height: 44px; appearance: none; -webkit-appearance: none; color-scheme: dark;
      background: var(--well); color: var(--text); border: 1px solid var(--edge); box-shadow: var(--well-inset);
      border-radius: 12px; padding: 0 38px 0 14px; font-size: 14.5px; font-weight: 650;
      cursor: pointer; outline: none; transition: border-color .15s ease, box-shadow .15s ease;
      font-family: inherit;
    }
    select.umd-quality option, select.umd-quality optgroup { background: #0b1130; color: #f2f6ff; }
    select.umd-quality:hover { border-color: rgba(120,190,255,.50); }
    select.umd-quality:focus { border-color: var(--sky); box-shadow: var(--well-inset), var(--ring); }
    .umd-save {
      margin-top: auto; display: flex; align-items: center; gap: 9px;
      background: rgba(4,7,22,.30); border: 1px solid rgba(150,196,255,.14);
      border-radius: 12px; padding: 10px 13px;
      font-size: 12.5px; font-weight: 500; color: var(--text2); min-width: 0;
    }
    .umd-save svg { flex: none; }
    .umd-save span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ---- footer: the action zone, a denser surface under the glass ---- */
    .umd-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: none;
      padding: 14px 22px 16px;
      background: linear-gradient(180deg, rgba(4,6,22,0), rgba(4,6,22,.38));
    }
    .umd-footnote { font-size: 12.5px; font-weight: 500; color: var(--text3); }
    .umd-actions { display: flex; gap: 10px; }
    .umd-btn {
      height: 40px; border: 0; border-radius: 12px; cursor: pointer; font-family: inherit;
      font-size: 14px; font-weight: 700; padding: 0 20px; color: var(--text);
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      transition: transform .12s ease, filter .15s ease, box-shadow .15s ease, background .15s ease, border-color .15s ease;
    }
    .umd-btn:active { transform: scale(.975); }
    /* keyboard focus: a sky ring instead of the browser's default outline
       (the primary button takes focus on open) */
    .umd-btn:focus:not(:focus-visible) { outline: none; }
    .umd-btn:focus-visible { outline: 2px solid var(--sky); outline-offset: 2px; }
    .umd-ghost { background: rgba(255,255,255,.07); border: 1px solid var(--edge); color: var(--text); }
    .umd-ghost:hover { background: rgba(255,255,255,.13); border-color: rgba(170,210,255,.38); }
    .umd-primary {
      /* the mark's blue-to-violet gradient, kept deep enough for 4.5:1 white
         text, lit along the top edge like the logo's cyan rim */
      background: linear-gradient(135deg, #1565e8 0%, #4a52ee 55%, #6d48f0 100%); color: #fff;
      border: 1px solid rgba(140,205,255,.46);
      box-shadow: inset 0 1px 0 rgba(160,222,255,.70), inset 0 -1px 0 rgba(10,10,60,.35), 0 6px 20px rgba(60,100,255,.34);
    }
    .umd-primary:hover { filter: brightness(1.12); box-shadow: inset 0 1px 0 rgba(180,232,255,.85), inset 0 -1px 0 rgba(10,10,60,.35), 0 8px 26px rgba(80,120,255,.46); }
    .umd-primary:disabled { opacity: .45; cursor: default; filter: none; box-shadow: none; }

    /* ---- loading ---- */
    .umd-loading { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 28px 0 22px; }
    .umd-spin {
      width: 36px; height: 36px; border-radius: 50%;
      background: conic-gradient(from 0deg, rgba(82,200,255,0) 0%, var(--sky) 55%, var(--violet) 100%);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px));
      animation: umd-rot .9s linear infinite;
    }
    @keyframes umd-rot { to { transform: rotate(360deg); } }
    .umd-loadtext { font-size: 13.5px; color: var(--text2); text-align: center; }

    /* ---- progress ---- */
    .umd-prog { padding: 6px 0 2px; }
    .umd-pctrow { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px; }
    .umd-pct { font-size: 40px; font-weight: 700; letter-spacing: -.03em; line-height: 1; font-variant-numeric: tabular-nums; }
    .umd-stage { font-size: 13px; color: var(--text2); }
    .umd-bar {
      height: 10px; border-radius: 999px; overflow: hidden;
      background: rgba(4,7,22,.52); border: 1px solid var(--edge); box-shadow: inset 0 1px 2px rgba(0,0,0,.4);
    }
    .umd-fill {
      position: relative; height: 100%; width: 0%; border-radius: 999px;
      background: linear-gradient(90deg, var(--blue), var(--sky) 52%, #8b6bff);
      transition: width .3s ease;
      box-shadow: 0 0 12px rgba(63,160,255,.55);
    }
    /* one soft glint travelling along the fill says "still working" */
    .umd-fill::after {
      content: ""; position: absolute; inset: 0; border-radius: inherit;
      background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.42) 50%, transparent 70%);
      background-size: 220% 100%;
      animation: umd-glint 1.7s linear infinite;
    }
    @keyframes umd-glint { 0% { background-position: 120% 0; } 100% { background-position: -120% 0; } }
    .umd-stats { display: flex; gap: 10px; margin-top: 16px; }
    .umd-stat { flex: 1; min-width: 0; background: var(--well); border: 1px solid rgba(150,196,255,.14); box-shadow: var(--well-inset); border-radius: 12px; padding: 10px 13px; }
    .umd-stat .k { font-size: 12px; font-weight: 600; color: var(--text3); }
    .umd-stat .v { font-size: 14px; font-weight: 650; color: var(--text); margin-top: 3px; font-variant-numeric: tabular-nums; }

    /* ---- done ---- */
    .umd-done { display: flex; flex-direction: column; align-items: center; padding: 22px 0 12px; }
    .umd-checkwrap { position: relative; width: 86px; height: 86px; margin-bottom: 16px; }
    .umd-checkring {
      position: absolute; inset: 0; border-radius: 50%;
      background: radial-gradient(circle at 35% 25%, rgba(82,200,255,.26), rgba(122,92,255,.12) 75%);
      border: 1.5px solid rgba(120,205,255,.60);
      box-shadow: 0 0 24px rgba(60,150,255,.30);
      animation: umd-pop .45s cubic-bezier(.2,1.4,.4,1) both;
    }
    .umd-checkring svg { position: absolute; inset: 0; margin: auto; }
    .umd-checkring svg path {
      stroke-dasharray: 60; stroke-dashoffset: 60;
      animation: umd-draw .5s .25s ease-out forwards;
    }
    @keyframes umd-draw { to { stroke-dashoffset: 0; } }
    .umd-sitelogo {
      position: absolute; right: -7px; bottom: -7px; width: 34px; height: 34px;
      border-radius: 11px; background: rgba(8,12,34,.92); border: 1px solid rgba(170,210,255,.30);
      display: flex; align-items: center; justify-content: center; overflow: hidden;
      animation: umd-pop .5s .3s cubic-bezier(.2,1.6,.4,1) both;
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .umd-sitelogo img { width: 22px; height: 22px; border-radius: 5px; }
    @keyframes umd-pop { 0% { transform: scale(.3); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
    .umd-donetitle { font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
    .umd-donefile { margin-top: 6px; font-size: 13px; color: var(--text2); max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ---- error ---- */
    .umd-err { padding: 14px 0 4px; }
    .umd-errbox {
      display: flex; gap: 12px; align-items: flex-start;
      background: rgba(255,92,116,.10); border: 1px solid rgba(255,125,142,.38);
      border-radius: 14px; padding: 14px 16px; font-size: 13.5px; line-height: 1.5; color: #ffd3d9;
    }
    .umd-errbox svg { flex: none; margin-top: 1px; color: #ff8d9b; }

    /* ---- narrow viewports: stack the media above its choices ---- */
    @media (max-width: 620px) {
      .umd-main { flex-direction: column; gap: 16px; }
      .umd-left { width: 100%; }
      .umd-right { height: auto; }
      .umd-save { margin-top: 0; }
      .umd-selectwrap { margin-bottom: 12px; }
      .umd-stats { flex-wrap: wrap; }
      .umd-stat { flex: 1 1 40%; }
      .umd-foot { flex-wrap: wrap; }
      .umd-head, .umd-body, .umd-foot { padding-left: 18px; padding-right: 18px; }
      .umd-pasterow { padding-left: 18px; padding-right: 18px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .umd-fill::after, .umd-spin, .umd-cardsheen::before { animation: none !important; }
      .umd-cardsheen::before { display: none; }
      .umd-backdrop, .umd-card, .umd-fill, .umd-x svg { transition: none !important; }
    }
  `;

  function faviconUrl() {
    const l = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
    if (l && l.href) return l.href;
    return location.origin + "/favicon.ico";
  }

  function fmtDur(sec) {
    if (!sec) return "";
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60, h = Math.floor(m / 60);
    return h ? h + ":" + String(m % 60).padStart(2, "0") + ":" + String(s).padStart(2, "0")
             : m + ":" + String(s).padStart(2, "0");
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  let overlay = null; // { host, root, close() }
  // Probe sequencing: a newer probe supersedes an in-flight one, so a
  // pasted link never waits for the page probe and the page probe's late
  // result can never overwrite the link the user actually picked.
  let probeSeq = 0;

  // The media identity of a URL: origin + path + YouTube's ?v=, so tracking
  // or progress params neither bust the probe cache nor fool the nav watch.
  function mediaKey(u) {
    try {
      const x = new URL(u);
      let k = x.origin + x.pathname;
      const v = x.searchParams.get("v");
      if (v) k += "?v=" + v; // YouTube identifies videos by ?v=
      return k;
    } catch (e) { return u; }
  }
  // Does this page's own URL name a single media item? On these pages the
  // URL bar is the primary probe target (yt-dlp reads them natively); on
  // feeds and home pages it is not, and player-targeting stays the fallback.
  function isMediaPage(u) {
    try {
      const x = new URL(u), h = x.hostname.replace(/^www\./, ""), p = x.pathname;
      if (/(^|\.)youtube\.com$/.test(h)) return p.startsWith("/watch") || p.startsWith("/shorts/");
      if (/(^|\.)instagram\.com$/.test(h)) return /^\/(p|reel|reels)\//.test(p);
      if (/(^|\.)reddit\.com$/.test(h)) return p.includes("/comments/");
      if (/(^|\.)twitch\.tv$/.test(h)) {
        if (h.startsWith("clips.") || /^\/videos\/\d/.test(p)) return true;
        // A bare channel page is a live stream, which the URL also names.
        const seg = p.replace(/^\/+|\/+$/g, "");
        if (seg && !seg.includes("/")) {
          return ["directory","settings","jobs","store","prime","turbo","drops",
                  "wallet","subscriptions","inventory","messaging","search",
                  "browse","p","video","videos","clip","clips"].indexOf(seg) < 0;
        }
        return false;
      }
      if (/(^|\.)soundcloud\.com$/.test(h)) return /^\/[^/]+\/[^/]+/.test(p);
      if (/(^|\.)streamable\.com$/.test(h)) return /^\/[^/]{3,}\/?$/.test(p);
      if (/(^|\.)ted\.com$/.test(h)) return p.startsWith("/talks/");
      if (h === "open.spotify.com") return true;
      return true; // any other supported host: let the URL try first
    } catch (e) { return true; }
  }
  // Probe results live until the tab moves to a different video. Reopening
  // the pill on the same page reads this instead of re-probing, and the
  // prefetch below lands here too, so the first click is usually instant.
  // ------------------------------------------------ in-browser media resolvers
  // Instagram and Reddit refuse the engine's anonymous requests. The page
  // itself is logged in and same-origin, so it reads the media links and the
  // helper only has to fetch plain files / playlists. Any failure here falls
  // back to the helper reading the page URL itself.
  const IG_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function igMediaId(code) {
    let n = 0n;
    for (const c of code.slice(0, 11)) {
      const i = IG_ALPHA.indexOf(c);
      if (i < 0) return null;
      n = n * 64n + BigInt(i);
    }
    return n.toString();
  }
  const MP3_RATES = [320, 256, 192, 128];
  async function igResolve(url) {
    const m = new URL(url).pathname.match(/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/);
    const id = m && igMediaId(m[1]);
    if (!id) return null;
    const r = await fetch("/api/v1/media/" + id + "/info/", {
      credentials: "include",
      headers: { "X-IG-App-ID": "936619743392459", "X-Requested-With": "XMLHttpRequest" },
    });
    if (!r.ok) return null;
    const top = (((await r.json()).items) || [])[0];
    if (!top) return null;
    const vid = top.video_versions ? top : (top.carousel_media || []).find((c) => c.video_versions);
    if (!vid || !vid.video_versions.length) return null;
    const byH = new Map();
    vid.video_versions.forEach((v) => {
      const h = Math.min(v.width || 0, v.height || 0);
      const cur = byH.get(h);
      if (!cur || (v.width * v.height) > (cur.width * cur.height)) byH.set(h, v);
    });
    const heights = [...byH.keys()].sort((a, b) => b - a);
    const best = byH.get(heights[0]);
    // Strip query parameters from URLs to avoid filename too long errors
    const cleanUrl = (u) => u.split("?")[0];
    const options = [{ id: "v-best", kind: "video", label: "Best available (auto)", selector: "b", url: cleanUrl(best.url) }];
    heights.forEach((h) => options.push({ id: "v" + h, kind: "video", label: (h ? h + "p" : "Video"), selector: "b", url: cleanUrl(byH.get(h).url) }));
    MP3_RATES.forEach((br) => options.push({ id: "a" + br, kind: "audio-mp3", label: "MP3 " + br + " kbps", mp3: br, url: cleanUrl(best.url) }));
    const cap = (top.caption && top.caption.text || "").replace(/\s+/g, " ").trim();
    const user = (top.user && top.user.username) || "";
    const cand = vid.image_versions2 && vid.image_versions2.candidates && vid.image_versions2.candidates[0];
    return { ok: true, resolvedUrl: url, useName: true, options,
      info: { title: cap.slice(0, 90) || (user ? user + " - Instagram video" : "Instagram video"),
              uploader: user ? "@" + user : "", site: "Instagram",
              thumbnail: cand ? cand.url : "", duration: vid.video_duration || 0 } };
  }
  async function redditResolve(url, timeoutMs, onWorking) {
    const u = new URL(url);
    if (u.hostname !== location.hostname || !/\/comments\/\w+/.test(u.pathname)) return null;
    const r = await fetch(u.origin + u.pathname.replace(/\/?$/, "/") + ".json?raw_json=1",
      { credentials: "include", headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    let post = (((await r.json())[0] || {}).data || {}).children;
    post = post && post[0] && post[0].data;
    if (!post) return null;
    if (!post.secure_media && !post.media && post.crosspost_parent_list && post.crosspost_parent_list[0]) post = post.crosspost_parent_list[0];

    const prev = post.preview && post.preview.images && post.preview.images[0];
    const thumb = (prev && prev.source && prev.source.url) || (/^http/.test(post.thumbnail || "") ? post.thumbnail : "");
    const info = { title: post.title || "Reddit post", site: "Reddit", thumbnail: thumb, duration: 0,
                   uploader: ["r/" + post.subreddit, post.author ? "u/" + post.author : ""].filter(Boolean).join(" \u00b7 ") };

    // Check if it's an image post (url_overridden_by_dest or url pointing to an image)
    const mediaUrl = post.url_overridden_by_dest || post.url;
    if (mediaUrl && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(mediaUrl)) {
      return { ok: true, resolvedUrl: url, useName: true, info,
        options: [{ id: "img-direct", kind: "image", label: "Image (HD)", selector: "b", url: mediaUrl.split("?")[0] }] };
    }

    const rv = (post.secure_media && post.secure_media.reddit_video) ||
               (post.media && post.media.reddit_video) ||
               (post.preview && post.preview.reddit_video_preview);
    if (!rv) return null;

    info.duration = rv.duration || 0;
    if (rv.hls_url) {
      const pr = await send("probe", { url: rv.hls_url }, timeoutMs, onWorking);
      if (pr && pr.ok && (pr.options || []).length) {
        return Object.assign({}, pr, { info: Object.assign({}, pr.info, info), resolvedUrl: rv.hls_url, useName: true });
      }
    }
    if (rv.fallback_url) { // silent clip / GIF: one plain mp4
      const h = rv.height || 0;
      return { ok: true, resolvedUrl: url, useName: true, info,
        options: [{ id: "v-direct", kind: "video", label: (h ? h + "p" : "Video") + " (no audio track)", selector: "b", url: rv.fallback_url.split("?")[0] }] };
    }
    return null;
  }
  async function probeVia(url, timeoutMs, onWorking) {
    try {
      const h = new URL(url).hostname;
      // For Instagram, let the bridge handle it natively with yt-dlp
      // yt-dlp has built-in Instagram extractors that handle authentication properly
      // The igResolve() approach extracts direct CDN URLs that require cookies and fail with 403
      if (/(^|\.)instagram\.com$/.test(h) && h === location.hostname) {
        // Fall through to bridge's probe (send "probe" command)
      } else if (/(^|\.)reddit\.com$/.test(h)) {
        const r = await redditResolve(url, timeoutMs, onWorking);
        if (r) return r;
      }
    } catch (e) { /* fall through to the helper */ }
    return send("probe", { url }, timeoutMs, onWorking);
  }

  // ------------------------------------------------------------ Spotify track
  // The track's own page carries clean title/artist/cover meta tags.
  async function spGetTrack() {
    const a = document.querySelector('[data-testid="now-playing-widget"] a[href*="/track/"], footer a[href*="/track/"]');
    const m = ((a && a.getAttribute("href")) || location.pathname).match(/\/track\/(\w+)/);
    if (m) {
      try {
        const r = await fetch("/track/" + m[1], { credentials: "omit" });
        const doc = new DOMParser().parseFromString(await r.text(), "text/html");
        const meta = (p) => { const e = doc.querySelector('meta[property="' + p + '"]'); return e ? (e.content || "").trim() : ""; };
        const title = meta("og:title");
        if (title) return { title, thumb: meta("og:image"),
          artist: (meta("og:description").split(" \u00b7 ")[0] || "").split(",")[0].trim() };
      } catch (e) {}
    }
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md && md.title) return { title: md.title, artist: (md.artist || "").split(",")[0].trim(),
        thumb: (md.artwork && md.artwork.length) ? md.artwork[md.artwork.length - 1].src : "" };
    } catch (e) {}
    return null;
  }

  const probeCache = new Map(); // mediaKey -> { url, info, options }
  let inflightProbe = null; // { key, promise } - a prefetch still in flight
  function cacheProbe(url, r) {
    if (!r || !r.ok || !(r.options || []).length) return;
    probeCache.set(mediaKey(url), { url: r.resolvedUrl || url, useName: !!r.useName, info: r.info || {}, options: r.options || [] });
    // Entries for pages already left can never be served (lookups are keyed
    // by the page being probed); drop them so the cache stays one-video deep.
    const keep = mediaKey(location.href);
    const tk = targetOverride && targetOverride.url ? mediaKey(targetOverride.url) : null;
    for (const k of probeCache.keys()) if (k !== keep && k !== tk) probeCache.delete(k);
  }

  // Prefetch: the first hover on the pill - and, on media pages, shortly
  // after the pill appears - starts reading the current target in the
  // background, so the menu usually opens with options already in cache.
  // Failures are silent here - the menu's own probe reports errors when it runs.
  let pageProbeSent = false;
  function prefetchProbe() {
    if (pageProbeSent || SPOTIFY) return;
    if (targetOverride && targetOverride.unresolved) return; // nothing to warm
    const url = (targetOverride && targetOverride.url) || location.href;
    if (probeCache.has(mediaKey(url))) return; // already warm
    if (inflightProbe && inflightProbe.key === mediaKey(url)) return; // probing now
    pageProbeSent = true;
    inflightProbe = { key: mediaKey(url), promise: probeVia(url, 60000)
      .then((r) => { if (r && r.ok) cacheProbe(url, r); return r; })
      .catch(() => { pageProbeSent = false; return null; }) }; // retry later
  }

  // Player targeting: dropping the floating pill over a player targets THAT
  // media instead of the page URL (feeds and players that never change the
  // address bar). Dragging it back off the player clears the target. A drop
  // on a player with no resolvable link marks the target UNRESOLVED: the menu
  // then says so instead of silently probing the page (which on a feed could
  // pick a different video).
  let targetOverride = null; // { url, anchor } | { unresolved: true } | null
  function umdResolvePlayerTarget(el) {
    let node = el, video = null, iframe = null, hop = 0;
    let permalink = null, hopsPastVideo = 0;
    while (node && node !== document.body && hop++ < 14) {
      const tag = node.tagName || "";
      if (!iframe && tag === "IFRAME") iframe = node;
      if (!video && tag === "VIDEO") video = node;
      else if (video) hopsPastVideo++;
      // Reddit's web components carry the canonical link on the post node.
      if (!permalink && node.getAttribute) {
        const pl = node.getAttribute("permalink");
        if (pl && typeof pl === "string") {
          try { permalink = new URL(pl, location.href).href; } catch (e) {}
        }
      }
      if (node.querySelector) {
        if (!video) video = node.querySelector("video");
        // Generic fallback: a post wrapper usually links to its own page.
        // Only near the player - higher up a feed, the first /comments/ link
        // could belong to a different post.
        if (!permalink && hopsPastVideo <= 2) {
          const a = node.querySelector('a[href*="/comments/"]');
          if (a && a.href) permalink = a.href;
        }
      }
      // Keep climbing after the video turns up: the canonical post link often
      // lives on a wrapper ABOVE the player (e.g. the post container).
      node = node.parentElement ||
             (node.getRootNode && node.getRootNode().host) || null;
    }
    // An embedded cross-origin player (YouTube-in-Reddit etc.) cannot be
    // inspected, but its frame src IS readable and usually names the media.
    if (iframe) {
      try {
        const s = new URL(iframe.src, location.href);
        if (s.protocol === "http:" || s.protocol === "https:") {
          return { url: s.href, anchor: iframe };
        }
      } catch (e) {}
    }
    if (permalink) return { url: permalink, anchor: video || el };
    if (video) {
      const src = video.currentSrc || video.src || "";
      if (/^https?:/i.test(src)) return { url: src, anchor: video };
      return { unresolved: true, anchor: video }; // blob:/MSE-only player
    }
    return null; // no player under the button at all
  }
  function umdMarkTarget(b, anchor, flash, unresolved) {
    b.classList.toggle("umd-targeting", !!anchor);
    b.title = !anchor ? "" : (unresolved
      ? "That player has no downloadable link - open the video's own page"
      : "Targets the video under this button");
    if (!anchor || !flash) return;
    const r = anchor.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) return;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;" +
      "border:2px solid #7ec8ff;border-radius:10px;" +
      "box-shadow:0 0 18px rgba(126,200,255,.45);" +
      "left:" + (r.left - 4) + "px;top:" + (r.top - 4) + "px;" +
      "width:" + (r.width + 8) + "px;height:" + (r.height + 8) + "px;" +
      "opacity:1;transition:opacity .5s ease";
    document.body.appendChild(box);
    setTimeout(() => { box.style.opacity = "0"; }, 900);
    setTimeout(() => { box.remove(); }, 1500);
  }
  function umdUpdateTarget(b) {
    const r = b.getBoundingClientRect();
    const prev = b.style.pointerEvents;
    b.style.pointerEvents = "none";
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    b.style.pointerEvents = prev;
    const t = el && umdResolvePlayerTarget(el);
    if (t && t.url) {
      const isNew = !targetOverride || targetOverride.url !== t.url;
      targetOverride = t;
      umdMarkTarget(b, t.anchor, isNew);
      if (isNew) { pageProbeSent = false; prefetchProbe(); } // warm this target now
    } else if (t) {
      // A player was found but exposes no link (blob:/MSE-only). On a media
      // page the URL bar still names the video and page probing is primary,
      // so the player must not block it; elsewhere remember the dead end.
      if (isMediaPage(location.href)) {
        targetOverride = null;
        umdMarkTarget(b, null, false);
      } else {
        targetOverride = { unresolved: true };
        umdMarkTarget(b, t.anchor, true, true);
      }
    } else {
      targetOverride = null;
      umdMarkTarget(b, null, false);
    }
  }

  // menuMode: opened from the toolbar button - the same liquid-glass card,
  // plus the paste-a-link row the browser popup used to carry.
  function openOverlay(menuMode) {
    if (overlay) { overlay.close(); overlay = null; }
    const oh = document.createElement("div");
    const shadow = oh.attachShadow({ mode: "open" });
    oh.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS
      .replace("FONT_WOFF2", chrome.runtime.getURL("fonts/ibm-plex-sans-italic-latin.woff2"))
      .replace(/ACCENTBB/g, site.accent + "bb").replace(/ACCENT88/g, site.accent + "88")
      .replace(/ACCENT66/g, site.accent + "66").replace(/ACCENT55/g, site.accent + "55")
      .replace(/ACCENT44/g, site.accent + "44").replace(/ACCENT33/g, site.accent + "33")
      .replace(/ACCENT22/g, site.accent + "22")
      .replace(/ACCENT/g, site.accent);
    shadow.appendChild(style);

    const backdrop = el("div", "umd-backdrop");
    backdrop.style.pointerEvents = "auto";
    const wrap = el("div", "umd-cardwrap");
    const cardShadow = el("i", "umd-cardshadow");
    const cardShadowShape = el("i", "umd-cardshadowshape");
    cardShadow.appendChild(cardShadowShape);
    cardShadow.setAttribute("aria-hidden", "true");
    // The frost + refraction layer lives OUTSIDE the shadow root: in the
    // Chrome build tested 2026-11-11, backdrop-filter: url(...) did not
    // render on shadow-tree elements (plain CSS blur did; the same url()
    // filter rendered on document-level elements). applyCardGlass positions
    // this sibling exactly under the card and cuts it to the same silhouette.
    const docGlass = document.createElement("div");
    docGlass.setAttribute("aria-hidden", "true");
    docGlass.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;" +
      "background:linear-gradient(180deg, rgba(10,18,48,.16), rgba(8,12,36,.30));opacity:0;transform:scale(.96) translateY(8px);" +
      "transition:opacity .22s ease, transform .24s cubic-bezier(.2,.9,.25,1.1);";
    const card = el("div", "umd-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Download this media");
    // Liquid-glass layers sit behind the content; the silhouette rim is an
    // SVG outline of the exact card polygon, rebuilt whenever the size changes.
    const cardTint = el("i", "umd-cardlayer umd-cardtint");
    const cardCap = el("i", "umd-cardlayer umd-cardcap");
    const cardSheen = el("i", "umd-cardlayer umd-cardsheen");
    const cardRim = el("i", "umd-cardrim");
    for (const l of [cardTint, cardCap, cardSheen, cardRim]) l.setAttribute("aria-hidden", "true");
    const content = el("div", "umd-content");
    card.append(cardTint, cardCap, cardSheen, cardRim, content);
    wrap.append(cardShadow, card);
    backdrop.appendChild(wrap);
    shadow.appendChild(backdrop);

    // Bake the silhouette clip-path, rim outline and displacement filter for
    // the card's current size; re-runs automatically after every phase change
    // (renderFoot) because the card grows/shrinks with its content.
    function applyCardGlass() {
      const rect = card.getBoundingClientRect();
      const W = Math.round(rect.width), H = Math.round(rect.height);
      if (W < 80 || H < 80) return;
      const baked = W + "x" + H + "@" + Math.round(rect.left) + "," + Math.round(rect.top);
      if (card._umdBaked === baked) return;
      card._umdBaked = baked;
      const shape = umdCardShape(W, H);
      card.style.clipPath = "polygon(" + shape.clip + ")";
      cardShadowShape.style.clipPath = "polygon(" + shape.clip + ")";
      docGlass.style.left = rect.left + "px";
      docGlass.style.top = rect.top + "px";
      docGlass.style.width = W + "px";
      docGlass.style.height = H + "px";
      docGlass.style.clipPath = "polygon(" + shape.clip + ")";
      const rimId = "umd-cardrim-g" + (++lgFilterSeq);
      cardRim.innerHTML =
        '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
        '<defs><linearGradient id="' + rimId + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="rgba(255,255,255,.98)"/>' +
        '<stop offset=".22" stop-color="rgba(255,255,255,.28)"/>' +
        '<stop offset=".5" stop-color="rgba(185,212,255,.40)"/>' +
        '<stop offset=".72" stop-color="rgba(255,255,255,.22)"/>' +
        '<stop offset=".88" stop-color="rgba(198,222,255,.64)"/>' +
        '<stop offset="1" stop-color="rgba(255,255,255,.92)"/></linearGradient></defs>' +
        '<polygon points="' + shape.ptsAttr + '" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="4.5" stroke-linejoin="round"/>' +
        '<polygon points="' + shape.ptsAttr + '" fill="none" stroke="url(#' + rimId + ')" stroke-width="1.8" stroke-linejoin="round"/></svg>';
      const fid = ensureLiquidGlassFilter(W, H, {
        sdf: umdPolySDF(shape.centered),
        thickness: Math.min(64, H / 2), reach: 64, sample: 1,
        frost: 9, mapSmooth: 3, scale: 60,
        cacheKey: "card-" + W + "x" + H, svgParent: document.body || document.documentElement,
      });
      docGlass.style.webkitBackdropFilter = "url(#" + fid + ")";
      docGlass.style.backdropFilter = "url(#" + fid + ")";
    }
    function queueCardGlass() { requestAnimationFrame(applyCardGlass); }
    (document.documentElement || document.body).appendChild(docGlass);
    (document.documentElement || document.body).appendChild(oh);
    window.addEventListener("resize", queueCardGlass);

    const st = {
      phase: "loading", // loading | ready | downloading | done | error | setup
      info: null, options: [], job: null, downloadDir: "~/Downloads/UMD",
      url: null, // the exact page URL the visible options were probed from
      urlIsPage: true, // false when the options came from a pasted link
    };

    function close() {
      probeSeq++; // invalidate any in-flight probe continuation
      backdrop.classList.remove("umd-in");
      docGlass.style.opacity = "0";
      setTimeout(() => { oh.remove(); docGlass.remove(); }, 240);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", queueCardGlass);
      clearInterval(navWatch);
      overlay = null;
      const b = document.getElementById(BTN_ID);
      if (b) { try { b.focus(); } catch (e) {} }
    }
    overlay = { host: oh, root: shadow, close };

    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); if (st.phase === "downloading") cancelJob(); else close(); }
      if (e.key === "Tab") {
        const f = card.querySelectorAll('button, select, input, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        const active = shadow.activeElement;
        if (e.shiftKey && (active === first || !card.contains(active))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || !card.contains(active))) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);
    // If the single-page app navigates to a DIFFERENT media page while the
    // panel is open, the shown options would no longer match - close instead
    // of mixing them. Players also rewrite the URL on their own (tracking or
    // progress params), so compare the media identity (mediaKey), not href.
    // Only a probe of THIS page goes stale when the page navigates; pasted
    // links keep their options regardless of where this tab goes.
    const navWatch = setInterval(() => {
      if (st.url && st.urlIsPage && mediaKey(location.href) !== mediaKey(st.url)) close();
    }, 800);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop && st.phase !== "downloading" && st.phase !== "loading") close();
    });

    // ---- header
    const head = el("div", "umd-head");
    // Branding (icon + AMD) sits inside the raised top-right tab, where the
    // reference card carries its corner mark; the site name stays in the
    // media meta line below the thumbnail.
    const brand = el("div", "umd-brand");
    const bimg = document.createElement("img");
    bimg.src = chrome.runtime.getURL("icons/tab-mark.png"); bimg.alt = "";
    bimg.onerror = () => bimg.remove();
    brand.append(bimg, el("span", "umd-brandname", "AMD"));
    card.appendChild(brand);
    const ht = el("span", "umd-headtitle", "Download media");
    const x = el("button", "umd-x");
    x.type = "button";
    x.innerHTML = '<svg viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    x.setAttribute("aria-label", "Close");
    x.onclick = () => { if (st.phase === "downloading") cancelJob(); else close(); };
    card.appendChild(x); // the close button caps the right end of the raised tab
    head.append(ht);

    const body = el("div", "umd-body");
    const foot = el("div", "umd-foot");
    content.append(head, body, foot);

    // Menu mode only: paste any video/audio link and probe it, the same job
    // the browser popup's link field did. The page probe still starts on its
    // own below, exactly like the Download button.
    let pasteInput = null, pasteBtn = null;
    if (menuMode) {
      const prow = el("div", "umd-pasterow");
      pasteInput = el("input", "umd-pasteinput");
      pasteInput.type = "url";
      pasteInput.placeholder = "Paste a video or audio link";
      pasteInput.setAttribute("aria-label", "Paste a video or audio link");
      pasteInput.spellcheck = false;
      pasteInput.autocomplete = "off";
      pasteBtn = el("button", "umd-btn umd-primary umd-pastebtn", "Check");
      const go = () => { const u = (pasteInput.value || "").trim(); if (u) probeUrl(u, false); };
      pasteBtn.onclick = go;
      pasteInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); go(); } });
      prow.append(pasteInput, pasteBtn);
      content.insertBefore(prow, body);
    }
    function setPasteEnabled(on) {
      if (!pasteInput) return;
      pasteInput.disabled = !on;
      pasteBtn.disabled = !on;
    }

    // Error text always travels with an icon, so it never relies on colour alone.
    function errBox(msg) {
      const b = el("div", "umd-errbox");
      b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M12 3.5l9.5 16.5h-19L12 3.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
        '<path d="M12 10v4.2M12 17.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      b.appendChild(el("span", "", msg));
      return b;
    }

    // ---- footer (rebuilt per phase)
    function renderFoot(note, actions) {
      foot.innerHTML = "";
      foot.append(el("span", "umd-footnote", note || ""));
      const a = el("div", "umd-actions");
      actions.forEach((b) => a.appendChild(b));
      foot.appendChild(a);
      queueCardGlass();
    }
    function ghostBtn(label, fn) {
      const b = el("button", "umd-btn umd-ghost", label);
      b.onclick = fn;
      return b;
    }
    function primaryBtn(label, fn) {
      const b = el("button", "umd-btn umd-primary");
      b.innerHTML = ICON_SVG + "<span></span>";
      b.querySelector("span").textContent = label;
      b.onclick = fn;
      return b;
    }

    // ---- phases
    function showLoading(forPage) {
      st.phase = "loading";
      // Paste stays enabled: checking a link must not wait on an unrelated
      // page probe (probeUrl sequencing keeps their results straight).
      body.innerHTML = "";
      const w = el("div", "umd-loading");
      w.append(el("div", "umd-spin"), el("div", "umd-loadtext",
        forPage === false ? "Reading that link\u2026" : "Reading this page\u2026"));
      body.appendChild(w);
      renderFoot("Checking what the local engine can fetch", []);
    }

    function showSetupError(msg) {
      st.phase = "setup";
      setPasteEnabled(true);
      body.innerHTML = "";
      const w = el("div", "umd-err");
      w.appendChild(errBox(
        "The local helper is not answering (" + msg + "). Run the installer for your system, restart your browser, then click the Download button again."));
      body.appendChild(w);
      renderFoot("", [ghostBtn("Close", close)]);
    }

    function showError(msg) {
      st.phase = "error";
      setPasteEnabled(true);
      body.innerHTML = "";
      const w = el("div", "umd-err");
      w.appendChild(errBox(msg || "Something went wrong."));
      body.appendChild(w);
      renderFoot("", [ghostBtn("Close", close), primaryBtn("Try again", boot)]);
    }

    function showReady() {
      st.phase = "ready";
      setPasteEnabled(true);
      body.innerHTML = "";
      const main = el("div", "umd-main");

      const left = el("div", "umd-left");
      const tw = el("div", "umd-thumbwrap");
      if (st.info.thumbnail) {
        const img = document.createElement("img");
        img.src = st.info.thumbnail; img.alt = "";
        img.onerror = () => { img.remove(); tw.appendChild(placeholder()); };
        tw.appendChild(img);
      } else {
        tw.appendChild(placeholder());
      }
      const dur = fmtDur(st.info.duration);
      if (dur) tw.appendChild(el("span", "umd-dur", dur));
      left.appendChild(tw);
      left.appendChild(el("div", "umd-title", st.info.title || "Untitled media"));
      const up = [st.info.uploader, st.info.site].filter(Boolean).join(" \u00b7 ");
      if (up) left.appendChild(el("div", "umd-uploader", up));

      const right = el("div", "umd-right");
      right.appendChild(el("div", "umd-label", "Format"));
      const selWrap = el("div", "umd-selectwrap");
      const sel = document.createElement("select");
      sel.className = "umd-quality";
      sel.setAttribute("aria-label", "Choose download quality or type");
      const groups = {};
      st.options.forEach((o, i) => {
        const gname = o.kind === "video" ? "Video" : "Audio only";
        groups[gname] = groups[gname] || document.createElement("optgroup");
        groups[gname].label = gname;
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = o.label + (o.size ? "  \u00b7  " + o.size : "");
        groups[gname].appendChild(opt);
      });
      Object.keys(groups).forEach((k) => sel.appendChild(groups[k]));
      selWrap.appendChild(sel);
      right.appendChild(selWrap);

      const save = el("div", "umd-save");
      save.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="#8fb8ff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
      right.appendChild(save);

      main.append(left, right);
      body.appendChild(main);

      const dl = primaryBtn("Download", () => startDownload(sel));
      renderFoot("", [ghostBtn("Cancel", close), dl]);
      dl.focus({ focusVisible: false }); // autofocus for Enter-to-download without showing the ring; the styled :focus-visible ring still appears on real Tab navigation
    }

    function placeholder() {
      return el("div", "umd-thumbph", (site.name[0] || "U").toUpperCase());
    }

    function showProgress() {
      st.phase = "downloading";
      setPasteEnabled(false);
      body.innerHTML = "";
      const w = el("div", "umd-prog");
      const row = el("div", "umd-pctrow");
      const pct = el("div", "umd-pct", "0%");
      pct.id = "umd-pct";
      row.append(pct, el("div", "umd-stage", "Starting\u2026"));
      row.querySelector(".umd-stage").id = "umd-stage";
      const bar = el("div", "umd-bar");
      const fill = el("div", "umd-fill");
      fill.id = "umd-fill";
      bar.appendChild(fill);
      const stats = el("div", "umd-stats");
      stats.innerHTML =
        '<div class="umd-stat"><div class="k">Speed</div><div class="v" id="umd-speed">\u2014</div></div>' +
        '<div class="umd-stat"><div class="k">ETA</div><div class="v" id="umd-eta">\u2014</div></div>';
      w.append(row, bar, stats);
      body.appendChild(w);
      renderFoot("", [ghostBtn("Cancel", cancelJob)]);
    }

    function showDone(file, filePath) {
      st.phase = "done";
      setPasteEnabled(true);
      body.innerHTML = "";
      const w = el("div", "umd-done");
      const cw = el("div", "umd-checkwrap");
      const ring = el("div", "umd-checkring");
      ring.innerHTML =
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M4.5 12.5l5 5 10-11" stroke="#8fe0ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const lg = el("div", "umd-sitelogo");
      const li = document.createElement("img");
      li.src = faviconUrl(); li.alt = site.name; li.onerror = () => li.remove();
      lg.appendChild(li);
      cw.append(ring, lg);

      // Show file name
      w.append(cw, el("div", "umd-donetitle", "Download complete"));

      // Show file path if available
      if (filePath) {
        const pathDiv = el("div", "umd-donefile");
        pathDiv.style.fontSize = "12px";
        pathDiv.style.color = "var(--text2)";
        pathDiv.style.marginTop = "4px";
        pathDiv.style.maxWidth = "480px";
        pathDiv.style.overflow = "hidden";
        pathDiv.style.textOverflow = "ellipsis";
        pathDiv.style.whiteSpace = "nowrap";
        // Show just the filename with folder indicator
        const filename = filePath.split("/").pop() || filePath;
        pathDiv.textContent = "📁 ~/Downloads/" + filename;
        pathDiv.title = filePath; // Full path on hover
        w.append(pathDiv);
      } else if (file) {
        w.append(el("div", "umd-donefile", "📁 ~/Downloads/" + file));
      } else {
        w.append(el("div", "umd-donefile", "Saved to " + st.downloadDir));
      }

      body.appendChild(w);
      renderFoot("", [
        primaryBtn("Open Folder", () => send("open-downloads")),
        ghostBtn("Show in Chrome", () => chrome.runtime.sendMessage({ to: "bridge", cmd: "open-downloads-tab" })),
        ghostBtn("Close", close)
      ]);
      // Don't auto-close - let user decide when to close
    }

    // ---- actions
    function cancelJob() {
      if (st.job) send("cancel", { job: st.job.id });
      st.job = null;
      close();
    }

    async function startDownload(sel) {
      const o = st.options[Number(sel.value)];
      if (!o) return;

      // For Spotify, ensure we have the track info before downloading
      if (SPOTIFY && !st.spQuery) {
        const t = await spGetTrack();
        if (t) {
          st.spQuery = (t.artist ? t.artist + " " : "") + t.title;
          st.spTitle = t.title;
        }
      }

      // Ensure we have a query for Spotify
      if (SPOTIFY && !st.spQuery) {
        showError("Could not identify the playing track. Play a song and try again.");
        return;
      }

      showProgress();
      const r = SPOTIFY
        ? await send("song", { query: st.spQuery, title: st.spTitle,
            kind: o.kind === "video" ? "video" : "audio-mp3", mp3: o.mp3 || 0, height: o.height || 0 })
        : await send("download", {
            url: o.url || st.url || location.href, kind: o.kind, selector: o.selector || "", mp3: o.mp3 || 0,
            name: st.useName ? ((st.info && st.info.title) || "") : "",
          });
      if (!r.ok) { showError(r.error || "Download failed to start."); return; }
      st.job = { id: r.job };
    }

    jobListeners.add(function onJob(g) {
      if (!st.job || g.job !== st.job.id) return;
      const $id = (i) => shadow.getElementById(i);
      if (g.type === "progress") {
        const p = Math.max(0, Math.min(100, g.pct || 0));
        if ($id("umd-fill")) $id("umd-fill").style.width = p + "%";
        if ($id("umd-pct")) $id("umd-pct").textContent = (Math.round(p * 10) / 10) + "%";
        if ($id("umd-speed")) $id("umd-speed").textContent = g.speed || "\u2014";
        if ($id("umd-eta")) $id("umd-eta").textContent = g.eta || "\u2014";
        if ($id("umd-stage")) $id("umd-stage").textContent = g.stage
          ? (g.stage[0].toUpperCase() + g.stage.slice(1)) + "\u2026"
          : "Downloading\u2026";
      } else if (g.type === "done") {
        st.job = null;
        showDone(g.file, g.path);
        if (g.url) chrome.runtime.sendMessage({ to: "save-file", url: g.url, name: g.file });
      } else if (g.type === "error") {
        st.job = null;
        if (st.phase === "downloading") showError(g.error || "Download failed.");
      }
    });

    // One probe path for the page itself and for pasted links; isPage marks
    // whether SPA navigation should retire the shown options (navWatch).
    async function probeUrl(url, isPage) {
      const my = ++probeSeq;
      showLoading(isPage);
      // A prefetch for this exact target may already be in flight: consume
      // it instead of starting a second probe over the first. A failed
      // prefetch falls through to a fresh probe below.
      let r = null;
      if (inflightProbe && inflightProbe.key === mediaKey(url)) {
        r = await inflightProbe.promise;
        inflightProbe = null;
      }
      if (my !== probeSeq) return; // superseded by a newer probe
      if (!r) {
        const p = probeVia(url, 13000, () => {
          if (my !== probeSeq) return; // a newer probe owns the card now
          const lt = shadow.querySelector(".umd-loadtext");
          if (lt) lt.textContent = isPage
            ? "Still reading this page - this can take up to 45 seconds."
            : "Still reading that link - this can take up to 45 seconds.";
        });
        inflightProbe = { key: mediaKey(url), promise: p };
        r = await p;
        if (inflightProbe && inflightProbe.promise === p) inflightProbe = null;
      }
      if (my !== probeSeq) return; // superseded by a newer probe
      if (st.phase !== "loading") return; // closed or moved on
      if (!r.ok) {
        showError(r.error || "Could not read that link.");
        return;
      }
      st.url = r.resolvedUrl || url;
      st.useName = !!r.useName;
      st.urlIsPage = !!isPage;
      st.info = r.info || {};
      st.options = r.options || [];
      if (!st.options.length) {
        showError(isPage
          ? "The downloader found no downloadable formats on this page."
          : "The downloader found no downloadable formats at that link.");
        return;
      }
      cacheProbe(url, r);
      showReady();
    }

    async function bootSpotify() {
      // Don't show loading screen immediately, as we'll do the track fetch
      // quickly enough to not need a full blocking UI.
      // Or show it, but don't block the UI with an automatic probe if not needed.

      const stt = await new Promise((res) =>
        chrome.runtime.sendMessage({ to: "bridge", cmd: "bridge-state" }, res));
      if (!stt || !stt.connected) { showSetupError((stt && stt.error) || "not connected"); return; }

      const ping = await send("ping", null, 10000);
      if (!ping.ok) { showSetupError(ping.error || "no answer"); return; }

      const t = await spGetTrack();
      if (!t) {
        showLoading(true);
        showError("Play a song first, then open the menu.");
        return;
      }

      st.downloadDir = "your Downloads folder";
      // Delay setting spQuery until download is clicked
      st.spQuery = null;
      st.spTitle = t.title;
      st.url = "spotify:track";
      st.urlIsPage = false; // Important: prevents navWatch from closing the menu since we don't use the page URL
      st.info = { title: t.title, uploader: t.artist, site: "Spotify", thumbnail: t.thumb || "" };
      st.options = MP3_RATES.map((br) => ({ id: "a" + br, kind: "audio-mp3", label: "MP3 " + br + " kbps", mp3: br }))
        .concat([1080, 720, 480, 360].map((h) => ({ id: "v" + h, kind: "video", height: h, label: "Music video " + h + "p" })));

      showReady();
    }

    async function boot() {
      if (SPOTIFY) { await bootSpotify(); return; }
      // Page URL is the primary probe target. A player drop wins only when
      // it resolved to a real link for a DIFFERENT media item than the page;
      // an unreadable player (blob:/MSE-only) never blocks a media page.
      const t = targetOverride;
      let url = location.href, isPage = true;
      if (t && t.url && mediaKey(t.url) !== mediaKey(location.href)) {
        url = t.url; isPage = false;
      } else if (t && t.unresolved && !isMediaPage(location.href)) {
        showLoading(true);
        showError("That player doesn't expose a downloadable link. Open the video's own page and try there.");
        return;
      }
      showLoading(true);
      const stt = await new Promise((res) =>
        chrome.runtime.sendMessage({ to: "bridge", cmd: "bridge-state" }, res));
      if (!stt || !stt.connected) {
        showSetupError((stt && stt.error) || "not connected");
        return;
      }
      const hit = probeCache.get(mediaKey(url));
      if (hit) {
        // Instant path: this page was already probed (prefetch or an earlier
        // open) and the tab has not moved to another video since.
        st.url = hit.url; st.useName = !!hit.useName; st.urlIsPage = isPage;
        st.info = hit.info; st.options = hit.options;
        showReady();
        // Still confirm the helper in the background so a dead bridge and
        // the download dir surface correctly instead of failing at click.
        send("ping", null, 10000).then((ping) => {
          if (st.phase !== "ready" && st.phase !== "downloading") return;
          if (!ping.ok) { showSetupError(ping.error || "no answer"); return; }
          if (ping.download_dir) st.downloadDir = ping.download_dir;
        });
        return;
      }
      // Ping runs in parallel with the probe; it used to add a full round
      // trip before the probe even started.
      const pingP = send("ping", null, 10000);
      probeUrl(url, isPage);
      const ping = await pingP;
      if (!ping.ok) { showSetupError(ping.error || "no answer"); return; }
      if (ping.download_dir) st.downloadDir = ping.download_dir;
    }

    boot();
    requestAnimationFrame(() => {
      backdrop.classList.add("umd-in");
    });
    // docGlass stays hidden through the entrance: a bake taken mid-animation
    // (scale .96 / translateY 8px) leaves the blur offset from the card for
    // the rest of the phase. It appears only after the settle rebake below.
    // After the entrance animation, drop the wrap's identity transform: any
    // non-"none" transform on a glass ancestor makes it a backdrop root and
    // the card's refraction/frost layers would sample an empty backdrop.
    const settleGlass = () => {
      wrap.style.transition = "none"; wrap.style.transform = "none";
      docGlass.style.transition = "none"; docGlass.style.transform = "none";
      applyCardGlass(); // rect changed by the settle: rebake clip + glass geometry
      docGlass.style.opacity = "1";
    };
    wrap.addEventListener("transitionend", settleGlass, { once: true });
    setTimeout(settleGlass, 500); // safety if transitionend is missed
  }
})();
