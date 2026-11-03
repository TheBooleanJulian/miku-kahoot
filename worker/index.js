// MIKU-19 Live Quiz on Cloudflare Workers — port of backend/main.py (FastAPI, rooms in memory).
//
// Each room is one Durable Object (class Room), addressed by its 6-digit PIN; the host and every player hold a
// WebSocket to it, so a room behaves exactly like the in-process Room did: same messages, same timer broadcasts
// (every 0.25 s), same scoring. Rooms vanish when the host disconnects, as before.
//
// Pages (backend/static) are only served through the routes below, never as raw files, so /admin stays behind
// Basic Auth. Quiz edits (POST /api/questions) and uploaded media live in R2 (bucket "miku-kahoot"), replacing the
// container disk; until the first save, the bundled backend/questions.json is the quiz.
//
// Secrets: ADMIN_PASSWORD (required for /admin; unlike main.py there is no built-in default). Var: ADMIN_USER.
import bundledQuiz from '../backend/questions.json' with { type: 'json' };

const BASE_POINTS = 1000;
const MIN_POINTS = 100;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB per uploaded image/audio file
const DEFAULT_EMOJI = '🙂';
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const AUDIO_EXT = ['.mp3', '.ogg', '.wav'];
const CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const NOCACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', Pragma: 'no-cache', Expires: '0' };

// ── quiz data ────────────────────────────────────────────────────────────────────────────────────────────────
export async function loadQuiz(env) {
  const obj = env.MEDIA ? await env.MEDIA.get('questions.json') : null;
  return obj ? obj.json() : bundledQuiz;
}

export const isMulti = (q) => Array.isArray(q.correct);
export const correctIndices = (q) => (Array.isArray(q.correct) ? q.correct.map(Number).sort((a, b) => a - b) : [Number(q.correct)]);
export function normalizeAnswer(option) {
  if (Array.isArray(option)) return option.map(Number);
  return option === null || option === undefined ? [] : [Number(option)];
}
const sameAnswer = (picked, q) => JSON.stringify([...picked].sort((a, b) => a - b)) === JSON.stringify(correctIndices(q));

// Points for a correct answer, as main.py: 100..1000 by speed, +10% from a 3-answer streak (streak already counted).
export function pointsFor(elapsed, timeLimit, streak) {
  const frac = Math.max(0, Math.min(1, 1 - elapsed / timeLimit));
  let points = Math.floor(MIN_POINTS + (BASE_POINTS - MIN_POINTS) * frac);
  if (streak >= 3) points = Math.floor(points * 1.1);
  return points;
}

// ── room (Durable Object) ────────────────────────────────────────────────────────────────────────────────────
export class Room {
  constructor(state, env) {
    this.env = env;
    this.now = () => Date.now() / 1000;
    this.reset();
  }

  reset() {
    this.pin = null;
    this.host = null;
    this.players = new Map(); // id -> { id, name, emoji, ws, score, streak }
    this.quiz = null;
    this.roundIdx = 0;
    this.questionIdx = -1;
    this.state = 'lobby'; // lobby | question | reveal | leaderboard | ended
    this.questionStart = 0;
    this.timeLimit = 0;
    this.answers = new Map(); // player id -> { option, t, points }
    this.stopTimer();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const role = request.headers.get('X-Role');
    if (role === 'host' && this.host) return new Response('room in use', { status: 409 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (role === 'host') await this.attachHost(server, request.headers.get('X-Pin'));
    else this.attachPlayer(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch { /* closed socket: ignore, like safe_send */ }
  }

  broadcastAll(payload) {
    if (this.host) this.send(this.host, payload);
    for (const p of this.players.values()) this.send(p.ws, payload);
  }

  // ── host ──
  async attachHost(ws, pin) {
    this.reset();
    this.pin = pin;
    this.host = ws;
    this.quiz = await loadQuiz(this.env);
    this.send(ws, { type: 'room_created', pin });
    ws.addEventListener('message', (e) => this.onHostMessage(parse(e.data)));
    const left = () => this.hostLeft(ws);
    ws.addEventListener('close', left);
    ws.addEventListener('error', left);
  }

  hostLeft(ws) {
    if (this.host !== ws) return;
    for (const p of this.players.values()) {
      this.send(p.ws, { type: 'host_left' });
    }
    this.reset();
  }

  currentRound() {
    const rounds = this.quiz?.rounds || [];
    return this.roundIdx >= 0 && this.roundIdx < rounds.length ? rounds[this.roundIdx] : null;
  }

  currentQuestion() {
    const r = this.currentRound();
    return r && this.questionIdx >= 0 && this.questionIdx < r.questions.length ? r.questions[this.questionIdx] : null;
  }

  leaderboard(top = 10) {
    return [...this.players.values()].sort((a, b) => b.score - a.score).slice(0, top)
      .map((p) => ({ name: p.name, score: p.score, emoji: p.emoji }));
  }

  broadcastPlayers() {
    if (!this.host) return;
    this.send(this.host, {
      type: 'players_update',
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, emoji: p.emoji })),
      count: this.players.size
    });
  }

  broadcastAnswerCount() {
    if (this.host) this.send(this.host, { type: 'answer_count', answered: this.answers.size, total: this.players.size });
  }

  startTimer() {
    this.stopTimer();
    const limit = this.timeLimit;
    const started = this.now();
    const tick = () => {
      if (this.state !== 'question') return this.stopTimer();
      const remaining = Math.max(0, limit - (this.now() - started));
      this.broadcastAll({ type: 'timer', remaining: Math.round(remaining * 10) / 10, limit });
      if (remaining <= 0) this.doReveal();
    };
    tick();
    this.timer = setInterval(tick, 250);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async onHostMessage(msg) {
    if (!msg) return;
    const action = msg.action;

    if (action === 'start_round') {
      this.quiz = await loadQuiz(this.env); // pick up admin edits between rounds, like the hot-swapped QUIZ_DATA
      this.roundIdx = msg.round_index ?? 0;
      this.questionIdx = -1;
      this.state = 'lobby';
      const r = this.currentRound();
      for (const p of this.players.values()) p.streak = 0;
      if (!r) return;
      this.broadcastAll({ type: 'round_intro', round_title: r.title, round_type: r.type, round_index: this.roundIdx, question_count: r.questions.length });
    } else if (action === 'next_question') {
      const r = this.currentRound();
      if (!r) return;
      this.questionIdx += 1;
      if (this.questionIdx >= r.questions.length) {
        this.state = 'leaderboard';
        this.stopTimer();
        this.broadcastAll({ type: 'leaderboard', board: this.leaderboard(), round_done: true, round_index: this.roundIdx, round_title: r.title });
        return;
      }
      this.state = 'question';
      this.answers = new Map();
      this.questionStart = this.now();
      const q = this.currentQuestion();
      this.timeLimit = q.time_limit;
      this.broadcastAll({
        type: 'question',
        round_title: r.title,
        round_type: r.type,
        round_index: this.roundIdx,
        question_index: this.questionIdx,
        question_count: r.questions.length,
        question: q.question,
        options: q.options,
        time_limit: q.time_limit,
        media: q.media ?? null,
        multi: isMulti(q)
      });
      this.broadcastAnswerCount();
      this.startTimer();
    } else if (action === 'reveal') {
      this.doReveal();
    } else if (action === 'show_leaderboard') {
      this.state = 'leaderboard';
      this.stopTimer();
      const r = this.currentRound();
      const roundDone = Boolean(r) && this.questionIdx >= r.questions.length - 1;
      this.broadcastAll({ type: 'leaderboard', board: this.leaderboard(), round_done: roundDone, round_index: this.roundIdx, round_title: r ? r.title : '' });
    } else if (action === 'end_game') {
      this.state = 'ended';
      this.stopTimer();
      this.broadcastAll({ type: 'final', board: this.leaderboard(50) });
    } else if (action === 'kick') {
      const p = this.players.get(msg.player_id);
      if (p) {
        this.players.delete(p.id);
        this.send(p.ws, { type: 'kicked' });
      }
      this.broadcastPlayers();
    }
  }

  doReveal() {
    if (this.state !== 'question') return;
    const q = this.currentQuestion();
    if (!q) return;
    this.state = 'reveal';
    this.stopTimer();
    const counts = new Array(q.options.length).fill(0);
    for (const a of this.answers.values()) {
      for (const o of normalizeAnswer(a.option)) if (o >= 0 && o < counts.length) counts[o] += 1;
    }
    this.broadcastAll({ type: 'reveal', correct: correctIndices(q), counts, board: this.leaderboard(), question: q.question, options: q.options, explanation: q.explanation || '' });
    for (const p of this.players.values()) {
      const a = this.answers.get(p.id);
      this.send(p.ws, {
        type: 'your_result',
        correct: Boolean(a && sameAnswer(normalizeAnswer(a.option), q)),
        correct_option: correctIndices(q),
        score: p.score,
        points_added: a ? a.points || 0 : 0,
        streak: p.streak,
        options: q.options,
        explanation: q.explanation || ''
      });
    }
  }

  // ── players ──
  attachPlayer(ws) {
    if (!this.host) {
      this.send(ws, { type: 'error', message: 'Room not found' });
      ws.close(1000);
      return;
    }
    let player = null;
    ws.addEventListener('message', (e) => {
      const msg = parse(e.data);
      if (!player) {
        if (!msg) return ws.close(1000);
        player = this.join(ws, msg);
      } else {
        this.onPlayerMessage(player, msg);
      }
    });
    const left = () => {
      if (player && this.players.get(player.id) === player) {
        this.players.delete(player.id);
        this.broadcastPlayers();
      }
    };
    ws.addEventListener('close', left);
    ws.addEventListener('error', left);
  }

  join(ws, msg) {
    const name = String(msg.name || 'Player').trim().slice(0, 20) || 'Player';
    const emoji = [...String(msg.emoji || DEFAULT_EMOJI).trim()].slice(0, 8).join('') || DEFAULT_EMOJI;
    const id = `${name}-${1000 + Math.floor(Math.random() * 9000)}`;
    const player = { id, name, emoji, ws, score: 0, streak: 0 };
    this.players.set(id, player);
    this.send(ws, { type: 'joined', player_id: id, name });
    this.broadcastPlayers();
    return player;
  }

  onPlayerMessage(player, msg) {
    if (!msg || msg.action !== 'answer' || this.state !== 'question') return;
    if (this.answers.has(player.id)) return; // already answered
    const q = this.currentQuestion();
    if (!q) return;
    const option = msg.option;
    const elapsed = this.now() - this.questionStart;
    const answer = { option, t: elapsed, points: 0 };
    this.answers.set(player.id, answer);
    if (sameAnswer(normalizeAnswer(option), q)) {
      player.streak += 1;
      answer.points = pointsFor(elapsed, q.time_limit, player.streak);
      player.score += answer.points;
    } else {
      player.streak = 0;
    }
    this.send(player.ws, { type: 'answer_received', option });
    this.broadcastAnswerCount();
  }
}

function parse(data) {
  try { return JSON.parse(data); } catch { return null; }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const notFound = () => json({ detail: 'Not Found' }, 404);

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = new TextDecoder().decode(Uint8Array.from(atob(auth.slice(6)), (c) => c.charCodeAt(0))); } catch { return false; }
  const i = decoded.indexOf(':');
  const user = i === -1 ? decoded : decoded.slice(0, i);
  const pw = i === -1 ? '' : decoded.slice(i + 1);
  return timingSafeEqual(user, env.ADMIN_USER || 'admin') && timingSafeEqual(pw, env.ADMIN_PASSWORD);
}

const unauthorized = () => json({ detail: 'Not authenticated' }, 401, { 'WWW-Authenticate': 'Basic realm="miku-kahoot-admin"' });

async function page(request, env, file) {
  const res = await env.ASSETS.fetch(new Request(new URL('/' + file, request.url)));
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(NOCACHE)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

async function uploadMedia(request, env, url) {
  const form = await request.formData().catch(() => null);
  const file = form && form.get('file');
  if (!file || typeof file === 'string') return json({ error: 'no file' });
  const name0 = file.name || '';
  const ext = name0.includes('.') ? name0.slice(name0.lastIndexOf('.')).toLowerCase() : '';
  if (!IMAGE_EXT.includes(ext) && !AUDIO_EXT.includes(ext)) return json({ error: `unsupported file type: ${ext}` });
  if (file.size > MAX_MEDIA_BYTES) return json({ error: 'file too large (max 20MB)' });
  const kind = IMAGE_EXT.includes(ext) ? 'images' : 'audio';
  const safeId = [...(url.searchParams.get('question_id') || 'q')].filter((c) => /[A-Za-z0-9_-]/.test(c)).join('') || 'q';
  const name = `${safeId}${ext}`;
  await env.MEDIA.put(`media/${kind}/${name}`, file.stream(), { httpMetadata: { contentType: CONTENT_TYPES[ext] } });
  return json({ ok: true, media: `/media/${kind}/${name}` });
}

async function media(env, path) {
  const obj = await env.MEDIA.get(path.slice(1)); // "media/images/x.jpg"
  if (!obj) return notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  return new Response(obj.body, { headers });
}

function randomPin() {
  return String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
}

async function toRoom(request, env, pin, role) {
  const headers = new Headers(request.headers);
  headers.set('X-Role', role);
  headers.set('X-Pin', pin);
  return env.ROOMS.get(env.ROOMS.idFromName(pin)).fetch(new Request(request.url, { headers }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/ws/host') {
      // A fresh PIN per host; a PIN whose room still has a host answers 409, so try another (new_pin()).
      for (let i = 0; i < 10; i++) {
        const res = await toRoom(request, env, randomPin(), 'host');
        if (res.status !== 409) return res;
      }
      return new Response('no free PIN', { status: 503 });
    }
    const player = /^\/ws\/player\/([^/]+)$/.exec(path);
    if (player) return toRoom(request, env, decodeURIComponent(player[1]), 'player');

    if (method === 'GET' && path === '/') return page(request, env, 'index.html');
    if (method === 'GET' && path === '/host') return page(request, env, 'host.html');
    if (method === 'GET' && path === '/play') return page(request, env, 'player.html');
    if (method === 'GET' && path === '/healthz') return json({ status: 'pass', admin: env.ADMIN_PASSWORD ? 'configured' : 'disabled' });

    if (method === 'GET' && path === '/api/rounds') {
      const quiz = await loadQuiz(env);
      return json(quiz.rounds.map((r) => ({ id: r.id, title: r.title, type: r.type, count: r.questions.length })));
    }
    if (method === 'GET' && /^\/media\/(images|audio)\/[^/]+$/.test(path)) return media(env, path);

    if (path === '/admin' || path === '/api/questions' || path === '/api/media') {
      if (!isAdmin(request, env)) return unauthorized();
      if (method === 'GET' && path === '/admin') return page(request, env, 'admin.html');
      if (method === 'GET' && path === '/api/questions') return json(await loadQuiz(env));
      if (method === 'POST' && path === '/api/questions') {
        const data = await request.json().catch(() => null);
        if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ detail: 'body must be a JSON object' }, 422);
        if (!Array.isArray(data.rounds)) return json({ error: 'missing "rounds" list' });
        await env.MEDIA.put('questions.json', JSON.stringify(data, null, 2), { httpMetadata: { contentType: 'application/json' } });
        return json({ ok: true, rounds: data.rounds.length });
      }
      if (method === 'POST' && path === '/api/media') return uploadMedia(request, env, url);
      return json({ detail: 'Method Not Allowed' }, 405);
    }
    return notFound();
  }
};
