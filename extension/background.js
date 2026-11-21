// ARYZEN Media Downloader - background service worker.
// Sole job: relay messages between the popup and the local bridge
// (native messaging host "com.umd.bridge.rc") and remember job state
// so the popup can re-attach after being closed.

const HOST = "com.umd.bridge.rc";
let port = null;
let bridgeError = null;
let seq = 0;

// Only these commands may ever reach the helper, and page (content script)
// senders are accepted only from the sites the Download button is declared
// for in the manifest. Web pages themselves cannot message this extension
// (no externally_connectable), so every page-side command also requires a
// real click on our own button inside our own content script.
const ALLOWED_CMDS = new Set(["ping", "versions", "probe", "download",
  "cancel", "song", "open-downloads", "open-downloads-tab", "update-engine", "bridge-state",
  "discard-staged"]);
const PAGE_HOSTS = /(^|\.)(youtube\.com|instagram\.com|reddit\.com|twitch\.tv|soundcloud\.com|spotify\.com|streamable\.com|ted\.com)$/i;

let keepalive = null;
const pending = new Set();
// Tabs running the in-page overlay (content scripts). Runtime broadcasts do
// not reach content scripts, so bridge events are also pushed to these tabs
// with tabs.sendMessage; the content script filters by request/job id.
const umdTabs = new Set();

function broadcastUmd(msg) {
  chrome.runtime.sendMessage({ umd: msg }).catch(() => {});
  for (const t of umdTabs) {
    chrome.tabs.sendMessage(t, { umd: msg }).catch(() => umdTabs.delete(t));
  }
}

function failPending(reason) {
  for (const id of pending) {
    broadcastUmd({ id, type: "error", error: reason });
  }
  pending.clear();
}

function ensurePort() {
  if (port) return true;
  bridgeError = null;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    bridgeError = String(e && e.message ? e.message : e);
    port = null;
    return false;
  }
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.id) pending.delete(msg.id);
    if (msg.type === "progress" || msg.type === "done" || msg.type === "error") {
      if (msg.job) chrome.storage.session.set({ ["job:" + msg.job]: msg });
    }
    broadcastUmd(msg);
  });
  port.onDisconnect.addListener(() => {
    bridgeError = chrome.runtime.lastError
      ? chrome.runtime.lastError.message
      : "Local helper disconnected.";
    port = null;
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
    failPending("The local helper stopped unexpectedly (" + bridgeError + "). Run the installer again, then restart your browser.");
  });
  // Chrome documentation: an open connectNative() port keeps this service
  // worker alive, and sending a message resets its idle timer. The ping every
  // 20s is cheap insurance on top of that documented behavior.
  keepalive = setInterval(() => {
    try { if (port) port.postMessage({ id: "ka-" + Date.now(), cmd: "ping" }); }
    catch (e) {}
  }, 20000);
  return true;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  umdTabs.delete(tabId);
  try { chrome.storage.session.remove("umdDestTab:" + tabId); } catch (e) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.to === "save-file") {
    const ok = sender && sender.tab && /^http:\/\/127\.0\.0\.1:\d+\/[\w-]+$/.test(msg.url || "");
    if (!ok) { sendResponse({ ok: false }); return false; }
    let fname = String(msg.name || "song.mp3").replace(/[\\/:*?"<>|]/g, "_");
    // Optional subfolder inside the browser's download directory
    // ("AMD/Reddit"): relative only, no traversal, no absolute paths.
    const sub = String(msg.subdir || "").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
    if (sub) {
      if (!/^[\w .()\-]+(\/[\w .()\-]+)*$/.test(sub) || sub.includes("..")) {
        sendResponse({ ok: false, error: "Bad destination folder." });
        return false;
      }
      fname = sub + "/" + fname;
    }
    chrome.downloads.download({ url: msg.url, filename: fname, conflictAction: "uniquify", saveAs: !!msg.saveAs },
      (id) => {
        sendResponse({ ok: !!id, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
        // Destination history is written only when the file has actually
        // finished saving - never on selection, start, or failure. The
        // staged-cleanup signal rides the same completion watch, so the
        // listener registers even without a label ("Ask each time" saves).
        const label = String(msg.label || "");
        const hasJob = !!String(msg.job || "");
        if (!id || (!label && !hasJob)) return;
        const onChanged = (d) => {
          if (d.id !== id || !d.state) return;
          if (d.state.current !== "complete" && d.state.current !== "interrupted") return;
          chrome.downloads.onChanged.removeListener(onChanged);
          if (d.state.current !== "complete") return;
          if (label) try {
            chrome.storage.local.get(["umdDests"], (rr) => {
              const list = [label].concat(((rr && rr.umdDests) || []).filter((x) => x !== label)).slice(0, 8);
              chrome.storage.local.set({ umdDests: list });
            });
          } catch (e) {}
          // The browser has its copy; the helper's staged copy can go. An
          // interrupted save keeps the staged file (24h sweep owns it), so a
          // fresh retry of the whole download is never the only way back.
          const job = String(msg.job || "");
          if (job) {
            try {
              if (ensurePort()) {
                port.postMessage({ to: "bridge", cmd: "discard-staged", job: job,
                                   id: "r" + Date.now().toString(36) + "-" + (++seq) });
              }
            } catch (e) {}
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      });
    return true;
  }
  // Per-tab destination state: a custom folder chosen in one tab survives
  // page reloads and SPA navigation in THAT tab only, and is wiped when the
  // tab closes. Tabs never see each other's choice.
  if (msg && msg.to === "umd-dest-get") {
    const tid = sender && sender.tab && sender.tab.id;
    if (typeof tid !== "number") { sendResponse({ ok: false }); return false; }
    chrome.storage.session.get(["umdDestTab:" + tid], (r) => {
      sendResponse({ ok: true, state: (r && r["umdDestTab:" + tid]) || null });
    });
    return true;
  }
  if (msg && msg.to === "umd-dest-set") {
    const tid = sender && sender.tab && sender.tab.id;
    if (typeof tid !== "number") { sendResponse({ ok: false }); return false; }
    const st = msg.state && typeof msg.state === "object"
      ? { dest: String(msg.state.dest || "").slice(0, 300), saveAsOnce: !!msg.state.saveAsOnce }
      : { dest: "", saveAsOnce: false };
    chrome.storage.session.set({ ["umdDestTab:" + tid]: st }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.cmd === "open-downloads-tab") {
    chrome.tabs.create({ url: "chrome://downloads" });
    sendResponse({ ok: true });
    return true;
  }
  if (!msg || msg.to !== "bridge") return false;
  if (!ALLOWED_CMDS.has(msg.cmd)) {
    sendResponse({ ok: false, error: "Unknown request." });
    return false;
  }
  if (sender && sender.tab && typeof sender.tab.id === "number") {
    let pageHost = "";
    try { pageHost = new URL(sender.url || sender.tab.url || "").hostname || ""; } catch (e) {}
    if (!PAGE_HOSTS.test(pageHost)) {
      sendResponse({ ok: false, error: "This page is not supported by the downloader button." });
      return false;
    }
    umdTabs.add(sender.tab.id);
  }
  if (msg.cmd === "bridge-state") {
    sendResponse({ ok: true, connected: ensurePort(), error: bridgeError });
    return false;
  }
  if (!ensurePort()) {
    sendResponse({ ok: false, error: bridgeError || "Local helper is not available." });
    return false;
  }
  const id = "r" + Date.now().toString(36) + "-" + ++seq;
  try {
    port.postMessage(Object.assign({}, msg, { id }));
    pending.add(id);
    sendResponse({ ok: true, id });
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  }
  return false;
});
