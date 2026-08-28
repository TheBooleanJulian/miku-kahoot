"""
MIKU-19 Live Quiz — Kahoot-style quiz engine, no player cap.

Single FastAPI process. Room state lives in memory (fine for a live event;
restart the process = rooms reset). Three rounds: text / image / audio,
loaded from questions.json. Host drives the room; players join with a PIN.
"""
import asyncio
import json
import random
import string
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"

with open(BASE_DIR / "questions.json", encoding="utf-8") as f:
    QUIZ_DATA = json.load(f)

app = FastAPI()
app.mount("/media", StaticFiles(directory=STATIC_DIR / "media"), name="media")

BASE_POINTS = 1000
MIN_POINTS = 100


def is_multi(q):
    return isinstance(q.get("correct"), (list, tuple))


def correct_indices(q):
    c = q.get("correct")
    if isinstance(c, (list, tuple)):
        return sorted(int(x) for x in c)
    return [int(c)]


def normalize_answer(option):
    if isinstance(option, (list, tuple)):
        return [int(x) for x in option]
    return [int(option)] if option is not None else []


def new_pin() -> str:
    while True:
        pin = "".join(random.choices(string.digits, k=6))
        if pin not in ROOMS:
            return pin


class Player:
    def __init__(self, pid: str, name: str, ws: WebSocket):
        self.id = pid
        self.name = name
        self.ws = ws
        self.score = 0
        self.connected = True
        self.streak = 0


class Room:
    def __init__(self, pin: str):
        self.pin = pin
        self.host: Optional[WebSocket] = None
        self.players: dict[str, Player] = {}
        self.round_idx = 0          # index into QUIZ_DATA["rounds"]
        self.question_idx = -1      # index into current round's questions
        self.state = "lobby"        # lobby | question | reveal | leaderboard | ended
        self.question_start = 0.0
        self.answers: dict[str, dict] = {}  # player_id -> {"option": int, "t": float}
        self.lock = asyncio.Lock()

    def current_round(self):
        rounds = QUIZ_DATA["rounds"]
        if 0 <= self.round_idx < len(rounds):
            return rounds[self.round_idx]
        return None

    def current_question(self):
        r = self.current_round()
        if r and 0 <= self.question_idx < len(r["questions"]):
            return r["questions"][self.question_idx]
        return None

    def public_question_payload(self, q, round_meta):
        payload = {
            "type": "question",
            "round_title": round_meta["title"],
            "round_type": round_meta["type"],
            "round_index": self.round_idx,
            "question_index": self.question_idx,
            "question_count": len(round_meta["questions"]),
            "question": q["question"],
            "options": q["options"],
            "time_limit": q["time_limit"],
            "media": q.get("media"),
            "multi": is_multi(q),
        }
        return payload

    def leaderboard(self, top=10):
        ranked = sorted(self.players.values(), key=lambda p: p.score, reverse=True)
        return [{"name": p.name, "score": p.score} for p in ranked[:top]]

    async def broadcast_players(self):
        if self.host:
            await safe_send(self.host, {
                "type": "players_update",
                "players": [{"id": p.id, "name": p.name} for p in self.players.values()],
                "count": len(self.players),
            })

    async def broadcast_answer_count(self):
        if self.host:
            await safe_send(self.host, {
                "type": "answer_count",
                "answered": len(self.answers),
                "total": len(self.players),
            })


async def safe_send(ws: WebSocket, data: dict):
    try:
        await ws.send_json(data)
    except Exception:
        pass


ROOMS: dict[str, Room] = {}


@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/host")
async def host():
    return FileResponse(STATIC_DIR / "host.html")


@app.get("/play")
async def play():
    return FileResponse(STATIC_DIR / "player.html")


@app.get("/api/rounds")
async def rounds_meta():
    return [
        {"id": r["id"], "title": r["title"], "type": r["type"], "count": len(r["questions"])}
        for r in QUIZ_DATA["rounds"]
    ]


# ---------------------------------------------------------------- host WS --

@app.websocket("/ws/host")
async def ws_host(websocket: WebSocket):
    await websocket.accept()
    pin = new_pin()
    room = Room(pin)
    room.host = websocket
    ROOMS[pin] = room
    await safe_send(websocket, {"type": "room_created", "pin": pin})

    try:
        while True:
            msg = await websocket.receive_json()
            await handle_host_message(room, msg)
    except WebSocketDisconnect:
        pass
    finally:
        # Room stays alive briefly in case host reconnects is out of scope for
        # a single-event tool; just tear it down.
        room.host = None
        for p in room.players.values():
            await safe_send(p.ws, {"type": "host_left"})
        ROOMS.pop(pin, None)


async def handle_host_message(room: Room, msg: dict):
    action = msg.get("action")

    if action == "start_round":
        round_idx = msg.get("round_index", 0)
        room.round_idx = round_idx
        room.question_idx = -1
        room.state = "lobby"
        r = room.current_round()
        for p in room.players.values():
            p.streak = 0
        await broadcast_all(room, {
            "type": "round_intro",
            "round_title": r["title"],
            "round_type": r["type"],
            "round_index": room.round_idx,
            "question_count": len(r["questions"]),
        })

    elif action == "next_question":
        r = room.current_round()
        if not r:
            return
        room.question_idx += 1
        if room.question_idx >= len(r["questions"]):
            # round finished
            room.state = "leaderboard"
            payload = {"type": "leaderboard", "board": room.leaderboard(),
                       "round_done": True, "round_index": room.round_idx}
            await broadcast_all(room, payload)
            return
        room.state = "question"
        room.answers = {}
        room.question_start = time.time()
        q = room.current_question()
        payload = room.public_question_payload(q, r)
        await broadcast_all(room, payload)
        await room.broadcast_answer_count()

    elif action == "reveal":
        q = room.current_question()
        if not q:
            return
        room.state = "reveal"
        # tally per-option counts
        counts = [0] * len(q["options"])
        for a in room.answers.values():
            for o in normalize_answer(a["option"]):
                if 0 <= o < len(counts):
                    counts[o] += 1
        await broadcast_all(room, {
            "type": "reveal",
            "correct": correct_indices(q),
            "counts": counts,
            "board": room.leaderboard(),
        })
        # tell each player their own result
        for p in room.players.values():
            a = room.answers.get(p.id)
            got_it = bool(a and sorted(normalize_answer(a["option"])) == correct_indices(q))
            await safe_send(p.ws, {
                "type": "your_result",
                "correct": got_it,
                "correct_option": correct_indices(q),
                "score": p.score,
                "streak": p.streak,
            })

    elif action == "show_leaderboard":
        room.state = "leaderboard"
        await broadcast_all(room, {"type": "leaderboard", "board": room.leaderboard(), "round_done": False})

    elif action == "end_game":
        room.state = "ended"
        await broadcast_all(room, {"type": "final", "board": room.leaderboard(top=50)})

    elif action == "kick":
        pid = msg.get("player_id")
        p = room.players.pop(pid, None)
        if p:
            await safe_send(p.ws, {"type": "kicked"})
        await room.broadcast_players()


async def broadcast_all(room: Room, payload: dict):
    if room.host:
        await safe_send(room.host, payload)
    for p in list(room.players.values()):
        await safe_send(p.ws, payload)


# -------------------------------------------------------------- player WS --

@app.websocket("/ws/player/{pin}")
async def ws_player(websocket: WebSocket, pin: str):
    await websocket.accept()
    room = ROOMS.get(pin)
    if not room:
        await safe_send(websocket, {"type": "error", "message": "Room not found"})
        await websocket.close()
        return

    try:
        join_msg = await websocket.receive_json()
    except Exception:
        await websocket.close()
        return

    name = (join_msg.get("name") or "Player").strip()[:20] or "Player"
    pid = f"{name}-{random.randint(1000, 9999)}"
    player = Player(pid, name, websocket)
    room.players[pid] = player
    await safe_send(websocket, {"type": "joined", "player_id": pid, "name": name})
    await room.broadcast_players()

    try:
        while True:
            msg = await websocket.receive_json()
            await handle_player_message(room, player, msg)
    except WebSocketDisconnect:
        room.players.pop(pid, None)
        await room.broadcast_players()


async def handle_player_message(room: Room, player: Player, msg: dict):
    if msg.get("action") != "answer" or room.state != "question":
        return
    if player.id in room.answers:
        return  # already answered

    q = room.current_question()
    if not q:
        return
    option = msg.get("option")
    elapsed = time.time() - room.question_start
    time_limit = q["time_limit"]

    room.answers[player.id] = {"option": option, "t": elapsed}

    picked = normalize_answer(option)
    correct = sorted(picked) == correct_indices(q)
    if correct:
        frac = max(0.0, min(1.0, 1 - (elapsed / time_limit)))
        points = int(MIN_POINTS + (BASE_POINTS - MIN_POINTS) * frac)
        player.streak += 1
        if player.streak >= 3:
            points = int(points * 1.1)
        player.score += points
    else:
        player.streak = 0

    await safe_send(player.ws, {"type": "answer_received", "option": option})
    await room.broadcast_answer_count()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
