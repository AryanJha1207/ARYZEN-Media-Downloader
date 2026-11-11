# Liquid glass button regression test

Two layers: a static guard, and a manual visual reproduction in a real browser.

## 1. Static guard (fast, no browser)

    node tests/liquid-glass-regression/guard.js

Checks the wiring that the visual test below depends on: the button stays at
`opacity:1`, the `feDisplacementMap` filter is built, and `backdrop-filter: url()`
is applied. Exit code 1 on any failure.

Why opacity matters: in testing on Chrome 157 (November 2026), setting
`opacity` below 1 on the button made the reference SVG filter stop rendering -
the refraction went flat with no console error. That was observed in that test
setup, not proven as a rule for every Chromium version; the guard pins the
working configuration regardless.

## 2. Visual reproduction (real browser, ~2 minutes)

The point of this test: the refraction must be *seen*, not inferred. A filter
that parses but renders flat passes no assertion; only pixels tell the truth.

1. Build the page-injectable harness (chrome API stub + verbatim content.js):

       node tests/liquid-glass-regression/build-harness.js > /tmp/umd-harness.js

2. Open any page with rich background content (e.g. https://www.ted.com/talks),
   open DevTools console, paste the harness, run it.

3. Inject an alignment grid behind the button:

       (() => {
         const g = document.createElement('div');
         g.style.cssText = 'position:fixed;inset:0;z-index:2147483640;pointer-events:none;' +
           'background-image:repeating-linear-gradient(0deg,rgba(255,0,0,.5) 0 2px,transparent 2px 40px),' +
           'repeating-linear-gradient(90deg,rgba(0,0,255,.5) 0 2px,transparent 2px 40px)';
         document.body.appendChild(g);
       })()

4. Pass: grid lines inside the pill visibly bend/shift relative to outside,
   with a bright rim and slight chromatic fringe. Fail: lines run straight
   through the pill unchanged.

Reference screenshot of a passing run: /downloads/warp-button.png (2026-11-09,
Chrome 157) - kept with the project archive, since repo images would bloat the
extension repo.
