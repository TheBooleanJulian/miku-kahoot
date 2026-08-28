# MIKU-19 Live Quiz

Kahoot-style live quiz with no player cap. FastAPI + native WebSockets, in-memory
room state, single host screen + single player screen. Three rounds:

| Round | Type | Questions | Notes |
|---|---|---|---|
| General Trivia | `text` | 13 | plain question + 4 text options |
| Guess the Module | `image` | 13 | cropped image of a Miku module/figure + 4 options |
| Guess the Song | `audio` | 13 | 1s auto-playing clip + 4 song-name options |

## Run locally

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

- Host screen (put this on the projector/TV): `http://localhost:8000/`
- Player screen (share this + the PIN): `http://localhost:8000/play`

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
4. Point players at `https://<your-zeabur-domain>/play` and put
   `https://<your-zeabur-domain>/` up on the host screen.

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
