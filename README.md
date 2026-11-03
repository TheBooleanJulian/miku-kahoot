<div align="center">

# MIKU-19 Live Quiz

**A Kahoot-style live quiz built for Hatsune Miku's 19th birthday event — no player cap, FastAPI + native WebSockets.**

![Python](https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/-FastAPI-009688?logo=fastapi&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/badge/license-AGPLv3%20%2B%20Commercial-00D4C8.svg)

</div>

---

## What it does

A self-hosted, Kahoot-style live trivia game for a single in-person event. One host screen drives the game (projector/TV), and any number of players join from their phones with a 6-digit PIN and a nickname — no login or account required. Game state lives entirely in memory on the server process (no database), which keeps the stack simple at the cost of state resetting on a redeploy.

## Features

- Four question rounds: Miku Trivia (text), General Trivia (text), Guess the Module (image), Guess the Song (audio clip) — 13 questions each, plus a 2-question Quick Test round for iteration
- Real-time host/player sync over native WebSockets (`/ws/host`, `/ws/player/{pin}`)
- No player cap — bound only by server resources, not a pricing tier
- Kahoot-style speed scoring (100–1000 points based on answer speed) with a 10% streak bonus after 3 correct answers in a row
- Password-protected admin dashboard (`/admin`) for editing questions and uploading image/audio media, with extension and size validation (20 MB cap)
- Auto-generated 6-digit game PIN per host session; players can join via PIN or a direct `?pin=` link
- Animated podium/leaderboard reveal with confetti at round and game end
- Standalone local script (`scripts/cut_clips.py`) to cut 1-second song clips from YouTube via `yt-dlp` + `ffmpeg` for the audio round

## Tech Stack

| Layer | Choice |
|---|---|
| Backend (production) | Cloudflare Worker (`worker/index.js`): one Durable Object per room, WebSockets |
| Backend (local dev) | FastAPI + native WebSockets (`backend/main.py`), same messages |
| State | In-memory per room (Durable Object); quiz edits and uploaded media in R2 |
| Frontend | Static host/player/admin screens (`backend/static`), served by route |
| Media tooling | `yt-dlp` + `ffmpeg` (local clip-cutting script only) |
| Hosting | Cloudflare Workers at miku-kahoot.thebooleanjulian.dev |

## Screenshots

_Screenshots coming soon._

## Quick Start

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

- Landing page (links to host and player screens): `http://localhost:8000/`
- Host screen (put this on the projector/TV): `http://localhost:8000/host`
- Player screen (share this + the PIN): `http://localhost:8000/play`
- Admin dashboard (edit questions / upload media): `http://localhost:8000/admin`

The host screen generates a 6-digit PIN on load. Players enter it at `/play` (or share `/play?pin=123456` directly).

## Configuration

| Variable | Required | Description |
|---|---|---|
| `ADMIN_USER` | No | Admin dashboard username (`admin` by default; a var in `wrangler.jsonc`) |
| `ADMIN_PASSWORD` | Yes, for `/admin` | Admin dashboard password. On Workers it's a secret (`npx wrangler secret put ADMIN_PASSWORD`) with no default: unset means the admin dashboard is locked. The local FastAPI server still falls back to a default with a warning. |

## Filling in real content

Edit `backend/questions.json`. Each round has 13 questions:

```json
{
  "id": "general-1",
  "question": "What year did Hatsune Miku debut?",
  "options": ["2004", "2007", "2010", "2012"],
  "correct": 1,
  "time_limit": 20
}
```

- `correct` is the 0-indexed correct option.
- Image round questions also need `"media": "/media/images/general-1.jpg"` — drop the file into `backend/static/media/images/`.
- Song round questions need `"media": "/media/audio/song-1.mp3"` — see `scripts/cut_clips.py` for generating these from YouTube links.

## Project Structure

```
miku-kahoot/
├── backend/
│   ├── main.py            # FastAPI app, WebSocket routes, room state
│   ├── questions.json     # All round questions and media references
│   ├── static/            # host / player / admin / landing pages
│   └── requirements.txt
├── worker/
│   └── index.js           # production: Cloudflare Worker + Room Durable Object (tests alongside)
├── wrangler.jsonc
├── scripts/
│   └── cut_clips.py       # Local YouTube → 1s clip cutter (yt-dlp + ffmpeg)
├── questions/              # Source question material
└── Dockerfile
```

## Deploying (Cloudflare Workers)

`npx wrangler deploy` from the repo root (`wrangler.jsonc`). Put `https://miku-kahoot.thebooleanjulian.dev/host` on the
projector and point players at `/play`.

- Each room is a Durable Object keyed by its PIN; the host and players hold WebSockets to it. Rooms end when the host
  disconnects, as before.
- Quiz edits saved in `/admin` go to R2 (`questions.json` in bucket `miku-kahoot`) and survive redeploys; until the first
  save, `backend/questions.json` is used. Uploaded media is stored in the same bucket under `media/` and served at
  `/media/...`.
- Tests: `cd worker && node --test`.

## Status / Roadmap

- [x] Four question rounds (text, image, audio) with a Quick Test round
- [x] Real-time host/player sync over WebSockets
- [x] Kahoot-style speed scoring with streak bonus
- [x] Password-protected admin dashboard with media upload
- [x] Animated podium reveal with confetti
- [x] Local YouTube clip-cutting script for the audio round
- [ ] Optional SQLite persistence for multi-session history/leaderboards
- [ ] Session recovery after a mid-event redeploy

## Changelog

- **2026-11-03** — Moved from Zeabur to Cloudflare Workers: rooms are Durable Objects, quiz edits and uploaded media persist in R2, and the admin dashboard has no default password.

- **2026-08-30** — Synced the timer via server broadcasts; split the question set into sets 1–3 with vetted sources
- **2026-08-29** — Added player emoji picker, particles/animations, timer countdown, animated podium reveal with confetti, and a Quick Test round; password-protected the admin panel; supported image/audio questions on the player screen
- **2026-08-28** — Initial commit: quiz backend, landing page, `/host` route, admin dashboard for editing questions and media, final podium with top-3 winners

## License

This project is dual licensed.

- Community Edition — [GNU Affero General Public License v3 (AGPLv3)](LICENSE). Free to use, modify, and self-host. If you distribute a modified version or run it as a network service, you must make the corresponding source available.
- Commercial License — for organisations that want to embed, modify, or distribute this software without AGPLv3's obligations. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

---

<div align="center">
<sub>Built by <a href="https://github.com/TheBooleanJulian">@TheBooleanJulian</a></sub>
</div>
