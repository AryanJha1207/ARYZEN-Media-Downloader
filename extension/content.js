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
  ];
  const host = (location.hostname || "").toLowerCase();
  const site = SITES.find((s) => s.re.test(host)) ||
    { name: host.replace(/^www\./, ""), accent: "#4f8cff" };
  const isYTWatch = /(^|\.)youtube\.com$/.test(host) && location.pathname === "/watch";

  // ------------------------------------------------------- bridge messaging
  // Same request/response contract as the toolbar popup: a command gets an
  // immediate ack {ok, id}; the real answer arrives later as {umd: {...}}
  // with a matching id. Events (progress/done/error) carry the job id.
  function send(cmd, extra, timeoutMs) {
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
          const timer = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(onMsg);
            resolve({ ok: false, error: "No answer from the local helper. Open the extension popup and click Check; if it repeats, run the installer again and restart your browser." });
          }, timeoutMs || 15000);
          function onMsg(m) {
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
  const CARD_TAB_W = 196, CARD_RISE = 30, CARD_SHOULDER = 34, CARD_R = 20, CARD_TAB_R = 13;
  function umdCardShape(W, H) {
    const R = CARD_R, T = CARD_TAB_R, tw = CARD_TAB_W, y0 = CARD_RISE, sh = CARD_SHOULDER;
    const pts = [];
    function arc(cx, cy, r, a0, a1) {
      const n = 4;
      for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * i / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
    arc(R, y0 + R, R, Math.PI, Math.PI * 1.5);        // main top-left corner
    pts.push([W - tw - sh, y0]);                       // top edge to the shoulder
    pts.push([W - tw, T]);                             // angled shoulder up
    arc(W - tw + T, T, T, Math.PI, Math.PI * 1.5);     // tab top-left corner
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
        b.style.transform = "none"; // drop the hover lift while dragging
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
        b.style.transform = b.matches(":hover") ? "translateY(-2px) scale(1.04)" : "";
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
    openOverlay();
  };
    return b;
  }

  function ensureButton() {
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
  window.addEventListener("yt-navigate-finish", () => setTimeout(ensureButton, 400));
  window.addEventListener("spfdone", () => setTimeout(ensureButton, 400));

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
      color: #f2f4f8;
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
    .umd-cardshadowshape {
      position: absolute; inset: 0; display: block;
      background: rgba(4,6,10,.34);
    }
    /* Layered liquid glass, same recipe as the Download pill: a refraction
       layer (SVG displacement of the page behind), tint, top light cap and a
       silhouette rim. The card's clip-path cuts everything to the raised
       top-right silhouette. */
    .umd-cardlayer { position: absolute; inset: 0; display: block; pointer-events: none; }
    /* The actual frost + refraction lives on a document-level sibling (see
       docGlass in openOverlay): in the Chrome build tested 2026-11-11,
       backdrop-filter: url() did not render on shadow-tree elements. */
    .umd-cardtint {
      background: linear-gradient(155deg, rgba(255,255,255,.16), rgba(255,255,255,.02) 32%, rgba(96,140,255,.08) 70%, rgba(160,190,255,.05));
    }
    .umd-cardcap {
      background: linear-gradient(180deg, rgba(255,255,255,.20), rgba(255,255,255,.03) 30%, transparent 55%);
    }
    .umd-cardrim { position: absolute; inset: 0; display: block; pointer-events: none; filter: drop-shadow(0 0 7px rgba(255,255,255,.38)); }
    .umd-content { position: relative; z-index: 1; display: flex; flex-direction: column; max-height: inherit; }
    .umd-backdrop.umd-in .umd-cardwrap { transform: scale(1) translateY(0); opacity: 1; }
    .umd-head {
      display: flex; align-items: center; gap: 10px;
      /* the 30px top margin keeps this row below the card's raised tab */
      margin-top: 30px;
      padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,.10);
      background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.01));
    }
    .umd-brand {
      /* sits at the START (left end) of the raised top-right tab, just past
         the angled shoulder; the Mac-style close button caps the tab's right */
      position: absolute; top: 4px; left: calc(100% - 158px); z-index: 2;
      display: flex; align-items: center; gap: 7px; height: 24px;
    }
    .umd-brand img { height: 20px; width: auto; display: block; }
    .umd-brandname {
      font-size: 13px; font-weight: 700; letter-spacing: .22em; color: #fff;
      text-shadow: 0 1px 4px rgba(0,0,0,.55), 0 0 10px rgba(0,0,0,.3);
    }
    .umd-chip img { width: 14px; height: 14px; border-radius: 3px; }
    .umd-headtitle { font-size: 16px; font-weight: 700; letter-spacing: .01em; color: #eef1f7; flex: 1; text-shadow: 0 1px 3px rgba(0,0,0,.5), 0 0 10px rgba(0,0,0,.28); }
    .umd-x {
      /* macOS traffic-light close: red dot at the right end of the raised
         tab; the glyph fades in on hover like the real thing */
      position: absolute; top: 9px; right: 15px; z-index: 2;
      width: 15px; height: 15px; padding: 0; border-radius: 50%; border: 0; cursor: pointer;
      background: #ff5f57; color: rgba(0,0,0,0);
      font-size: 11px; font-style: normal; font-weight: 700; line-height: 15px; text-align: center;
      box-shadow: inset 0 0 0 .5px rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.18);
      transition: background .12s ease, color .12s ease;
    }
    .umd-cardwrap:hover .umd-x { color: rgba(96,4,0,.8); }
    .umd-x:hover { background: #ff3b30; }
    .umd-body { padding: 18px; overflow-y: auto; }
    .umd-main { display: flex; gap: 18px; }
    .umd-left { width: 254px; flex: none; }
    .umd-thumbwrap {
      position: relative; width: 254px; height: 143px; border-radius: 12px; overflow: hidden;
      background: linear-gradient(135deg, rgba(255,255,255,.10), rgba(255,255,255,.03));
      border: 1px solid rgba(255,255,255,.12);
      display: flex; align-items: center; justify-content: center;
    }
    .umd-thumbwrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .umd-thumbph {
      width: 52px; height: 52px; border-radius: 14px; background: ACCENT33;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; font-weight: 800; color: #fff;
    }
    .umd-dur {
      position: absolute; right: 7px; bottom: 7px;
      background: rgba(0,0,0,.78); color: #fff; font-size: 11px; font-weight: 600;
      padding: 2px 7px; border-radius: 6px;
    }
    .umd-title {
      margin-top: 11px; font-size: 15px; font-weight: 700; letter-spacing: -.005em; line-height: 1.35; color: #f5f7fb; text-shadow: 0 1px 3px rgba(0,0,0,.5), 0 0 10px rgba(0,0,0,.28);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .umd-uploader { margin-top: 4px; font-size: 13px; font-weight: 500; color: #c3cbda; text-shadow: 0 1px 3px rgba(0,0,0,.45), 0 0 8px rgba(0,0,0,.25); }
    .umd-right { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .umd-label { font-size: 11.5px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #ccd4e3; text-shadow: 0 1px 3px rgba(0,0,0,.45), 0 0 8px rgba(0,0,0,.25); margin-bottom: 7px; }
    .umd-selectwrap { position: relative; }
    .umd-selectwrap::after {
      content: ""; position: absolute; right: 14px; top: 50%; width: 8px; height: 8px;
      border-right: 2px solid #bcc4d5; border-bottom: 2px solid #bcc4d5;
      transform: translateY(-70%) rotate(45deg); pointer-events: none;
    }
    select.umd-quality {
      width: 100%; appearance: none; -webkit-appearance: none;
      background: rgba(255,255,255,.07); color: #eef1f7; border: 1px solid rgba(255,255,255,.18);
      border-radius: 10px; padding: 11px 36px 11px 13px; font-size: 14.5px; font-weight: 650; text-shadow: 0 1px 3px rgba(0,0,0,.45);
      cursor: pointer; outline: none; transition: border-color .15s ease, box-shadow .15s ease;
      font-family: inherit;
    }
    select.umd-quality:hover { border-color: ACCENT88; }
    select.umd-quality:focus { border-color: ACCENT; box-shadow: 0 0 0 3px ACCENT33; }
    .umd-save {
      margin-top: 13px; display: flex; align-items: center; gap: 8px;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.17);
      border-radius: 10px; padding: 9px 12px;
      font-size: 13px; color: #d4dbe8; text-shadow: 0 1px 3px rgba(0,0,0,.45), 0 0 8px rgba(0,0,0,.25); min-width: 0;
    }
    .umd-save svg { flex: none; }
    .umd-save span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .umd-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 14px 18px; border-top: 1px solid rgba(255,255,255,.10);
      background: linear-gradient(0deg, rgba(255,255,255,.045), rgba(255,255,255,.01));
    }
    .umd-footnote { font-size: 12px; font-weight: 600; color: #d3d9e6; text-shadow: 0 1px 3px rgba(0,0,0,.45), 0 0 8px rgba(0,0,0,.25); }
    .umd-actions { display: flex; gap: 10px; }
    .umd-btn {
      border: 0; border-radius: 10px; cursor: pointer; font-family: inherit;
      font-size: 14px; font-weight: 700; padding: 10px 20px;
      transition: transform .12s ease, filter .15s ease, box-shadow .15s ease;
    }
    .umd-btn:active { transform: scale(.97); }
    /* keyboard focus: soft accent ring instead of the browser's default
       black/white outline (we autofocus the primary button on open) */
    .umd-btn:focus:not(:focus-visible) { outline: none; }
    .umd-btn:focus-visible { outline: 2px solid ACCENTcc; outline-offset: 2px; }
    .umd-ghost { background: rgba(255,255,255,.08); color: #dde3ee; border: 1px solid rgba(255,255,255,.10); }
    .umd-ghost:hover { background: rgba(255,255,255,.15); color: #fff; }
    .umd-primary {
      /* liquid-glass primary: translucent accent tint over the glass, bright
         inset rim on top, soft accent glow - keeps the site color identity
         without the flat solid fill */
      background: linear-gradient(180deg, ACCENT66, ACCENT44); color: #fff;
      border: 1px solid ACCENT55;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.38), inset 0 -1px 0 rgba(0,0,0,.10), 0 4px 16px ACCENT33;
      text-shadow: 0 1px 2px rgba(0,0,0,.35);
      display: inline-flex; align-items: center; gap: 8px;
    }
    .umd-primary:hover { filter: brightness(1.15); box-shadow: inset 0 1px 0 rgba(255,255,255,.45), inset 0 -1px 0 rgba(0,0,0,.10), 0 6px 22px ACCENT55; }
    .umd-primary:disabled { opacity: .45; cursor: default; filter: none; box-shadow: none; }
    /* loading skeleton */
    .umd-skel {
      border-radius: 10px;
      background: linear-gradient(90deg, #1b1f2b 25%, #232838 45%, #1b1f2b 65%);
      background-size: 220% 100%; animation: umd-shimmer 1.3s linear infinite;
    }
    @keyframes umd-shimmer { 0% { background-position: 130% 0; } 100% { background-position: -90% 0; } }
    .umd-loading { display: flex; flex-direction: column; align-items: center; gap: 13px; padding: 26px 0 20px; }
    .umd-spin {
      width: 34px; height: 34px; border-radius: 50%;
      border: 3px solid rgba(255,255,255,.12); border-top-color: ACCENT;
      animation: umd-rot .8s linear infinite;
    }
    @keyframes umd-rot { to { transform: rotate(360deg); } }
    .umd-loadtext { font-size: 13px; color: #9aa3b2; }
    /* progress state */
    .umd-prog { padding: 8px 2px 2px; }
    .umd-pctrow { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
    .umd-pct { font-size: 34px; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
    .umd-stage { font-size: 12px; color: #9aa3b2; }
    .umd-bar {
      height: 12px; border-radius: 999px; overflow: hidden;
      background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12);
    }
    .umd-fill {
      height: 100%; width: 0%; border-radius: 999px;
      background: linear-gradient(90deg, ACCENTBB, ACCENT 55%, ACCENTBB);
      background-size: 200% 100%;
      animation: umd-flow 1.4s linear infinite;
      transition: width .3s ease;
      box-shadow: 0 0 14px ACCENT88;
      position: relative;
    }
    .umd-fill::after {
      content: ""; position: absolute; inset: 0;
      background: repeating-linear-gradient(115deg, rgba(255,255,255,.16) 0 8px, transparent 8px 16px);
      animation: umd-stripes .7s linear infinite;
    }
    @keyframes umd-flow { 0% { background-position: 0% 0; } 100% { background-position: -200% 0; } }
    @keyframes umd-stripes { 0% { transform: translateX(0); } 100% { transform: translateX(22.6px); } }
    .umd-stats { display: flex; gap: 18px; margin-top: 13px; }
    .umd-stat { flex: 1; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.11); border-radius: 10px; padding: 9px 12px; }
    .umd-stat .k { font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #6f7789; }
    .umd-stat .v { font-size: 14px; font-weight: 700; color: #eef1f7; margin-top: 2px; font-variant-numeric: tabular-nums; }
    /* done state */
    .umd-done { display: flex; flex-direction: column; align-items: center; padding: 22px 0 14px; }
    .umd-checkwrap { position: relative; width: 86px; height: 86px; margin-bottom: 14px; }
    .umd-checkring {
      position: absolute; inset: 0; border-radius: 50%;
      background: ACCENT22; border: 1.5px solid ACCENT66;
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
      border-radius: 10px; background: rgba(22,26,36,.9); border: 1px solid rgba(255,255,255,.22);
      display: flex; align-items: center; justify-content: center; overflow: hidden;
      animation: umd-pop .5s .3s cubic-bezier(.2,1.6,.4,1) both;
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .umd-sitelogo img { width: 22px; height: 22px; border-radius: 5px; }
    @keyframes umd-pop { 0% { transform: scale(.3); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
    .umd-donetitle { font-size: 19px; font-weight: 700; letter-spacing: -.01em; }
    .umd-donefile { margin-top: 5px; font-size: 12.5px; color: #9aa3b2; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* error state */
    .umd-err { padding: 18px 2px 6px; }
    .umd-errbox {
      background: rgba(255, 82, 82, .08); border: 1px solid rgba(255, 82, 82, .25);
      border-radius: 12px; padding: 13px 15px; font-size: 13px; line-height: 1.5; color: #ffb4ab;
    }
    @media (prefers-reduced-motion: reduce) {
      .umd-fill, .umd-fill::after, .umd-spin, .umd-skel { animation: none !important; }
      .umd-backdrop, .umd-card, .umd-fill { transition: none !important; }
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

  function openOverlay() {
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
      "background:linear-gradient(180deg, rgba(14,20,42,.08), rgba(11,16,36,.34));opacity:0;transform:scale(.96) translateY(8px);" +
      "transition:opacity .22s ease, transform .24s cubic-bezier(.2,.9,.25,1.1);";
    const card = el("div", "umd-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Download this media");
    // Liquid-glass layers sit behind the content; the silhouette rim is an
    // SVG outline of the exact card polygon, rebuilt whenever the size changes.
    const cardTint = el("i", "umd-cardlayer umd-cardtint");
    const cardCap = el("i", "umd-cardlayer umd-cardcap");
    const cardRim = el("i", "umd-cardrim");
    for (const l of [cardTint, cardCap, cardRim]) l.setAttribute("aria-hidden", "true");
    const content = el("div", "umd-content");
    card.append(cardTint, cardCap, cardRim, content);
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
    };

    function close() {
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
        const f = card.querySelectorAll('button, select, [tabindex]:not([tabindex="-1"])');
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
    // progress params), so compare the media identity, not the raw href.
    const mediaKey = (u) => {
      try {
        const x = new URL(u);
        let k = x.origin + x.pathname;
        const v = x.searchParams.get("v");
        if (v) k += "?v=" + v; // YouTube identifies videos by ?v=
        return k;
      } catch (e) { return u; }
    };
    const navWatch = setInterval(() => {
      if (st.url && mediaKey(location.href) !== mediaKey(st.url)) close();
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
    const x = el("button", "umd-x", "\u00d7");
    x.setAttribute("aria-label", "Close");
    x.onclick = () => { if (st.phase === "downloading") cancelJob(); else close(); };
    card.appendChild(x); // Mac-style close caps the right end of the raised tab
    head.append(ht);

    const body = el("div", "umd-body");
    const foot = el("div", "umd-foot");
    content.append(head, body, foot);

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
    function showLoading() {
      st.phase = "loading";
      body.innerHTML = "";
      const w = el("div", "umd-loading");
      w.append(el("div", "umd-spin"), el("div", "umd-loadtext", "Reading this page\u2026"));
      body.appendChild(w);
      renderFoot("Checking what the local engine can fetch", []);
    }

    function showSetupError(msg) {
      st.phase = "setup";
      body.innerHTML = "";
      const w = el("div", "umd-err");
      w.appendChild(el("div", "umd-errbox",
        "The local helper is not answering (" + msg + "). Run the installer for your system, restart your browser, then click the Download button again."));
      body.appendChild(w);
      renderFoot("", [ghostBtn("Close", close)]);
    }

    function showError(msg) {
      st.phase = "error";
      body.innerHTML = "";
      const w = el("div", "umd-err");
      w.appendChild(el("div", "umd-errbox", msg || "Something went wrong."));
      body.appendChild(w);
      renderFoot("", [ghostBtn("Close", close), primaryBtn("Try again", boot)]);
    }

    function showReady() {
      st.phase = "ready";
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
      right.appendChild(el("div", "umd-label", "Quality / type"));
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
        '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="#bcc4d5" stroke-width="1.7" stroke-linejoin="round"/></svg>';
      save.appendChild(el("span", "", "Saves to " + st.downloadDir));
      right.appendChild(save);

      main.append(left, right);
      body.appendChild(main);

      const dl = primaryBtn("Download", () => startDownload(sel));
      renderFoot(st.options.length + " formats found", [ghostBtn("Cancel", close), dl]);
      dl.focus({ focusVisible: false }); // autofocus for Enter-to-download without showing the ring; the styled :focus-visible ring still appears on real Tab navigation
    }

    function placeholder() {
      return el("div", "umd-thumbph", (site.name[0] || "U").toUpperCase());
    }

    function showProgress() {
      st.phase = "downloading";
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
        '<div class="umd-stat"><div class="k">ETA</div><div class="v" id="umd-eta">\u2014</div></div>' +
        '<div class="umd-stat"><div class="k">Saving to</div><div class="v" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="umd-dest">' +
        st.downloadDir.replace(/</g, "&lt;") + "</div></div>";
      w.append(row, bar, stats);
      body.appendChild(w);
      renderFoot("", [ghostBtn("Cancel download", cancelJob)]);
    }

    function showDone(file) {
      st.phase = "done";
      body.innerHTML = "";
      const w = el("div", "umd-done");
      const cw = el("div", "umd-checkwrap");
      const ring = el("div", "umd-checkring");
      ring.innerHTML =
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M4.5 12.5l5 5 10-11" stroke="' + site.accent + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const lg = el("div", "umd-sitelogo");
      const li = document.createElement("img");
      li.src = faviconUrl(); li.alt = site.name; li.onerror = () => li.remove();
      lg.appendChild(li);
      cw.append(ring, lg);
      w.append(cw, el("div", "umd-donetitle", "Download complete"),
               el("div", "umd-donefile", file || "Saved to " + st.downloadDir));
      body.appendChild(w);
      renderFoot("Closing\u2026", [ghostBtn("Close now", close)]);
      setTimeout(() => { if (st.phase === "done") close(); }, 3400);
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
      showProgress();
      const r = await send("download", {
        url: st.url || location.href, kind: o.kind, selector: o.selector || "", mp3: o.mp3 || 0,
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
        showDone(g.file);
      } else if (g.type === "error") {
        st.job = null;
        if (st.phase === "downloading") showError(g.error || "Download failed.");
      }
    });

    async function boot() {
      showLoading();
      const stt = await new Promise((res) =>
        chrome.runtime.sendMessage({ to: "bridge", cmd: "bridge-state" }, res));
      if (!stt || !stt.connected) {
        showSetupError((stt && stt.error) || "not connected");
        return;
      }
      const ping = await send("ping", null, 10000);
      if (!ping.ok) { showSetupError(ping.error || "no answer"); return; }
      if (ping.download_dir) st.downloadDir = ping.download_dir;
      const pageUrl = location.href;
      const r = await send("probe", { url: pageUrl }, 13000);
      if (!r.ok) { showError(r.error || "Could not read that link."); return; }
      st.url = pageUrl;
      st.info = r.info || {};
      st.options = r.options || [];
      if (!st.options.length) { showError("The downloader found no downloadable formats on this page."); return; }
      showReady();
    }

    boot();
    requestAnimationFrame(() => {
      backdrop.classList.add("umd-in");
      docGlass.style.opacity = "1";
      docGlass.style.transform = "scale(1) translateY(0)";
    });
    // After the entrance animation, drop the wrap's identity transform: any
    // non-"none" transform on a glass ancestor makes it a backdrop root and
    // the card's refraction/frost layers would sample an empty backdrop.
    const settleGlass = () => {
      wrap.style.transition = "none"; wrap.style.transform = "none";
      docGlass.style.transition = "none"; docGlass.style.transform = "none";
    };
    wrap.addEventListener("transitionend", settleGlass, { once: true });
    setTimeout(settleGlass, 500); // safety if transitionend is missed
  }
})();
