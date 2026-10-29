/* =========================================================================
   NEON BOMBER — multiplayer client (Node.js + Socket.IO, server-authoritative).
   Loaded on demand by game.js; the campaign never touches this file.

   Trust model:
   - The server simulation owns every gameplay fact: positions, bombs,
     explosions, damage, power-ups, eliminations and victory.
   - This file sends INTENTS only (move direction, bomb, throw) and renders
     ordered snapshots (~10 Hz) with smoothing. A hacked client can at worst
     spam intents, which the server rate-limits and validates.
   - Identity is server-assigned: create/join acks return {playerId, token}.
     Reconnection replays the token through the Socket.IO handshake auth;
     the server only restores the seat if the token matches exactly.

   The socket.io client library is fetched at runtime from the game server
   itself (`${SERVER_URL}/socket.io/socket.io.js`), so nothing is needed at
   build time and the campaign works with no server at all.
   ========================================================================= */
'use strict';
(function () {

  const SESSION_KEY = 'neon-mp-session';        // sessionStorage: resume creds
  const MY_SPEED = 158;                         // cosmetic: own extrapolation
  const TURBO_MULT = 1.55;
  const EXTRAPOLATE_CAP = 0.12;
  const INPUT_REFRESH_MS = 250;
  const INTERPOLATION_MS = 100;

  const $ = (id) => document.getElementById(id);
  const g = () => window.BOMBER.game;

  const S = {
    socket: null,
    connected: false,
    libPromise: null,
    code: null,          // room code we hold a seat in
    playerId: null,      // server-assigned identity for THIS browser seat
    myId: null,          // same id inside match payloads (actor id)
    room: null,          // last publicRoom pushed by the server
    inMatch: false,
    ended: false,
    isHost: false,
    roster: {},          // actorId → { id, name, color, isBot, kind }
    lastSeq: 0,
    lastSnapAt: 0,
    lastIntent: null,
    intentX: 0,
    intentY: 0,
    inputSeq: 0,
    lastInputAt: 0,
    inputTimer: null,
    connectPromise: null,
    cancelConnect: null,
    clockOffset: null,
    myAlive: true,
    busy: false,         // Host/Join click guard while a request is in flight
    wired: false,
  };

  /* ================= backend connection ================= */

  function serverBase() {
    const configured = String(
      (window.MULTIPLAYER_CONFIG || {}).SERVER_URL || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    if (location.protocol === 'https:') {
      throw new Error('Multiplayer backend is not configured — set MULTIPLAYER_SERVER_URL in Vercel and redeploy.');
    }
    if (location.protocol === 'http:' && location.port && location.port !== '3000') {
      return `${location.protocol}//${location.hostname}:3000`;
    }
    return '';
  }

  function loadSocketLib() {
    if (window.io) return Promise.resolve();
    if (!S.libPromise) {
      S.libPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `${serverBase()}/socket.io/socket.io.js`;
        s.onload = () => resolve();
        s.onerror = () => {
          S.libPromise = null;
          reject(new Error('Cannot reach the game server at '
            + (serverBase() || location.origin)
            + ' — check the Render service, or run `cd backend && npm start` locally.'));
        };
        document.body.appendChild(s);
      });
    }
    return S.libPromise;
  }

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function saveSession(s) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  /* Exactly ONE socket with ONE set of listeners: reconnects reuse the
     Socket.IO auto-reconnection, and a fresh connect() tears the old
     socket down first, so handlers can never stack up. */
  async function ensureSocket() {
    await loadSocketLib();
    if (S.socket) return waitForConnection();
    const sess = loadSession();
    const sk = window.io(serverBase() || undefined, {
      auth: sess ? { code: sess.code, playerId: sess.playerId, token: sess.token } : {},
      reconnectionDelayMax: 4000,
      timeout: 12000,
    });
    S.socket = sk;
    sk.on('connect', () => {
      S.connected = true;
      S.lastIntent = null;
      if (!S.code) status('Connected — host or join a room.');
      else if (!S.room) status('Rejoining room…');
    });
    sk.on('disconnect', () => {
      S.connected = false;
      S.lastIntent = null;
      status('Connection lost — reconnecting…');
      if (S.inMatch) toast('CONNECTION LOST — RETRYING', 2);
    });
    sk.on('connect_error', () => {
      S.connected = false;
      status('Game server unreachable. Is it running? ('
        + (serverBase() || location.origin) + ')');
    });
    sk.on('room:update', onRoom);
    sk.on('room:resumed', onResumeed);
    sk.on('match:start', joinMatch);
    sk.on('match:snapshot', applySnapshot);
    return waitForConnection();
  }

  function waitForConnection() {
    if (S.connected) return Promise.resolve();
    if (S.connectPromise) return S.connectPromise;
    const sk = S.socket;
    const promise = new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        sk.off('connect', connected);
        sk.off('connect_error', failed);
        if (S.socket === sk) S.cancelConnect = null;
        error ? reject(error) : resolve();
      };
      S.cancelConnect = () => finish(new Error('Connection cancelled.'));
      const connected = () => finish();
      const failed = () => finish(new Error('Game server unreachable. Is it running?'));
      const timer = setTimeout(() => finish(new Error('Game server unreachable. Is it running?')), 15000);
      sk.once('connect', connected);
      sk.once('connect_error', failed);
    }).finally(() => { if (S.connectPromise === promise) S.connectPromise = null; });
    S.connectPromise = promise;
    return promise;
  }

  function teardownSocket() {
    if (S.cancelConnect) S.cancelConnect();
    S.connectPromise = null;
    clearInterval(S.inputTimer);
    S.inputTimer = null;
    if (S.socket) {
      S.socket.removeAllListeners();
      S.socket.close();
      S.socket = null;
    }
    S.connected = false;
  }

  /** Ack request with timeout; server acks are {ok, …} or {ok:false, code, error}. */
  function request(event, payload) {
    return new Promise((resolve, reject) => {
      if (!S.socket || !S.connected) {
        reject(new Error('Not connected to the game server yet.'));
        return;
      }
      S.socket.timeout(15000).emit(event, payload, (err, res) => {
        if (err) { reject(new Error('The server did not answer in time.')); return; }
        if (!res || !res.ok) {
          const e = new Error((res && res.error) || 'The server rejected that request.');
          e.code = (res && res.code) || 'rejected';
          reject(e);
          return;
        }
        resolve(res);
      });
    });
  }

  /* ================= tiny helpers ================= */

  function status(text) { const el = $('lobby-status'); if (el) el.textContent = text; }
  function toast(text, life) { g().toast = { text, life: life || 1.8 }; }

  function pushFeed(text) {
    const feed = $('br-feed');
    if (!feed) return;
    const line = document.createElement('div');
    line.textContent = text;
    feed.prepend(line);
    while (feed.children.length > 5) feed.lastChild.remove();
  }

  function shortName(name) { return String(name || '?').slice(0, 14); }

  /* ================= lobby ================= */

  async function enter() {
    wireOnce();
    if (S.code && S.room && !S.inMatch) { renderLobby(); return; }
    if (!S.code) showLobbyHome();
    const sess = loadSession();
    if (sess && !S.code) { S.code = sess.code; S.playerId = sess.playerId; S.myId = sess.playerId; }
    try {
      await ensureSocket();
      if (!S.code) status('Connected — host or join a room.');
      else if (!S.room) status('Rejoining room ' + S.code + '…');
    } catch (e) { status(friendly(e)); }
  }

  function showLobbyHome() {
    $('lobby-home').classList.remove('hidden');
    $('lobby-room').classList.add('hidden');
  }
  function showLobbyRoom() {
    $('lobby-home').classList.add('hidden');
    $('lobby-room').classList.remove('hidden');
  }

  function wireOnce() {
    if (S.wired) return;
    S.wired = true;
    $('btn-host-room').addEventListener('click', hostRoom);
    $('btn-join-room').addEventListener('click', joinRoom);
    $('btn-copy-code').addEventListener('click', () => {
      const code = S.code || '';
      if (!code) return;
      (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject())
        .then(() => status('Room code copied.'))
        .catch(() => status(`Room code: ${code}`));
    });
    $('btn-leave-room').addEventListener('click', leaveRoom);
    $('btn-ready').addEventListener('click', toggleReady);
    $('btn-start-match').addEventListener('click', startMatchCall);
    $('btn-lobby-back').addEventListener('click', backToMenu);
    ['sel-max-players', 'sel-bots', 'sel-arena'].forEach((id) =>
      $(id).addEventListener('change', pushConfig));
    // battle-royale end screen
    $('btn-br-again').addEventListener('click', playAgain);
    $('btn-br-lobby').addEventListener('click', returnToLobbyCall);
  }

  /* Repeated clicks must not fire a second create/join while the first
     request is in flight — the button pair is disabled for the duration. */
  function lobbyGuard(on) {
    S.busy = on;
    $('btn-host-room').disabled = on;
    $('btn-join-room').disabled = on;
  }

  async function hostRoom() {
    if (S.busy) return;
    lobbyGuard(true);
    try {
      await ensureSocket();
      status('Creating room…');
      const name = ($('lobby-name').value || '').trim() || 'GUEST';
      const res = await request('room:create',
        { name, config: { maxPlayers: 4, botCount: 2, arenaPreset: 'mixed' } });
      adoptSeat(res);
    } catch (e) { status(friendly(e)); }
    finally { lobbyGuard(false); }
  }

  async function joinRoom() {
    if (S.busy) return;
    lobbyGuard(true);
    try {
      const code = ($('lobby-code').value || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) { status('Room codes are 4 letters/numbers.'); return; }
      const name = ($('lobby-name').value || '').trim() || 'GUEST';
      await ensureSocket();
      status(`Joining ${code}…`);
      const res = await request('room:join', { code, name });
      adoptSeat(res);
    } catch (e) { status(friendly(e)); }
    finally { lobbyGuard(false); }
  }

  function adoptSeat(res) {
    S.code = res.code;
    S.playerId = res.playerId;
    S.myId = res.playerId;                 // actor id in match payloads == seat id
    S.isHost = res.room.hostUid === res.playerId;
    const credentials = { code: res.code, playerId: res.playerId, token: res.token };
    saveSession(credentials);
    S.socket.auth = credentials;
    S.room = res.room;
    showLobbyRoom();
    $('lobby-room-code').textContent = res.code;
    status('Connected. Waiting for the host to start…');
    renderLobby();
  }

  /* Server-driven resume: the handshake token restored our seat. */
  function onResumeed(r) {
    if (!r || !r.ok) {
      clearSession();
      S.socket.auth = {};
      if (S.inMatch) { exitMatchScene(); window.BOMBER.showOverlay('lobby'); }
      S.code = null; S.playerId = null; S.myId = null; S.room = null;
      showLobbyHome(); status('Previous session expired — host or join again.');
      return;
    }
    S.code = r.room.code;
    S.playerId = r.playerId;
    S.myId = r.playerId;
    S.room = r.room;
    if (r.inMatch && r.matchStart && r.snapshot) {
      joinMatch(r.matchStart);
      applySnapshot(r.snapshot);
      S.lastIntent = null;
      window.BOMBER.syncNetInput();
      return;
    }
    if (S.inMatch) { exitMatchScene(); window.BOMBER.showOverlay('lobby'); }
    showLobbyRoom();
    $('lobby-room-code').textContent = r.room.code;
    renderLobby();
  }

  async function leaveRoom() {
    const code = S.code;
    if (S.inMatch) exitMatchScene();
    clearSession();
    if (S.socket) S.socket.auth = {};
    S.code = null; S.playerId = null; S.myId = null; S.room = null; S.isHost = false;
    showLobbyHome();
    if (code && S.connected) {
      try { await request('room:leave'); } catch (e) { /* seat is gone anyway */ }
    }
    status('Left the room.');
  }

  async function backToMenu() {
    if (S.code) await leaveRoom();
    teardownSocket();
    window.BOMBER.showOverlay('start');
    g().state = 'start';
  }

  async function toggleReady() {
    if (!S.code || !S.room || !S.myId) return;
    const me = S.room.players[S.myId];
    if (!me) return;
    try { await request('lobby:ready', { ready: !me.ready }); }
    catch (e) { status(friendly(e)); }
  }

  async function startMatchCall() {
    if (!S.code) return;
    try { await request('match:start'); }
    catch (e) { status(friendly(e)); toast(friendly(e), 2); }
  }

  async function playAgain() {
    if (!S.isHost) { toast('THE HOST STARTS REMATCHES', 1.6); return; }
    try { await request('match:start'); }
    catch (e) { toast(friendly(e), 2); }
  }

  async function returnToLobbyCall() {
    if (!S.isHost) { toast('THE HOST CONTROLS THE LOBBY', 1.6); return; }
    try { await request('match:return'); }
    catch (e) { toast(friendly(e), 2); }
  }

  async function pushConfig() {
    if (!S.code || !S.room || S.room.hostUid !== S.myId) return;
    const patch = {
      maxPlayers: Number($('sel-max-players').value),
      botCount: Number($('sel-bots').value),
      arenaPreset: $('sel-arena').value,
    };
    try { await request('lobby:config', { patch }); }
    catch (e) { status(friendly(e)); }
  }

  /* Map server ack codes to short, honest messages. The server's own
     error text already arrives via request(); nothing here echoes tokens
     or server internals. */
  function friendly(e) {
    const code = String((e && e.code) || '');
    const msg = String((e && e.message) || '');
    if (/did not answer in time|Not connected|unreachable|npm start/.test(msg)) return msg;
    if (code === 'full') return 'Room is full.';
    if (code === 'closed') return 'That room is not accepting players.';
    if (code === 'not-found') return 'No room with that code.';
    if (code === 'invalid-code') return 'Room codes are 4 letters/numbers.';
    if (code === 'duplicate' || code === 'already-in') return 'You are already in a room — leave it first.';
    if (code === 'unauthorized' || code === 'resume-failed') {
      return 'Your session is no longer valid — join the room again.';
    }
    if (code === 'rate-limit') return 'Slow down — the server throttled that.';
    if (code === 'bad-payload') return 'Malformed request.';
    if (code === 'not-host') return 'Only the host can do that.';
    if (msg) return msg;
    return 'Something went wrong — try again.';
  }

  /* ---------- room view rendering ---------- */

  function onRoom(room) {
    if (!room) {                            // room deleted or we left
      if (S.code && !S.inMatch) {
        S.code = null; S.room = null;
        showLobbyHome();
        status('Room closed.');
      }
      return;
    }
    S.room = room;
    S.isHost = room.hostUid === S.myId;
    if (room.status === 'lobby' && S.inMatch) { openLobbyFromMatch(); return; }
    if (!S.inMatch) renderLobby();
  }

  /* client-side mirror of the server's start check, for button feedback only;
     the server re-validates everything authoritatively. */
  function startWhy(room) {
    const players = Object.values(room.players);
    if (players.some((p) => !p.ready)) return 'Waiting for players to be ready.';
    if (players.length + room.config.botCount < 2) return 'Need 2 participants: a friend or at least one bot.';
    return null;
  }

  function renderLobby() {
    if (!S.room) return;
    showLobbyRoom();
    const room = S.room;
    $('lobby-room-code').textContent = room.code;

    // ---- config selects (host only) ----
    const limit = (window.MULTIPLAYER_CONFIG || {}).ROOM_LIMIT_MAX || 8;
    const selMax = $('sel-max-players'), selBots = $('sel-bots'), selArena = $('sel-arena');
    if (selMax.options.length === 0) {
      for (let n = 2; n <= limit; n++) addOpt(selMax, n, `${n}`);
      for (let n = 0; n <= limit - 2; n++) addOpt(selBots, n, `${n}`);
      (window.LevelGen.PRESET_NAMES || ['mixed']).forEach((p) => addOpt(selArena, p, p));
    }
    selMax.value = room.config.maxPlayers;
    selBots.value = room.config.botCount;
    selArena.value = room.config.arenaPreset;
    const host = S.isHost;
    selMax.disabled = !host; selBots.disabled = !host; selArena.disabled = !host;

    // ---- players ----
    const ul = $('lobby-players');
    ul.innerHTML = '';
    Object.values(room.players)
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))
      .forEach((p) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot'; dot.style.color = p.color;
        const nm = document.createElement('span');
        nm.textContent = shortName(p.name) + (p.uid === S.myId ? ' (you)' : '');
        const st = document.createElement('span');
        if (p.uid === room.hostUid) { st.className = 'state host'; st.textContent = 'HOST'; }
        else if (!p.online) { st.className = 'state lost'; st.textContent = 'OFFLINE'; }
        else if (p.ready) { st.className = 'state ready'; st.textContent = 'READY'; }
        else { st.className = 'state waiting'; st.textContent = 'WAITING'; }
        li.append(dot, nm, st);
        ul.appendChild(li);
      });

    const me = room.players[S.myId];
    $('btn-ready').textContent = (me && me.ready) ? 'NOT READY' : 'READY';
    $('btn-ready').classList.toggle('hidden', !me);
    $('btn-start-match').classList.toggle('hidden', !host);

    const humans = Object.keys(room.players).length;
    const slots = humans + room.config.botCount;
    const why = startWhy(room);
    if (host) {
      $('btn-start-match').disabled = !!why;
      status(why || (slots >= room.config.maxPlayers
        ? 'Slots full — ready to start.'
        : 'All set — start when you are ready.'));
    } else {
      status(`Waiting for the host… (${humans} human${humans === 1 ? '' : 's'} + ${room.config.botCount} bots)`);
    }
  }

  function addOpt(sel, value, label) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    sel.appendChild(o);
  }

  /* ================= battle royale match ================= */

  /* match:start payload (backend/game/sim.js startPayload()):
     { arenaSeed, preset, cols, rows,
       roster: [{ id, name, color, isBot, kind }],
       actors: [{ id, x, y }] }  — pixel coordinates, TILE=48. */
  function joinMatch(start) {
    if (S.inMatch && !S.ended) return;       // already live on the board
    if (S.inMatch && S.ended) exitMatchScene();  // rematch: rebuild from scratch
    S.inMatch = true;
    S.ended = false;
    S.lastSeq = 0;
    S.myAlive = true;
    S.lastIntent = null;
    S.intentX = 0; S.intentY = 0;
    S.inputSeq = 0;
    S.clockOffset = null;

    const G = window.BOMBER;
    const game = G.game;
    G.hideOverlays();
    $('overlay-lobby').classList.add('hidden');   // hideOverlays covers it; belt & braces

    game.mode = 'br';
    game.net = true;                              // update() switches to mirror mode
    game.arenaSeed = start.arenaSeed;
    game.arenaPreset = start.preset;
    G.resetGame(true);                            // same seed → same maze as the server
    game.enemies = [];                            // bots arrive as remotes, not campaign AI
    game.remotes = [];

    S.roster = {};
    start.roster.forEach((r) => { S.roster[r.id] = r; });
    const posOf = (id) => start.actors.find((a) => a.id === id);

    for (const r of start.roster) {
      if (r.id === S.myId) continue;
      const a = posOf(r.id) || { x: 0, y: 0 };
      game.remotes.push({
        id: r.id, name: shortName(r.name), color: r.color,
        kind: r.isBot ? 'bot' : 'human',
        x: a.x, y: a.y, tx: a.x, ty: a.y,
        dir: { x: 1, y: 0 }, dirX: 1, dirY: 0, alive: true,
      });
    }

    const me = posOf(S.myId);
    const p = game.player;
    if (me) { p.x = me.x; p.y = me.y; }
    p.srvX = p.x; p.srvY = p.y;
    p.predX = p.x; p.predY = p.y;
    p.correctionX = 0; p.correctionY = 0;
    p.predTime = 0;
    p.srvDX = 1; p.srvDY = 0;
    p.alive = true; p.dying = 0;
    p.invuln = 1;                                 // blink until the first snapshot
    p.netBombs = 0; p.netKills = 0; p.bombMax = 2;
    p.speedTimer = 0; p.warpTimer = 0; p.chaosTimer = 0; p.droneTimer = 0;
    p.shield = false; p.tosser = false;
    game.state = 'playing';
    game.netLive = { kills: 0, myAlive: true, aliveCount: start.roster.length,
                     aliveOthers: start.roster.length - 1 };

    G.hooks.brFrame = brFrame;
    G.hooks.brIntent = brIntent;
    G.hooks.brAction = brAction;
    clearInterval(S.inputTimer);
    S.inputTimer = setInterval(() => {
      G.syncNetInput();
      sendIntent(true);
    }, INPUT_REFRESH_MS);
    G.syncNetInput();

    S.lastSnapAt = performance.now();
    const feed = $('br-feed');
    if (feed) feed.innerHTML = '';
    $('br-live').classList.remove('hidden');
    toast('BATTLE ROYALE — LAST BOMBER STANDING', 2.4);
  }

  function brFrame(dt) {
    const game = g();
    const p = game.player;
    if (!p) return;
    const speed = MY_SPEED * (p.speedTimer > 0 ? TURBO_MULT : 1);
    const step = S.connected && p.alive !== false
      ? Math.max(0, Math.min(dt, EXTRAPOLATE_CAP - p.predTime)) : 0;
    const predicted = { x: p.predX, y: p.predY };
    window.BOMBER.moveEntity(predicted, S.intentX * speed * step, S.intentY * speed * step, true);
    p.predX = predicted.x; p.predY = predicted.y;
    p.predTime += dt;
    p.correctionX *= Math.exp(-14 * dt);
    p.correctionY *= Math.exp(-14 * dt);
    p.x = p.predX + p.correctionX;
    p.y = p.predY + p.correctionY;
    if (window.BOMBER.boxBlocked(p.x, p.y, true, p)) {
      p.x = p.predX; p.y = p.predY;
      p.correctionX = 0; p.correctionY = 0;
    }
    if (S.intentX || S.intentY) p.dir = { x: S.intentX, y: S.intentY };
    const half = window.BOMBER.TILE * 0.36;
    for (const b of game.bombs) {
      if (b.escapePlayer && (p.predX + half <= b.cellX * 48 ||
          p.predX - half >= (b.cellX + 1) * 48 || p.predY + half <= b.cellY * 48 ||
          p.predY - half >= (b.cellY + 1) * 48)) b.escapePlayer = false;
    }
    const renderTime = performance.now() - S.clockOffset - INTERPOLATION_MS;
    for (const r of game.remotes) {
      const samples = r.samples;
      if (!samples || !samples.length) continue;
      while (samples.length > 2 && samples[1].t <= renderTime) samples.shift();
      const a = samples[0], b = samples[1] || a;
      const fraction = b.t > a.t ? Math.max(0, Math.min(1, (renderTime - a.t) / (b.t - a.t))) : 0;
      r.x = a.x + (b.x - a.x) * fraction;
      r.y = a.y + (b.y - a.y) * fraction;
      r.dir = { x: r.dirX, y: r.dirY };
    }
    if (p.droneTimer > 0 && p.droneTX != null) {
      const dk = Math.min(1, 10 * dt);
      p.droneX += (p.droneTX - p.droneX) * dk;
      p.droneY += (p.droneTY - p.droneY) * dk;
    }
    for (const pk of game.pickups) pk.age += dt;   // keep the bob animating
  }

  function brIntent(vx, vy, force) {
    S.intentX = vx; S.intentY = vy;
    if (force) S.lastIntent = null;
    sendIntent(false);
  }

  function sendIntent(refresh) {
    if (!S.inMatch || S.ended || !S.socket || !S.connected) return;
    const key = `${S.intentX},${S.intentY}`;
    const now = performance.now();
    if (key === S.lastIntent && (!refresh || now - S.lastInputAt < INPUT_REFRESH_MS - 10)) return;
    S.socket.volatile.emit('game:input', {
      type: 'move', dirX: S.intentX, dirY: S.intentY, seq: ++S.inputSeq,
    });
    S.lastIntent = key;
    S.lastInputAt = now;
  }

  function brAction(kind) {
    if (!S.inMatch || S.ended || g().state !== 'playing' || !S.myAlive) return;
    request('game:action', { type: kind }).catch((e) => {
      const code = e.code;
      if (code === 'no-bomb') toast('NO ROOM FOR ANOTHER BOMB', 1.2);
      else if (code === 'no-throw') toast('THROW REFUSED', 1.2);
      else if (code === 'ended') toast('MATCH OVER', 1.2);
      else if (code) toast(String(code).toUpperCase().replace('-', ' '), 1.2);
    });
  }

  /* Snapshot contract (backend/game/sim.js snapshot()):
     { seq, t, alive, ended, winnerId,
       actors:[{id,x,y,dx,dy,alive,bombs,bombMax,shield,invuln,tosser,
                turboMs,warpMs,chaosMs,kills,deaths}],
       bombs:[{uid,owner,cellX,cellY,range,fuseMs,flight|null}],
       flames:[{x,y,m,s,k}], pickups:[{uid,x,y,type}], drones:[{id,x,y}],
       destroyed:[[x,y]], events:[{type,…}] } */
  function applySnapshot(s) {
    const game = g();
    if (!S.inMatch || !game.net || !s) return;
    if (s.seq <= S.lastSeq) return;               // ignore stale/out-of-order
    S.lastSeq = s.seq;
    S.lastSnapAt = performance.now();
    const offset = S.lastSnapAt - s.t;
    if (S.clockOffset == null || Math.abs(offset - S.clockOffset) > INTERPOLATION_MS * 2) {
      S.clockOffset = offset;
    } else {
      S.clockOffset += (offset - S.clockOffset) * 0.1;
    }

    const TILE = window.BOMBER.TILE;
    const p = game.player;
    const byRemote = {};
    for (const r of game.remotes) byRemote[r.id] = r;

    let meA = null;
    for (const a of s.actors) {
      if (a.id === S.myId) {
        meA = a;
        p.srvX = a.x; p.srvY = a.y;
        p.correctionX = Math.max(-24, Math.min(24, p.x - a.x));
        p.correctionY = Math.max(-24, Math.min(24, p.y - a.y));
        p.predX = a.x; p.predY = a.y; p.predTime = 0;
        p.srvDX = a.dx; p.srvDY = a.dy;
        S.inputSeq = Math.max(S.inputSeq, a.inputSeq || 0);
        p.alive = a.alive;
        p.netBombs = a.bombs; p.netKills = a.kills; p.bombMax = a.bombMax;
        p.shield = !!a.shield; p.tosser = !!a.tosser;
        p.invuln = a.invuln ? 1 : 0;              // blink only — the server decides damage
        p.speedTimer = a.turboMs / 1000;
        p.warpTimer = a.warpMs / 1000;
        p.chaosTimer = a.chaosMs / 1000;
      } else {
        const r = byRemote[a.id];
        if (r) {
          r.tx = a.x; r.ty = a.y;
          if (!r.samples) r.samples = [];
          r.samples.push({ t: s.t, x: a.x, y: a.y });
          if (r.samples.length > 8) r.samples.shift();
          r.dirX = a.dx; r.dirY = a.dy;
          r.alive = a.alive;
        }
      }
    }

    const myDrone = s.drones && s.drones.find((d) => d.id === S.myId);
    if (myDrone) {
      p.droneTimer = Math.max(p.droneTimer, 0.3); // decays locally between snapshots
      p.droneTX = myDrone.x; p.droneTY = myDrone.y;
      if (p.droneX == null) { p.droneX = myDrone.x; p.droneY = myDrone.y; }
    }

    game.bombs = (s.bombs || []).map((b) => {
      const out = { uid: b.uid, owner: b.owner, cellX: b.cellX, cellY: b.cellY,
        range: b.range, fuse: b.fuseMs >= 0 ? b.fuseMs / 1000 : 3,
        remote: true, escapePlayer: !!b.escape && b.owner === S.myId,
        dir: { x: 0, y: 0 } };
      if (b.flight) {
        const f = b.flight;
        out.cellX = Math.round((f.tx - TILE / 2) / TILE);
        out.cellY = Math.round((f.ty - TILE / 2) / TILE);
        const dist = Math.hypot(f.tx - f.fx, f.ty - f.fy) / TILE;
        const dur = Math.max(0.08, dist * 0.09);
        out.fuse = 3;                              // fuse starts on landing
        out.fly = { t: f.p * dur, dur, fromX: f.fx, fromY: f.fy };
      }
      return out;
    });
    game.flames = (s.flames || []).map((f) => ({
      cellX: f.x, cellY: f.y, life: f.m / 1000, shape: f.s, kind: f.k,
    }));
    const pickupAges = new Map(game.pickups.map((pk) => [pk.uid, pk.age]));
    game.pickups = (s.pickups || []).map((pk) => ({
      uid: pk.uid, cellX: pk.x, cellY: pk.y, type: pk.type, age: pickupAges.get(pk.uid) || 0,
    }));
    for (const [x, y] of s.fullDestroyed || []) window.BOMBER.applyDestroyedCell(x, y);
    for (const [x, y] of s.destroyed || []) window.BOMBER.applyDestroyedCell(x, y);
    for (const ev of s.events || []) handleEvent(ev);

    const aliveCount = s.alive || 0;
    const meAliveNow = !!(meA && meA.alive);
    S.myAlive = meAliveNow;
    game.netLive = {
      kills: meA ? meA.kills : 0,
      myAlive: meAliveNow,
      aliveCount,
      aliveOthers: Math.max(0, aliveCount - (meAliveNow ? 1 : 0)),
    };
    const liveEl = $('br-alive');
    if (liveEl) {
      liveEl.textContent = `${aliveCount} LEFT · YOU ${meAliveNow ? 'ALIVE' : 'DOWN'} · KILLS ${meA ? meA.kills : 0}`;
    }

    if (s.ended) endMatch(s);
  }

  function handleEvent(ev) {
    const game = g();
    if (ev.type === 'blast') {
      game.shake = Math.min(26, game.shake + 12);
    } else if (ev.type === 'elimination') {
      const by = ev.byId ? shortName((S.roster[ev.byId] || {}).name || '?') : 'THE BLAST';
      pushFeed(`⚡ ${shortName(ev.victim)} ← ${by}`);
      if (ev.victimId === S.myId) toast('YOU WERE ELIMINATED', 2.2);
    } else if (ev.type === 'pickup') {
      const who = ev.actorId === S.myId ? 'YOU'
        : shortName((S.roster[ev.actorId] || {}).name || '?');
      pushFeed(`${who} GRABBED ${String(ev.kind).toUpperCase()}`);
    }
  }

  /* ---------- end screen ---------- */

  function endMatch(s) {
    if (S.ended) return;
    S.ended = true;
    clearInterval(S.inputTimer);
    S.inputTimer = null;
    const game = g();
    game.state = 'gameover';                      // freeze local input; overlay takes over
    const winner = s && s.winnerId ? S.roster[s.winnerId] : null;
    const meWon = !!(winner && winner.id === S.myId);
    const title = $('br-end-title');
    if (!winner) { title.textContent = 'DRAW'; title.className = 'neon-title small danger'; }
    else if (meWon) { title.textContent = 'VICTORY!'; title.className = 'neon-title small victory'; }
    else { title.textContent = `${shortName(winner.name)} WINS`; title.className = 'neon-title small danger'; }

    const rows = (s.actors || []).slice().sort((a, b) =>
      b.kills - a.kills || a.deaths - b.deaths || String(a.id).localeCompare(String(b.id)));
    const myIdx = rows.findIndex((a) => a.id === S.myId);
    const mine = rows[myIdx] || {};
    $('br-end-detail').textContent = meWon
      ? 'Last bomber standing.'
      : `You placed #${(myIdx + 1) || '—'} · ${mine.kills || 0} kill(s) · `
        + (S.myAlive ? 'survived the blast' : 'eliminated');

    const ul = $('br-end-scores');
    ul.innerHTML = '';
    rows.forEach((a, i) => {
      const r = S.roster[a.id] || { name: '?', color: '#94a3b8' };
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot'; dot.style.color = r.color;
      const nm = document.createElement('span');
      nm.textContent = `${i + 1}. ${shortName(r.name)}${a.id === S.myId ? ' (you)' : ''}${r.isBot ? ' ⌁' : ''}`;
      const st = document.createElement('span');
      st.className = 'state ' + (a.alive ? 'ready' : 'lost');
      st.textContent = `${a.kills}K / ${a.deaths}D`;
      li.append(dot, nm, st);
      ul.appendChild(li);
    });

    // Rematch control belongs to the host (the server enforces it too).
    $('btn-br-again').classList.toggle('hidden', !S.isHost);
    $('btn-br-lobby').classList.toggle('hidden', !S.isHost);
    $('overlay-br-end').classList.remove('hidden');
    $('br-live').classList.add('hidden');
    if (!S.isHost) toast('WAITING FOR THE HOST', 2.2);
  }

  /* ---------- leaving the match scene ---------- */

  function exitMatchScene() {
    const G = window.BOMBER;
    const game = G.game;
    S.inMatch = false;
    S.ended = false;
    G.clearHeldInput();
    S.lastIntent = null;
    clearInterval(S.inputTimer);
    S.inputTimer = null;
    game.net = false;
    game.mode = 'campaign';
    game.state = 'start';
    G.hooks.brFrame = null;
    G.hooks.brIntent = null;
    G.hooks.brAction = null;
    game.remotes = [];
    game.bombs = [];
    game.flames = [];
    game.pickups = [];
    game.enemies = [];
    game.netLive = null;
    game.arenaSeed = null;
    game.arenaPreset = null;
    $('br-live').classList.add('hidden');
    $('overlay-br-end').classList.add('hidden');
  }

  function openLobbyFromMatch() {
    exitMatchScene();
    window.BOMBER.showOverlay('lobby');
    if (S.room) renderLobby();
    status('Back in the lobby.');
  }

  /* ================= exports ================= */

  window.NEON_MP = {
    enter,
    _debug: S,                             // console introspection only
  };
})();
