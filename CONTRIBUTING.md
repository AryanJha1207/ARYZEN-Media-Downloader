# Contributing to ARYZEN Media Downloader

Thanks for helping. This is how to contribute systematically.

## Reporting a bug

Open an Issue with:

- your OS and version, browser and version
- exact steps, what you expected, what happened instead (exact error text
  or a screenshot)
- the bridge log, if the problem involves downloading:
  `~/.universal-media-downloader-rc/bridge/bridge.log` (macOS/Linux) or
  `%LOCALAPPDATA%\universal-media-downloader-rc\bridge\bridge.log` (Windows)

Before posting any log or error text publicly, redact private information:
cookies, tokens, URLs of private or account-linked pages, and personal
folder paths (your username appears in paths like /Users/<name> or
C:\Users\<name>).

## Development setup

- Extension: open `brave://extensions` or `chrome://extensions`, turn on
  Developer mode, Load unpacked, choose the `extension/` folder.
- Bridge + engine: run your OS's installer from `install/`, or check the
  README's install section. Python 3.11+ required (yt-dlp refuses older).
- Tests:
  - `tests/bridge-e2e/` drives the bridge over the real native-messaging
    protocol - run it after any bridge change.
  - `tests/liquid-glass-regression/` guards the glass Download button and
    menu rendering - run it after any `extension/content.js` UI change.

## Project rules (keep these intact)

- Every audio option produces MP3. There is no original-format audio
  passthrough; do not add one without an Issue discussion first.
- The bridge never runs a shell: fixed argument lists, URL passed after a
  `--` separator, selectors and bitrates whitelisted. Keep it that way.
- Only public http(s) URLs; private-network hostnames stay rejected.
- Installers must never touch an existing install or a folder they did
  not create, and must checksum-verify every downloaded binary.
- Honest status: say what you tested and on which OS. Do not mark a
  platform tested in the README unless it really ran there.
- Keep the notices in THIRD_PARTY_NOTICES intact when touching ported
  code (the liquid-glass refraction port, IBM Plex Sans).

## Pull requests

- One change per PR. Describe the before/after and list exactly what you
  tested, on which OS and browser.
- Don't bump a pinned dependency (yt-dlp, FFmpeg, the macOS Python
  runtime) without updating its pinned SHA-256 in the same PR.
- By opening a PR you agree your contribution is licensed under the
  project's MIT license (see LICENSE).
