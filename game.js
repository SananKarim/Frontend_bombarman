/* =========================================================================
   NEON BOMBER — a Bomberman-style arcade game in vanilla JavaScript.
   No libraries, no images: everything is drawn on one <canvas>.

   Big picture:
   - The maze is a grid of tiles (EMPTY / SOLID / SOFT).
   - The player and enemies move smoothly in pixels, but bombs and
     explosions live on the grid.
   - Every frame: read input → update entities → update bombs/explosions
     → check damage → check win/lose → render.
   ========================================================================= */
'use strict';

/* ========================= 1. CONSTANTS ========================= */

const TILE       = 48;          // pixel size of one grid tile
const COLS       = 15;          // board width  in tiles
const ROWS       = 13;          // board height in tiles

const PLAYER_SPEED   = 158;     // pixels per second
const ENTITY_HALF    = TILE * 0.36; // half of an entity's collision box
const SNAP_ASSIST    = 10;      // how strongly entities center themselves in corridors

const BOMB_FUSE      = 2.4;     // seconds before a bomb explodes
const BOMB_RANGE     = 2;       // explosion distance in tiles (each direction)
const FLAME_LIFETIME = 0.65;    // seconds the flame stays VISIBLE
const FLAME_DAMAGE_TIME = 0.22; // seconds the flame can actually hurt (150–250ms window)
const PLAYER_HIT_HALF = ENTITY_HALF * 0.7; // smaller box: blasts must clearly overlap you

const RESPAWN_INVULN = 2.5;     // seconds of safety after being hit
const MAX_LIVES      = 3;       // campaign hard cap — rewards never push past it

const SCORE_SOFT     = 10;      // points per destroyed block
const SCORE_ENEMY    = 150;     // points per destroyed enemy
const SCORE_LIFE     = 250;     // victory bonus per remaining life

// ---------- Power-up configuration ----------
const POWERUP_CHANCE       = 0.22;  // chance a destroyed block drops something
const TURBO_MULT           = 1.55;  // Turbo Boots speed multiplier
const TURBO_TIME           = 10;    // seconds; a new pickup REFRESHES to this
const THROW_RANGE          = 3;     // tiles a thrown bomb travels (plus upgrades)
const THROW_POSE_TIME      = 0.25;  // seconds of player throw pose
const SHIELD_ABSORB_INVULN = 1.6;   // grace after the shield shatters (same blast cannot also cost a life)
const MAX_BOMB_RANGE       = 4;     // blast range can never grow past this

// Progression milestones (deterministic — unlike the random power-up drops).
// Reach the threshold during a level and the reward is unlocked once.
const MILESTONES = [
  { kind: 'blocks', need: 5,  id: 'bomb',  label: 'MULTI-BOMB',  text: 'MULTI-BOMB UNLOCKED! +1 bomb' },
  { kind: 'blocks', need: 12, id: 'range', label: 'BIG BLAST',   text: 'BIG BLAST! +1 explosion range' },
  { kind: 'blocks', need: 20, id: 'throw', label: 'POWER THROW', text: 'POWER THROW! bombs fly farther' },
  { kind: 'kills',  need: 4,  id: 'rare',  label: 'GHOST HUNTER', text: 'GHOST HUNTER! shield + 200 pts' },
];

// Weighted picks: common power-ups appear more often than rare ones.
const POWERUPS = [
  { type: 'boots',  weight: 24 },   // Turbo Boots    (common)
  { type: 'shield', weight: 18 },   // Quantum Shield
  { type: 'warp',   weight: 16 },   // Time Warp
  { type: 'chaos',  weight: 14 },   // Chaos Bomb
  { type: 'tosser', weight: 12 },   // Bomb Tosser
  { type: 'drone',  weight: 10 },   // Phantom Drone  (rare)
];

// One entry per level: how many enemies, how fast, and the starting bomb limit.
// Maps for each level come from LevelGen (varied, validated layouts).
const LEVELS = [
  { enemies: 3, speed: 78,  bombMax: 2 },
  { enemies: 4, speed: 86,  bombMax: 2 },
  { enemies: 5, speed: 94,  bombMax: 2 },
  { enemies: 7, speed: 102, bombMax: 2 },
  { enemies: 8, speed: 112, bombMax: 2 },
];

// ---------- Enemy AI ----------
const PATH_INTERVAL    = 0.6;   // seconds between routine path recalculations
const ALERT_BASE       = 150;   // patroller alert radius px (+30 per level)
const TELEGRAPH_TIME   = 0.5;   // '!' warning before a patroller charges
const AGGRO_SPEED_MULT = 1.18;  // charging patroller speed bonus
const AMBUSH_PREDICT   = 2;     // tiles ahead of the player's facing direction
const FLEE_TIME        = 0.8;   // seconds an enemy keeps clear after a nearby blast

// Lightweight visual identity per enemy personality.
const ENEMY_LOOK = { hunter: '#f43f5e', ambush: '#a78bfa', patrol: '#d946ef' };

// ---------- Temporary power-up timing ----------
const TIME_WARP_TIME   = 6;     // seconds enemies move slower
const TIME_WARP_MULT   = 0.45;  // enemy speed multiplier during the warp
const CHAOS_TEMP_TIME  = 10;    // seconds of overcharge when blast range is already capped
const DRONE_TIME       = 8;     // seconds the phantom drone stays out
const DRONE_FIRE_RATE  = 0.5;   // seconds between drone attacks
const DRONE_RANGE      = TILE * 1.35; // how close the drone must get to strike

const T_EMPTY = 0, T_SOLID = 1, T_SOFT = 2;   // tile types

const DIRS = {
  up:    { x:  0, y: -1 },
  down:  { x:  0, y:  1 },
  left:  { x: -1, y:  0 },
  right: { x:  1, y:  0 },
};

/* ========================= 2. DOM REFS ========================= */

const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

const hudEls = {
  score:   document.getElementById('hud-score'),
  level:   document.getElementById('hud-level'),
  lives:   document.getElementById('hud-lives'),
  enemies: document.getElementById('hud-enemies'),
  bombs:   document.getElementById('hud-bombs'),
  progress: document.getElementById('hud-progress'),
  turbo:   document.getElementById('hud-turbo'),
  tosser:  document.getElementById('hud-tosser'),
  shield:  document.getElementById('hud-shield'),
  warp:    document.getElementById('hud-warp'),
  chaos:   document.getElementById('hud-chaos'),
  drone:   document.getElementById('hud-drone'),
};

const overlays = {
  start:    document.getElementById('overlay-start'),
  pause:    document.getElementById('overlay-pause'),
  levelclear: document.getElementById('overlay-levelclear'),
  'restart-confirm': document.getElementById('overlay-restart-confirm'),
  controls: document.getElementById('overlay-controls'),
  settings: document.getElementById('overlay-settings'),
  lobby:    document.getElementById('overlay-lobby'),
  'br-end': document.getElementById('overlay-br-end'),
  gameover: document.getElementById('overlay-gameover'),
  victory:  document.getElementById('overlay-victory'),
};

/* ========================= 3. AUDIO (Web Audio API) =========================
   All sounds are synthesized — no audio files. The AudioContext is only
   created after the first user interaction, as browsers require.
   ========================================================================= */

const Sfx = {
  ctx: null,
  muted: localStorage.getItem('neon-bomber-muted') === '1',

  /** Create/resume the audio context (must be called from a user gesture). */
  ensure() {
    if (this.muted) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;                 // very old browser — game still works
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  /** Play a single oscillator note, optionally sliding to another pitch. */
  tone(freq, dur, { type = 'square', vol = 0.15, slideTo = null, delay = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },

  /** White-noise burst through a low-pass filter — used for explosions. */
  noise(dur, { vol = 0.3, cutoff = 800, delay = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t0);
    filter.frequency.exponentialRampToValueAtTime(60, t0 + dur);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter).connect(gain).connect(this.ctx.destination);
    src.start(t0);
  },

  place()    { this.tone(300, 0.12, { type: 'sine', vol: 0.2, slideTo: 120 }); },
  explode()  { this.noise(0.5, { vol: 0.35, cutoff: 1200 });
               this.tone(90, 0.4, { type: 'sawtooth', vol: 0.18, slideTo: 40 }); },
  enemyDie() { this.tone(700, 0.09, { vol: 0.15 });
               this.tone(450, 0.09, { vol: 0.15, delay: 0.08 });
               this.tone(260, 0.16, { vol: 0.15, delay: 0.16, slideTo: 130 }); },
  hurt()     { this.tone(200, 0.35, { type: 'sawtooth', vol: 0.2, slideTo: 60 }); },
  victory()  { [523, 659, 784, 1047].forEach((f, i) =>
                 this.tone(f, 0.22, { type: 'square', vol: 0.14, delay: i * 0.14 })); },
  gameOver() { [392, 330, 262, 196].forEach((f, i) =>
                 this.tone(f, 0.3, { type: 'triangle', vol: 0.16, delay: i * 0.22 })); },
  collect()  { [660, 880, 1175].forEach((f, i) =>
                 this.tone(f, 0.09, { type: 'square', vol: 0.13, delay: i * 0.06 })); },
  shatter()  { this.noise(0.25, { vol: 0.22, cutoff: 3000 });
               this.tone(1400, 0.25, { type: 'sine', vol: 0.12, slideTo: 250 }); },
  throwBomb(){ this.tone(240, 0.14, { type: 'sine', vol: 0.15, slideTo: 540 }); },
  clank()    { this.tone(180, 0.08, { type: 'square', vol: 0.12, slideTo: 120 }); },
  zap()      { this.tone(980, 0.09, { type: 'sawtooth', vol: 0.12, slideTo: 300 }); },
  unlock()   { [523, 659, 784, 1046].forEach((f, i) =>
                 this.tone(f, 0.12, { type: 'square', vol: 0.14, delay: i * 0.08 })); },
};

/* ========================= 4. GAME STATE ========================= */

const game = {
  state: 'start',        // 'start' | 'playing' | 'paused' | 'levelclear' | 'gameover' | 'victory'
  mode: 'campaign',      // 'campaign' | 'br' (battle royale owns the world in br mode)
  board: [],             // 2D array of tile types
  spawnCells: [],        // validated spawn candidates for the current layout
  arenaSeed: null,       // set for multiplayer: every client builds the same maze
  arenaPreset: null,     // LevelGen preset name; null = rotate per campaign level
  remotes: [],           // multiplayer: [{ id, name, color, x, y, dirX, dirY, alive, kills, rx, ry }]
  player: null,          // { x, y, dir, bombMax, invuln, dying,
                         //   speedTimer, tosser, shield, throwAnim }
  enemies: [],           // [{ x, y, dir, speed, turnTimer }]
  bombs: [],             // [{ cellX, cellY, fuse, escapePlayer, fly? }]
  flames: [],            // [{ cellX, cellY, shape, kind, life, dmg, blast }]
  pickups: [],           // [{ cellX, cellY, type, age }] power-ups on the floor
  particles: [],         // short-lived visual sparks
  trail: [],             // Turbo Boots after-images [{ x, y, life }]
  score: 0,
  lives: 3,
  levelIndex: 0,
  shake: 0,              // screen-shake magnitude, decays each frame
  hitFlash: 0,           // red vignette strength after the player is hurt
  blastSeq: 0,           // incrementing explosion id, used to dedupe damage
  myId: null,            // multiplayer: participant id of the local player
  blocksBroken: 0,       // progression: destructible blocks destroyed this level
  kills: 0,              // progression: enemies destroyed this level
  milestonesDone: [],    // per-level flags, one per MILESTONES entry
  mazeVersion: 0,        // bumped whenever walkability changes → invalidates AI paths
  levelRewarded: [],     // campaign: one +1-life reward per level, never twice
  toast: null,           // { text, life } shown floating on the canvas
  time: 0,               // total elapsed time, used for animations
};

const input = {
  keys: new Set(),       // held direction names ('up', 'down', …) from keyboard
  touchDirs: new Set(),  // held directions from on-screen buttons
};

/* ---- Multiplayer bridge (mp.js installs handlers; campaign ignores) ----
   The engine stays authoritative for LOCAL physics only. Every event the
   network layer must mirror or arbitrate leaves through one of these.   */
const hooks = {
  onBombPlaced: null,     // (bomb)          — my bomb is armed and on a tile
  onBombDetonated: null,  // (bomb)          — a bomb exploded (owner deletes its node)
  onBrickHit: null,       // (bomb, tx, ty)  — br mode: blast hit a soft block
  onPickupTouch: null,    // (pk)            — br mode: I touched a shared pickup
  onEliminated: null,     // (attackerId)    — br mode: local player died
  onBotKilled: null,      // (botEntity, attackerId) — host: a simulated bot died
  brFrame: null,          // (dt)         — net mode: interpolate server-driven actors
  brIntent: null,         // (dirX, dirY) — net mode: my held direction (server owns physics)
  brAction: null,         // ('bomb' | 'throw') — net mode: ask the server for the action
};

/* ========================= 5. BOARD GENERATION ========================= */

/** Cell center in pixels, e.g. tileToWorld(3, 4) → (168, 216). */
function cellCenter(cx, cy) { return { x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 }; }

function buildBoard() {
  // All layouts come from the shared generator so campaign and multiplayer
  // build arenas from identical rules. Campaign seeds are random per level;
  // multiplayer pins game.arenaSeed so every client gets the same maze.
  const preset = game.arenaPreset || LevelGen.presetForLevel(game.levelIndex);
  const seed = game.arenaSeed != null
    ? `${game.arenaSeed}:l${game.levelIndex}`
    : `sp:${Math.floor(Math.random() * 1e9)}`;
  const out = LevelGen.make({ seed, preset, levelIndex: game.levelIndex, cols: COLS, rows: ROWS });
  game.spawnCells = out.spawnCells;
  return out.board;
}

function spawnEnemies() {
  const cfg = LEVELS[game.levelIndex];
  const kinds = ['hunter', 'ambush', 'patrol'];
  const enemies = [];

  // Varied spawn points chosen from the generator's validated candidates:
  // always reachable open floor, clear of the player's safe zone.
  const pool = (game.spawnCells || []).slice();
  const taken = [];
  let guard = 0;
  while (enemies.length < cfg.enemies && pool.length && guard++ < 400) {
    const spot = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    // keep spawns apart so ghosts never stack on one tile
    if (taken.some(t => Math.abs(t.x - spot.x) + Math.abs(t.y - spot.y) < 3)) continue;
    taken.push(spot);
    const pos = cellCenter(spot.x, spot.y);
    enemies.push({ ...pos, dir: { ...DIRS.left }, speed: cfg.speed, turnTimer: 1,
                   kind: kinds[enemies.length % kinds.length],
                   path: null, pathTimer: Math.random() * PATH_INTERVAL, mazeVer: -1,
                   alert: 0, aggro: false, fleeTimer: 0 });
  }
  return enemies;
}

/** Full (re)initialisation: used by Play, Restart and level changes. */
function resetGame(fullRestart) {
  if (fullRestart) {
    game.score = 0;
    game.lives = MAX_LIVES;
    game.levelIndex = 0;
    game.levelRewarded = [];       // rewards are re-earnable only on a fresh campaign
  }
  const cfg = LEVELS[game.levelIndex];
  game.board = buildBoard();
  game.bombs = [];
  game.flames = [];
  game.pickups = [];                     // no power-ups carry over between
  game.trail = [];                       // restarts or level changes
  game.particles = [];
  game.shake = 0;
  game.blocksBroken = 0;               // progression restarts every level
  game.kills = 0;
  game.milestonesDone = MILESTONES.map(() => false);
  game.hitFlash = 0;
  const p = cellCenter(1, 1);
  game.player = { x: p.x, y: p.y, dir: { ...DIRS.right }, bombMax: cfg.bombMax || 2,
                  bombRange: BOMB_RANGE, throwBonus: 0,
                  invuln: RESPAWN_INVULN, dying: 0, lastBlast: 0,
                  speedTimer: 0, tosser: false, shield: false, throwAnim: 0,
                  warpTimer: 0, chaosTimer: 0, droneTimer: 0, droneFire: 0,
                  droneX: p.x, droneY: p.y };
  game.enemies = spawnEnemies();
  game.toast = { text: `LEVEL ${game.levelIndex + 1}`, life: 1.6 };
}

/* ========================= 6. COLLISION HELPERS ========================= */

function tileAt(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return T_SOLID; // outside = wall
  return game.board[ty][tx];
}

// Airborne (thrown) bombs are not ground obstacles yet — they fly over tiles
// and only take effect once they land.
function bombAt(tx, ty) {
  return game.bombs.find(b => !b.fly && b.cellX === tx && b.cellY === ty);
}

/**
 * True if a collision box centered at (x, y) overlaps a wall, a block,
 * or a bomb.
 *
 * Bomb exception: the bomb the player has just placed is NOT solid while
 * the player still overlaps its tile, so they can run away from it
 * (see updateBombEscape). Every other bomb — and this one once the
 * player has fully left its tile — blocks movement normally.
 */
function boxBlocked(x, y, isPlayer, self) {
  const x0 = Math.floor((x - ENTITY_HALF) / TILE), x1 = Math.floor((x + ENTITY_HALF) / TILE);
  const y0 = Math.floor((y - ENTITY_HALF) / TILE), y1 = Math.floor((y + ENTITY_HALF) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (tileAt(tx, ty) !== T_EMPTY) return true;

      const bomb = bombAt(tx, ty);
      if (bomb) {
        // Ignore only the bomb the player is currently escaping from,
        // not other bombs.
        if (isPlayer && bomb.escapePlayer) continue;
        // Multiplayer bots get the same courtesy for the bomb they just set.
        if (self && self.botId && bomb.escapeBot === self.botId) continue;
        return true;
      }
    }
  }
  return false;
}

/**
 * Once the player's collision box completely clears an escaping bomb's
 * tile, that bomb becomes a normal solid obstacle again. Called every
 * frame while playing, so the bomb's fuse keeps running independently
 * of any movement.
 */
function updateBombEscape() {
  const p = game.player;

  for (const bomb of game.bombs) {
    if (!bomb.escapePlayer) continue;

    const left = bomb.cellX * TILE;
    const top = bomb.cellY * TILE;
    const right = left + TILE;
    const bottom = top + TILE;

    const overlaps =
      p.x + ENTITY_HALF > left  && p.x - ENTITY_HALF < right &&
      p.y + ENTITY_HALF > top   && p.y - ENTITY_HALF < bottom;

    if (!overlaps) bomb.escapePlayer = false;   // escape complete — now solid
  }

  // Multiplayer bots get the same escape window on the bomb they just set.
  if (game.mode === 'br') {
    for (const bomb of game.bombs) {
      if (!bomb.escapeBot) continue;
      const bot = game.enemies.find(en => en.botId === bomb.escapeBot);
      if (!bot) { bomb.escapeBot = null; continue; }
      const bcx = Math.floor(bot.x / TILE), bcy = Math.floor(bot.y / TILE);
      if (bcx !== bomb.cellX || bcy !== bomb.cellY) bomb.escapeBot = null;
    }
  }
}

/** Move an entity by (dx, dy) one frame, axis by axis, sliding along walls. */
function moveEntity(e, dx, dy, isPlayer) {
  if (dx !== 0 && !boxBlocked(e.x + dx, e.y, isPlayer, e)) e.x += dx;
  if (dy !== 0 && !boxBlocked(e.x, e.y + dy, isPlayer, e)) e.y += dy;

  // Snap assist: while travelling along one axis, gently center the entity
  // in the corridor so it does not snag on tile corners.
  if (dx !== 0 && dy === 0) {
    const cy = Math.floor(e.y / TILE) * TILE + TILE / 2;
    e.y += (cy - e.y) * Math.min(1, SNAP_ASSIST * (1 / 60));
  } else if (dy !== 0 && dx === 0) {
    const cx = Math.floor(e.x / TILE) * TILE + TILE / 2;
    e.x += (cx - e.x) * Math.min(1, SNAP_ASSIST * (1 / 60));
  }
}

/* ========================= 7. BOMBS & EXPLOSIONS ========================= */

function requestBomb() {
  if (game.state !== 'playing' || game.player.dying > 0) return;
  const mine = game.bombs.filter(b => !b.remote).length;
  if (mine >= game.player.bombMax) return;        // one bomb per finger!
  const cx = Math.floor(game.player.x / TILE);
  const cy = Math.floor(game.player.y / TILE);
  if (bombAt(cx, cy)) return;                     // already a bomb here

  const bomb = { cellX: cx, cellY: cy, fuse: BOMB_FUSE, escapePlayer: true };
  game.bombs.push(bomb);
  game.mazeVersion++;                             // tiles around the bomb re-plan
  Sfx.place();
  if (game.mode === 'br' && hooks.onBombPlaced) hooks.onBombPlaced(bomb);
}

/** Detonate a bomb: build the flame cross, break soft blocks, chain bombs. */
function explodeBomb(bomb) {
  game.bombs = game.bombs.filter(b => b !== bomb);
  game.mazeVersion++;                            // the blast reshapes the maze
  const { cellX, cellY } = bomb;
  if (game.mode === 'br' && hooks.onBombDetonated) hooks.onBombDetonated(bomb);
  // Every flame of this blast shares one id: the same explosion event can
  // only ever damage an entity once.
  const blast = ++game.blastSeq;
  // byId attributes the blast to whoever set the bomb (multiplayer kills).
  const byId = bomb.byId || bomb.owner || null;
  const mkFlame = (x, y, shape, kind) =>
    game.flames.push({ cellX: x, cellY: y, shape, kind, by: byId,
                       life: FLAME_LIFETIME, dmg: FLAME_DAMAGE_TIME, blast });
  mkFlame(cellX, cellY, 'center', 'center');
  shakeScreen(7);
  scareEnemiesNear(cellX, cellY);
  Sfx.explode();

  const directions = [
    { dx: 1, shape: 'h' }, { dx: -1, shape: 'h' },
    { dy: 1, shape: 'v' }, { dy: -1, shape: 'v' },
  ];

  const pNow = game.player;
  // Remote bombs explode at THEIR owner's published range, not ours.
  const range = bomb.range != null
    ? bomb.range
    : (pNow ? Math.min(pNow.bombRange + (pNow.chaosTimer > 0 ? 1 : 0), MAX_BOMB_RANGE + 1) : BOMB_RANGE);
  for (const d of directions) {
    for (let i = 1; i <= range; i++) {
      const tx = cellX + (d.dx || 0) * i;
      const ty = cellY + (d.dy || 0) * i;
      const tile = tileAt(tx, ty);

      if (tile === T_SOLID) break;                       // explosion is blocked

      const last = i === range || tile !== T_EMPTY;     // arm tip / just before a block
      mkFlame(tx, ty, d.shape, last ? 'end' : 'body');

      if (tile === T_SOFT) {
        if (game.mode === 'br') {
          // Single-writer rule: only the bomb's owner reports the destruction.
          // Every client (owner included) applies it through the shared
          // destroyed-blocks feed, so no block is counted or looted twice.
          if (hooks.onBrickHit) hooks.onBrickHit(bomb, tx, ty);
          break;
        }
        game.board[ty][tx] = T_EMPTY;                    // brick crumbles away
        game.score += SCORE_SOFT;
        game.blocksBroken++;
        spawnDebris(tx, ty);
        maybeDropPowerup(tx, ty);                        // lucky bricks reveal power-ups
        break;                                           // soft block absorbs the blast
      }

      const other = bombAt(tx, ty);
      if (other) { other.fuse = 0.05; other.chained = true; break; }   // chain reaction!
    }
  }
  checkMilestones();
}

function updateBombs(dt) {
  for (const b of [...game.bombs]) {
    // Mirror bombs from other clients stay synced to their published
    // detonation instant instead of drifting on our local clock.
    if (b.remote && !b.chained) {
      b.fuse = (b.fuseEnd - Date.now()) / 1000;
      if (b.fuse <= 0) explodeBomb(b);
      continue;
    }
    // A thrown bomb is mid-flight: animate it, but only start the fuse
    // once it has landed on its tile.
    if (b.fly) {
      b.fly.t += dt;
      if (b.fly.t >= b.fly.dur) finishThrow(b);
      continue;
    }
    b.fuse -= dt;
    if (b.fuse <= 0) explodeBomb(b);
  }
}

function updateFlames(dt) {
  for (const f of game.flames) {
    f.life -= dt;
    if (f.dmg > 0) f.dmg = Math.max(0, f.dmg - dt);   // visual outlasts the damage
  }
  game.flames = game.flames.filter(f => f.life > 0);
}

/** Damaging flame that is still inside its short damaging phase, or null. */
function damagingFlameAt(tx, ty) {
  return game.flames.find(f => f.dmg > 0 && f.cellX === tx && f.cellY === ty) || null;
}

/* ========================= 7b. POWER-UPS ========================= */

/** Roll for a drop when a soft block breaks; spawn it on the (now empty) tile. */
function maybeDropPowerup(tx, ty) {
  if (Math.random() >= POWERUP_CHANCE) return;                  // most blocks drop nothing
  if (game.board[ty][tx] !== T_EMPTY) return;                   // never inside a wall
  if (bombAt(tx, ty) || pickupAt(tx, ty)) return;               // tile must be free
  const type = weightedPowerupRoll();
  game.pickups.push({ cellX: tx, cellY: ty, type, age: 0 });
}

function weightedPowerupRoll() {
  const total = POWERUPS.reduce((sum, p) => sum + p.weight, 0);
  let roll = Math.random() * total;
  for (const p of POWERUPS) {
    roll -= p.weight;
    if (roll <= 0) return p.type;
  }
  return POWERUPS[0].type;
}

function pickupAt(tx, ty) {
  return game.pickups.find(pk => pk.cellX === tx && pk.cellY === ty);
}

function applyPowerup(type) {
  const p = game.player;
  Sfx.collect();
  addParticles(p.x, p.y, 16, '#67e8f9', 170);
  if (type === 'boots') {
    // Rule: a new pair always REFRESHES the timer to the full duration.
    p.speedTimer = TURBO_TIME;
    game.toast = { text: 'TURBO BOOTS!', life: 1.4 };
  } else if (type === 'tosser') {
    if (p.tosser) {                            // duplicate permanent → bonus score
      game.score += 100;
      game.toast = { text: 'TOSSER UPGRADE +100', life: 1.4 };
    } else {
      p.tosser = true;                         // lasts the current level
      game.toast = { text: 'BOMB TOSSER! press Z', life: 1.8 };
    }
  } else if (type === 'shield') {
    if (p.shield) {                            // already armed → bonus score
      game.score += 100;
      game.toast = { text: 'SHIELD ALREADY UP +100', life: 1.4 };
    } else {
      p.shield = true;                         // absorbs one hit
      game.toast = { text: 'QUANTUM SHIELD!', life: 1.4 };
    }
  } else if (type === 'warp') {
    p.warpTimer = TIME_WARP_TIME;              // refresh: enemies crawl for a while
    game.toast = { text: 'TIME WARP!', life: 1.4 };
  } else if (type === 'chaos') {
    if (p.bombRange < MAX_BOMB_RANGE) {        // permanent-per-level upgrade
      p.bombRange += 1;
      game.toast = { text: 'CHAOS BOMB! +1 BLAST RANGE', life: 1.6 };
    } else {                                   // capped → temporary overcharge
      p.chaosTimer = CHAOS_TEMP_TIME;
      game.toast = { text: 'CHAOS OVERCHARGE! 10s', life: 1.6 };
    }
  } else if (type === 'drone') {
    p.droneTimer = DRONE_TIME;                 // refreshes the escort
    p.droneFire = 0;
    p.droneX = p.x; p.droneY = p.y;
    game.toast = { text: 'PHANTOM DRONE!', life: 1.4 };
  }
}

/* ---- Progression milestones (deterministic, tracked per level) ---- */

function checkMilestones() {
  MILESTONES.forEach((m, i) => {
    if (game.milestonesDone[i]) return;
    const value = m.kind === 'blocks' ? game.blocksBroken : game.kills;
    if (value >= m.need) {
      game.milestonesDone[i] = true;
      grantMilestone(m);
    }
  });
}

function grantMilestone(m) {
  const p = game.player;
  if (m.id === 'bomb') {
    p.bombMax += 1;
  } else if (m.id === 'range') {
    if (p.bombRange >= MAX_BOMB_RANGE) game.score += 250;   // capped → convert to points
    else p.bombRange += 1;
  } else if (m.id === 'throw') {
    p.tosser = true;
    p.throwBonus += 2;
  } else if (m.id === 'rare') {
    p.shield = true;
    game.score += 200;
  }
  addParticles(p.x, p.y, 26, '#fde047', 210);   // golden unlock burst
  shakeScreen(4);
  Sfx.unlock();
  game.toast = { text: m.text, life: 2.0 };
  updateHud();                                   // HUD reflects new capacity right away
}

/** Text for the HUD: the next milestone the player is working toward. */
function milestoneProgressText() {
  const next = MILESTONES.find((m, i) => !game.milestonesDone[i]);
  if (!next) return 'ALL UP';
  const value = Math.min(next.kind === 'blocks' ? game.blocksBroken : game.kills, next.need);
  return `${value}/${next.need} ${next.kind} — ${next.label}`;
}

/** Phantom Drone: an orb that trails the player and zaps nearby enemies. */
function updateDrone(dt) {
  const p = game.player;
  if (p.droneTimer <= 0) return;
  p.droneFire = Math.max(0, p.droneFire - dt);

  const tx = p.x - p.dir.x * TILE * 0.9;
  const ty = p.y - p.dir.y * TILE * 0.9 - 14;
  const k = Math.min(1, 6 * dt);
  p.droneX += (tx - p.droneX) * k;
  p.droneY += (ty - p.droneY) * k;

  if (p.droneFire <= 0) {
    let best = null, bd = DRONE_RANGE;
    for (const e of game.enemies) {
      const d = Math.hypot(e.x - p.droneX, e.y - p.droneY);
      if (d < bd) { bd = d; best = e; }
    }
    if (best) {
      p.droneFire = DRONE_FIRE_RATE;
      addParticles(p.droneX, p.droneY, 6, '#a7f3d0', 120);
      Sfx.zap();
      killEnemy(best);
    }
  }
}

/** Pickups float, glow, and are collected on touch. */
function updatePickups(dt) {
  const p = game.player;
  for (const pk of game.pickups) pk.age += dt;
  if (p.dying > 0) return;
  if (game.mode === 'br') {
    // Multiplayer: touching only DECLARES a claim — the shared pickupTaken
    // node decides who actually gets the reward (first write wins), so two
    // clients grabbing the same token can never both collect it.
    if (hooks.onPickupTouch) for (const pk of game.pickups) {
      if (pk.claimed) continue;
      const c = cellCenter(pk.cellX, pk.cellY);
      if (Math.hypot(p.x - c.x, p.y - c.y) < TILE * 0.8) {
        pk.claimed = true;
        hooks.onPickupTouch(pk);
      }
    }
    return;
  }
  for (let i = game.pickups.length - 1; i >= 0; i--) {
    const pk = game.pickups[i];
    const c = cellCenter(pk.cellX, pk.cellY);
    if (Math.hypot(p.x - c.x, p.y - c.y) < TILE * 0.8) {
      game.pickups.splice(i, 1);
      applyPowerup(pk.type);
    }
  }
}

/**
 * Bomb Tosser: hurl a bomb THROW_RANGE tiles in the facing direction.
 * The projectile flies through the AIR — straight over walls and blocks —
 * and only becomes a real ground bomb (fuse running, tile blocking) when it
 * lands. The landing tile is the farthest valid one on the trajectory; if
 * none exists the throw is cancelled with feedback.
 */
function throwBomb() {
  const p = game.player;
  if (game.state !== 'playing' || !p.tosser || p.dying > 0) return;
  const mine = game.bombs.filter(b => !b.remote).length;
  if (mine >= p.bombMax) return;   // airborne bombs count toward the limit

  const startCx = Math.floor(p.x / TILE), startCy = Math.floor(p.y / TILE);
  const dx = p.dir.x, dy = p.dir.y;
  const range = THROW_RANGE + (p.throwBonus || 0);

  // Farthest valid landing tile along the straight trajectory.
  let landI = 0;
  for (let i = range; i >= 1; i--)
    if (landingValid(startCx + dx * i, startCy + dy * i)) { landI = i; break; }
  if (!landI) {                                 // every tile blocked → cancel, no bomb
    game.toast = { text: 'NO ROOM TO TOSS', life: 1.0 };
    Sfx.clank();
    return;
  }

  game.bombs.push({
    cellX: startCx + dx * landI, cellY: startCy + dy * landI,   // planned landing tile
    fuse: BOMB_FUSE, escapePlayer: false,
    fly: { fromX: p.x, fromY: p.y, t: 0, dur: 0.09 * landI,   // flight is NOT the fuse
           startCx, startCy, dx, dy, maxI: landI },
  });
  p.throwAnim = THROW_POSE_TIME;                               // short throw pose
  Sfx.throwBomb();
}

/** A bomb may only REST on a free, unoccupied tile. */
function landingValid(tx, ty) {
  if (tileAt(tx, ty) !== T_EMPTY || bombAt(tx, ty) || pickupAt(tx, ty)) return false;
  for (const e of game.enemies)
    if (Math.floor(e.x / TILE) === tx && Math.floor(e.y / TILE) === ty) return false;
  return true;
}

/** Touchdown: re-validate (the maze may have changed mid-flight), then arm. */
function finishThrow(b) {
  const f = b.fly;
  let land = null;
  for (let i = f.maxI; i >= 1; i--) {
    const tx = f.startCx + f.dx * i, ty = f.startCy + f.dy * i;
    if (landingValid(tx, ty)) { land = { tx, ty }; break; }
  }
  if (!land) {                                  // became fully blocked: drop at feet
    land = { tx: Math.floor(game.player.x / TILE), ty: Math.floor(game.player.y / TILE) };
  }
  delete b.fly;                                 // now a normal ground bomb
  game.mazeVersion++;
  b.cellX = land.tx; b.cellY = land.ty;
  b.fuse = BOMB_FUSE;                           // fuse starts on landing
  b.escapePlayer = tileOverlapsPlayer(b.cellX, b.cellY);
  b.thrown = true;
  Sfx.place();
  if (game.mode === 'br' && hooks.onBombPlaced) hooks.onBombPlaced(b);
}

function tileOverlapsPlayer(tx, ty) {
  const p = game.player;
  return p.x + ENTITY_HALF > tx * TILE && p.x - ENTITY_HALF < (tx + 1) * TILE &&
         p.y + ENTITY_HALF > ty * TILE && p.y - ENTITY_HALF < (ty + 1) * TILE;
}

/* ========================= 8. PARTICLES ========================= */

function addParticles(x, y, count, color, speed) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random() * 0.7);
    game.particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 0.4 + Math.random() * 0.5, maxLife: 0.9, color,
      size: 2 + Math.random() * 3,
    });
  }
}

function spawnDebris(tx, ty) {
  const c = cellCenter(tx, ty);
  addParticles(c.x, c.y, 10, '#c084fc', 140);
}

function updateParticles(dt) {
  for (const p of game.particles) {
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += 260 * dt;                    // light gravity
    p.life -= dt;
  }
  game.particles = game.particles.filter(p => p.life > 0);
}

function shakeScreen(mag) { game.shake = Math.max(game.shake, mag); }

/* ========================= 9. ENEMY AI ========================= */

/**
 * Breadth-first search over the tile grid. Walls, destructible blocks and
 * grounded bombs are impassable. Returns the path as an array of [x, y]
 * cells (goal included, start excluded), or null when unreachable.
 */
function bfsPath(fromCx, fromCy, toCx, toCy) {
  if (fromCx === toCx && fromCy === toCy) return [];
  const id = (x, y) => y * COLS + x;
  const walkable = (x, y) => tileAt(x, y) === T_EMPTY && !bombAt(x, y);
  if (!walkable(toCx, toCy)) return null;

  const cameFrom = new Map();
  cameFrom.set(id(fromCx, fromCy), null);
  const queue = [[fromCx, fromCy]];
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head];
    for (const d of Object.values(DIRS)) {
      const nx = x + d.x, ny = y + d.y;
      if (cameFrom.has(id(nx, ny)) || !walkable(nx, ny)) continue;
      cameFrom.set(id(nx, ny), [x, y]);
      if (nx === toCx && ny === toCy) {
        const path = [];
        let cur = [toCx, toCy];
        while (cur && !(cur[0] === fromCx && cur[1] === fromCy)) {
          path.push(cur);
          cur = cameFrom.get(id(cur[0], cur[1]));
        }
        return path.reverse();
      }
      queue.push([nx, ny]);
    }
  }
  return null;   // player genuinely unreachable — callers fall back
}

/** Where this enemy type actually wants to go, as a cell. */
function enemyTargetCell(e, p) {
  const pcx = Math.floor(p.x / TILE), pcy = Math.floor(p.y / TILE);
  if (e.kind === 'ambush' && p.dying <= 0) {
    // Predict where the player is heading and try to cut them off there.
    const ahead = AMBUSH_PREDICT + (e.aggro ? 1 : 0);
    let tx = pcx, ty = pcy;
    for (let i = 1; i <= ahead; i++) {
      const nx = pcx + p.dir.x * i, ny = pcy + p.dir.y * i;
      if (tileAt(nx, ny) !== T_EMPTY || bombAt(nx, ny)) break;
      tx = nx; ty = ny;
    }
    return { x: tx, y: ty };
  }
  return { x: pcx, y: pcy };   // hunter — and patroller once it charges
}

/**
 * Follow the front of e.path toward its waypoint center. Returns false when
 * the path is missing/blocked and the caller should steer with wander logic.
 */
function steerAlongPath(e, dt, speed) {
  if (!e.path || e.path.length === 0) return false;
  const [cx, cy] = e.path[0];
  if (tileAt(cx, cy) !== T_EMPTY || bombAt(cx, cy)) {  // route just got blocked
    e.path = null;
    e.pathTimer = 0;
    return false;
  }
  const c = cellCenter(cx, cy);
  const dx = c.x - e.x, dy = c.y - e.y;
  const dist = Math.hypot(dx, dy);
  const stepLen = Math.max(speed * dt, 0.5);
  if (dist <= stepLen) {
    e.x = c.x; e.y = c.y;          // arrive exactly on the tile center
    e.path.shift();
    if (e.path.length === 0) e.pathTimer = 0;   // reached end → replan now
  } else {
    e.dir = { x: Math.round(dx / dist), y: Math.round(dy / dist) };
    moveEntity(e, dx / dist * stepLen, dy / dist * stepLen, false);
  }
  return true;
}

/** Classic timer-driven wander, used when no path exists (or while fleeing). */
function wanderEnemy(e, dt) {
  e.turnTimer -= dt;
  if (e.turnTimer <= 0) {
    e.turnTimer = 0.5 + Math.random() * 0.9;
    const options = Object.values(DIRS).filter(d =>
      !(d.x === -e.dir.x && d.y === -e.dir.y));   // prefer not to double back
    e.dir = options[Math.floor(Math.random() * options.length)];
  }
  const before = { x: e.x, y: e.y };
  moveEntity(e, e.dir.x * e.speed * dt, e.dir.y * e.speed * dt, false);
  if (before.x === e.x && before.y === e.y) e.turnTimer = 0;   // wall ahead → rethink
}

/** Battle royale: which living competitor is closest to (x, y)?
    Bots (host-simulated enemies) hunt the nearest human, not the host. */
function nearestCombatant(x, y) {
  const p = game.player;
  let best = p, bd = Math.hypot(p.x - x, p.y - y);
  for (const r of game.remotes) {
    if (!r.alive || r.kind === 'bot') continue;
    const d = Math.hypot(r.x - x, r.y - y);
    if (d < bd) {
      bd = d;
      // Player-shaped proxy so the existing AI target logic just works.
      best = { x: r.x, y: r.y, dir: r.dir || { x: 1, y: 0 }, dying: 0 };
    }
  }
  return best;
}

function updateEnemies(dt) {
  const p0 = game.player;
  const alertRange = ALERT_BASE + game.levelIndex * 30;       // grows per level
  const slow = p0.warpTimer > 0 ? TIME_WARP_MULT : 1;          // Time Warp
  for (const e of game.enemies) {
    // In br mode bots always chase the nearest competitor.
    const p = game.mode === 'br' ? nearestCombatant(e.x, e.y) : p0;
    const distToPlayer = Math.hypot(p.x - e.x, p.y - e.y);
    const chasing = p.dying <= 0;

    if (e.fleeTimer > 0) e.fleeTimer = Math.max(0, e.fleeTimer - dt);
    if (e.alert > 0) e.alert = Math.max(0, e.alert - dt);

    // ----- personality state machine -----
    if (e.kind === 'patrol') {
      // Patrol until the player comes close; telegraph, then charge.
      if (!e.aggro && distToPlayer < alertRange && chasing) {
        e.aggro = true;
        e.alert = TELEGRAPH_TIME;                 // '!' flashes first
      } else if (e.aggro && distToPlayer > alertRange * 1.6) {
        e.aggro = false;                          // lost them → back to patrol
      }
    } else if (e.kind === 'ambush') {
      e.aggro = distToPlayer < alertRange * 1.4 && chasing;   // press harder up close
    }

    const wantsPath =
      e.kind === 'hunter' ||
      (e.kind === 'ambush') ||
      (e.kind === 'patrol' && e.aggro && e.alert <= 0);       // charge only after the telegraph

    // ----- path planning (interval-based, never per-frame for its own sake) -----
    e.pathTimer -= dt;
    if (e.fleeTimer <= 0 && wantsPath &&
        (e.pathTimer <= 0 || e.mazeVer !== game.mazeVersion)) {
      e.pathTimer = PATH_INTERVAL;
      e.mazeVer = game.mazeVersion;
      const ecx = Math.floor(e.x / TILE), ecy = Math.floor(e.y / TILE);
      const t = enemyTargetCell(e, p);
      const path = bfsPath(ecx, ecy, t.x, t.y);
      e.path = path && path.length ? path : null;  // null → wander fallback
    }

    // ----- movement -----
    if (e.fleeTimer > 0) { wanderEnemy(e, dt); continue; }
    const speed = e.speed * slow * (e.aggro && e.kind !== 'ambush' ? AGGRO_SPEED_MULT : 1);
    if (!steerAlongPath(e, dt, speed)) wanderEnemy(e, dt);
  }
}

/** Called from explodeBomb: neighbours scatter instead of walking into fire. */
function scareEnemiesNear(cellX, cellY) {
  for (const e of game.enemies) {
    const ecx = Math.floor(e.x / TILE), ecy = Math.floor(e.y / TILE);
    if (Math.abs(ecx - cellX) + Math.abs(ecy - cellY) <= BOMB_RANGE + 2) {
      e.fleeTimer = FLEE_TIME;
      e.path = null;
      e.turnTimer = 0;
    }
  }
}

/* ========================= 10. DAMAGE, WIN / LOSE ========================= */

/** Damaging flame under the player's (reduced) hurtbox, or null.
    Using PLAYER_HIT_HALF means merely grazing a blast with the sprite's
    corner — or float-point wobble at a tile boundary — is not enough. */
function playerBlastHit() {
  const p = game.player;
  const x0 = Math.floor((p.x - PLAYER_HIT_HALF) / TILE), x1 = Math.floor((p.x + PLAYER_HIT_HALF) / TILE);
  const y0 = Math.floor((p.y - PLAYER_HIT_HALF) / TILE), y1 = Math.floor((p.y + PLAYER_HIT_HALF) / TILE);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const f = damagingFlameAt(tx, ty);
      if (f) return f;
    }
  return null;
}

function updateDamage(dt) {
  const p = game.player;

  // Explosions kill enemies instantly, even while the player is safe.
  for (const e of game.enemies) {
    const cx = Math.floor(e.x / TILE), cy = Math.floor(e.y / TILE);
    const f = damagingFlameAt(cx, cy);
    if (f) killEnemy(e, f.by);
  }
  game.enemies = game.enemies.filter(e => !e.dead);

  if (p.dying > 0) return;                       // already dying this round
  if (p.invuln > 0) { p.invuln -= dt; return; }  // post-respawn grace period

  const blast = playerBlastHit();
  if (blast) {
    // Same explosion event can never damage the player twice — even if
    // the shield absorbed it or a neighbouring flame cell also overlaps.
    if (blast.blast !== p.lastBlast) hurtPlayer(blast.blast, blast.by);
    return;
  }

  if (game.mode === 'br') {
    // A bot walking into me is lethal: bots are host-simulated enemies here,
    // and remote bot snapshots for everyone else. Victim-side check only —
    // the player being killed is the one who declares the death.
    for (const e of game.enemies)
      if (e.botId && Math.hypot(e.x - p.x, e.y - p.y) < TILE * 0.78) {
        hurtPlayer(0, e.botId); return;
      }
    for (const r of game.remotes) {
      if (r.kind === 'bot' && r.alive && Math.hypot(r.x - p.x, r.y - p.y) < TILE * 0.78) {
        hurtPlayer(0, r.id); return;
      }
    }
    return;
  }

  // A touching ghost hurts too (no blast id: invulnerability does the gating).
  for (const e of game.enemies)
    if (Math.hypot(e.x - p.x, e.y - p.y) < TILE * 0.78) { hurtPlayer(0, e.botId || null); break; }
}

function killEnemy(e, by) {
  if (e.dead) return;
  if (game.mode === 'br' && e.botId) {
    // Multiplayer bots are host-owned: no campaign score, the host reports
    // the elimination through the trusted backend instead.
    e.dead = true;
    addParticles(e.x, e.y, 22, '#f0abfc', 190);
    Sfx.enemyDie();
    if (hooks.onBotKilled) hooks.onBotKilled(e, by || null);
    return;
  }
  e.dead = true;
  game.score += SCORE_ENEMY;
  game.kills++;
  addParticles(e.x, e.y, 22, '#f0abfc', 190);
  Sfx.enemyDie();
  checkMilestones();
}

function hurtPlayer(blast, by) {
  const p = game.player;
  p.lastBlast = blast;   // remembered even on shield-absorb or invuln rounds

  // The Quantum Shield eats exactly one hit and buys a short grace
  // window, so the same explosion cannot also cost a life.
  if (p.shield) {
    p.shield = false;
    p.invuln = SHIELD_ABSORB_INVULN;
    addParticles(p.x, p.y, 30, '#67e8f9', 240);
    shakeScreen(6);
    Sfx.shatter();
    game.toast = { text: 'SHIELD SHATTERED!', life: 1.2 };
    return;
  }

  if (game.mode === 'br') {
    // Battle royale: one unshielded hit eliminates. The victim declares its
    // own death locally and the trusted backend finalises winner state.
    p.dying = 999;
    game.hitFlash = 0.5;
    Sfx.hurt();
    shakeScreen(12);
    addParticles(p.x, p.y, 30, '#ffffff', 220);
    if (hooks.onEliminated) hooks.onEliminated(by || null);
    return;
  }

  game.lives -= 1;
  game.hitFlash = 0.4;                       // brief red vignette: hit feedback
  Sfx.hurt();
  shakeScreen(10);
  addParticles(p.x, p.y, 24, '#ffffff', 200);

  if (game.lives <= 0) {
    p.dying = 999;                               // stay dead
    game.state = 'gameover';
    Sfx.gameOver();
    showOverlay('gameover');
    document.getElementById('final-score-loss').textContent = game.score;
  } else {
    // Respawn at the safe corner with a short grace period.
    const c = cellCenter(1, 1);
    p.x = c.x; p.y = c.y;
    p.invuln = RESPAWN_INVULN;
    game.toast = { text: `${game.lives} ${game.lives === 1 ? 'LIFE' : 'LIVES'} LEFT`, life: 1.4 };
  }
}

/** Clearing a level grants exactly one extra life — never more than MAX_LIVES. */
function grantLevelReward() {
  const li = game.levelIndex;
  if (game.levelRewarded[li]) return false;      // this clear already paid out
  game.levelRewarded[li] = true;
  if (game.lives < MAX_LIVES) {
    game.lives += 1;
    const p = game.player;
    addParticles(p.x, p.y, 20, '#f87171', 180);
    game.toast = { text: '+1 LIFE!', life: 1.6 };
    return true;
  }
  game.score += 150;                              // already at the cap → points
  game.toast = { text: 'LIVES FULL +150', life: 1.6 };
  return false;
}

function checkLevelOutcome() {
  if (game.mode !== 'campaign') return;   // battle royale owns its own end rules
  if (game.state !== 'playing') return;
  if (game.enemies.length > 0) return;
  const gotLife = grantLevelReward();
  if (game.levelIndex < LEVELS.length - 1) {
    game.state = 'levelclear';
    Sfx.unlock();
    showOverlay('levelclear');
    document.getElementById('levelclear-num').textContent   = game.levelIndex + 1;
    document.getElementById('levelclear-score').textContent = game.score;
    document.getElementById('levelclear-lives').textContent = game.lives;
    document.getElementById('levelclear-reward').textContent =
      gotLife ? 'BONUS: +1 LIFE' : 'BONUS: +150 PTS (LIVES FULL)';
    updateHud();
  } else {
    game.score += game.lives * SCORE_LIFE;
    game.state = 'victory';
    Sfx.victory();
    showOverlay('victory');
    document.getElementById('final-score-win').textContent = game.score;
  }
}

/** Level-complete screen → next campaign level (fresh maze, temp effects off). */
function nextLevel() {
  if (game.state !== 'levelclear') return;
  game.levelIndex += 1;
  resetGame(false);                 // rebuilds player: timers/shield/tosser reset
  game.state = 'playing';
  hideOverlays();
  updateHud();
}

/* ========================= 10b. MULTIPLAYER GLUE =========================
   Remote competitors arrive as compact snapshots (see mp.js). We keep a
   render position that eases toward the latest received target position —
   that interpolation is what makes a 10 Hz network feel like 60 fps play.
   ========================================================================= */

function updateRemotes(dt) {
  if (game.mode !== 'br') return;
  const k = Math.min(1, 12 * dt);
  for (const r of game.remotes) {
    if (!r.alive) continue;                 // dead players freeze where they fell
    r.x += (r.tx - r.x) * k;
    r.y += (r.ty - r.y) * k;
    if (r.dirX != null) r.dir = { x: r.dirX, y: r.dirY };
  }
}

/** Apply one destroyed-block event from the shared feed (idempotent). */
function applyDestroyedCell(tx, ty) {
  if (!game.board[ty] || game.board[ty][tx] !== T_SOFT) return;  // already handled
  game.board[ty][tx] = T_EMPTY;
  game.mazeVersion++;
  spawnDebris(tx, ty);
  game.blocksBroken++;
  checkMilestones();
}

/* ========================= 11. MAIN UPDATE ========================= */

function update(dt) {
  game.time += dt;
  if (game.toast) { game.toast.life -= dt; if (game.toast.life <= 0) game.toast = null; }
  updateParticles(dt);
  game.shake = Math.max(0, game.shake - 26 * dt);
  game.hitFlash = Math.max(0, game.hitFlash - 1.6 * dt);
  if (game.state !== 'playing') return;

  // --- Player movement from held keys / touch buttons ---
  const p = game.player;

  // Power-up timers (pickups REFRESH, then simply decay).
  if (p.speedTimer > 0) p.speedTimer = Math.max(0, p.speedTimer - dt);
  if (p.warpTimer > 0)  p.warpTimer  = Math.max(0, p.warpTimer - dt);
  if (p.chaosTimer > 0) p.chaosTimer = Math.max(0, p.chaosTimer - dt);
  if (p.droneTimer > 0) p.droneTimer = Math.max(0, p.droneTimer - dt);
  if (p.throwAnim > 0) p.throwAnim = Math.max(0, p.throwAnim - dt);

  if (game.net) {
    // Server-authoritative match: this client never runs gameplay physics.
    // It mirrors snapshots (mp.js), smooths actors, and uploads input only.
    updateRemotes(dt);
    if (hooks.brFrame) hooks.brFrame(dt);
    let ix = 0, iy = 0;
    for (const name of [...input.keys, ...input.touchDirs]) {
      const d = DIRS[name];
      if (d) { ix = d.x; iy = d.y; p.dir = d; break; }   // first held direction wins
    }
    if (hooks.brIntent) hooks.brIntent(ix, iy);
    for (const b of game.bombs) {          // visual-only fuse/flight decay
      b.fuse -= dt;
      if (b.fly) b.fly.t += dt;
    }
    updateFlames(dt);                      // animation only; damage is server-side
    for (const t of game.trail) t.life -= dt;
    game.trail = game.trail.filter(t => t.life > 0);
    return;
  }

  updateDrone(dt);
  updateRemotes(dt);

  if (p.dying <= 0) {
    const held = [...input.keys, ...input.touchDirs];
    let vx = 0, vy = 0;
    for (const name of held) {
      const d = DIRS[name];
      if (d) { vx = d.x; vy = d.y; p.dir = d; break; }   // first held direction wins
    }
    if (vx !== 0 || vy !== 0) {
      const speed = PLAYER_SPEED * (p.speedTimer > 0 ? TURBO_MULT : 1);
      moveEntity(p, vx * speed * dt, vy * speed * dt, true);
      if (p.speedTimer > 0) game.trail.push({ x: p.x, y: p.y, life: 0.3 });
    }
  }

  // Solidify escaped bombs (player's or a multiplayer bot's) once their
  // owner has fully left the tile — runs even while the player is dead.
  updateBombEscape();

  // Fade the Turbo trail after-images.
  for (const t of game.trail) t.life -= dt;
  game.trail = game.trail.filter(t => t.life > 0);

  updateBombs(dt);
  updateFlames(dt);
  updateEnemies(dt);
  updatePickups(dt);
  updateDamage(dt);
  checkLevelOutcome();
}

/* ========================= 12. RENDERING =========================
   Everything is drawn with Canvas shapes + glow (shadowBlur).
   ========================================================================= */

function drawTile(x, y, type) {
  const px = x * TILE, py = y * TILE;

  if (type === T_EMPTY) {
    // Dark floor tile with a faint grid line.
    ctx.fillStyle = '#0a0d1c';
    ctx.fillRect(px, py, TILE, TILE);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.06)';
    ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
    return;
  }

  if (type === T_SOLID) {
    // Steel pillar: beveled grey block with a cool edge light.
    const g = ctx.createLinearGradient(px, py, px, py + TILE);
    g.addColorStop(0, '#3c4358');
    g.addColorStop(1, '#20222e');
    ctx.fillStyle = g;
    ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(px + 2, py + 2, TILE - 4, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(px + 2, py + TILE - 7, TILE - 4, 5);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.strokeRect(px + 2.5, py + 2.5, TILE - 5, TILE - 5);
    return;
  }

  // T_SOFT: breakable neon-brick block.
  const g = ctx.createLinearGradient(px, py, px, py + TILE);
  g.addColorStop(0, '#5b1f66');
  g.addColorStop(1, '#33113f');
  ctx.fillStyle = g;
  ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
  // brick seams
  ctx.strokeStyle = 'rgba(240, 171, 252, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px + 2, py + TILE / 2); ctx.lineTo(px + TILE - 2, py + TILE / 2);
  ctx.moveTo(px + TILE / 2, py + 2); ctx.lineTo(px + TILE / 2, py + TILE / 2);
  ctx.moveTo(px + TILE / 4, py + TILE / 2); ctx.lineTo(px + TILE / 4, py + TILE - 2);
  ctx.moveTo(px + TILE * 0.75, py + TILE / 2); ctx.lineTo(px + TILE * 0.75, py + TILE - 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(240, 171, 252, 0.5)';
  ctx.strokeRect(px + 2.5, py + 2.5, TILE - 5, TILE - 5);
  ctx.lineWidth = 1;
}

function drawBoard() {
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      drawTile(x, y, game.board[y][x]);
}

function drawBombs() {
  for (const b of game.bombs) {
    const pulse = 1 + Math.sin(game.time * 8) * 0.06;
    const urgent = b.fuse < 0.8 && Math.sin(game.time * 22) > 0;
    const r = TILE * 0.32 * pulse;

    // In-flight (thrown) bombs slide from the player to their landing
    // tile with a small arc; landed bombs sit on their tile center.
    const c = cellCenter(b.cellX, b.cellY);
    if (b.fly) {
      const prog = Math.min(1, b.fly.t / b.fly.dur);
      const groundX = b.fly.fromX + (c.x - b.fly.fromX) * prog;
      const groundY = b.fly.fromY + (c.y - b.fly.fromY) * prog;
      c.x = groundX;
      c.y = groundY - Math.sin(prog * Math.PI) * 18;

      // Projected landing marker: rotating dashed ring on the target tile.
      ctx.save();
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -game.time * 24;
      const landC = cellCenter(b.cellX, b.cellY);
      ctx.beginPath();
      ctx.arc(landC.x, landC.y, TILE * 0.34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Shadow tracks the ground position under the airborne bomb.
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.ellipse(groundX, groundY + TILE * 0.2, r * 0.7, r * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.shadowColor = '#f87171';
    ctx.shadowBlur = urgent ? 18 : 8;
    const g = ctx.createRadialGradient(c.x - r * 0.3, c.y - r * 0.35, r * 0.15, c.x, c.y, r);
    g.addColorStop(0, urgent ? '#7f1d1d' : '#3f3f50');
    g.addColorStop(1, '#05060a');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y + 2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Fuse and a flickering spark.
    ctx.strokeStyle = '#9ca3af';
    ctx.beginPath();
    ctx.moveTo(c.x + 3, c.y - r);
    ctx.quadraticCurveTo(c.x + 9, c.y - r - 8, c.x + 5, c.y - r - 12);
    ctx.stroke();
    ctx.fillStyle = Math.sin(game.time * 30) > -0.3 ? '#fde047' : '#fb923c';
    ctx.beginPath();
    ctx.arc(c.x + 5, c.y - r - 13, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPickups() {
  // Floating, spinning neon tokens; each power-up has its own colour/icon.
  const LOOK = {
    boots:  '#22d3ee',
    tosser: '#fbbf24',
    shield: '#c084fc',
    warp:   '#60a5fa',
    chaos:  '#f87171',
    drone:  '#4ade80',
  };
  for (const pk of game.pickups) {
    const c = cellCenter(pk.cellX, pk.cellY);
    const bob = Math.sin(pk.age * 4 + pk.cellX) * 4;
    const color = LOOK[pk.type];

    ctx.save();
    ctx.translate(c.x, c.y + bob);
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;

    // Diamond token
    ctx.rotate(Math.PI / 4);
    const s = 13 + Math.sin(pk.age * 2) * 1.5;
    const g = ctx.createLinearGradient(-s, -s, s, s);
    g.addColorStop(0, '#0d1020');
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.fillRect(-s, -s, 2 * s, 2 * s);
    ctx.strokeStyle = color;
    ctx.strokeRect(-s, -s, 2 * s, 2 * s);
    ctx.rotate(-Math.PI / 4);

    // Icon
    ctx.shadowBlur = 0;
    ctx.strokeStyle = ctx.fillStyle = '#eaf9ff';
    if (pk.type === 'boots') {                      // double speed chevron
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-7, -6); ctx.lineTo(-1, 0); ctx.lineTo(-7, 6);
      ctx.moveTo(1, -6);  ctx.lineTo(7, 0);  ctx.lineTo(1, 6);
      ctx.stroke();
    } else if (pk.type === 'tosser') {              // mini bomb with spark
      ctx.beginPath();
      ctx.arc(-1, 2, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fde047';
      ctx.beginPath();
      ctx.moveTo(2, -2); ctx.lineTo(5, -7);
      ctx.stroke();
      ctx.fillStyle = '#fde047';
      ctx.beginPath(); ctx.arc(5, -8, 1.8, 0, Math.PI * 2); ctx.fill();
    } else if (pk.type === 'shield') {            // shield ring
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, Math.PI * 2); ctx.fill();
    } else if (pk.type === 'warp') {              // clock: circle + hands
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, -5);
      ctx.moveTo(0, 0); ctx.lineTo(4, 2);
      ctx.stroke();
    } else if (pk.type === 'chaos') {             // blast star
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        const r = i % 2 === 0 ? 8 : 3.5;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
    } else {                                      // drone: orb with orbit ring
      ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(0, 0, 8, 3.4, -Math.PI / 5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
}

function drawFlames() {
  for (const f of game.flames) {
    const t = Math.max(0, f.life / FLAME_LIFETIME);          // 1 → 0
    const c = cellCenter(f.cellX, f.cellY);
    const flicker = 0.75 + Math.sin(game.time * 40 + f.cellX * 3 + f.cellY) * 0.12;
    const size = TILE * 0.5 * t * flicker + TILE * 0.18;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(c.x, c.y, 2, c.x, c.y, size);
    g.addColorStop(0, `rgba(255, 255, 220, ${0.95 * t})`);
    g.addColorStop(0.4, `rgba(255, 160, 40, ${0.8 * t})`);
    g.addColorStop(1, 'rgba(255, 40, 0, 0)');
    ctx.fillStyle = g;

    // Flame cells stretch along their beam direction.
    ctx.beginPath();
    if (f.shape === 'center' || f.kind !== 'end') {
      const horiz = f.shape === 'h';
      const rx = horiz ? TILE * 0.62 * t + 6 : size;
      const ry = horiz ? size : TILE * 0.62 * t + 6;
      ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(c.x, c.y, size, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPlayer() {
  const p = game.player;
  if (game.state === 'gameover') return;
  if (game.net && p.alive === false) return;   // spectating: the server says you're out

  // Turbo Boots trail: fading after-images of recent positions.
  for (const t of game.trail) {
    ctx.save();
    ctx.globalAlpha = (t.life / 0.3) * 0.3;
    ctx.fillStyle = '#22d3ee';
    roundRect(t.x - 10, t.y - 12, 20, 24, 8);
    ctx.fill();
    ctx.restore();
  }

  // Blink while invulnerable after a respawn.
  if (p.invuln > 0 && Math.sin(game.time * 24) > 0) return;

  ctx.save();
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 16;

  // Body
  ctx.fillStyle = '#e8f6ff';
  roundRect(p.x - 13, p.y - 15, 26, 30, 10);
  ctx.fill();

  // Helmet band
  ctx.fillStyle = '#22d3ee';
  roundRect(p.x - 13, p.y - 15, 26, 9, 6);
  ctx.fill();

  // Eyes look where the player faces.
  const ex = p.dir.x * 3, ey = p.dir.y * 2;
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#0b1020';
  ctx.beginPath();
  ctx.arc(p.x - 5 + ex, p.y + 1 + ey, 2.6, 0, Math.PI * 2);
  ctx.arc(p.x + 5 + ex, p.y + 1 + ey, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Quantum Shield: rotating dashed glow ring.
  if (p.shield) {
    ctx.save();
    ctx.strokeStyle = 'rgba(103, 232, 249, 0.9)';
    ctx.shadowColor = '#67e8f9';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([10, 7]);
    ctx.lineDashOffset = -game.time * 40;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 22 + Math.sin(game.time * 5) * 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Throw pose: an arm punching out in the facing direction.
  if (p.throwAnim > 0) {
    const t = 1 - p.throwAnim / THROW_POSE_TIME;       // 0 → 1
    const reach = 16 + 12 * (1 - t);
    ctx.save();
    ctx.fillStyle = '#e8f6ff';
    ctx.beginPath();
    ctx.arc(p.x + p.dir.x * reach, p.y + p.dir.y * reach - 3, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Phantom Drone escort: a glowing green orb trailing behind the player.
  if (p.droneTimer > 0) {
    ctx.save();
    if (p.droneTimer < 1.5 && Math.sin(game.time * 20) > 0) ctx.globalAlpha = 0.35;
    ctx.shadowColor = '#4ade80';
    ctx.shadowBlur = 16;
    const dr = 7 + Math.sin(game.time * 8) * 1.2;
    const dg = ctx.createRadialGradient(p.droneX - 2, p.droneY - 2, 1, p.droneX, p.droneY, dr + 2);
    dg.addColorStop(0, '#eafff3');
    dg.addColorStop(1, '#4ade80');
    ctx.fillStyle = dg;
    ctx.beginPath();
    ctx.arc(p.droneX, p.droneY, dr, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(167, 243, 208, 0.8)';
    ctx.beginPath();
    ctx.ellipse(p.droneX, p.droneY, dr + 5, 3.5, game.time * 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawEnemies() {
  for (const e of game.enemies) {
    const bob = Math.sin(game.time * 6 + e.x * 0.05) * 2;
    const x = e.x, y = e.y + bob;
    const look = ENEMY_LOOK[e.kind] || ENEMY_LOOK.patrol;

    ctx.save();
    ctx.shadowColor = look;
    ctx.shadowBlur = e.aggro ? 20 : 14;

    // Ghost: dome top + wavy skirt.
    ctx.fillStyle = look;
    ctx.beginPath();
    ctx.arc(x, y - 2, 14, Math.PI, 0);
    ctx.lineTo(x + 14, y + 12);
    for (let i = 0; i < 4; i++) {
      const w = 28 / 4;
      ctx.quadraticCurveTo(x + 14 - w * (i + 0.5), y + 12 + (i % 2 === 0 ? -6 : 6) * -1 + 3,
                           x + 14 - w * (i + 1), y + 12);
    }
    ctx.closePath();
    ctx.fill();

    // Type mark above the ghost: hunter ▲, ambush ◆, patrol ○.
    ctx.fillStyle = look;
    ctx.shadowBlur = 0;
    const my = y - 22;
    ctx.beginPath();
    if (e.kind === 'hunter') {
      ctx.moveTo(x - 5, my - 4); ctx.lineTo(x + 5, my - 4); ctx.lineTo(x, my + 4);
    } else if (e.kind === 'ambush') {
      ctx.moveTo(x, my - 5); ctx.lineTo(x + 5, my); ctx.lineTo(x, my + 5); ctx.lineTo(x - 5, my);
    } else {
      ctx.arc(x, my, 4, 0, Math.PI * 2);
    }
    ctx.closePath();
    ctx.fill();

    // Telegraph: a flashing '!' before a patroller charges.
    if (e.alert > 0 && Math.sin(game.time * 24) > -0.3) {
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fde047';
      ctx.shadowColor = '#fde047';
      ctx.shadowBlur = 10;
      ctx.fillText('!', x, my - 8);
    }

    // Eyes track the player a little.
    const dx = Math.sign(game.player.x - e.x) * 2.5;
    const dy = Math.sign(game.player.y - e.y) * 1.5;
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x - 5, y - 3, 4, 0, Math.PI * 2);
    ctx.arc(x + 5, y - 3, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(x - 5 + dx, y - 3 + dy, 1.8, 0, Math.PI * 2);
    ctx.arc(x + 5 + dx, y - 3 + dy, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Remote competitors: neon suits with a floating name tag.
    Bots get a distinctly angular "droid" silhouette so players can tell
    simulated opponents apart from humans at a glance. */
function drawRemotes() {
  if (game.mode !== 'br') return;
  for (const r of game.remotes) {
    if (!r.alive) continue;
    const x = r.x, y = r.y;
    const dir = r.dir || { x: 1, y: 0 };
    ctx.save();
    ctx.shadowColor = r.color || '#22d3ee';
    ctx.shadowBlur = 14;
    if (r.kind === 'bot') {
      // Angular droid chassis.
      ctx.fillStyle = r.color || '#94a3b8';
      ctx.beginPath();
      ctx.moveTo(x, y - 17);
      ctx.lineTo(x + 13, y - 4);
      ctx.lineTo(x + 9, y + 15);
      ctx.lineTo(x - 9, y + 15);
      ctx.lineTo(x - 13, y - 4);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(x - 7 + dir.x * 2, y - 6 + dir.y * 2, 14, 4);
    } else {
      // Human suit: same silhouette family as the local player, own colour.
      ctx.fillStyle = r.color || '#22d3ee';
      roundRect(x - 13, y - 15, 26, 30, 10);
      ctx.fill();
      ctx.fillStyle = 'rgba(6, 8, 20, 0.75)';
      roundRect(x - 13, y - 15, 26, 9, 6);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#eaffff';
      ctx.beginPath();
      ctx.arc(x - 5 + dir.x * 3, y + 1 + dir.y * 2, 2.4, 0, Math.PI * 2);
      ctx.arc(x + 5 + dir.x * 3, y + 1 + dir.y * 2, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (r.name) {
      ctx.shadowBlur = 0;
      ctx.font = 'bold 11px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(229, 231, 245, 0.9)';
      ctx.fillText(r.name, x, y - 24);
    }
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of game.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

function drawToast() {
  if (!game.toast) return;
  const t = game.toast.life;
  ctx.save();
  ctx.globalAlpha = Math.min(1, t * 2);
  ctx.font = 'bold 34px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#e0f7ff';
  ctx.fillText(game.toast.text, canvas.width / 2, canvas.height / 2 - 40);
  ctx.restore();
}

function render() {
  ctx.save();
  // Screen shake: jitter the whole board briefly after blasts.
  if (game.shake > 0) {
    ctx.translate((Math.random() - 0.5) * game.shake, (Math.random() - 0.5) * game.shake);
  }
  ctx.clearRect(-10, -10, canvas.width + 20, canvas.height + 20);
  drawBoard();
  drawFlames();
  drawBombs();
  drawPickups();
  drawEnemies();
  drawRemotes();
  drawPlayer();
  drawParticles();
  drawToast();
  ctx.restore();

  // Subtle CRT scanlines over everything.
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#000';
  for (let y = 0; y < canvas.height; y += 4) ctx.fillRect(0, y, canvas.width, 2);
  ctx.restore();

  // Red vignette flash right after the player takes a hit.
  if (game.hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.45, game.hitFlash);
    const g = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2,
                                       canvas.height * 0.35,
                                       canvas.width / 2, canvas.height / 2,
                                       canvas.width * 0.72);
    g.addColorStop(0, 'rgba(255,0,40,0)');
    g.addColorStop(1, 'rgba(255,0,40,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

/* ========================= 13. HUD & OVERLAYS ========================= */

function updateHud() {
  if (game.net) {
    // Live match scoreboard: mp.js fills game.netLive from server snapshots.
    const live = game.netLive || {};
    hudEls.score.textContent = String(live.kills || 0);
    hudEls.level.textContent = 'BR';
    hudEls.lives.textContent = live.myAlive ? '♥' : '—';
    hudEls.enemies.textContent = live.aliveOthers != null ? live.aliveOthers : 0;
    const p = game.player;
    const max = (p && p.bombMax) || 2;
    hudEls.bombs.textContent = `${Math.max(0, max - ((p && p.netBombs) || 0))}/${max}`;
    hudEls.progress.textContent = live.aliveCount != null ? `${live.aliveCount} LEFT` : '';
  } else {
    hudEls.score.textContent   = game.score;
    hudEls.level.textContent   = game.levelIndex + 1;
    hudEls.lives.textContent   = '♥'.repeat(Math.max(0, game.lives));
    hudEls.enemies.textContent = game.enemies.length;
    const mine = game.player ? game.bombs.filter(b => !b.remote).length : 0;
    const available = game.player ? game.player.bombMax - mine : 0;
    hudEls.bombs.textContent   = `${Math.max(0, available)}/${game.player ? game.player.bombMax : 2}`;
    hudEls.progress.textContent = game.player ? milestoneProgressText() : '';
  }

  // Power-up badges
  const p = game.player;
  hudEls.turbo.classList.toggle('off', !(p && p.speedTimer > 0));
  if (p && p.speedTimer > 0) hudEls.turbo.textContent = `TURBO ${p.speedTimer.toFixed(1)}s`;
  hudEls.tosser.classList.toggle('off', !(p && p.tosser));
  hudEls.shield.classList.toggle('off', !(p && p.shield));
  hudEls.warp.classList.toggle('off', !(p && p.warpTimer > 0));
  if (p && p.warpTimer > 0) hudEls.warp.textContent = `WARP ${p.warpTimer.toFixed(1)}s`;
  hudEls.chaos.classList.toggle('off', !(p && p.chaosTimer > 0));
  if (p && p.chaosTimer > 0) hudEls.chaos.textContent = `OVERCHARGE ${p.chaosTimer.toFixed(1)}s`;
  hudEls.drone.classList.toggle('off', !(p && p.droneTimer > 0));
  if (p && p.droneTimer > 0) hudEls.drone.textContent = `DRONE ${p.droneTimer.toFixed(1)}s`;
}

function showOverlay(name) {
  for (const key of Object.keys(overlays)) overlays[key].classList.toggle('hidden', key !== name);
}
function hideOverlays() {
  for (const key of Object.keys(overlays)) overlays[key].classList.add('hidden');
}

function startGame() {
  if (game.mode === 'br') return;    // never let menu keys hijack a live match
  Sfx.ensure();
  resetGame(true);
  game.state = 'playing';
  hideOverlays();
}

function togglePause() {
  if (game.state === 'playing') {
    game.state = 'paused';
    showOverlay('pause');
  } else if (game.state === 'paused') {
    game.state = 'playing';
    hideOverlays();
  }
}

/* ========================= 14. INPUT ========================= */

const KEY_TO_DIR = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};

// preventDefault stops gameplay keys from scrolling the page (or opening
// Firefox's quick-find on F). Escape is NOT blocked so the browser can
// still exit fullscreen with the same key.
const BLOCKED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                              'Space', 'KeyF']);

/* ---- Restart confirmation (R must never instantly wipe an active match) ---- */
let restartReturnState = 'paused';

function openRestartConfirm() {
  if (game.mode === 'br') return;   // multiplayer rounds are host-controlled
  if (game.state !== 'playing' && game.state !== 'paused') return;
  restartReturnState = game.state;
  game.state = 'confirming';
  showOverlay('restart-confirm');
}

function resolveRestartConfirm(confirmed) {
  if (game.state !== 'confirming') return;
  if (confirmed) { startGame(); return; }
  // Cancel: put the game back exactly where the dialog interrupted it.
  game.state = restartReturnState;
  if (game.state === 'paused') showOverlay('pause');
  else hideOverlays();
}

window.addEventListener('keydown', (e) => {
  if (BLOCKED_KEYS.has(e.code)) e.preventDefault();
  if (e.repeat) return;                               // ignore held-key auto-repeat

  const dir = KEY_TO_DIR[e.code];
  if (dir) input.keys.add(dir);

  if (e.code === 'Space') {
    if (game.state === 'start') startGame();
    else if (game.state === 'levelclear') nextLevel();
    else if (game.net && hooks.brAction) hooks.brAction('bomb');
    else requestBomb();
  }
  if (e.code === 'KeyZ') {
    if (game.net && hooks.brAction) hooks.brAction('throw');   // net: ask the server
    else throwBomb();                                          // Bomb Tosser action (replaces E)
  }
  if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'KeyR') {
    if (game.state === 'playing' || game.state === 'paused') openRestartConfirm();
    else if (game.state === 'gameover' || game.state === 'victory') startGame();
    // R is ignored in 'start', 'confirming' and 'levelclear' screens.
  }
  if (e.code === 'Enter') {
    if (game.state === 'start') startGame();
    else if (game.state === 'levelclear') nextLevel();
    else if (game.state === 'gameover' || game.state === 'victory') startGame();
    else if (game.state === 'confirming') resolveRestartConfirm(true);
  }
  if (e.code === 'Escape' && game.state === 'confirming') resolveRestartConfirm(false);
});

window.addEventListener('keyup', (e) => {
  const dir = KEY_TO_DIR[e.code];
  if (dir) input.keys.delete(dir);
});

// If the tab loses focus, drop all held keys so nobody "runs" into a wall.
window.addEventListener('blur', () => input.keys.clear());

/* ---- Touch controls ---- */
for (const btn of document.querySelectorAll('#dpad .tbtn')) {
  const dir = btn.dataset.dir;
  const press = (ev) => {
    ev.preventDefault();
    Sfx.ensure();
    input.touchDirs.add(dir);
    btn.classList.add('pressed');
  };
  const release = () => { input.touchDirs.delete(dir); btn.classList.remove('pressed'); };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
}

document.getElementById('btn-bomb-touch').addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  Sfx.ensure();
  if (game.state === 'start') startGame();
  else if (game.state === 'levelclear') nextLevel();
  else requestBomb();
});

document.getElementById('btn-throw-touch').addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  Sfx.ensure();
  throwBomb();
});

/* ---- Buttons ---- */
document.getElementById('btn-campaign').addEventListener('click', () => { Sfx.ensure(); startGame(); });
document.getElementById('btn-controls-open').addEventListener('click', () => showOverlay('controls'));
document.getElementById('btn-controls-back').addEventListener('click', () => showOverlay('start'));
document.getElementById('btn-settings-open').addEventListener('click', () => { paintSettingsBtns(); showOverlay('settings'); });
document.getElementById('btn-settings-back').addEventListener('click', () => showOverlay('start'));
document.getElementById('btn-settings-sound').addEventListener('click', () => { setMuted(!Sfx.muted); });
document.getElementById('btn-settings-fullscreen').addEventListener('click', () => { toggleFullscreen(); });

function paintSettingsBtns() {
  document.getElementById('btn-settings-sound').textContent =
    Sfx.muted ? 'SOUND: OFF' : 'SOUND: ON';
  document.getElementById('btn-settings-fullscreen').textContent =
    document.fullscreenElement ? 'FULLSCREEN: ON' : 'FULLSCREEN: OFF';
}

/* ---- Multiplayer: loaded on demand, never needed for the campaign ---- */
let mpLoading = null;
function openMultiplayer() {
  Sfx.ensure();
  showOverlay('lobby');
  if (window.NEON_MP) { window.NEON_MP.enter(); return; }
  if (!mpLoading) {
    mpLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'mp.js';
      s.onload = () => resolve(window.NEON_MP);
      s.onerror = () => { mpLoading = null; reject(new Error('mp.js failed to load')); };
      document.body.appendChild(s);
    });
  }
  mpLoading.then((mp) => mp && mp.enter()).catch(() => {
    game.toast = { text: 'MULTIPLAYER SCRIPT UNAVAILABLE', life: 2 };
  });
}
document.getElementById('btn-multiplayer').addEventListener('click', openMultiplayer);
document.getElementById('btn-resume').addEventListener('click', togglePause);
document.getElementById('btn-restart-pause').addEventListener('click', startGame);
document.getElementById('btn-next-level').addEventListener('click', nextLevel);
document.getElementById('btn-restart-yes').addEventListener('click', () => resolveRestartConfirm(true));
document.getElementById('btn-restart-no').addEventListener('click', () => resolveRestartConfirm(false));
document.getElementById('btn-retry').addEventListener('click', startGame);
document.getElementById('btn-restart-win').addEventListener('click', startGame);

const soundBtn = document.getElementById('sound-toggle');
function paintSoundBtn() {
  soundBtn.textContent = Sfx.muted ? '🔇' : '🔊';
  soundBtn.classList.toggle('muted', Sfx.muted);
  const ss = document.getElementById('btn-settings-sound');
  if (ss) ss.textContent = Sfx.muted ? 'SOUND: OFF' : 'SOUND: ON';
}
function setMuted(m) {
  Sfx.muted = m;
  localStorage.setItem('neon-bomber-muted', m ? '1' : '0');
  if (!m) { Sfx.ensure(); Sfx.place(); }
  paintSoundBtn();
}
soundBtn.addEventListener('click', () => setMuted(!Sfx.muted));
paintSoundBtn();

/* ========================= 14b. RESPONSIVE SCALING & FULLSCREEN ========================= */

// The canvas KEEPS its fixed logical resolution (720x624); we only change
// its CSS pixel size, so movement, bombs and collisions are never rescaled.
const gameShell = document.getElementById('game-shell');
const boardWrap = document.getElementById('board-wrap');
const hudBar    = document.getElementById('hud');
const touchBar  = document.getElementById('touch-controls');
const fsBtn     = document.getElementById('fullscreen-toggle');

const LOGICAL_W = canvas.width, LOGICAL_H = canvas.height;
const MAX_SCALE = 1.7;   // allow the board to render bigger than before

function fitCanvas() {
  const isFs = document.fullscreenElement === gameShell;
  const hudH   = hudBar ? hudBar.offsetHeight : 0;
  const touchH = (touchBar && getComputedStyle(touchBar).display !== 'none')
                 ? touchBar.offsetHeight : 0;
  const availW = (isFs ? gameShell.clientWidth  : window.innerWidth)  - 16;
  const availH = (isFs ? gameShell.clientHeight : window.innerHeight) - hudH - touchH - 36;
  const scale  = Math.max(0.35, Math.min(availW / LOGICAL_W, availH / LOGICAL_H, MAX_SCALE));
  const w = Math.round(LOGICAL_W * scale), h = Math.round(LOGICAL_H * scale);
  canvas.style.width    = w + 'px';
  canvas.style.height   = h + 'px';
  boardWrap.style.width = w + 'px';   // overlays sit on the canvas, not beside it
}

function setFsBtn() {
  const on = document.fullscreenElement === gameShell;
  fsBtn.classList.toggle('active', on);
  fsBtn.textContent = on ? '✕' : '⛶';
  fsBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
}

function toggleFullscreen() {
  if (!document.fullscreenEnabled) {           // graceful fallback
    game.toast = { text: 'FULLSCREEN NOT AVAILABLE', life: 1.6 };
    return;
  }
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    gameShell.requestFullscreen().catch(() => {
      game.toast = { text: 'FULLSCREEN BLOCKED', life: 1.6 };
    });
  }
}

fsBtn.addEventListener('click', toggleFullscreen);

document.addEventListener('fullscreenchange', () => { setFsBtn(); fitCanvas(); paintSettingsBtns(); });
window.addEventListener('resize', fitCanvas);
fitCanvas();
setFsBtn();

/* ========================= 15. MAIN LOOP ========================= */

let lastFrame = performance.now();

function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);   // clamp big pauses
  lastFrame = now;
  update(dt);
  render();
  updateHud();
  requestAnimationFrame(loop);
}

// Draw one static board behind the start screen so the menu looks alive.
resetGame(true);
game.state = 'start';
showOverlay('start');
requestAnimationFrame(loop);

// Debug + multiplayer bridge handle: mp.js and the console both use this.
window.BOMBER = {
  game, input, hooks, update, render, updateHud, requestBomb, throwBomb, startGame,
  togglePause, fitCanvas, bfsPath, updateEnemies, scareEnemiesNear,
  resetGame, applyDestroyedCell, applyPowerup, showOverlay, hideOverlays,
  cellCenter, tileOverlapsPlayer, spawnDebris,
  TILE, COLS, ROWS, BOMB_FUSE,
};
