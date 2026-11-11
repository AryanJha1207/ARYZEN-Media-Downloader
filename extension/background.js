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
  "cancel", "open-downloads", "update-engine", "bridge-state"]);
const PAGE_HOSTS = /(^|\.)(youtube\.com|instagram\.com|reddit\.com|twitch\.tv|soundcloud\.com|streamable\.com|ted\.com)$/i;

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
