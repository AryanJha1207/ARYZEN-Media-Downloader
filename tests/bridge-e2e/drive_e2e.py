#!/usr/bin/env python3
"""E2E driver: speaks the browser side of native messaging to umd_host.py."""
import json, os, select, struct, subprocess, sys, time
from pathlib import Path

PY = sys.executable  # run with the system python3 in CI/dev checks
HOST = str(Path(__file__).resolve().parents[2] / "bridge" / "umd_host.py")
DL = Path.home() / "Downloads" / "UMD"

proc = subprocess.Popen([PY, HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
results = []
seq = 0

def send(cmd, extra=None):
    global seq
    seq += 1
    rid = "t%d" % seq
    msg = {"id": rid, "cmd": cmd}
    if extra: msg.update(extra)
    data = json.dumps(msg).encode()
    proc.stdin.write(struct.pack("<I", len(data)) + data)
    proc.stdin.flush()
    return rid

def read_msg(timeout):
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([proc.stdout], [], [], max(0.1, end - time.time()))
        if not r: continue
        hdr = proc.stdout.read(4)
        if len(hdr) < 4: return None
        (n,) = struct.unpack("<I", hdr)
        body = b""
        while len(body) < n:
            chunk = proc.stdout.read(n - len(body))
            if not chunk: return None
            body += chunk
        return json.loads(body.decode())
    return "TIMEOUT"

def wait_result(rid, timeout=30):
    """Wait for the result message matching rid; collect stray events."""
    events = []
    while True:
        m = read_msg(timeout)
        if m in (None, "TIMEOUT"):
            return {"ok": False, "error": "timeout waiting for %s" % rid}, events
        if m.get("id") == rid and m.get("type") == "result":
            return m, events
        events.append(m)

def wait_job(rid, timeout=120):
    """After an ok result, wait for done/error for job=rid."""
    events = []
    end = time.time() + timeout
    while time.time() < end:
        m = read_msg(max(0.1, end - time.time()))
        if m in (None, "TIMEOUT"): break
        events.append(m)
        if m.get("job") == rid and m.get("type") in ("done", "error"):
            return m, events
    return {"type": "timeout"}, events

def check(name, cond, detail=""):
    results.append({"test": name, "pass": bool(cond), "detail": str(detail)[:500]})
    print(("PASS " if cond else "FAIL ") + name + (" :: " + str(detail)[:200] if detail else ""), flush=True)

# 1. ping
r, _ = wait_result(send("ping"))
check("ping", r.get("ok") and r.get("download_dir"), r.get("download_dir"))

# 2. versions
r, _ = wait_result(send("versions"), 40)
v = (r.get("versions") or {})
check("versions", r.get("ok") and v.get("ytdlp") == "2026.10.26", v)

# 3. negative: private host rejected
r, _ = wait_result(send("probe", {"url": "http://127.0.0.1:8000/x.mp4"}))
check("reject private host", r.get("ok") is False, r.get("error"))

# 4. negative: non-http scheme rejected
r, _ = wait_result(send("probe", {"url": "ftp://example.com/x"}))
check("reject non-http scheme", r.get("ok") is False, r.get("error"))

# 5. negative: unknown download kind
r, _ = wait_result(send("download", {"url": "https://example.com/x.mp4", "kind": "bogus"}))
check("reject bad kind", r.get("ok") is False, r.get("error"))

# 6. negative: hostile selector rejected
r, _ = wait_result(send("download", {"url": "https://example.com/x.mp4", "kind": "video", "selector": "b; rm -rf /"}))
check("reject hostile selector", r.get("ok") is False, r.get("error"))

# 7. negative: bad mp3 quality
r, _ = wait_result(send("download", {"url": "https://example.com/x.mp4", "kind": "audio-mp3", "mp3": 999}))
check("reject bad mp3 value", r.get("ok") is False, r.get("error"))

# 8. probe a real TED talk
TED = "https://www.ted.com/talks/mila_rojas_what_kids_wish_their_parents_knew_about_fun"
rid = send("probe", {"url": TED})
r, ev = wait_result(rid, 30)
check("probe TED talk", r.get("ok"), (r.get("info") or {}).get("title") or r.get("error"))
opts = r.get("options") or []
print("options:", json.dumps([o.get("label") for o in opts])[:400], flush=True)

# 9. download a real video (lowest listed specific option if present, else best)
pick = None
for o in opts:
    if o.get("kind") == "video" and o.get("id") not in ("v-best",):
        pick = o  # keep last (lowest resolution, sorted desc)
if pick is None:
    pick = next((o for o in opts if o.get("kind") == "video"), None)
check("probe returned a video option", pick is not None, pick and pick.get("label"))
if pick:
    rid = send("download", {"url": TED, "kind": "video", "selector": pick.get("selector", "bv*+ba/b")})
    r, _ = wait_result(rid)
    check("download accepted", r.get("ok") and r.get("job") == rid, r.get("error"))
    if r.get("ok"):
        m, events = wait_job(rid, 180)
        pcts = [e.get("pct") for e in events if e.get("type") == "progress" and e.get("pct") is not None]
        check("download done event", m.get("type") == "done", m.get("file") or m.get("error"))
        check("progress events streamed", len(pcts) > 0, "%d events, last pct %s" % (len(pcts), pcts[-1] if pcts else None))
        fpath = DL / (m.get("file") or "")
        ok = m.get("file") and fpath.exists() and fpath.stat().st_size > 100000
        check("file on disk in ~/Downloads/UMD", ok, "%s (%s bytes)" % (fpath.name, fpath.stat().st_size if fpath.exists() else "missing"))

        # 10. cancel: delete file, start again, cancel quickly
        try: fpath.unlink()
        except Exception: pass
        rid2 = send("download", {"url": TED, "kind": "video", "selector": pick.get("selector", "bv*+ba/b")})
        r2, _ = wait_result(rid2)
        if r2.get("ok"):
            time.sleep(1.0)
            rc, _ = wait_result(send("cancel", {"job": rid2}))
            m2, _ = wait_job(rid2, 60)
            check("cancel acknowledged", rc.get("ok") is True, rc.get("error"))
            check("cancelled job ends with Cancelled error", m2.get("type") == "error" and "ancel" in str(m2.get("error")), m2.get("error") or m2.get("type"))
        else:
            check("cancel acknowledged", False, "second download not accepted: %s" % r2.get("error"))

# 10b. real MP3 download: an "MP3 128 kbps" option must produce an actual .mp3
mp3opt = None
try:
    mp3opt = next(o for o in opts if o.get("id") == "a-mp3-128")
except Exception:
    mp3opt = None
check("probe exposes MP3 options", mp3opt is not None, "")
non_video = [o for o in opts if o.get("kind") != "video"]
check("every exposed audio option is MP3-converting", len(non_video) > 0 and all(o.get("kind") == "audio-mp3" for o in non_video), str([o.get("kind") for o in non_video]))
check("no original-format audio passthrough option", not any("original" in str(o.get("label", "")).lower() for o in opts), "")
if mp3opt:
    check("MP3 option kind routes to converter", mp3opt.get("kind") == "audio-mp3", mp3opt.get("kind"))
    before = set(DL.glob("*.mp3"))
    ridm = send("download", {"url": TED, "kind": mp3opt["kind"], "mp3": mp3opt["mp3"]})
    rm, _ = wait_result(ridm)
    check("MP3 download accepted", rm.get("ok") is True, rm.get("error"))
    if rm.get("ok"):
        mm, _ = wait_job(ridm, 300)
        check("MP3 job completes", mm.get("type") == "done", mm.get("error") or mm.get("type"))
        new_mp3 = [p for p in set(DL.glob("*.mp3")) - before if p.stat().st_size > 50000]
        check("real .mp3 file produced", len(new_mp3) > 0, ", ".join(p.name for p in new_mp3) or "no new mp3 in ~/Downloads/UMD")

# 11. update-engine (we just installed latest: expect 'already latest')
rid = send("update-engine")
r, _ = wait_result(rid)
if r.get("ok"):
    m, _ = wait_job(rid, 240)
    check("update-engine", m.get("type") == "done", "%s %s" % (m.get("note", ""), m.get("version", m.get("error", ""))))
else:
    check("update-engine", False, r.get("error"))

proc.stdin.close()
try: proc.wait(timeout=120)
except Exception: proc.kill()
ok = sum(1 for x in results if x["pass"])
print("=== %d/%d PASS ===" % (ok, len(results)))
json.dump(results, open("/tmp/umd-e2e/e2e-results.json", "w"), indent=2)
