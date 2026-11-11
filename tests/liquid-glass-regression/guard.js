#!/usr/bin/env node
// Static guard for the liquid glass button. Run: node tests/liquid-glass-regression/guard.js
// Fails (exit 1) if the refraction wiring regresses. Keep in sync if content.js is refactored.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'content.js'), 'utf8');

const checks = [
  ['button keeps opacity:1 (observed in Chrome 157 testing: opacity < 1 stopped the url() backdrop filter rendering)',
    /"opacity:1;transition:transform/.test(src)],
  ['no other opacity on the button cssText (scrim/modal/card opacity elsewhere is fine)',
    !/b\.style\.cssText[\s\S]*?opacity:\s*0?\.\d/.test(src.split('Refraction layer')[0])],
  ['feDisplacementMap displacement filter is built',
    /feDisplacementMap/.test(src)],
  ['backdrop-filter url() is applied to the refraction layer',
    /backdrop-filter:\s*url\(/.test(src) || /backdropFilter/.test(src)],
];

let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) fail = 1;
}
process.exit(fail);
