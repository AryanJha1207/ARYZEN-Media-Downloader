<div align="center">

<img src="assets/icon.png" width="150" alt="ARYZEN Media Downloader app icon" />

<img src="assets/hero.svg" width="100%" alt="ARYZEN Media Downloader - download videos and audio right from the page" />

<br />

<img src="https://img.shields.io/badge/release-candidate-22d3ee?style=for-the-badge&labelColor=0b1030" alt="Release candidate" />
<img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-3b82f6?style=for-the-badge&labelColor=0b1030" alt="macOS, Windows, Linux" />
<img src="https://img.shields.io/badge/engine-yt--dlp-8b5cf6?style=for-the-badge&labelColor=0b1030" alt="Powered by yt-dlp" />
<img src="https://img.shields.io/badge/license-MIT-a855f7?style=for-the-badge&labelColor=0b1030" alt="MIT License" />

<br /><br />

**[Features](#features)** &nbsp;·&nbsp; **[How it works](#how-it-works)** &nbsp;·&nbsp; **[Install](#install)** &nbsp;·&nbsp; **[Security](#security-model-and-its-limits)** &nbsp;·&nbsp; **[Status](#tested-vs-untested)** &nbsp;·&nbsp; **[Credits](#credits)**

</div>

<br />

Click the floating glass button on a supported video site, pick a quality (or MP3), and the file lands in your Downloads folder. Built by **Aryzen Nex** on top of [yt-dlp](https://github.com/yt-dlp/yt-dlp), with huge credit to the yt-dlp team and contributors. This project wraps their engine in a browser extension and a small local bridge.

<img src="assets/divider.svg" width="100%" alt="" />

## Features

<img src="assets/features.svg" width="100%" alt="One-click download, pick your quality, MP3 your way, local and private" />

<br />

Supported sites: **YouTube · Instagram · Reddit · Twitch · SoundCloud · Streamable · TED**

<img src="assets/divider.svg" width="100%" alt="" />

## How it works

<img src="assets/flow.svg" width="100%" alt="Extension to native messaging to local bridge to yt-dlp and FFmpeg to your Downloads folder" />

<br />

- A **browser extension** adds the Download button and quality picker to the supported sites.
- A tiny **local bridge** (`bridge/umd_host.py`) talks to the extension through native messaging and runs yt-dlp for you.
- **yt-dlp** fetches the media; **FFmpeg** merges video and audio and converts to MP3.

Everything runs locally on your machine. No accounts, no servers, no tracking.

<img src="assets/divider.svg" width="100%" alt="" />

## Install

### 1. Prerequisites

| OS | What you need first |
| :-- | :-- |
| **macOS** | Nothing. The installer bundles a standalone Python runtime and FFmpeg, both checksum-verified. |
| **Windows** | Python 3.11+ on your PATH (python.org, tick "Add python.exe to PATH"). Current yt-dlp releases refuse to run on older Python (verified against yt-dlp 2026.10.26 on Python 3.10). FFmpeg and FFprobe are downloaded and checksum-verified by the installer. |
| **Linux** | `python3` 3.11+, `curl`, and `ffmpeg` (which includes `ffprobe`) from your package manager. The installer downloads no FFmpeg, because no static-build source we found publishes checksums; your distro's package is signature-verified. |

<details>
<summary><b>Linux package commands</b></summary>

<br />

```sh
# Debian / Ubuntu
sudo apt install python3 curl ffmpeg

# Fedora
sudo dnf install python3 curl ffmpeg

# Arch
sudo pacman -S python curl ffmpeg
```

</details>

### 2. Get the code

The easiest route is this repository's **Releases** page: download the ZIP for your OS (Mac Apple Silicon, Mac Intel, Windows, or Linux), unzip it, and run the installer file inside (double-click on macOS and Windows; on Linux use the .desktop launcher or run the .sh in a terminal - desktop double-click support varies by distribution).

To install from this source tree instead, use **Code -> Download ZIP** (or `git clone`) and run your OS's installer script from the repo root:

<table>
<tr>
<td width="33%" valign="top">

**macOS**

```sh
sh install/install-macos.sh
```

</td>
<td width="33%" valign="top">

**Linux**

```sh
sh install/install-linux.sh
```

</td>
<td width="34%" valign="top">

**Windows**

```powershell
powershell -ExecutionPolicy Bypass `
  -File install\install-windows.ps1
```

</td>
</tr>
</table>

### 3. Load the extension (one manual step, all OSes)

The installer creates a folder named `ARYZEN Media Downloader` on your Desktop. That folder **is** the extension (`manifest.json` at its root). You can move it anywhere before importing, and the installer prints these same steps when it finishes.

1. Open `brave://extensions` or `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and choose that `ARYZEN Media Downloader` folder (wherever you moved it)
4. Open a supported site (YouTube, Instagram, Reddit, Twitch, SoundCloud, Streamable, TED) and look for the glass Download button

<details>
<summary><b>Isolation and coexistence</b> - how this release candidate stays apart from any existing install</summary>

<br />

This release candidate is deliberately installed **apart from any existing ARYZEN Media Downloader setup**:

- It installs only to `~/.universal-media-downloader-rc` (macOS/Linux) or `%LOCALAPPDATA%\universal-media-downloader-rc` (Windows). It refuses to touch any folder it did not create, and it creates no backup clutter.
- It registers only the native-messaging host **`com.umd.bridge.rc`** - a different name from the original app's `com.umd.bridge` - so an existing install's registration and absolute paths keep working exactly as they are.
- The RC extension only allows its own pinned extension ID.

**Switching from the October 2026 install is a separate, deliberate decision**: load the RC extension, verify it works for you, then remove the old extension from `brave://extensions`, delete the old `~/universal-media-downloader` folder, and delete the old `com.umd.bridge.json` native-messaging manifests. No installer step does this for you.

</details>

<img src="assets/divider.svg" width="100%" alt="" />

## Download verification

What is checked, and what is not:

| Component | Where it comes from | Integrity check |
| :-- | :-- | :-- |
| **yt-dlp** (all OSes) | github.com/yt-dlp/yt-dlp | SHA-256 verified at install time against the official release checksums. The bridge's built-in updater verifies the same way. |
| **Python runtime** (macOS) | astral-sh/python-build-standalone | Version-pinned, SHA-256 verified at install time. |
| **FFmpeg** (macOS) | ffmpeg.martin-riedl.de | Version-pinned build (9.0.2), SHA-256 verified at install time. Checksums carried from the author's tested October 2026 installer. |
| **FFmpeg + FFprobe** (Windows) | gyan.dev | SHA-256 verified at install time against the publisher's published checksum. |
| **FFmpeg + FFprobe** (Linux) | your distro only | Verified by your package manager. No unverified download path exists in this installer. |

<img src="assets/divider.svg" width="100%" alt="" />

## Security model (and its limits)

**What the bridge does**

- Never runs a shell. It builds fixed argument lists and passes the URL after a `--` separator.
- Only accepts URLs starting with `http(s)://` and refuses obvious loopback/private-network hostnames.
- Whitelists quality selectors, MP3 bitrates and command names; output paths are fixed to `~/Downloads/UMD`; the caller cannot choose a command or a path.
- Only the pinned extension ID in `bridge/com.umd.bridge.rc.json` may talk to the bridge; the browser enforces this. The extension declares no `externally_connectable`, so web pages cannot message it.
- yt-dlp runs with `--ignore-config --no-plugin-dirs`, so no stray config or plugin on the machine can add options.

> [!WARNING]
> **Known limits, stated plainly**
>
> - The private-network guard matches hostname text only. It is **not** a full defense against DNS rebinding or a public URL that redirects to a private address. This is a static-review finding, not tested.
> - Everything in this section comes from code review and syntax/static checks. It has **not** been validated by an end-to-end security test.

<img src="assets/divider.svg" width="100%" alt="" />

## Tested vs untested

An honest snapshot of where this release candidate stands. A **historical macOS baseline** of this app (previous extension build, previous installer, same bundled-runtime design) was fully tested end-to-end on the author's Mac in October 2026 and worked. **This current tree is a rebuilt release candidate**: new extension key and ID, new host name, rewritten installers, small bridge patches.

| Area | Status | Notes |
| :-- | :-: | :-- |
| Bridge to engine pipeline (Linux) | ✅ Tested | 23/23 checks over the real native-messaging stdio framing |
| Linux installer | ✅ Tested | Offline smoke test and a full end-to-end re-run of the rebuilt installer |
| In-page UI | ✅ Verified live | Chrome on ted.com; other sites not individually re-verified |
| macOS installer and bridge edits | 🟡 Static review only | Not yet run on a real Mac for this RC |
| Windows installer | ⛔ Untested | No PowerShell runtime was available; first real Windows 10 test planned |
| Browser-to-bridge hop of this RC | ⛔ Not done | Needs a real browser with the native-messaging manifest registered |

> [!NOTE]
> Treat the untested rows as untested until this section changes.

<details>
<summary><b>Full test log</b> (what was verified, when, and what it caught)</summary>

<br />

Verified so far, without a browser in the loop:

- The bridge was exercised through its real native-messaging protocol on Linux - 16 behavioral checks (liveness, URL/scheme/private-host rejection, selector and bitrate whitelisting, an injection attempt, async error relay, malformed-frame recovery, clean shutdown) all pass.
- The Linux installer was smoke-tested offline against a stubbed network - full install flow, checksum acceptance and tamper rejection, idempotent re-run, and refusal to touch foreign folders all behave as designed. (This caught and fixed a real GNU-vs-BSD `cp` layout bug.)

**2026-11-10** - the full bridge-to-engine pipeline was exercised end-to-end on Linux with the pinned Python 3.13.17 runtime, yt-dlp 2026.10.26 (SHA-256 verified against the release's own SHA2-256SUMS) and distro FFmpeg, driven over the real native-messaging stdio framing - the same path the browser uses. **23/23 checks pass**: liveness, version report, private-host / non-http / bad-kind / hostile-selector / bad-bitrate rejection, a real TED talk probe (returns the actual quality ladder 1080p down to 180p plus four MP3 bitrates), a real 180p video download with live progress events ending in a merged MKV (ffprobe-verified h264 video + AAC audio in `~/Downloads/UMD`), a mid-download cancel (kills the job, reports "Cancelled."), a real MP3 download ending in an actual .mp3 file, and the self-update path reporting "already latest" against the live GitHub release. Every audio choice the app exposes converts to MP3; there is no original-format passthrough option. This run also caught and fixed a real bug: the Linux and Windows installers accepted Python 3.9+, but current yt-dlp requires 3.11+.

**2026-11-11 (UI)** - the in-page UI (floating glass button, download menu glass, quality picker, in-menu Download button) was verified live in Chrome on ted.com against the harness: rendering on both light and busy/dark backgrounds, text legibility, and scrolling stability. The extension declares the same code path for all supported sites, but each site was not individually re-verified in this pass.

**2026-11-11 (cross-platform audit)** - an audit of the installers and bridge fixed three real bugs: the "open downloads folder" action used the macOS-only `open` command on every OS (it now dispatches to each platform's opener: `os.startfile` on Windows, `open` on macOS, `xdg-open` on Linux); the Linux and Windows installs shipped FFmpeg without FFprobe, which yt-dlp expects next to it (Linux now requires and links the distro `ffprobe`, Windows now copies `ffprobe.exe` from the same checksum-verified archive); and the Windows version footer queried `ffmpeg` without its `.exe` name. The Linux fixes were re-verified by re-running the rebuilt installer end-to-end; the macOS and Windows edits are static-review only, still untested on real machines.

**Still not done**: any run on a real Mac or Windows machine, the Windows installer (no PowerShell runtime was available to test it - a first real Windows 10 test is planned by the author), and the browser-to-bridge hop of this RC (extension loaded in a real browser talking through the registered native-messaging manifest - the cloud test browser cannot install native-messaging hosts). Treat those as untested until this section changes.

</details>

<details>
<summary><b>Help test on Windows 10</b> (first real run)</summary>

<br />

1. Install Python 3.11+ from python.org, ticking **Add python.exe to PATH**.
2. In the repo folder, run: `powershell -ExecutionPolicy Bypass -File install\install-windows.ps1`
3. Open `brave://extensions` or `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, and choose the `ARYZEN Media Downloader` folder the installer created on your Desktop.
4. Open a YouTube or TED video, click the floating **Download** button, pick **360p** (small and fast), and confirm a merged file lands in `Downloads\UMD`.
5. Then pick any **MP3** option and confirm the result is a real `.mp3` file.
6. Report what happened (step reached, exact error text if any, whether the files played) so this README's Windows status can be updated from "untested" to tested.

</details>

<img src="assets/divider.svg" width="100%" alt="" />

## Updating yt-dlp

yt-dlp updates often to keep up with site changes. The bridge can update its own bundled yt-dlp in place (checksum-verified), or you can re-run the installer.

## Uninstall

<details>
<summary><b>Remove the RC install</b></summary>

<br />

1. Remove the RC engine folder: `~/.universal-media-downloader-rc` (macOS/Linux) or `%LOCALAPPDATA%\universal-media-downloader-rc` (Windows).
2. Remove the movable `ARYZEN Media Downloader` extension folder.
3. Delete `com.umd.bridge.rc.json` from your browser's `NativeMessagingHosts` folder (or the `com.umd.bridge.rc` registry keys under `HKCU\Software\...\NativeMessagingHosts` on Windows).
4. Remove the extension from `brave://extensions` / `chrome://extensions`.

Your original October 2026 install, if you have one, is untouched by all of this.

</details>

<img src="assets/divider.svg" width="100%" alt="" />

## Credits

The floating Download button's refraction effect is a JavaScript/SVG port of the geometry and render passes from [liquid_glass_widgets](https://github.com/sdegenaar/liquid_glass_widgets) by Sebastian Degenaar (pixel-innovations.com), MIT License, which builds on [liquid_glass_renderer](https://github.com/whynotmake-it/flutter_liquid_glass) by Tim Lehmann (whynotmake.it), MIT License (as vendored upstream). The pill's rounded-rect SDF, spherical-cap surface normal, Snell refraction and RGB chromatic dispersion follow their shaders (`shaders/sdf.glsl`, `shaders/liquid_glass_geometry_blended.frag`, `shaders/liquid_glass_render.frag`); the port bakes the displacement into an SVG `feDisplacementMap` driven through Chromium's `backdrop-filter: url()`. Full license texts, copyright notices and the exact ported revision are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES), and the notices are carried in `extension/content.js`.

The download menu's typeface is [IBM Plex Sans](https://github.com/IBM/plex) (italic), SIL Open Font License 1.1 (full text in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)); the latin italic variable subset is bundled at `extension/fonts/ibm-plex-sans-italic-latin.woff2`. The menu floats centered over an untouched page - no backdrop tint or page blur - and the same refraction port drives the menu's glass, computed against its raised top-right silhouette.

The installer's terminal spinner is an original terminal drawing inspired by a loading animation the author linked (lottiefiles.com/free-animation/loading-99FrBcVjYZ); no Lottie assets, code or license material are used. The icon and in-menu brand artwork were supplied by the project's author; their ownership and licensing are not independently verified here, and the third-party notices above do not cover them.

### Licenses of the bundled dependencies

Facts, not advice.

- **yt-dlp**: [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE) (public domain) for yt-dlp's own code. The install-time `yt-dlp` file is yt-dlp's zipimport Unix executable, which per yt-dlp's README also bundles ISC-licensed (meriyah) and MIT-licensed (astring) components; the PyInstaller executables (not used by this project) contain GPLv3+ code. Downloaded by the installer at setup time, not distributed inside this repo.
- **FFmpeg static builds** (gyan.dev, ffmpeg.martin-riedl.de; also johnvansickle.com and evermeet.cx, which this repo no longer uses): built with `--enable-gpl` and GPL components such as x264/x265, so the binaries are **GPLv3**. They are downloaded by the installer at setup time, not distributed inside this repo.
- **python-build-standalone** (macOS runtime): see its [project licenses](https://github.com/astral-sh/python-build-standalone); CPython itself is PSF-licensed.

<img src="assets/divider.svg" width="100%" alt="" />

<div align="center">

This project's own code is under the [MIT License](LICENSE) - Copyright (c) 2026 Aryzen Nex.
Bundled third-party works keep their own licenses (see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)), and components the installer downloads (yt-dlp, FFmpeg, the Python runtime) keep theirs.
Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

<br />

**Made by Aryzen Nex** &nbsp;·&nbsp; Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp)

</div>
