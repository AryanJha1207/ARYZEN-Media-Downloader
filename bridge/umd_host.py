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
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parent.parent
BIN = BASE / "bin"
YTDLP = BIN / "yt-dlp"
DL_DIR = Path.home() / "Downloads" / "UMD"
LOG = Path(__file__).resolve().parent / "bridge.log"

RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
RELEASE_DL = "https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/{name}"

MAX_URL_LEN = 2048
MAX_CONCURRENT = 3
PROBE_TIMEOUT = 8
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
    return [sys.executable, str(YTDLP), "--ignore-config", "--no-plugin-dirs", "--no-playlist",
            "--no-warnings", "--no-color", "--ffmpeg-location", str(BIN)]


def friendly_error(stderr_text):
    lines = [l for l in clean(stderr_text).splitlines() if l.strip()]
    msg = lines[-1] if lines else "The downloader could not read that page."
    msg = re.sub(r"^ERROR:\s*(\[[^\]]*\]\s*)?", "", msg)
    low = msg.lower()
    if any(k in low for k in ("login", "sign in", "cookies", "log in", "private")):
        return ("This page needs a site login. The helper only fetches public "
                "content, so this one is not downloadable.")
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
        if vc and vc != "none" and h:
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


def do_probe(rid, url):
    host = (urlparse(url).hostname or "").lower()
    if "spotify.com" in host:
        send({"id": rid, "type": "result", "ok": False,
              "error": "Spotify streams are copy-protected (DRM) and cannot be downloaded."})
        return
    try:
        p = subprocess.run(base_args() + ["-J", "--", url],
                           capture_output=True, text=True, timeout=PROBE_TIMEOUT)
    except subprocess.TimeoutExpired:
        send({"id": rid, "type": "result", "ok": False,
              "error": "That site took too long to answer (over 8 seconds). Try again."})
        return
    except Exception as e:
        log("probe spawn error: %r" % e)
        send({"id": rid, "type": "result", "ok": False,
              "error": "Could not start the downloader engine."})
        return
    if p.returncode != 0:
        send({"id": rid, "type": "result", "ok": False,
              "error": friendly_error(p.stderr)})
        return
    try:
        info = json.loads(p.stdout)
    except Exception:
        send({"id": rid, "type": "result", "ok": False,
              "error": "The downloader returned unreadable data for that page."})
        return
    if info.get("_type") == "playlist" or info.get("entries"):
        send({"id": rid, "type": "result", "ok": False,
              "error": "That link is a playlist. Open a single video and try again."})
        return
    note = None
    out = {
        "title": info.get("title") or "Untitled media",
        "site": info.get("extractor_key") or "",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
    }
    opts = build_options(info)
    if note:
        out["note"] = note
    send({"id": rid, "type": "result", "ok": True, "info": out, "options": opts})


# ---------------- download ----------------

PCT = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
SPEED = re.compile(r"\sat\s+(\S+)")
ETA = re.compile(r"\sETA\s+(\S+)")
DEST = re.compile(r"Destination:\s*(.+)$")
MERGE = re.compile(r'Merging formats into "(.+)"')
ALREADY = re.compile(r"^\[download\]\s+(.+?)\s+has already been downloaded")


def run_download(rid, url, kind, selector, mp3):
    proc = None
    try:
        DL_DIR.mkdir(parents=True, exist_ok=True)
        args = base_args() + [
            "--newline", "--paths", str(DL_DIR),
            "-o", "%(title).120B [%(id)s].%(ext)s"]
        if kind == "video":
            args += ["-f", selector, "--merge-output-format", "mp4/mkv/webm"]
        elif kind == "audio-mp3":
            args += ["-f", "ba/b", "--extract-audio",
                     "--audio-format", "mp3", "--audio-quality", "%dK" % mp3]
        else:
            args += ["-f", "ba/b"]
        args += ["--", url]

        proc = subprocess.Popen(args, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
        with _jobs_lock:
            _active_procs[rid] = proc
            _jobs[rid] = {"state": "running"}

        final_path = None
        saw_merge = False
        destinations = set()
        last_lines = []
        for line in proc.stdout:
            line = line.rstrip("\n")
            last_lines.append(line)
            del last_lines[:-8]
            m = ALREADY.match(line)
            if m:
                final_path = m.group(1).strip()
                continue
            m = MERGE.search(line)
            if m:
                saw_merge = True
                final_path = m.group(1).strip()
                send({"type": "progress", "job": rid, "pct": 99.0,
                      "stage": "merging", "ts": time.time()})
                continue
            if "[ExtractAudio]" in line:
                m = DEST.search(line)
                if m:
                    final_path = m.group(1).strip()
                send({"type": "progress", "job": rid, "pct": 99.0,
                      "stage": "converting audio", "ts": time.time()})
                continue
            if "[Fixup]" in line or "[VideoRemuxer]" in line or "[Metadata]" in line:
                send({"type": "progress", "job": rid, "pct": 99.0,
                      "stage": "finishing", "ts": time.time()})
                continue
            m = DEST.search(line)
            if m:
                destinations.add(m.group(1).strip())
                final_path = m.group(1).strip()
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
        # A "+" selector only sometimes means separate files: on progressive
        # streams yt-dlp falls back to one combined file, which is a fine
        # outcome. It is a failure only when several parts downloaded and no
        # merge happened.
        merge_needed = "+" in selector and kind == "video"
        if proc.returncode == 0 and merge_needed and not saw_merge and len(destinations) > 1:
            send({"type": "error", "job": rid,
                  "error": "The streams downloaded but could not be merged "
                           "(FFmpeg stopped working). The separate files are in "
                           "Downloads/UMD; re-run the setup script to repair, "
                           "then download again."})
            return
        if proc.returncode == 0:
            name = None
            if final_path:
                pth = Path(final_path)
                if pth.exists():
                    name = pth.name
            if not name:
                try:
                    newest = max(DL_DIR.iterdir(), key=lambda p: p.stat().st_mtime)
                    name = newest.name
                except Exception:
                    name = "file"
            send({"type": "done", "job": rid, "file": name, "ts": time.time()})
        else:
            if proc.returncode is not None and proc.returncode < 0:
                send({"type": "error", "job": rid, "error": "Cancelled."})
            else:
                send({"type": "error", "job": rid,
                      "error": friendly_error("\n".join(last_lines))})
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
    if kind not in ("video", "audio", "audio-mp3"):
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
                     args=(rid, url, kind, selector, mp3), daemon=True).start()


def do_cancel(rid, msg):
    job = msg.get("job")
    with _jobs_lock:
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


if __name__ == "__main__":
    log("bridge started (python " + sys.version.split()[0] + ")")
    try:
        main()
    finally:
        # stdin EOF means Brave closed the port. Let active download threads
        # finish writing their files before this process exits.
        for t in list(threading.enumerate()):
            if t is not threading.current_thread() and t.is_alive():
                t.join()
