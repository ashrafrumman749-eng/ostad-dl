#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
worker.py — single job processor
Called by server.js per job via stdin JSON:
  {"m3u8": "...", "title": "...", "referer": "https://ostad.app"}
All output → stdout (real-time), server.js streams to SSE
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

REFERER  = "https://ostad.app"
WORK_DIR = Path("/tmp/ostad_work")
WORK_DIR.mkdir(parents=True, exist_ok=True)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
TG_API_ID  = os.environ.get("TG_API_ID", "")
TG_API_HASH = os.environ.get("TG_API_HASH", "")
CHAT_ID    = os.environ.get("CHAT_ID", "")


def log(tag, msg):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] [{tag}] {msg}"
    print(line, flush=True)


def fmt_time(sec):
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s   = divmod(rem, 60)
    if h: return f"{h}h {m}m {s}s"
    if m: return f"{m}m {s}s"
    return f"{s}s"


def fmt_size(b):
    if b >= 1073741824: return f"{b/1073741824:.2f} GB"
    if b >= 1048576:    return f"{b/1048576:.1f} MB"
    return f"{b/1024:.1f} KB"


# ── FFmpeg probe duration ────────────────────────────────────────
def probe_duration(url):
    headers = f"Accept: */*\r\nReferer: {REFERER}\r\nOrigin: {REFERER}\r\n"
    cmd = [
        "ffprobe", "-v", "error",
        "-user_agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36",
        "-headers", headers,
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        url,
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=30)
        return float(out.strip())
    except Exception:
        return None


def parse_ffmpeg_time(line):
    m = re.search(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", line)
    if not m: return None
    return int(m.group(1))*3600 + int(m.group(2))*60 + float(m.group(3))


# ── Download ─────────────────────────────────────────────────────
def download_m3u8(url, out_path):
    log("DL", f"Probing duration...")
    duration = probe_duration(url)
    if duration:
        log("DL", f"Duration: {fmt_time(duration)}")
    else:
        log("DL", "Duration: unknown")

    headers_val = f"Accept: */*\r\nReferer: {REFERER}\r\nOrigin: {REFERER}\r\n"
    cmd = [
        "ffmpeg", "-y",
        "-user_agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36",
        "-headers", headers_val,
        "-i", url,
        "-c", "copy",
        "-threads", "4",
        "-movflags", "+faststart",
        out_path,
    ]

    log("DL", "ffmpeg started...")
    start     = time.time()
    last_log  = 0
    last_pct  = -1

    p = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, text=True, bufsize=1
    )

    for line in p.stderr:
        line = line.rstrip()
        if "time=" in line and duration and (time.time() - last_log) > 2:
            cur = parse_ffmpeg_time(line)
            if cur:
                pct = min(99, int(cur / duration * 100))
                if pct != last_pct:
                    elapsed = time.time() - start
                    bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
                    log("DL", f"[{bar}] {pct}%  elapsed={fmt_time(elapsed)}")
                    last_pct  = pct
                    last_log  = time.time()
        elif any(x in line.lower() for x in ["error", "failed", "invalid", "no such file"]):
            log("DL", f"WARN: {line}")

    p.wait()
    elapsed = time.time() - start

    if p.returncode != 0:
        log("ERR", f"ffmpeg exited with code {p.returncode}")
        return False

    if not os.path.exists(out_path) or os.path.getsize(out_path) < 1024:
        log("ERR", "Output file missing or too small")
        return False

    size = os.path.getsize(out_path)
    log("DL", f"✓ Download complete — {fmt_size(size)} in {fmt_time(elapsed)}")
    return True


# ── Upload ───────────────────────────────────────────────────────
def upload_telegram(file_path, title):
    import requests

    size_b  = os.path.getsize(file_path)
    size_mb = size_b / 1048576
    log("UP", f"File size: {fmt_size(size_b)}")

    caption = f"**{title}**" if title else ""

    # Bot API for small files (≤49MB)
    if size_mb <= 49:
        log("UP", "Using Bot API (small file)...")
        t0  = time.time()
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendVideo"
        with open(file_path, "rb") as f:
            resp = requests.post(url, data={
                "chat_id": CHAT_ID,
                "caption": caption,
                "supports_streaming": True,
            }, files={"video": f}, timeout=600)
        elapsed = time.time() - t0
        if resp.ok:
            data   = resp.json()
            msg_id = data["result"]["message_id"]
            log("UP", f"✓ Uploaded via Bot API in {fmt_time(elapsed)}")
            log("UP", f"MSG_ID:{msg_id}")
            return True
        else:
            log("ERR", f"Bot API failed: {resp.text[:200]}")
            return False

    # Pyrogram for large files (>49MB)
    log("UP", "Using Pyrogram (large file >49MB)...")
    if not all([TG_API_ID, TG_API_HASH, BOT_TOKEN]):
        log("ERR", "TG_API_ID / TG_API_HASH / BOT_TOKEN missing for Pyrogram")
        return False

    last = [0]
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _do():
        from pyrogram import Client
        t0 = time.time()
        async with Client(
            "ostad_bot",
            api_id    = int(TG_API_ID),
            api_hash  = TG_API_HASH,
            bot_token = BOT_TOKEN,
            in_memory = True,
        ) as app:
            def _prog(cur, total):
                if total and time.time() - last[0] > 2:
                    pct = int(cur / total * 100)
                    bar = "█"*(pct//5) + "░"*(20-pct//5)
                    log("UP", f"[{bar}] {pct}%  {fmt_size(cur)}/{fmt_size(total)}")
                    last[0] = time.time()

            msg = await app.send_video(
                chat_id = CHAT_ID,
                video   = file_path,
                caption = caption,
                supports_streaming = True,
                progress = _prog,
            )
            elapsed = time.time() - t0
            log("UP", f"✓ Uploaded via Pyrogram in {fmt_time(elapsed)}")
            if hasattr(msg, "link"):
                log("UP", f"LINK:{msg.link}")
            return True

    try:
        result = loop.run_until_complete(_do())
        return result
    except Exception as e:
        log("ERR", f"Pyrogram error: {e}")
        return False
    finally:
        loop.close()


# ── Main ─────────────────────────────────────────────────────────
def main():
    raw = sys.stdin.read().strip()
    try:
        job = json.loads(raw)
    except Exception:
        log("ERR", f"Invalid JSON from stdin: {raw[:100]}")
        sys.exit(1)

    m3u8    = job.get("m3u8", "").strip()
    title   = job.get("title", "").strip()
    referer = job.get("referer", REFERER).strip() or REFERER

    if not m3u8:
        log("ERR", "No m3u8 URL provided")
        sys.exit(1)

    log("JOB", f"Title   : {title or '(no title)'}")
    log("JOB", f"m3u8    : {m3u8[:80]}{'...' if len(m3u8)>80 else ''}")
    log("JOB", f"Referer : {referer}")

    job_dir  = WORK_DIR / f"job_{int(time.time())}_{os.getpid()}"
    job_dir.mkdir(parents=True, exist_ok=True)
    out_path = str(job_dir / "video.mp4")

    try:
        # Download
        ok = download_m3u8(m3u8, out_path)
        if not ok:
            log("ERR", "Download failed — skipping upload")
            sys.exit(2)

        # Upload
        ok = upload_telegram(out_path, title)
        if ok:
            log("DONE", "Job complete ✓")
            sys.exit(0)
        else:
            log("ERR", "Upload failed")
            sys.exit(3)

    finally:
        shutil.rmtree(job_dir, ignore_errors=True)
        log("JOB", "Temp files cleaned")


if __name__ == "__main__":
    main()
