#!/usr/bin/env python3
"""
Cut 1-second (or custom-length) audio clips from YouTube links for the
song-guess round. Run this LOCALLY on your machine (not in a sandbox) —
it needs internet access to YouTube plus yt-dlp and ffmpeg installed.

Setup (once):
    pip install yt-dlp
    # ffmpeg must be on PATH — brew install ffmpeg / apt install ffmpeg / choco install ffmpeg

Usage:
    1. Fill in CLIPS below: one entry per song-round question.
       - id must match the question id in questions.json (e.g. "song-1")
       - url is the YouTube link
       - start is the timestamp (seconds, or "mm:ss") where the 1s snippet begins
       - duration defaults to 1.0 second — bump it if you want a longer snippet
    2. Run: python cut_clips.py
    3. Output lands in backend/static/media/audio/<id>.mp3, matching what
       questions.json already expects.
"""
import subprocess
import sys
from pathlib import Path

OUT_DIR = Path(__file__).parent.parent / "backend" / "static" / "media" / "audio"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---- fill this in with your 13 song-round entries -------------------------
CLIPS = [
    # {"id": "song-1", "url": "https://www.youtube.com/watch?v=XXXXXXXXXXX", "start": "0:45", "duration": 1.0},
    # {"id": "song-2", "url": "https://www.youtube.com/watch?v=YYYYYYYYYYY", "start": 30, "duration": 1.0},
]
# -----------------------------------------------------------------------------


def to_seconds(t):
    if isinstance(t, (int, float)):
        return float(t)
    parts = [float(p) for p in str(t).split(":")]
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return secs


def cut_clip(entry):
    cid = entry["id"]
    url = entry["url"]
    start = to_seconds(entry["start"])
    duration = entry.get("duration", 1.0)
    out_path = OUT_DIR / f"{cid}.mp3"
    tmp_audio = OUT_DIR / f"_{cid}_full.m4a"

    print(f"[{cid}] downloading audio from {url} ...")
    dl_cmd = [
        "yt-dlp", "-f", "bestaudio", "-o", str(tmp_audio),
        "--no-playlist", url,
    ]
    r = subprocess.run(dl_cmd, capture_output=True, text=True)
    if r.returncode != 0 or not tmp_audio.exists():
        # yt-dlp may append an extension it chose itself; look for it
        candidates = list(OUT_DIR.glob(f"_{cid}_full.*"))
        if not candidates:
            print(f"  !! download failed for {cid}: {r.stderr[-500:]}")
            return
        tmp_audio = candidates[0]

    print(f"[{cid}] trimming {duration}s starting at {start}s ...")
    trim_cmd = [
        "ffmpeg", "-y", "-ss", str(start), "-i", str(tmp_audio),
        "-t", str(duration), "-af", "afade=t=in:st=0:d=0.05,afade=t=out:st={:.2f}:d=0.1".format(max(0, duration - 0.1)),
        "-codec:a", "libmp3lame", "-qscale:a", "2",
        str(out_path),
    ]
    r2 = subprocess.run(trim_cmd, capture_output=True, text=True)
    if r2.returncode != 0:
        print(f"  !! trim failed for {cid}: {r2.stderr[-500:]}")
        return

    tmp_audio.unlink(missing_ok=True)
    print(f"  -> wrote {out_path}")


def main():
    if not CLIPS:
        print("CLIPS list is empty — fill it in at the top of this script, then re-run.")
        sys.exit(1)
    for entry in CLIPS:
        cut_clip(entry)
    print("\nDone. Files are in:", OUT_DIR)


if __name__ == "__main__":
    main()
