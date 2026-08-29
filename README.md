# MIKU-19 Live Quiz

Kahoot-style live quiz with no player cap. FastAPI + native WebSockets, in-memory
room state, single host screen + single player screen. Four rounds:

| Round | Type | Questions | Notes |
|---|---|---|---|
| Miku Trivia | `text` | 13 | Vocaloid lore + producer/pairing questions |
| General Trivia | `text` | 13 | plain question + 4 text options |
| Guess the Module | `image` | 13 | cropped image of a Miku module/figure + 4 options |
| Guess the Song | `audio` | 13 | 1s auto-playing clip + 4 song-name options |

> A **Quick Test** round (2 `text` questions) is also included for fast
> iteration — delete it via the admin dashboard once you're done testing.

## Run locally

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

- Landing page (links to the host and player screens): `http://localhost:8000/`
- Host screen (put this on the projector/TV): `http://localhost:8000/host`
- Player screen (share this + the PIN): `http://localhost:8000/play`
- Admin dashboard (edit questions / upload media): `http://localhost:8000/admin`

The host screen generates a 6-digit PIN on load. Players enter it at `/play`
(or you can share `/play?pin=123456` directly).

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
- Image round questions also need `"media": "/media/images/general-1.jpg"` —
  drop the actual file into `backend/static/media/images/`.
- Song round questions need `"media": "/media/audio/song-1.mp3"` — see below
  for how to generate those from YouTube links.

Once you send me the PDF of your actual questions (and, for the image round,
tell me which crops/files to use), I'll fill `questions.json` in for you
directly instead of you hand-editing JSON.

## Generating the song clips

`scripts/cut_clips.py` is a **local** script — run it on your own machine (not
here), since it needs real internet access to YouTube plus `yt-dlp` + `ffmpeg`.

```bash
pip install yt-dlp
# ffmpeg via brew/apt/choco if you don't have it

python scripts/cut_clips.py
```

Fill in the `CLIPS` list at the top of that file with each song's YouTube URL
and the timestamp where the 1-second snippet should start — send me your
list of links + timestamps and I'll write that list into the script for you.
Output lands directly in `backend/static/media/audio/`, matching what
`questions.json` expects.

## Deploying (GitHub → Zeabur, same as your other apps)

1. Push this repo to GitHub.
2. Create a new Zeabur service from the repo, root directory `backend`.
3. Zeabur will pick up `requirements.txt` + `Procfile` automatically.
4. Put `https://<your-zeabur-domain>/host` up on the projector/host screen and
   point players at `https://<your-zeabur-domain>/play`. The lobby's join hint
   is built from the page's own origin, so it always matches whatever host
   serve the app.

### Image & audio media

Image and audio questions carry a `"media": "/media/…"` path. Two ways to get
the files in place:

- **Upload via the admin dashboard** (`/admin`): pick a round → a question →
  Upload. Files are validated by extension (jpg/jpeg/png/webp/gif for images,
  mp3/ogg/wav for audio), capped at 20 MB, and served from `/media/…`.
- **Commit them into the repo.** Media is git-ignored (see `.gitignore`), so
  uploaded files live in the running container only and are **lost on redeploy**.
  For persistent media, drop the files into `backend/static/media/images/` or
  `backend/static/media/audio/` and force-add them (`git add -f`) so they ship
  in the image.

No database, no external services — just the one process. Room state is
in-memory, so a redeploy mid-event would reset any live game (fine for a
single-session party quiz; let me know if you want SQLite persistence for
multi-session history/leaderboards later).

## How scoring works

Kahoot-style speed bonus: correct answers score between 100–1000 points based
on how fast you answered (faster = more points), plus a 10% bonus once you
hit a 3-answer streak. Wrong answers score 0 and reset your streak.

## Architecture notes

- One `Room` per game PIN, held in memory on the server process.
- Host connects via `/ws/host` (gets a fresh PIN each time), drives the game:
  pick round → start round → next question → reveal → leaderboard → repeat →
  end game.
- Players connect via `/ws/player/{pin}` with a nickname (no login/auth —
  fine for a live event; duplicate names are allowed, each gets a unique
  internal id).
- No real cap on concurrent players — you're bound by server resources, not
  a pricing tier. A small Zeabur instance comfortably handles hundreds of
  WebSocket connections for a quiz like this.
