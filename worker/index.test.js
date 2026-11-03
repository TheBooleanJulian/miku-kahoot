// node --test   The Room Durable Object (driven with fake sockets) and the HTTP routes, against main.py's behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { Room, pointsFor, correctIndices, normalizeAnswer, isAdmin } from './index.js';

const QUIZ = {
  rounds: [
    { id: 'r1', title: 'Round 1', type: 'text', questions: [
      { question: 'Q1', options: ['a', 'b', 'c', 'd'], correct: 1, time_limit: 20 },
      { question: 'Q2', options: ['a', 'b', 'c', 'd'], correct: [0, 2], time_limit: 10, explanation: 'two' }
    ] }
  ]
};

class FakeWs {
  constructor() { this.sent = []; this.listeners = {}; this.closed = false; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
  last(type) { return [...this.sent].reverse().find((m) => m.type === type); }
}

const r2 = (objects = {}) => ({
  objects,
  async get(k) { return k in objects ? { json: async () => JSON.parse(objects[k]), body: objects[k], writeHttpMetadata() {}, httpEtag: '"e"' } : null; },
  async put(k, v) { objects[k] = typeof v === 'string' ? v : '<stream>'; }
});

async function room(clock = { t: 1000 }) {
  const r = new Room({}, { MEDIA: r2({ 'questions.json': JSON.stringify(QUIZ) }) });
  r.now = () => clock.t;
  const host = new FakeWs();
  await r.attachHost(host, '123456');
  return { r, host, clock };
}
const flush = () => new Promise((res) => setImmediate(res));

function addPlayer(r, name) {
  const ws = new FakeWs();
  r.attachPlayer(ws);
  ws.emit('message', { name, emoji: '🎤' });
  return ws;
}

test('scoring matches main.py: speed-scaled, floor, streak bonus from the third correct answer', () => {
  assert.equal(pointsFor(0, 20, 1), 1000);
  assert.equal(pointsFor(10, 20, 1), 550);
  assert.equal(pointsFor(25, 20, 1), 100);
  assert.equal(pointsFor(10, 20, 3), 605);
  assert.deepEqual(correctIndices({ correct: [2, 0] }), [0, 2]);
  assert.deepEqual(normalizeAnswer(null), []);
});

test('host gets a PIN; players join, are listed for the host, and get unique ids', async () => {
  const { r, host } = await room();
  assert.deepEqual(host.sent[0], { type: 'room_created', pin: '123456' });
  const p = addPlayer(r, '  Miku  ');
  assert.equal(p.last('joined').name, 'Miku');
  assert.match(p.last('joined').player_id, /^Miku-\d{4}$/);
  assert.equal(host.last('players_update').count, 1);
});

test('a full question: answers, answer counts, reveal with per-player results', async () => {
  const { r, host, clock } = await room();
  const a = addPlayer(r, 'A');
  const b = addPlayer(r, 'B');
  host.emit('message', { action: 'start_round', round_index: 0 });
  await flush();
  assert.equal(a.last('round_intro').question_count, 2);
  host.emit('message', { action: 'next_question' });
  await flush();
  const q = a.last('question');
  assert.equal(q.question, 'Q1');
  assert.equal(q.multi, false);
  assert.equal('correct' in q, false); // never leak the answer
  assert.ok(a.last('timer'));

  clock.t += 10;
  a.emit('message', { action: 'answer', option: 1 });
  a.emit('message', { action: 'answer', option: 2 }); // second answer ignored
  b.emit('message', { action: 'answer', option: 3 });
  assert.deepEqual(host.last('answer_count'), { type: 'answer_count', answered: 2, total: 2 });

  host.emit('message', { action: 'reveal' });
  await flush();
  const reveal = host.last('reveal');
  assert.deepEqual(reveal.correct, [1]);
  assert.deepEqual(reveal.counts, [0, 1, 0, 1]);
  assert.equal(reveal.board[0].name, 'A');
  assert.deepEqual(a.last('your_result'), { type: 'your_result', correct: true, correct_option: [1], score: 550, points_added: 550, streak: 1, options: ['a', 'b', 'c', 'd'], explanation: '' });
  assert.equal(b.last('your_result').correct, false);
  r.stopTimer();
});

test('multi-answer questions need the exact set; finishing the round sends a leaderboard', async () => {
  const { r, host } = await room();
  const a = addPlayer(r, 'A');
  host.emit('message', { action: 'start_round', round_index: 0 });
  await flush();
  host.emit('message', { action: 'next_question' });
  await flush();
  host.emit('message', { action: 'next_question' });
  await flush();
  assert.equal(a.last('question').multi, true);
  a.emit('message', { action: 'answer', option: [2, 0] });
  host.emit('message', { action: 'reveal' });
  await flush();
  assert.equal(a.last('your_result').correct, true);
  host.emit('message', { action: 'next_question' });
  await flush();
  assert.deepEqual(a.last('leaderboard').round_done, true);
  host.emit('message', { action: 'end_game' });
  await flush();
  assert.equal(a.last('final').board.length, 1);
});

test('the timer reveals by itself when time runs out', async () => {
  const { r, host, clock } = await room();
  addPlayer(r, 'A');
  host.emit('message', { action: 'start_round', round_index: 0 });
  await flush();
  host.emit('message', { action: 'next_question' });
  await flush();
  clock.t += 25;
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(r.state, 'reveal');
  assert.ok(host.last('reveal'));
  assert.equal(host.last('timer').remaining, 0);
});

test('kick removes a player; host leaving tells players and closes the room', async () => {
  const { r, host } = await room();
  const a = addPlayer(r, 'A');
  const b = addPlayer(r, 'B');
  host.emit('message', { action: 'kick', player_id: a.last('joined').player_id });
  await flush();
  assert.ok(a.last('kicked'));
  assert.equal(host.last('players_update').count, 1);
  host.emit('close');
  assert.ok(b.last('host_left'));
  assert.equal(r.host, null);
  const late = new FakeWs();
  r.attachPlayer(late);
  assert.deepEqual(late.sent[0], { type: 'error', message: 'Room not found' });
  assert.equal(late.closed, true);
});

// ── HTTP ──
const basic = (u, p) => ({ Authorization: 'Basic ' + btoa(`${u}:${p}`) });
const ENV = () => ({
  ADMIN_PASSWORD: 'pw',
  MEDIA: r2(),
  ASSETS: { fetch: async (req) => new Response(`file:${new URL(req.url).pathname}`) }
});
const call = (env, path, init = {}) => worker.fetch(new Request('https://k.example' + path, init), env);

test('pages are served by route only, with no-cache headers; raw .html paths 404', async () => {
  const env = ENV();
  const res = await call(env, '/play');
  assert.equal(await res.text(), 'file:/player.html');
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.equal((await call(env, '/admin.html')).status, 404);
});

test('admin needs Basic Auth, and is disabled without ADMIN_PASSWORD', async () => {
  const env = ENV();
  const res = await call(env, '/admin');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('WWW-Authenticate'), /Basic/);
  assert.equal((await call(env, '/admin', { headers: basic('admin', 'wrong') })).status, 401);
  assert.equal(await (await call(env, '/admin', { headers: basic('admin', 'pw') })).text(), 'file:/admin.html');
  assert.equal(isAdmin(new Request('https://k', { headers: basic('admin', 'xymiku39') }), {}), false);
});

test('rounds come from the bundled quiz until an admin saves one to R2', async () => {
  const env = ENV();
  const bundled = await (await call(env, '/api/rounds')).json();
  assert.ok(bundled.length >= 1);
  const save = await call(env, '/api/questions', { method: 'POST', headers: basic('admin', 'pw'), body: JSON.stringify(QUIZ) });
  assert.deepEqual(await save.json(), { ok: true, rounds: 1 });
  assert.deepEqual(await (await call(env, '/api/rounds')).json(), [{ id: 'r1', title: 'Round 1', type: 'text', count: 2 }]);
  const bad = await call(env, '/api/questions', { method: 'POST', headers: basic('admin', 'pw'), body: '{"x":1}' });
  assert.deepEqual(await bad.json(), { error: 'missing "rounds" list' });
});

test('media upload checks type and stores under media/<kind>/<sanitised id><ext>', async () => {
  const env = ENV();
  const fd = new FormData();
  fd.append('file', new File(['x'], 'pic.PNG', { type: 'image/png' }));
  const ok = await call(env, '/api/media?question_id=q1/../evil', { method: 'POST', headers: basic('admin', 'pw'), body: fd });
  assert.deepEqual(await ok.json(), { ok: true, media: '/media/images/q1evil.png' });
  assert.ok('media/images/q1evil.png' in env.MEDIA.objects);
  const fd2 = new FormData();
  fd2.append('file', new File(['x'], 'run.exe'));
  assert.deepEqual(await (await call(env, '/api/media', { method: 'POST', headers: basic('admin', 'pw'), body: fd2 })).json(), { error: 'unsupported file type: .exe' });
  assert.equal((await call(env, '/media/images/q1evil.png')).status, 200);
  assert.equal((await call(env, '/media/images/missing.png')).status, 404);
});
