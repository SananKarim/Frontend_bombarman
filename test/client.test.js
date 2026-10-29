'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');

const frontend = resolve(__dirname, '..');
const scripts = ['levelgen.js', 'game.js', 'mp.js'].map((name) => ({
  filename: resolve(frontend, name), source: readFileSync(resolve(frontend, name), 'utf8'),
}));
const html = readFileSync(resolve(frontend, 'index.html'), 'utf8');
const SESSION_KEY = 'neon-mp-session';
const ME = 'seat-local', OTHER = 'seat-remote', CODE = 'AB12';
const TILE = 48, HALF = TILE * 0.36;
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

class Target extends EventTarget {
  constructor() { super(); this.listeners = new Map(); }
  addEventListener(type, fn, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    super.addEventListener(type, fn, options);
  }
  removeEventListener(type, fn, options) {
    this.listeners.get(type)?.delete(fn);
    super.removeEventListener(type, fn, options);
  }
  fire(type, properties = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, properties);
    this.dispatchEvent(event);
    return event;
  }
  counts() { return [...this.listeners].map(([type, fns]) => [type, fns.size]).sort(); }
}

class Element extends Target {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.style = {}; this.dataset = {}; this.children = []; this.classes = new Set();
    this.value = ''; this.textContent = ''; this.disabled = false;
    this.width = 720; this.height = 624;
    this.clientWidth = 1024; this.clientHeight = 900; this.offsetHeight = 40;
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force = !this.classes.has(name)) => {
        if (force) this.classes.add(name); else this.classes.delete(name);
        return force;
      },
    };
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set innerHTML(value) {
    assert.equal(value, '', 'the fixture only supports clearing markup');
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
  }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  get lastChild() { return this.children.at(-1); }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  prepend(child) { child.parentNode = this; this.children.unshift(child); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function clock() {
  let now = 1000, nextId = 0;
  const timers = new Map();
  const schedule = (fn, delay, repeat, args) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + Math.max(1, delay || 0), repeat, args });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms, ...args) => schedule(fn, ms, 0, args),
    setInterval: (fn, ms, ...args) => schedule(fn, ms, Math.max(1, ms || 0), args),
    clear: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (let calls = 0; ; calls++) {
        const due = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        assert.ok(calls < 10000, 'fake timer callbacks must be bounded');
        const [id, timer] = due;
        now = timer.at;
        if (timer.repeat) timer.at += timer.repeat; else timers.delete(id);
        timer.fn(...timer.args);
      }
      now = end;
    },
  };
}

class Socket extends EventEmitter {
  constructor(options, replies) {
    super();
    this.auth = { ...options.auth }; this.replies = replies; this.sent = [];
    this.connected = false; this.active = true; this.closed = false;
    this.volatile = this;
  }
  timeout() { this.timedAck = true; return this; }
  emit(type, payload, ack) {
    this.sent.push({ type, payload: payload === undefined ? undefined : structuredClone(payload) });
    const timed = this.timedAck;
    this.timedAck = false;
    if (ack) queueMicrotask(() => {
      const reply = this.replies.get(type) || { ok: true };
      if (timed) ack(null, reply); else ack(reply);
    });
    return this;
  }
  receive(type, payload) {
    if (type === 'connect') { this.connected = true; this.active = true; }
    if (type === 'disconnect') this.connected = false;
    return super.emit(type, payload);
  }
  connect() { this.active = true; return this; } // Tests explicitly deliver the handshake.
  close() { this.closed = true; this.connected = false; this.active = false; return this; }
  disconnect() { return this.close(); }
  counts() { return this.eventNames().map((name) => [name, this.listenerCount(name)]).sort(); }
}

function room(status = 'lobby', localIsHost = true) {
  return {
    code: CODE, hostUid: localIsHost ? ME : OTHER, status,
    config: { maxPlayers: 4, botCount: 0, arenaPreset: 'mixed' },
    players: {
      [ME]: { uid: ME, name: 'LOCAL', color: '#22d3ee', online: true, ready: true, joinedAt: 1 },
      [OTHER]: { uid: OTHER, name: 'REMOTE', color: '#f43f5e', online: true, ready: true, joinedAt: 2 },
    },
  };
}

function startPayload(x = 168) {
  return {
    arenaSeed: 'client-regression', preset: 'mixed', cols: 15, rows: 13,
    roster: [ME, OTHER].map((id) => ({ id, name: id, color: '#22d3ee', isBot: false, kind: 'human' })),
    actors: [{ id: ME, x, y: 72 }, { id: OTHER, x: 360, y: 72 }],
  };
}

function actor(id, x, patch = {}) {
  return {
    id, x, y: 72, dx: 1, dy: 0, vx: 0, vy: 0, inputSeq: 0, alive: true,
    bombs: 0, bombMax: 2, shield: false, invuln: false, tosser: true,
    turboMs: 0, warpMs: 0, chaosMs: 0, kills: 0, deaths: 0, ...patch,
  };
}

function snapshot(seq = 1, patch = {}, x = 168) {
  return {
    seq, t: seq * 100, alive: 2, ended: false, winnerId: null,
    actors: [actor(ME, x), actor(OTHER, 360)], bombs: [], flames: [],
    pickups: [], drones: [], destroyed: [], events: [], ...patch,
  };
}

function bomb(patch = {}) {
  return { uid: 'bomb-1', owner: OTHER, cellX: 4, cellY: 1, range: 2,
    fuseMs: 2400, flight: null, escape: false, ...patch };
}

function harness({ savedSession } = {}) {
  const time = clock(), document = new Target(), window = new Target();
  const elements = new Map(), dpad = new Map(), sockets = [], replies = new Map(), logs = [];
  for (const match of html.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const [, tag, attrs] = match;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const dir = /\bdata-dir="([^"]+)"/.exec(attrs)?.[1];
    if (!id && !dir) continue;
    const element = new Element(tag);
    element.className = /\bclass="([^"]+)"/.exec(attrs)?.[1] || '';
    if (id) { element.id = id; elements.set(id, element); }
    if (dir) { element.dataset.dir = dir; dpad.set(dir, element); }
  }
  document.getElementById = (id) => elements.get(id) || null;
  document.createElement = (tag) => new Element(tag);
  document.querySelectorAll = (selector) => {
    if (selector.includes('#dpad') || selector.includes('.tbtn')) {
      return [...dpad.values()].filter((btn) => !selector.includes('.pressed') || btn.classList.contains('pressed'));
    }
    throw new Error(`Unsupported fixture selector: ${selector}`);
  };
  document.body = new Element('body');
  document.hidden = false; document.visibilityState = 'visible';
  document.fullscreenEnabled = false; document.fullscreenElement = null;
  const gradient = () => ({ addColorStop() {} });
  const canvasContext = new Proxy({
    createLinearGradient: gradient, createRadialGradient: gradient,
    measureText: () => ({ width: 0 }),
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  elements.get('game-canvas').getContext = () => canvasContext;
  const localStorage = storage(), sessionStorage = storage();
  if (savedSession) sessionStorage.setItem(SESSION_KEY, JSON.stringify(savedSession));
  localStorage.setItem('neon-bomber-muted', '1');
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [time.now()])); } static now() { return time.now(); } }
  Object.assign(window, {
    document, localStorage, sessionStorage, innerWidth: 1024, innerHeight: 900,
    MULTIPLAYER_CONFIG: { SERVER_URL: 'http://localhost:3000', ROOM_LIMIT_MAX: 8 },
    io: (_url, options) => { const sk = new Socket(options, replies); sockets.push(sk); return sk; },
  });
  const sandbox = Object.assign(window, {
    window, self: window, Event, EventTarget, Date: FakeDate,
    location: { protocol: 'http:', hostname: 'localhost', port: '8080', origin: 'http://localhost:8080' },
    navigator: { clipboard: { writeText: async () => {} } },
    performance: { now: time.now }, getComputedStyle: () => ({ display: 'block' }),
    setTimeout: time.setTimeout, clearTimeout: time.clear,
    setInterval: time.setInterval, clearInterval: time.clear,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, // Never schedule or execute a frame.
    queueMicrotask, console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map((key) => [key,
      (...args) => logs.push(args.map(String).join(' '))])),
  });
  const context = vm.createContext(sandbox);
  for (const script of scripts) vm.runInContext(script.source, context, { filename: script.filename });
  return {
    B: window.BOMBER, MP: window.NEON_MP, window, document, elements, dpad,
    sockets, replies, logs, time, sessionStorage,
    key: (type, code) => window.fire(type, { code, repeat: false }),
    button: (id, type = 'click') => elements.get(id).fire(type, { pointerId: 1 }),
    frame(ms = 50) { time.advance(ms); window.BOMBER.update(ms / 1000); },
  };
}

async function lobby(h = harness()) {
  let settled = false;
  const entering = h.MP.enter().then(() => { settled = true; });
  await flush();
  assert.equal(h.sockets.length, 1, 'one transport must be created');
  h.sockets[0].receive('connect');
  await flush();
  assert.ok(settled, 'enter must complete after the handshake');
  await entering;
  return h;
}

async function seat(h, kind = 'create') {
  // Credentials are intentionally checked with booleans, never assertion diffs/logs.
  const result = { ok: true, code: CODE, playerId: ME, token: randomBytes(32).toString('hex'),
    room: room('lobby', kind === 'create') };
  h.replies.set(`room:${kind}`, result);
  h.elements.get('lobby-code').value = CODE;
  h.button(kind === 'create' ? 'btn-host-room' : 'btn-join-room');
  await flush();
  assert.equal(h.MP._debug.myId, ME, 'the acknowledged seat must be adopted');
  return result;
}

async function live({ x = 168, patch = {} } = {}) {
  const h = await lobby();
  await seat(h);
  h.start = startPayload(x);
  h.sk = h.sockets[0];
  h.sk.receive('match:start', h.start);
  h.sk.receive('match:snapshot', snapshot(1, patch, x));
  h.sk.sent = [];
  return h;
}

const sent = (sk, type) => sk.sent.filter((event) => event.type === type);
function latestInput(sk) {
  const inputs = sent(sk, 'game:input');
  assert.ok(inputs.length > 0, 'a network movement intent must be emitted');
  const { type, dirX, dirY } = inputs.at(-1).payload;
  assert.equal(type, 'move');
  return [dirX, dirY];
}
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, message);
const resume = (h, snap) => h.sk.receive('room:resumed', {
  ok: true, room: room('match'), playerId: ME, inMatch: true,
  matchStart: h.start, snapshot: snap,
});

test('keydown and keyup upload immediately without update or rAF', async () => {
  const h = await live();
  h.key('keydown', 'ArrowRight');
  assert.deepEqual(latestInput(h.sk), [1, 0]);
  assert.equal(sent(h.sk, 'game:input').length, 1);
  h.key('keyup', 'ArrowRight');
  assert.deepEqual(latestInput(h.sk), [0, 0]);
  assert.equal(sent(h.sk, 'game:input').length, 2);
});

test('touch direction press and release upload immediately', async () => {
  const h = await live();
  h.dpad.get('up').fire('pointerdown', { pointerId: 1 });
  assert.deepEqual(latestInput(h.sk), [0, -1]);
  h.dpad.get('up').fire('pointercancel', { pointerId: 1 });
  assert.deepEqual(latestInput(h.sk), [0, 0]);
  assert.equal(h.B.input.touchDirs.size, 0);
});

for (const kind of ['bomb', 'throw']) {
  test(`touch ${kind} emits game:action and never creates a local bomb`, async () => {
    const h = await live();
    h.button(`btn-${kind}-touch`, 'pointerdown');
    assert.equal(h.B.game.bombs.length, 0, 'touch actions must not run local bomb physics');
    const actions = sent(h.sk, 'game:action');
    assert.equal(actions.length, 1, 'one server action per touch');
    assert.equal(actions[0].payload.type, kind);
    await flush();
    h.frame();
    assert.equal(h.B.game.bombs.length, 0, 'only a server snapshot may introduce a bomb');
  });
}

for (const trigger of ['blur', 'visibilitychange']) {
  test(`${trigger} clears keys, touch directions and pressed styling, then uploads neutral`, async () => {
    const h = await live();
    h.key('keydown', 'KeyD');
    h.dpad.get('up').fire('pointerdown', { pointerId: 1 });
    h.B.update(0); // Prime existing frame-driven clients so this isolates focus clearing.
    h.sk.sent = [];
    if (trigger === 'blur') h.window.fire('blur');
    else {
      h.document.hidden = true; h.document.visibilityState = 'hidden';
      h.document.fire('visibilitychange');
    }
    assert.deepEqual([
      h.B.input.keys.size, h.B.input.touchDirs.size,
      [...h.dpad.values()].filter((btn) => btn.classList.contains('pressed')).length,
    ], [0, 0, 0], 'all input state, including touch UI, must be released');
    assert.deepEqual(latestInput(h.sk), [0, 0]);
  });
}

test('pause uploads neutral and resume refreshes even an unchanged neutral intent', async () => {
  const h = await live();
  h.key('keydown', 'KeyD'); h.B.update(0);
  h.sk.sent = [];
  h.key('keydown', 'KeyP');
  assert.equal(h.B.game.state, 'paused');
  assert.deepEqual(latestInput(h.sk), [0, 0]);
  h.key('keyup', 'KeyD'); h.key('keyup', 'KeyP');
  h.sk.sent = [];
  h.button('btn-resume');
  assert.equal(h.B.game.state, 'playing');
  assert.deepEqual(latestInput(h.sk), [0, 0]);
  h.key('keydown', 'KeyD');
  assert.deepEqual(latestInput(h.sk), [1, 0]);
});

for (const kind of ['create', 'join']) {
  test(`room:${kind} updates socket.auth with the acknowledged credentials`, async () => {
    const h = await lobby(), result = await seat(h, kind), sk = h.sockets[0];
    assert.equal(sk.auth.code, result.code);
    assert.equal(sk.auth.playerId, result.playerId);
    assert.ok(sk.auth.token === result.token, 'the reconnect handshake must use the acknowledged credential');
    const stored = JSON.parse(h.sessionStorage.getItem(SESSION_KEY));
    assert.ok(stored.token === result.token, 'the same credential must be persisted');
    assert.ok(h.logs.every((line) => !line.includes(result.token)), 'credentials must not be logged');
  });
}

test('concurrent enter calls reuse connection setup and await the connect event', async () => {
  const h = harness();
  let completed = 0;
  const pending = [h.MP.enter(), h.MP.enter(), h.MP.enter()]
    .map((promise) => promise.then(() => { completed++; }));
  await flush();
  assert.equal(h.sockets.length, 1, 'pending connections must not be replaced');
  assert.equal(completed, 0, 'enter must not report success before connect');
  assert.equal(h.sockets[0].closed, false);
  h.sockets[0].receive('connect');
  await flush();
  assert.equal(completed, 3, 'all callers must resolve after connect');
  await Promise.all(pending);
});

for (const kind of ['create', 'join']) {
  test(`room:${kind} waits for an existing pending connection instead of replacing it`, async () => {
    const h = harness();
    const entering = h.MP.enter();
    await flush();
    const sk = h.sockets[0];
    h.replies.set(`room:${kind}`, { ok: true, code: CODE, playerId: ME,
      token: randomBytes(32).toString('hex'), room: room() });
    h.elements.get('lobby-code').value = CODE;
    h.button(kind === 'create' ? 'btn-host-room' : 'btn-join-room');
    await flush();
    assert.equal(h.sockets.length, 1, 'reuse the in-flight transport');
    assert.equal(sk.closed, false);
    assert.equal(sent(sk, `room:${kind}`).length, 0, 'no request before handshake');
    sk.receive('connect');
    await flush();
    assert.equal(sent(sk, `room:${kind}`).length, 1, 'send the waiting request once connected');
    assert.equal(h.MP._debug.code, CODE);
    await entering;
  });
}

test('a direction changed while disconnected is resent after room:resumed despite the same held key', async () => {
  const h = await live();
  h.key('keydown', 'KeyD'); h.B.update(0);
  h.sk.receive('disconnect'); h.sk.sent = [];
  h.key('keyup', 'KeyD'); h.key('keydown', 'KeyW'); h.B.update(0);
  assert.equal(sent(h.sk, 'game:input').length, 0, 'do not enqueue obsolete disconnected intents');
  h.sk.receive('connect');
  resume(h, snapshot(2));
  h.B.update(0);
  assert.deepEqual(latestInput(h.sk), [0, -1], 'resumption must refresh the still-held direction');
});

test('held input is refreshed after 250ms even without a direction change', async () => {
  const h = await live();
  h.key('keydown', 'KeyD'); h.B.update(0);
  const initial = sent(h.sk, 'game:input').length;
  assert.equal(initial, 1);
  h.time.advance(249); h.B.update(0);
  assert.equal(sent(h.sk, 'game:input').length, initial, 'avoid per-frame duplicate intents');
  h.time.advance(1); h.B.update(0);
  assert.ok(sent(h.sk, 'game:input').length > initial, 'refresh held movement at 250ms');
  assert.deepEqual(latestInput(h.sk), [1, 0]);
});

test('stale and duplicate snapshots cannot change actors, world, effects or match state', async () => {
  const h = await live();
  const cell = h.B.game.board.flatMap((row, y) => row.map((tile, x) => [tile, x, y]))
    .find(([tile]) => tile === 2).slice(1);
  h.sk.receive('match:snapshot', snapshot(10, {
    actors: [actor(ME, 180), actor(OTHER, 400)], bombs: [bomb()],
    pickups: [{ uid: 'pickup-1', x: 5, y: 1, type: 'boots' }],
  }));
  const mirror = () => JSON.stringify({
    srvX: h.B.game.player.srvX, remotes: h.B.game.remotes, board: h.B.game.board,
    bombs: h.B.game.bombs, pickups: h.B.game.pickups, live: h.B.game.netLive,
    state: h.B.game.state, shake: h.B.game.shake, seq: h.MP._debug.lastSeq,
    receivedAt: h.MP._debug.lastSnapAt,
  });
  const before = mirror();
  h.time.advance(20);
  for (const seq of [9, 10]) h.sk.receive('match:snapshot', snapshot(seq, {
    actors: [actor(ME, 600, { alive: false }), actor(OTHER, 600)],
    destroyed: [cell], events: [{ type: 'blast' }], ended: true, alive: 1, winnerId: OTHER,
  }));
  assert.equal(mirror(), before, 'out-of-order and duplicate payloads must have no side effects');
});

test('local prediction responds to new intent before any newer server snapshot', async () => {
  const h = await live({ patch: { actors: [actor(ME, 168, { dx: -1 }), actor(OTHER, 360)] } });
  h.key('keydown', 'KeyD');
  h.frame();
  assert.ok(h.B.game.player.x > 168, 'predict the local right intent, not stale server facing');
  assert.equal(h.MP._debug.lastSeq, 1, 'no newer snapshot was needed');
});

test('an idle actor does not drift along its last facing direction', async () => {
  const h = await live();
  for (let i = 0; i < 10; i++) h.frame();
  near(h.B.game.player.x, 168, 'zero local/server velocity must stay idle despite dx=1');
  near(h.B.game.player.y, 72, 'idle y must stay fixed');
});

test('releasing local movement stops forward prediction before the next snapshot', async () => {
  const h = await live();
  h.key('keydown', 'KeyD'); h.frame();
  const releasedAt = h.B.game.player.x;
  h.key('keyup', 'KeyD');
  for (let i = 0; i < 6; i++) h.frame(16);
  assert.ok(h.B.game.player.x <= releasedAt + 1e-6, 'released input must not keep extrapolating forward');
});

test('local prediction stays bounded when server snapshots stop arriving', async () => {
  const h = await live();
  h.key('keydown', 'KeyD');
  for (let i = 0; i < 10; i++) h.frame();
  const cappedAt = h.B.game.player.x;
  assert.ok(cappedAt > 168, 'held input should produce some immediate prediction');
  for (let i = 0; i < 90; i++) h.frame();
  assert.ok(h.B.game.player.x - 168 <= TILE, 'unacknowledged prediction cannot drift beyond one tile');
  assert.ok(Math.abs(h.B.game.player.x - cappedAt) < 0.1, 'prediction must settle at its cap, not integrate forever');
});

for (const obstacle of ['solid wall', 'soft block', 'foreign bomb with escape enabled']) {
  test(`prediction cannot cross a ${obstacle}`, async () => {
    const x = 4 * TILE - HALF - 4;
    const h = await live({ x, patch: obstacle.includes('bomb') ? { bombs: [bomb({ escape: true })] } : {} });
    if (!obstacle.includes('bomb')) h.B.game.board[1][4] = obstacle === 'solid wall' ? 1 : 2;
    h.key('keydown', 'KeyD');
    for (let i = 0; i < 10; i++) {
      h.frame();
      assert.ok(h.B.game.player.x + HALF <= 4 * TILE + 1e-6, 'collision box must remain outside the obstacle');
    }
  });
}

test('an own bomb permits escape but blocks re-entry after the actor clears its tile', async () => {
  const x = 4 * TILE + HALF - 2;
  const h = await live({ x, patch: { bombs: [bomb({ owner: ME, cellX: 3, escape: true })] } });
  h.key('keydown', 'KeyD'); h.frame();
  assert.ok(h.B.game.player.x > x + 2, 'the owner must be able to escape an overlapping bomb');
  h.key('keyup', 'KeyD'); h.key('keydown', 'KeyA');
  for (let i = 0; i < 5; i++) {
    h.frame(16);
    assert.ok(h.B.game.player.x - HALF >= 4 * TILE - 1e-6, 'a cleared escape bomb must become solid again');
  }
});

test('remote history interpolation uses snapshot time rather than frame-dependent latest-target lerp', async () => {
  const clients = [await live(), await live()];
  for (const h of clients) {
    h.sk.receive('match:snapshot', snapshot(2, { t: 1000, actors: [actor(ME, 168), actor(OTHER, 360)] }));
    h.time.advance(100);
    h.sk.receive('match:snapshot', snapshot(3, { t: 1100, actors: [actor(ME, 168), actor(OTHER, 400)] }));
    h.time.advance(100);
    h.sk.receive('match:snapshot', snapshot(4, { t: 1200, actors: [actor(ME, 168), actor(OTHER, 440)] }));
  }
  clients[0].B.update(0.05);
  for (let i = 0; i < 5; i++) clients[1].B.update(0.01);
  const positions = clients.map((h) => h.B.game.remotes[0].x);
  assert.ok(positions[0] > 360 && positions[0] < 440, 'render a delayed position bracketed by historical snapshots');
  near(positions[0], positions[1], 'the same render time must yield the same historical sample regardless of frame partition');
  clients[0].frame();
  assert.ok(clients[0].B.game.remotes[0].x > positions[0], 'history interpolation must advance with render time');
  assert.ok(clients[0].B.game.remotes[0].x <= 440, 'do not overshoot the newest stationary remote snapshot');
});

test('pickup animation age survives snapshots for the same uid but resets for a new uid', async () => {
  const pickup = { uid: 'pickup-1', x: 5, y: 1, type: 'boots' };
  const h = await live({ patch: { pickups: [pickup] } });
  h.frame(); h.frame();
  const age = h.B.game.pickups[0].age;
  assert.ok(age > 0, 'the real multiplayer frame must animate pickups');
  h.sk.receive('match:snapshot', snapshot(2, { pickups: [{ ...pickup }] }));
  near(h.B.game.pickups[0].age, age, 'stable pickup identity must preserve bobbing phase');
  h.sk.receive('match:snapshot', snapshot(3, { pickups: [{ ...pickup, uid: 'pickup-2' }] }));
  near(h.B.game.pickups[0].age, 0, 'a different pickup at the same cell starts a fresh animation');
  h.sk.receive('match:snapshot', snapshot(4));
  assert.equal(h.B.game.pickups.length, 0, 'server removal must still remove the pickup');
});

test('a resumed snapshot restores historical fullDestroyed cells missed while disconnected', async () => {
  const credentials = { code: CODE, playerId: ME, token: randomBytes(32).toString('hex') };
  const h = await lobby(harness({ savedSession: credentials }));
  h.sk = h.sockets[0]; h.start = startPayload();
  const generated = h.window.LevelGen.make({ seed: `${h.start.arenaSeed}:l0`, preset: 'mixed', levelIndex: 0, cols: 15, rows: 13 });
  const cells = generated.board.flatMap((row, y) => row.map((tile, x) => [tile, x, y]))
    .filter(([tile]) => tile === 2).slice(0, 3).map(([, x, y]) => [x, y]);
  assert.equal(cells.length, 3, 'the real arena fixture must have destructible cells');
  resume(h, snapshot(30, { fullDestroyed: cells, destroyed: [] }));
  assert.ok(h.B.game.net && h.MP._debug.inMatch, 'the live match must be reconstructed');
  for (const [x, y] of cells) assert.equal(h.B.game.board[y][x], 0, 'resume must apply cumulative destruction, not just deltas');
});

test('legacy snapshots without additive velocity, input sequence and escape fields remain usable', async () => {
  const legacy = snapshot(1, { bombs: [bomb()], pickups: [{ uid: 'pickup-1', x: 5, y: 1, type: 'boots' }] });
  for (const a of legacy.actors) { delete a.vx; delete a.vy; delete a.inputSeq; }
  delete legacy.bombs[0].escape;
  const h = await live({ patch: legacy });
  h.frame();
  assert.ok(Number.isFinite(h.B.game.player.x) && Number.isFinite(h.B.game.player.y));
  assert.ok(Number.isFinite(h.B.game.remotes[0].x));
  assert.equal(h.B.game.bombs.length, 1);
  assert.equal(h.B.game.pickups.length, 1);
});

test('expired resume credentials exit the live scene, clear the session and disable match hooks', async () => {
  const h = await live();
  h.key('keydown', 'KeyD'); h.dpad.get('up').fire('pointerdown', { pointerId: 1 });
  h.sk.receive('disconnect'); h.sk.receive('connect');
  h.sk.receive('room:resumed', { ok: false, code: 'unauthorized', error: 'Session expired.' });
  assert.equal(h.sessionStorage.getItem(SESSION_KEY), null);
  assert.equal(h.MP._debug.inMatch, false, 'expired sessions cannot remain on a live board');
  assert.equal(h.MP._debug.code, null);
  assert.equal(h.B.game.net, false);
  assert.equal(h.B.game.state, 'start');
  assert.equal(h.B.game.mode, 'campaign');
  for (const name of ['brFrame', 'brIntent', 'brAction']) assert.equal(h.B.hooks[name], null);
  assert.equal(h.elements.get('br-live').classList.contains('hidden'), true);
  assert.equal(h.elements.get('overlay-lobby').classList.contains('hidden'), false);
  assert.deepEqual([h.B.input.keys.size, h.B.input.touchDirs.size], [0, 0]);
  h.sk.sent = [];
  h.key('keydown', 'KeyW');
  assert.equal(sent(h.sk, 'game:input').length, 0, 'expired scenes must not upload match input');
});

test('repeated enter, including reconnecting enter, keeps one socket and one listener set', async () => {
  const h = await lobby(), sk = h.sockets[0];
  const listeners = () => JSON.stringify({
    socket: sk.counts(), window: h.window.counts(), document: h.document.counts(),
    elements: [...h.elements].map(([id, el]) => [id, el.counts()]),
    touch: [...h.dpad].map(([dir, el]) => [dir, el.counts()]),
  });
  const before = listeners();
  for (let i = 0; i < 5; i++) await h.MP.enter();
  assert.equal(listeners(), before, 'connected re-entry must not stack handlers');
  for (const event of ['connect', 'disconnect', 'room:update', 'room:resumed', 'match:start', 'match:snapshot']) {
    assert.equal(sk.listenerCount(event), 1, `${event} must have one persistent listener`);
  }
  sk.receive('disconnect');
  const pending = [h.MP.enter(), h.MP.enter()];
  await flush();
  assert.equal(h.sockets.length, 1, 'reconnecting enter must reuse the same transport');
  assert.equal(sk.closed, false);
  sk.receive('connect');
  await flush();
  await Promise.all(pending);
  assert.equal(listeners(), before, 'reconnection must not duplicate any DOM or socket handlers');
});

test('teardown cancels a pending connection and cannot contaminate the next connection', async () => {
  const h = harness();
  let firstFinished = false, nextFinished = false;
  const first = h.MP.enter().then(() => { firstFinished = true; });
  await flush();
  h.button('btn-lobby-back');
  await flush();
  assert.equal(firstFinished, true);
  assert.equal(h.MP._debug.connectPromise, null);
  const next = h.MP.enter().then(() => { nextFinished = true; });
  await flush();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[0].closed, true);
  assert.equal(nextFinished, false);
  h.sockets[1].receive('connect');
  await flush();
  assert.equal(nextFinished, true);
  await Promise.all([first, next]);
});

for (const kind of ['bomb', 'throw']) {
  test(`paused multiplayer refuses touch ${kind} actions`, async () => {
    const h = await live();
    h.B.togglePause();
    h.sk.sent = [];
    h.button(`btn-${kind}-touch`, 'pointerdown');
    assert.equal(sent(h.sk, 'game:action').length, 0);
    assert.equal(h.B.game.bombs.length, 0);
    h.B.togglePause();
    h.button(`btn-${kind}-touch`, 'pointerdown');
    assert.equal(sent(h.sk, 'game:action').length, 1);
  });
}

test('interpolation rebases when the simulation clock loses time after a server stall', async () => {
  const h = await live();
  h.time.advance(1000);
  h.sk.receive('match:snapshot', snapshot(2, { actors: [actor(ME, 168), actor(OTHER, 400)] }));
  h.time.advance(100);
  h.sk.receive('match:snapshot', snapshot(3, { actors: [actor(ME, 168), actor(OTHER, 440)] }));
  h.time.advance(50);
  h.B.update(0);
  const x = h.B.game.remotes[0].x;
  assert.ok(x > 400 && x < 440, 'a clock stall must not permanently clamp rendering to the newest sample');
});

test('successful resume without a retained world exposes lobby controls', async () => {
  const h = await live();
  h.sk.receive('room:resumed', { ok: true, room: room('ended'), playerId: ME,
    inMatch: true, matchStart: null, snapshot: null });
  assert.equal(h.B.game.net, false);
  assert.equal(h.elements.get('overlay-lobby').classList.contains('hidden'), false);
  assert.equal(h.elements.get('lobby-room').classList.contains('hidden'), false);
});

test('an ended match releases the periodic input timer', async () => {
  const h = await live();
  assert.ok(h.MP._debug.inputTimer);
  h.sk.receive('match:snapshot', snapshot(2, { ended: true, winnerId: OTHER }));
  assert.equal(h.MP._debug.inputTimer, null);
});
