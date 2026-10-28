'use strict';

const fs = require('node:fs');
const path = require('node:path');

const value = String(process.env.MULTIPLAYER_SERVER_URL || '').trim();
if (!value) throw new Error('Set MULTIPLAYER_SERVER_URL to the Render HTTPS service URL.');
const url = new URL(value);
if (url.protocol !== 'https:' || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) {
  throw new Error('MULTIPLAYER_SERVER_URL must be an HTTPS origin without a path, query or credentials.');
}

const output = path.join(__dirname, 'dist');
fs.mkdirSync(output, { recursive: true });
for (const file of ['index.html', 'style.css', 'levelgen.js', 'game.js', 'mp.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(output, file));
}
const config = { SERVER_URL: url.origin, ROOM_LIMIT_MAX: 8, SYNC_HZ: 10 };
fs.writeFileSync(path.join(output, 'config.js'),
  `window.MULTIPLAYER_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
