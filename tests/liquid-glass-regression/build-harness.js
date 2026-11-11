#!/usr/bin/env node
// Builds the page-injectable preview harness: a minimal chrome.* stub followed
// by the verbatim extension/content.js, so the button can be previewed on any
// page without loading the extension. Run from the repo root:
//   node tests/liquid-glass-regression/build-harness.js > /tmp/umd-harness.js
const fs = require('fs');
const path = require('path');
const stub = `
// Minimal chrome.* stub for harness preview (not part of the extension).
window.chrome = window.chrome || {};
chrome.runtime = chrome.runtime || {
  id: 'harness',
  sendMessage: (m, cb) => { if (cb) cb({ ok: false, error: 'harness: no bridge' }); },
  onMessage: { addListener: () => {} },
  getURL: (p) => p,
};
chrome.storage = chrome.storage || {
  sync: { get: (k, cb) => cb({}), set: (v, cb) => cb && cb() },
  local: { get: (k, cb) => cb({}), set: (v, cb) => cb && cb() },
  onChanged: { addListener: () => {} },
};
`;
const content = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'content.js'), 'utf8');
process.stdout.write(stub + '\n' + content);
