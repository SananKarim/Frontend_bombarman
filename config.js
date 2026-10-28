/* Vercel builds generate dist/config.js from MULTIPLAYER_SERVER_URL.
   This source config is for local/offline use: an HTTP page on port 5000
   connects to the same hostname on port 3000, including LAN/mobile clients. */
window.MULTIPLAYER_CONFIG = {
  SERVER_URL: '',
  ROOM_LIMIT_MAX: 8,
  SYNC_HZ: 10,
};
