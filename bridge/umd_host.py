#!/usr/bin/env python3
"""
ARYZEN Media Downloader - local bridge (Brave native messaging host).

This program is started and owned by Brave itself through the native messaging
manifests at:
  ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.umd.bridge.json
  (and, for older Brave builds, ~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/)
That manifest allowlists ONE extension ID, so only that extension can talk to
this bridge. It communicates over stdin/stdout only: it opens no network
listener, so no other app or website can reach it.

What it does, and only this:
  ping            - report engine versions and the download folder
  probe           - list the formats yt-dlp can actually fetch for an https URL
  download        - run yt-dlp for a chosen format into ~/Downloads/UMD
  cancel          - stop a running download
  open-downloads  - reveal ~/Downloads/UMD in Finder
  update-engine   - replace bin/yt-dlp with the latest official GitHub release,
                    SHA-256 verified against the release's own SHA2-256SUMS

It never runs a shell, never takes a command or output path from the caller,
accepts only http(s) URLs (no local/internal addresses), and writes only
inside ~/Downloads/UMD.
"""

import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time

# Native messaging frames are length-prefixed binary. On Windows the C runtime
# starts stdin/stdout in text mode, which rewrites every 0x0A byte to 0x0D 0x0A
# and corrupts frame headers; force binary mode there. No effect elsewhere.
if os.name == "nt":
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
import shutil
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parent.parent
BIN = BASE / "bin"
YTDLP = BIN / "yt-dlp"
DL_DIR = Path.home() / "Downloads"
TMP_DIR = BASE / "song-tmp"
LOG = Path(__file__).resolve().parent / "bridge.log"

RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
RELEASE_DL = "https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/{name}"

MAX_URL_LEN = 2048
MAX_CONCURRENT = 3
# Warm-engine probe budget. Cold first runs are covered by the warm-up thread
# at bridge start plus the extension's page-load ping, not by inflating this.
PROBE_TIMEOUT = 8
# A download started soon after a probe can reuse that probe's saved engine
# answer (--load-info-json) instead of re-reading the page. Kept SHORT on
# purpose: signed media URLs can die within minutes on some networks, so an
# entry older than this is treated as absent and the page is read fresh.
PROBE_INFO_TTL = 120
VERSION_CACHE = {}

_send_lock = threading.Lock()
_jobs = {}
_jobs_lock = threading.Lock()
_active_procs = {}


def log(msg):
    try:
        with open(LOG, "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + str(msg)[:2000] + "\n")
    except Exception:
        pass


def send(msg):
    # If Brave closed the port (e.g. the service worker was put to sleep),
    # keep working silently - an in-flight download must still finish.
    data = json.dumps(msg).encode("utf-8")
    try:
        with _send_lock:
            sys.stdout.buffer.write(struct.pack("<I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError):
        pass


def recv():
    hdr = sys.stdin.buffer.read(4)
    if len(hdr) < 4:
        return None
    (n,) = struct.unpack("<I", hdr)
    if n <= 0 or n > 64 * 1024:
        return None
    body = sys.stdin.buffer.read(n)
    if len(body) < n:
        return None
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return {}


ANSI = re.compile(r"\x1b\[[0-9;]*m")
PRIVATE_HOST = re.compile(
    r"^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|169\.254\.|"
    r"172\.(1[6-9]|2[0-9]|3[01])\.)", re.I)
SELECTOR_RE = re.compile(r"^[A-Za-z0-9_\-\+\*/\[\]=<>:, ]{1,200}$")


def clean(s):
    return ANSI.sub("", s or "").strip()


def valid_url(url):
    if not isinstance(url, str) or not (8 <= len(url) <= MAX_URL_LEN):
        return False
    if not re.match(r"^https?://", url, re.I):
        return False
    host = (urlparse(url).hostname or "")
    if not host or PRIVATE_HOST.match(host):
        return False
    return True


def base_args():
    # --ignore-config / --no-plugin-dirs: never pick up a yt-dlp.conf or plugin
    # already on this Mac (those could add cookies, exec hooks or proxy
    # options the user never asked this app for).
    # sys.executable: the zipapp is pure Python; run it with the interpreter
    # already running this bridge (no PATH/env dependence, no Gatekeeper event).
    args = [sys.executable, str(YTDLP), "--ignore-config", "--no-plugin-dirs", "--no-playlist",
            "--no-warnings", "--no-color", "--ffmpeg-location", str(BIN)]
    # YouTube extraction requires a real JavaScript runtime for its JS
    # challenges (yt-dlp announcement #14404). Deno is the only runtime
    # yt-dlp auto-detects; point it at the copy our installer placed in
    # bin/ so it works without any PATH setup. Absent = old installs keep
    # their previous (degraded) behavior.
    deno = BIN / ("deno.exe" if os.name == "nt" else "deno")
    if deno.exists():
        args += ["--js-runtimes", "deno:" + str(deno)]
    return args


def extra_headers(url):
    """Sites that refuse bare requests get a plain browser-style Referer."""
    h = (urlparse(url).hostname or "").lower()
    if h.endswith("reddit.com") or h.endswith("redd.it") or h.endswith("redditmedia.com"):
        return ["--add-header", "Referer:https://www.reddit.com/"]
    if h.endswith("cdninstagram.com") or h.endswith("fbcdn.net") or h.endswith("instagram.com"):
        return ["--add-header", "Referer:https://www.instagram.com/"]
    return []


def friendly_error(stderr_text):
    lines = [l for l in clean(stderr_text).splitlines() if l.strip()]
    msg = lines[-1] if lines else "The downloader could not read that page."
    msg = re.sub(r"^ERROR:\s*(\[[^\]]*\]\s*)?", "", msg)
    low = msg.lower()
    if any(k in low for k in ("login", "sign in", "cookies", "log in", "private")):
        return ("This page needs a site login. The helper only fetches public "
                "content, so this one is not downloadable.")
    if "403" in low or "blocked" in low or "429" in low:
        return ("The site refused the request (blocked or rate-limited). "
                "Wait a minute and try again.")
    if "unsupported url" in low:
        return "This site is not supported by the downloader."
    if "drm" in low:
        return "This media is DRM-protected and cannot be downloaded."
    if "not a bot" in low or "sign in to confirm" in low:
        return ("The site asked for a bot check. Try again in a few minutes, "
                "or update the engine from the popup footer.")
    return msg[:400]


# ---------------- probe ----------------

def build_options(info):
    fmts = info.get("formats") or []
    if not fmts and info.get("url"):
        fmts = [info]  # direct media file
    videos = {}
    have_audio = False
    for f in fmts:
        if not isinstance(f, dict):
            continue
        vc, ac = f.get("vcodec"), f.get("acodec")
        h = f.get("height")
        # Some extractors (e.g. Streamable's single-file probe) leave BOTH
        # codec fields null - unknown is not "none". A media file with a
        # height and unknown codecs is still downloadable video.
        codecs_unknown = vc is None and ac is None
        if h and ((vc and vc != "none") or codecs_unknown):
            fps = f.get("fps") or 0
            dr = (f.get("dynamic_range") or "SDR").upper()
            key = (int(h), int(round(fps)), dr)
            score = f.get("tbr") or f.get("vbr") or 0
            size = f.get("filesize") or f.get("filesize_approx")
            if key not in videos or score > videos[key][0]:
                videos[key] = (score, size)
        if (not vc or vc == "none") and ac and ac != "none":
            have_audio = True
        elif vc and vc != "none" and ac and ac != "none":
            have_audio = True
        elif codecs_unknown and h:
            have_audio = True

    opts = []
    if videos:
        opts.append({"id": "v-best", "kind": "video",
                     "label": "Best available (auto)", "selector": "bv*+ba/b"})
        for (h, fps, dr) in sorted(videos.keys(),
                                   key=lambda k: (-k[0], -k[1], k[2] != "SDR")):
            label = "%dp" % h
            if fps > 30:
                label += " %dfps" % fps
            if dr != "SDR":
                label += " " + dr
            fpsc = "[fps<=%d]" % fps if fps else ""
            sel = "bv*[height=%d]%s+ba/b[height<=%d]" % (h, fpsc, h)
            size = videos[(h, fps, dr)][1]
            opts.append({"id": "v%d-%d-%s" % (h, fps, dr), "kind": "video",
                         "label": label, "selector": sel,
                         "size": ("~%.0f MB" % (size / 1048576.0)) if size else ""})
    if have_audio or videos:
        # Every audio choice converts to MP3 - the user-facing rule is
        # "audio always means MP3", no original-format passthrough option.
        for br in (320, 256, 192, 128):
            opts.append({"id": "a-mp3-%d" % br, "kind": "audio-mp3",
                         "label": "MP3 %d kbps" % br, "mp3": br})
    return opts


# A probe that outlives its caller's 8-second budget is no longer killed:
# the engine keeps running (bounded by PROBE_LINGER_CAP) and a successful
# result is cached, so the user's next attempt rides the work already done
# instead of restarting a slow fetch from zero. One engine process per URL;
# concurrent requests for the same URL share it. Feedback still reaches the
# caller at PROBE_TIMEOUT seconds; nothing retries on its own.
PROBE_RESULT_TTL = 180
PROBE_LINGER_CAP = 45
MAX_INFLIGHT_PROBES = 3

_probe_cache = {}     # url -> (monotonic_ts, payload dict incl. "ok": True, info_json_path|None)


# Saved probe answers hold signed CDN URLs: they live in a private temp dir,
# owner-read-only files, and are deleted on use, on expiry/eviction, and at
# bridge exit. Never written to the log.
import atexit
import tempfile

_INFO_DIR = None


def _info_dir():
    global _INFO_DIR
    if _INFO_DIR is None:
        _INFO_DIR = tempfile.mkdtemp(prefix="umd-info-")
        try:
            os.chmod(_INFO_DIR, 0o700)
        except Exception:
            pass
    return _INFO_DIR


def _save_info_json(raw):
    try:
        fd, p = tempfile.mkstemp(prefix="p-", suffix=".json", dir=_info_dir())
        with os.fdopen(fd, "w") as f:
            f.write(raw)
        try:
            os.chmod(p, 0o600)
        except Exception:
            pass
        return p
    except Exception as e:
        log("info-json save failed: %r" % e)
        return None


def _drop_info_file(path):
    if not path:
        return
    try:
        os.unlink(path)
    except Exception:
        pass


def _cleanup_info_dir():
    if _INFO_DIR:
        try:
            for n in os.listdir(_INFO_DIR):
                _drop_info_file(os.path.join(_INFO_DIR, n))
            os.rmdir(_INFO_DIR)
        except Exception:
            pass


atexit.register(_cleanup_info_dir)
_probe_inflight = {}  # url -> {"proc", "started", "waiters": {rid: Timer}}
_probe_lock = threading.Lock()


def _probe_timeout_msg(rid):
    # Sent only when the engine hits the hard PROBE_LINGER_CAP: by then the
    # caller has been watching a progress note for most of the wait. No
    # promise about the next attempt: a killed engine leaves nothing cached
    # here, so a retry starts fresh.
    send({"id": rid, "type": "result", "ok": False, "code": "probe-timeout",
          "error": "That page still hasn't answered after 45 seconds. "
                   "Close this and try again."})


def _probe_waiter_progress(url, rid):
    # At PROBE_TIMEOUT seconds the probe is usually still legitimately
    # working (YouTube challenge solving can take a while). Tell the caller
    # it is alive instead of failing it; the waiter stays registered and
    # gets the real result when the engine finishes, or the cap error.
    with _probe_lock:
        st = _probe_inflight.get(url)
        if not st or rid not in st["waiters"]:
            return
    send({"id": rid, "type": "probe-working",
          "after": PROBE_TIMEOUT, "cap": PROBE_LINGER_CAP})


def _probe_add_waiter(st, url, rid):
    t = threading.Timer(PROBE_TIMEOUT, _probe_waiter_progress, args=(url, rid))
    t.daemon = True
    st["waiters"][rid] = t
    t.start()


def _probe_cache_put(url, payload, info_path=None):
    if len(_probe_cache) >= 50:
        oldest = min(_probe_cache, key=lambda u: _probe_cache[u][0])
        old = _probe_cache.pop(oldest, None)
        if old:
            _drop_info_file(old[2])
    _probe_cache[url] = (time.monotonic(), payload, info_path)


def _probe_watch(url, st):
    proc = st["proc"]
    killed = False
    try:
        out, err = proc.communicate(timeout=PROBE_LINGER_CAP)
    except subprocess.TimeoutExpired:
        killed = True
        proc.kill()
        try:
            out, err = proc.communicate(timeout=10)
        except Exception:
            out, err = "", ""
    except Exception as e:
        log("probe wait error: %r" % e)
        killed = True
        out, err = "", ""

    payload = None
    if not killed:
        if proc.returncode != 0:
            payload = {"ok": False, "error": friendly_error(err)}
        else:
            try:
                info = json.loads(out)
            except Exception:
                info = None
            if info is None:
                payload = {"ok": False,
                           "error": "The downloader returned unreadable data for that page."}
            elif info.get("_type") == "playlist" or info.get("entries"):
                payload = {"ok": False,
                           "error": "That link is a playlist. Open a single video and try again."}
            else:
                payload = {"ok": True, "info": {
                    "title": info.get("title") or "Untitled media",
                    "site": info.get("extractor_key") or "",
                    "uploader": info.get("uploader") or info.get("channel") or "",
                    "duration": info.get("duration"),
                    "thumbnail": info.get("thumbnail"),
                }, "options": build_options(info)}

    with _probe_lock:
        _probe_inflight.pop(url, None)
        waiters = list(st["waiters"].items())
        st["waiters"].clear()
        if payload and payload["ok"]:
            _probe_cache_put(url, payload, _save_info_json(out))
    for rid, timer in waiters:
        timer.cancel()
        if payload is None:
            _probe_timeout_msg(rid)
        else:
            send(dict({"id": rid, "type": "result"}, **payload))


def do_probe(rid, url):
    host = (urlparse(url).hostname or "").lower()
    if "spotify.com" in host:
        send({"id": rid, "type": "result", "ok": False,
              "error": "Spotify streams are copy-protected (DRM) and cannot be downloaded."})
        return
    with _probe_lock:
        ent = _probe_cache.get(url)
        if ent is not None:
            if time.monotonic() - ent[0] < PROBE_RESULT_TTL:
                send(dict({"id": rid, "type": "result"}, **ent[1]))
                return
            _probe_cache.pop(url, None)
            _drop_info_file(ent[2])
        st = _probe_inflight.get(url)
        if st is not None:
            _probe_add_waiter(st, url, rid)
            return
        if len(_probe_inflight) >= MAX_INFLIGHT_PROBES:
            send({"id": rid, "type": "result", "ok": False, "code": "probe-busy",
                  "error": "The helper is busy reading another page. Give it a few seconds, then try again."})
            return
        try:
            proc = subprocess.Popen(base_args() + extra_headers(url) + ["-J", "--", url],
                                    stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
        except Exception as e:
            log("probe spawn error: %r" % e)
            send({"id": rid, "type": "result", "ok": False,
                  "error": "Could not start the downloader engine."})
            return
        st = {"proc": proc, "started": time.monotonic(), "waiters": {}}
        _probe_inflight[url] = st
        _probe_add_waiter(st, url, rid)
    threading.Thread(target=_probe_watch, args=(url, st), daemon=True).start()


# ---------------- download ----------------

PCT = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
SPEED = re.compile(r"\sat\s+(\S+)")
ETA = re.compile(r"\sETA\s+(\S+)")
DEST = re.compile(r"Destination:\s*(.+)$")
MERGE = re.compile(r'Merging formats into "(.+)"')
ALREADY = re.compile(r"^\[download\]\s+(.+?)\s+has already been downloaded")


# Failure signature that justifies the ONE fresh-fetch fallback: the saved
# probe answer pointed at media URLs the CDN has already dropped. Anything
# else (disk, permissions, postprocessing, user cancel, unknown) surfaces as
# a plain error - the fallback never duplicates postprocessing or overrides
# the user.
# Anchored to the media-fetch line so a thumbnail/subtitle/metadata 404 can
# never trigger the fallback. (404 counts here: this pattern is only
# consulted right after a probe that DID find the media, so a media-URL 404
# at that point means the saved link died, not that the video vanished.)
STALE_SOURCE_RE = re.compile(
    r"(unable to download video data|Got error): HTTP Error (403|404|410)")


def run_download(rid, url, kind, selector, mp3, name=""):
    proc = None
    try:
        DL_DIR.mkdir(parents=True, exist_ok=True)
        # Use unique template with timestamp to avoid conflicts
        import time
        timestamp = int(time.time() * 1000) % 100000  # Last 5 digits of ms timestamp
        tmpl = "%(title).80B [%(id)s]_" + str(timestamp) + ".%(ext)s"
        if name:
            tmpl = name + "_" + str(timestamp) + ".%(ext)s"
        args = base_args() + extra_headers(url) + [
            "--newline", "--paths", str(DL_DIR),
            "--no-overwrites",
            "--restrict-filenames",
            "-o", tmpl]
        if kind == "video":
            args += ["-f", selector or "bv*+ba/b", "--merge-output-format", "mp4/mkv/webm"]
        elif kind == "audio-mp3":
            args += ["-f", "ba/b", "--extract-audio",
                     "--audio-format", "mp3", "--audio-quality", "%dK" % mp3]
        elif kind == "image":
            # For images, just download the file directly without format selection
            args += ["-f", "b"]
        else:
            args += ["-f", "ba/b"]

        # Fast start: reuse the probe answer saved moments ago instead of
        # re-reading the page. Only inside the short TTL; the plain URL path
        # below is today's behavior and stays the fallback and the default.
        info_path = None
        with _probe_lock:
            ent = _probe_cache.get(url)
            if ent is not None and time.monotonic() - ent[0] < PROBE_INFO_TTL:
                info_path = ent[2]
        attempts = []
        if info_path:
            attempts.append(["--load-info-json", info_path])
        attempts.append(["--", url])

        def job_cancelled():
            with _jobs_lock:
                j = _jobs.get(rid) or {}
            return bool(j.get("cancelled"))

        # Run one engine attempt; returns its outcome. Progress reporting is
        # identical for both source forms because the engine's output lines
        # are the same either way.
        def attempt(tail_args):
            nonlocal proc
            res = {"ret": None, "final": None, "saw_merge": False,
                   "saw_post": False, "destinations": set(), "tail": []}
            proc = subprocess.Popen(args + tail_args, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True)
            with _jobs_lock:
                _active_procs[rid] = proc
                _jobs[rid] = {"state": "running"}
            for line in proc.stdout:
                line = line.rstrip("\n")
                res["tail"].append(line)
                del res["tail"][:-8]
                m = ALREADY.match(line)
                if m:
                    res["final"] = m.group(1).strip()
                    continue
                m = MERGE.search(line)
                if m:
                    res["saw_merge"] = True
                    res["saw_post"] = True
                    res["final"] = m.group(1).strip()
                    send({"type": "progress", "job": rid, "pct": 99.0,
                          "stage": "merging", "ts": time.time()})
                    continue
                if "[ExtractAudio]" in line:
                    res["saw_post"] = True
                    m = DEST.search(line)
                    if m:
                        res["final"] = m.group(1).strip()
                    send({"type": "progress", "job": rid, "pct": 99.0,
                          "stage": "converting audio", "ts": time.time()})
                    continue
                if "[Fixup]" in line or "[VideoRemuxer]" in line or "[Metadata]" in line:
                    res["saw_post"] = True
                    send({"type": "progress", "job": rid, "pct": 99.0,
                          "stage": "finishing", "ts": time.time()})
                    continue
                m = DEST.search(line)
                if m:
                    res["destinations"].add(m.group(1).strip())
                    res["final"] = m.group(1).strip()
                m = PCT.search(line)
                if m:
                    sp = SPEED.search(line)
                    et = ETA.search(line)
                    send({"type": "progress", "job": rid,
                          "pct": min(float(m.group(1)), 100.0),
                          "speed": sp.group(1) if sp else "",
                          "eta": et.group(1) if et else "",
                          "ts": time.time()})
            proc.wait()
            res["ret"] = proc.returncode
            return res

        r = attempt(attempts[0])
        if (len(attempts) == 2 and r["ret"] not in (0, None)
                and not job_cancelled()
                and r["ret"] is not None and r["ret"] >= 0
                and not r["saw_post"]
                and STALE_SOURCE_RE.search("\n".join(r["tail"]))):
            # Stale saved answer: forget it and read the page fresh, once.
            log("saved probe answer was stale; retrying with a fresh read")
            with _probe_lock:
                old = _probe_cache.pop(url, None)
            if old:
                _drop_info_file(old[2])
            r = attempt(attempts[1])
        # The saved answer is single-use: never keep it after a download try.
        _drop_info_file(info_path)
        with _probe_lock:
            ent = _probe_cache.get(url)
            if ent is not None and ent[2] == info_path:
                _probe_cache[url] = (ent[0], ent[1], None)

        # A "+" selector only sometimes means separate files: on progressive
        # streams yt-dlp falls back to one combined file, which is a fine
        # outcome. It is a failure only when several parts downloaded and no
        # merge happened.
        merge_needed = "+" in selector and kind == "video"
        if r["ret"] == 0 and merge_needed and not r["saw_merge"] and len(r["destinations"]) > 1:
            send({"type": "error", "job": rid,
                  "error": "The streams downloaded but could not be merged "
                           "(FFmpeg stopped working). The separate files are in "
                           "Downloads/UMD; re-run the setup script to repair, "
                           "then download again."})
            return
        if r["ret"] == 0:
            name = None
            final_path = None
            if r["final"]:
                pth = Path(r["final"])
                if pth.exists():
                    name = pth.name
                    final_path = str(pth)
            if not name:
                try:
                    newest = max(DL_DIR.iterdir(), key=lambda p: p.stat().st_mtime)
                    name = newest.name
                    final_path = str(newest)
                except Exception:
                    name = "file"
            # Serve the file so Chrome can download it
            url = serve_once(final_path) if final_path else None
            send({"type": "done", "job": rid, "file": name, "path": final_path, "url": url, "ts": time.time()})
        else:
            if job_cancelled() or (r["ret"] is not None and r["ret"] < 0):
                send({"type": "error", "job": rid, "error": "Cancelled."})
            else:
                send({"type": "error", "job": rid,
                      "error": friendly_error("\n".join(r["tail"]))})
    except Exception as e:
        log("download error: %r" % e)
        send({"type": "error", "job": rid,
              "error": "The download stopped unexpectedly."})
    finally:
        with _jobs_lock:
            _active_procs.pop(rid, None)
            _jobs.pop(rid, None)


def ffmpeg_present():
    # Path.exists follows symlinks, so a dangling link (e.g. the distro
    # package was removed after install) is correctly reported missing.
    f = BIN / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    return f.exists()


def do_download(rid, msg):
    url = msg.get("url")
    kind = msg.get("kind")
    selector = msg.get("selector") or ""
    mp3 = msg.get("mp3") or 0
    name = re.sub(r'[\\/:*?"<>|%\x00-\x1f]', "_", str(msg.get("name") or "")).strip(" .")[:100]
    if kind not in ("video", "audio", "audio-mp3", "image"):
        send({"id": rid, "type": "result", "ok": False, "error": "Unknown download type."})
        return
    # Audio always needs FFmpeg (MP3 conversion); a "+" selector nearly
    # always resolves to separate video+audio streams that need merging.
    # Blocking up front beats downloading gigabytes of fragments that can
    # never be assembled. Rare progressive sources that would satisfy "+"
    # with one combined file are conservatively blocked too; the backstop
    # after proc.wait() covers the case where FFmpeg vanishes mid-download.
    needs_ffmpeg = kind in ("audio", "audio-mp3") or "+" in selector
    if needs_ffmpeg and not ffmpeg_present():
        send({"id": rid, "type": "result", "ok": False,
              "error": "FFmpeg is missing, so this download can't be assembled. "
                       "Re-run the setup script to repair it, then try again."})
        return
    if kind == "video" and not SELECTOR_RE.match(selector):
        send({"id": rid, "type": "result", "ok": False, "error": "Bad format selection."})
        return
    if kind == "audio-mp3" and mp3 not in (128, 192, 256, 320):
        send({"id": rid, "type": "result", "ok": False, "error": "Bad audio quality."})
        return
    with _jobs_lock:
        if len(_active_procs) >= MAX_CONCURRENT:
            send({"id": rid, "type": "result", "ok": False,
                  "error": "Too many downloads are already running."})
            return
    send({"id": rid, "type": "result", "ok": True, "job": rid})
    threading.Thread(target=run_download,
                     args=(rid, url, kind, selector, mp3, name), daemon=True).start()


def serve_once(path):
    """Serve one file once on 127.0.0.1 behind a random token so Chrome's own
    download manager can fetch it. Returns the URL, or None on failure.
    The file is NOT deleted after serving, so users can find it in the Downloads folder."""
    try:
        import http.server, secrets, urllib.parse, mimetypes
        token = secrets.token_urlsafe(24)
        fp = Path(path)

        # Guess MIME type from file extension
        mime_type, _ = mimetypes.guess_type(fp.name)
        if not mime_type:
            mime_type = "application/octet-stream"

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path != "/" + token:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", mime_type)
                self.send_header("Content-Length", str(fp.stat().st_size))
                self.send_header("Content-Disposition",
                                 "attachment; filename*=UTF-8''" + urllib.parse.quote(fp.name))
                self.end_headers()
                with open(fp, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                # File is kept in Downloads folder for user access

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        srv.timeout = 120

        def run():
            try:
                srv.handle_request()
            finally:
                srv.server_close()
        threading.Thread(target=run, daemon=True).start()
        return "http://127.0.0.1:%d/%s" % (srv.server_address[1], token)
    except Exception as e:
        log("serve_once failed: %r" % e)
        return None


SONG_AUDIO_SOURCES = [
    ("YouTube", "ytsearch10:%s official audio"),
    ("YouTube (lyrics)", "ytsearch10:%s lyrics"),
    ("YouTube Music", "ytsearch10:%s"),
    ("SoundCloud", "scsearch10:%s"),
    ("Bilibili", "bilisearch10:%s"),
]
SONG_VIDEO_SOURCES = [
    ("YouTube", "ytsearch10:%s official video"),
    ("YouTube (music video)", "ytsearch10:%s music video"),
    ("YouTube", "ytsearch10:%s"),
    ("Bilibili", "bilisearch10:%s"),
]
MEDIA_EXT = (".mp3", ".mp4", ".mkv", ".webm", ".m4a")


def run_song(rid, query, title, kind="audio-mp3", mp3=320, height=720):
    try:
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        words = re.findall(r"\w+", title or "", re.U)[:4]
        # Don't filter by duration - some official audio tracks might be longer
        flt = ""
        if words:
            flt = "title~=(?i)" + ".*".join(re.escape(w) for w in words)
        sources = SONG_VIDEO_SOURCES if kind == "video" else SONG_AUDIO_SOURCES
        if kind == "video":
            fmt = ["-f", "bv*[height<=%d]+ba/b[height<=%d]/b" % (height, height),
                   "--merge-output-format", "mp4/mkv"]
        else:
            fmt = ["-f", "ba/b", "--extract-audio", "--audio-format", "mp3",
                   "--audio-quality", "%dK" % mp3]
        last_err = "No source had this song."
        for label, tmpl in sources:
            with _jobs_lock:
                if (_jobs.get(rid) or {}).get("cancelled"):
                    send({"type": "error", "job": rid, "error": "Cancelled."})
                    return
            send({"type": "progress", "job": rid, "pct": 0.0,
                  "stage": "searching " + label, "ts": time.time()})
            args = base_args() + [
                "--newline", "--paths", str(TMP_DIR),
                "-o", "%(title).120B.%(ext)s",
                "--max-downloads", "1"] + fmt + [
                "--print", "after_move:filepath",
                "--", tmpl % query]
            if flt:
                args.insert(-2, "--match-filter")
                args.insert(-1, flt)
            proc = subprocess.Popen(args, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True)
            with _jobs_lock:
                _active_procs[rid] = proc
                _jobs.setdefault(rid, {"state": "running"})
            final, tail = None, []
            for line in proc.stdout:
                line = line.rstrip("\n")
                tail.append(line)
                del tail[:-8]
                if line.startswith(str(TMP_DIR)) and line.lower().endswith(MEDIA_EXT):
                    final = line.strip()
                    continue
                m = PCT.search(line)
                if m:
                    sp = SPEED.search(line)
                    et = ETA.search(line)
                    send({"type": "progress", "job": rid,
                          "pct": min(float(m.group(1)), 99.0),
                          "speed": sp.group(1) if sp else "",
                          "eta": et.group(1) if et else "",
                          "stage": label, "ts": time.time()})
                elif "[ExtractAudio]" in line or "[Merger]" in line:
                    send({"type": "progress", "job": rid, "pct": 99.0,
                          "stage": "finishing", "ts": time.time()})
            proc.wait()
            if proc.returncode is not None and proc.returncode < 0:
                send({"type": "error", "job": rid, "error": "Cancelled."})
                return
            if proc.returncode in (0, 101) and final and Path(final).exists():
                url = serve_once(final)
                # File stays in UMD folder (TMP_DIR which is under UMD)
                log("song saved: %s" % final)
                send({"type": "done", "job": rid, "file": Path(final).name,
                      "path": final, "url": url, "source": label, "ts": time.time()})
                return
            last_err = friendly_error("\n".join(tail))
            log("song source %s failed: %s" % (label, last_err))
        send({"type": "error", "job": rid,
              "error": "All sources failed. Last error: " + last_err})
    except Exception as e:
        log("song error: %r" % e)
        send({"type": "error", "job": rid, "error": "The download stopped unexpectedly."})
    finally:
        with _jobs_lock:
            _active_procs.pop(rid, None)
            _jobs.pop(rid, None)


def do_song(rid, msg):
    q = re.sub(r"\s+", " ", str(msg.get("query") or "")).strip().lstrip("-")[:200]
    title = re.sub(r"\s+", " ", str(msg.get("title") or "")).strip()[:150]
    kind = "video" if msg.get("kind") == "video" else "audio-mp3"
    mp3 = msg.get("mp3") if msg.get("mp3") in (128, 192, 256, 320) else 320
    height = msg.get("height") if msg.get("height") in (360, 480, 720, 1080, 1440, 2160) else 720
    if len(q) < 2:
        send({"id": rid, "type": "result", "ok": False, "error": "No song name."})
        return
    if not ffmpeg_present():
        send({"id": rid, "type": "result", "ok": False,
              "error": "FFmpeg is missing. Re-run the setup script."})
        return
    with _jobs_lock:
        if len(_active_procs) >= MAX_CONCURRENT:
            send({"id": rid, "type": "result", "ok": False,
                  "error": "Too many downloads are already running."})
            return
        _jobs[rid] = {"state": "running"}
    send({"id": rid, "type": "result", "ok": True, "job": rid})
    threading.Thread(target=run_song, args=(rid, q, title, kind, mp3, height),
                     daemon=True).start()


def do_cancel(rid, msg):
    job = msg.get("job")
    with _jobs_lock:
        j = _jobs.get(job)
        if j is not None:
            j["cancelled"] = True
        proc = _active_procs.get(job)
    if proc and proc.poll() is None:
        try:
            proc.kill()
        except Exception:
            pass
    send({"id": rid, "type": "result", "ok": True})


# ---------------- engine update ----------------

def http_get(url, binary=False, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "umd-bridge/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def do_update(rid):
    send({"id": rid, "type": "result", "ok": True, "job": rid})
    try:
        rel = json.loads(http_get(RELEASE_API))
        tag = rel.get("tag_name")
        if not tag:
            raise ValueError("no tag")
        try:
            cur = subprocess.run([sys.executable, str(YTDLP), "--version"],
                                 capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception:
            cur = ""
        if cur == tag:
            send({"type": "done", "job": rid, "file": "",
                  "note": "already latest", "version": tag, "ts": time.time()})
            return
        sums = http_get(RELEASE_DL.format(tag=tag, name="SHA2-256SUMS"))
        want = None
        for line in sums.splitlines():
            if line.rstrip().endswith("  yt-dlp"):
                want = line.split()[0].strip()
        if not want:
            raise ValueError("no checksum")
        data = http_get(RELEASE_DL.format(tag=tag, name="yt-dlp"),
                        binary=True, timeout=300)
        got = hashlib.sha256(data).hexdigest()
        if got.lower() != want.lower():
            send({"type": "error", "job": rid,
                  "error": "Update download failed its safety check - not installed."})
            return
        tmp = BIN / ".yt-dlp.new"
        with open(tmp, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o755)
        os.replace(tmp, YTDLP)
        send({"type": "done", "job": rid, "file": "",
              "version": tag, "ts": time.time()})
    except Exception as e:
        log("update error: %r" % e)
        send({"type": "error", "job": rid,
              "error": "Engine update failed. Your current version still works."})


# ---------------- misc ----------------

def do_ping(rid):
    # Instant liveness answer. Never spawn binaries here: the first execution
    # of a freshly downloaded engine can take far longer than the popup's
    # boot gate, and a slow version check must not look like a dead helper.
    send({"id": rid, "type": "result", "ok": True,
          "download_dir": str(DL_DIR)})


def do_versions(rid):
    # Lazy engine info for the popup footer. Runs only when asked, with short
    # timeouts; a slow cold binary yields None, never a blocked bridge.
    if "versions" not in VERSION_CACHE:
        versions = {}
        try:
            versions["ytdlp"] = subprocess.run(
                [sys.executable, str(YTDLP), "--version"], capture_output=True,
                text=True, timeout=5).stdout.strip()
        except Exception:
            versions["ytdlp"] = None
        try:
            fv = subprocess.run([str(BIN / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")), "-version"],
                                capture_output=True, text=True, timeout=5).stdout
            versions["ffmpeg"] = fv.splitlines()[0].split(" ")[2] if fv else None
        except Exception:
            versions["ffmpeg"] = None
        try:
            dv = subprocess.run([str(BIN / ("deno.exe" if os.name == "nt" else "deno")), "--version"],
                                capture_output=True, text=True, timeout=5).stdout
            versions["deno"] = dv.splitlines()[0].split(" ")[1] if dv else None
        except Exception:
            versions["deno"] = None
        VERSION_CACHE["versions"] = versions
    send({"id": rid, "type": "result", "ok": True,
          "versions": VERSION_CACHE["versions"]})


def do_open_downloads(rid):
    try:
        DL_DIR.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            os.startfile(str(DL_DIR))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(DL_DIR)])
        else:
            subprocess.Popen(["xdg-open", str(DL_DIR)],
                             stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        send({"id": rid, "type": "result", "ok": True})
    except Exception as e:
        log("open error: %r" % e)
        send({"id": rid, "type": "result", "ok": False,
              "error": "Could not open the downloads folder."})


def main():
    while True:
        req = recv()
        if req is None:
            break
        if not isinstance(req, dict):
            continue
        rid = req.get("id") or "?"
        cmd = req.get("cmd") or ""
        try:
            if cmd == "ping":
                do_ping(rid)
            elif cmd == "versions":
                do_versions(rid)
            elif cmd == "probe":
                url = req.get("url")
                if not valid_url(url):
                    send({"id": rid, "type": "result", "ok": False,
                          "error": "That does not look like a valid web link."})
                else:
                    threading.Thread(target=do_probe, args=(rid, url),
                                     daemon=True).start()
            elif cmd == "download":
                if not valid_url(req.get("url")):
                    send({"id": rid, "type": "result", "ok": False,
                          "error": "That does not look like a valid web link."})
                else:
                    do_download(rid, req)
            elif cmd == "song":
                do_song(rid, req)
            elif cmd == "cancel":
                do_cancel(rid, req)
            elif cmd == "open-downloads":
                do_open_downloads(rid)
            elif cmd == "update-engine":
                do_update(rid)
            else:
                send({"id": rid, "type": "result", "ok": False,
                      "error": "Unknown request."})
        except Exception as e:
            log("dispatch error: %r" % e)
            send({"id": rid, "type": "result", "ok": False,
                  "error": "Unexpected helper error."})


def warm_engine():
    # The first execution of the engine on a cold machine can take far longer
    # than PROBE_TIMEOUT (interpreter start, zip import, antivirus scan). Run
    # it here, in the background, at bridge start so the first real probe is
    # warm. Never blocks startup, ping, or any request.
    try:
        subprocess.run([sys.executable, str(YTDLP), "--version"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=45)
    except Exception:
        pass


def _sweep_info_orphans():
    # A bridge killed before atexit leaves its private temp dir behind. Remove
    # saved probe answers older than 10 minutes at startup (a live sibling
    # bridge's fresh files are untouched), then the empty dir.
    try:
        tmp = tempfile.gettempdir()
        cutoff = time.time() - 600
        for n in os.listdir(tmp):
            if not n.startswith("umd-info-"):
                continue
            d = os.path.join(tmp, n)
            if d == _INFO_DIR or not os.path.isdir(d):
                continue
            try:
                for f in os.listdir(d):
                    p = os.path.join(d, f)
                    try:
                        if os.path.getmtime(p) < cutoff:
                            os.unlink(p)
                    except Exception:
                        pass
                if not os.listdir(d):
                    os.rmdir(d)
            except Exception:
                pass
    except Exception:
        pass


if __name__ == "__main__":
    _sweep_info_orphans()
    threading.Thread(target=warm_engine, daemon=True).start()
    log("bridge started (python " + sys.version.split()[0] + ")")
    try:
        main()
    finally:
        # stdin EOF means Brave closed the port. Let active download threads
        # finish writing their files before this process exits.
        for t in list(threading.enumerate()):
            if t is not threading.current_thread() and t.is_alive():
                t.join()
